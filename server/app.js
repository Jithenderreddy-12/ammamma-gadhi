// API server — Express + SQLite (dev) / Postgres (prod).
//
// Endpoints:
//   GET  /health
//   GET  /api/products                     catalogue with variants + stock
//   POST /api/cart/validate                price + stock check, no side effects
//   POST /api/orders                       create order (Idempotency-Key supported)
//   GET  /api/orders/:id                   one order + its items
//   GET  /api/orders?phone=&status=        admin list (add auth before prod!)
//   POST /api/orders/:id/cancel            cancel + restore stock
//   POST /api/orders/:id/status            admin: advance fulfilment status
//   POST /api/webhooks/razorpay            Razorpay webhook (HMAC-verified)
//
// The two rules that matter most (see ARCHITECTURE.md):
//   1. Stock never goes negative — conditional UPDATE inside a transaction.
//   2. Only a verified webhook may mark an order PAID — never the browser.
const express = require('express');
const path = require('path');
const { calculateTotals } = require('./lib/pricing');
const { normalisePhone, validateCheckout } = require('./lib/validate');
const razorpay = require('./lib/razorpay');
const { close: closeDb, db, initDb, withTransaction } = require('./db');

const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
// Fulfilment may only move forward (cancel has its own endpoint).
const ALLOWED_TRANSITIONS = {
  PAID: ['CONFIRMED'],
  CONFIRMED: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
};

// Single-process serialiser for order mutations. The REAL guard is the DB
// transaction + conditional UPDATE (works across replicas); this mutex only
// stops two requests interleaving inside one Node process while SQLite
// (a single-file DB) is in use. In Postgres prod the DB guard is enough.
let orderMutex = Promise.resolve();
function withOrderLock(fn) {
  const run = orderMutex.then(fn, fn);
  orderMutex = run.catch(() => {});
  return run;
}

function publicOrder(order, items) {
  return { ...order, items: items || order.items || [] };
}

async function fetchOrder(client, orderId) {
  const order = await client.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return null;
  const items = await client.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]);
  return publicOrder(order, items);
}

async function createApp({ dbPath } = {}) {
  await initDb(dbPath);
  const app = express();

  // --- Razorpay webhook FIRST, before express.json() -------------------
  // Signature verification needs the RAW body bytes. express.json() would
  // consume + re-serialise them, breaking the HMAC. So this route uses
  // express.raw() and is registered before the JSON parser.
  app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res, next) => {
    try {
      const signature = req.get('x-razorpay-signature');
      if (!razorpay.verifyWebhookSignature(req.body, signature)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      const body = JSON.parse(req.body.toString('utf8'));
      const entity = body?.payload?.payment?.entity || {};
      const razorpayOrderId = entity.order_id || body.razorpay_order_id;
      const paymentId = entity.id || body.razorpay_payment_id;
      const event = body.event || 'payment.captured';
      if (!razorpayOrderId || !paymentId) {
        return res.status(400).json({ error: 'Webhook payload missing razorpay order/payment id' });
      }
      if (event !== 'payment.captured' && event !== 'payment.authorized') {
        return res.json({ received: true, ignored_event: event });
      }
      const result = await withOrderLock(() =>
        withTransaction(async (tx) => {
          // Duplicate-webhook safety: same payment id twice = one effect.
          const seen = await tx.get('SELECT * FROM processed_payments WHERE razorpay_payment_id = ?', [paymentId]);
          if (seen) return { duplicate: true, order_id: seen.order_id };
          const order = await tx.get('SELECT * FROM orders WHERE razorpay_order_id = ?', [razorpayOrderId]);
          if (!order) return { not_found: true };
          await tx.run('INSERT INTO processed_payments (razorpay_payment_id, order_id) VALUES (?, ?)', [paymentId, order.id]);
          if (order.status === 'PENDING_PAYMENT') {
            await tx.run("UPDATE orders SET status = 'PAID', razorpay_payment_id = ? WHERE id = ?", [paymentId, order.id]);
            return { order_id: order.id, status: 'PAID' };
          }
          return { order_id: order.id, status: order.status, already: true };
        }),
      );
      if (result.not_found) return res.status(404).json({ error: 'No order for this razorpay_order_id' });
      return res.json({ received: true, ...result });
    } catch (err) { next(err); }
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'client')));

  app.get('/health', (req, res) => res.json({ ok: true, status: 'ok' }));

  // --- Catalogue --------------------------------------------------------
  app.get('/api/products', async (req, res, next) => {
    try {
      const products = await db.all('SELECT * FROM products ORDER BY id');
      const variants = await db.all('SELECT * FROM variants ORDER BY product_id, price_paise');
      const byProduct = {};
      for (const v of variants) (byProduct[v.product_id] ||= []).push({
        id: v.id, size_label: v.size_label, price_paise: v.price_paise, stock: v.stock,
      });
      res.json({ products: products.map((p) => ({ ...p, veg: Boolean(p.veg), variants: byProduct[p.id] || [] })) });
    } catch (err) { next(err); }
  });

  // --- Cart validation (read-only: prices + stock from DB, never client) -
  async function resolveItems(items) {
    const resolved = [];
    for (const it of items) {
      const row = await db.get(
        `SELECT v.id AS variant_id, v.size_label, v.price_paise, v.stock,
                p.name AS product_name
         FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
        [it.variant_id],
      );
      if (!row) throw Object.assign(new Error(`Unknown variant_id ${it.variant_id}`), { status: 400 });
      resolved.push({ ...row, qty: it.qty, line_total_paise: row.price_paise * it.qty });
    }
    return resolved;
  }

  app.post('/api/cart/validate', async (req, res, next) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items must be a non-empty array' });
      }
      const resolved = await resolveItems(items);
      const outOfStock = resolved.filter((r) => r.qty > r.stock);
      if (outOfStock.length) {
        return res.status(409).json({ error: 'Insufficient stock', items: outOfStock.map((r) => ({ variant_id: r.variant_id, requested: r.qty, available: r.stock })) });
      }
      res.json({ items: resolved, totals: calculateTotals(resolved.map((r) => ({ unit_price_paise: r.price_paise, qty: r.qty }))) });
    } catch (err) { next(err); }
  });

  // --- Create order -----------------------------------------------------
  app.post('/api/orders', async (req, res, next) => {
    try {
      const errors = validateCheckout(req.body);
      if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
      const idempotencyKey = req.get('idempotency-key');
      if (idempotencyKey) {
        const prev = await db.get('SELECT * FROM idempotency_keys WHERE key = ?', [idempotencyKey]);
        if (prev) return res.status(201).json(JSON.parse(prev.response_json)); // retry = same order, no double charge/stock
      }
      // Merge duplicate variant lines (e.g. two 500g Avakaya rows).
      const merged = new Map();
      for (const it of req.body.items) merged.set(it.variant_id, (merged.get(it.variant_id) || 0) + it.qty);
      const items = [...merged.entries()].map(([variant_id, qty]) => ({ variant_id, qty }));

      const provisional = await resolveItems(items);
      const totals = calculateTotals(provisional.map((r) => ({ unit_price_paise: r.price_paise, qty: r.qty })));
      const paymentMethod = req.body.payment_method;

      // Razorpay order is created BEFORE the DB transaction (external call
      // must never hold a DB lock). If the DB step then fails, the Razorpay
      // order is simply orphaned — no money moves until payment.captured.
      let rzpOrder = null;
      if (paymentMethod === 'razorpay' || paymentMethod === 'upi') {
        rzpOrder = await razorpay.createOrder(totals.totalPaise, `pickles_${Date.now()}`);
      }

      const order = await withOrderLock(() =>
        withTransaction(async (tx) => {
          // Re-read + re-check INSIDE the transaction — this is the race guard.
          const fresh = [];
          for (const it of items) {
            const row = await tx.get(
              `SELECT v.id AS variant_id, v.size_label, v.price_paise, v.stock, p.name AS product_name
               FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`,
              [it.variant_id],
            );
            if (!row) throw Object.assign(new Error(`Unknown variant_id ${it.variant_id}`), { status: 400 });
            // Atomic decrement: succeeds only if enough stock is STILL there.
            const upd = await tx.run('UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?', [it.qty, it.variant_id, it.qty]);
            if (upd.changes === 0) {
              throw Object.assign(new Error(`Insufficient stock for variant ${it.variant_id}`), { status: 409 });
            }
            fresh.push({ ...row, qty: it.qty, line_total_paise: row.price_paise * it.qty });
          }
          const t = calculateTotals(fresh.map((r) => ({ unit_price_paise: r.price_paise, qty: r.qty })));
          const status = paymentMethod === 'cod' ? 'CONFIRMED' : 'PENDING_PAYMENT';
          const inserted = await tx.run(
            `INSERT INTO orders (customer_name, phone, address, pincode, delivery_slot,
               payment_method, status, subtotal_paise, gst_paise, delivery_fee_paise,
               total_paise, razorpay_order_id, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              String(req.body.customer_name).trim(), normalisePhone(req.body.phone),
              String(req.body.address).trim(), String(req.body.pincode).trim(),
              req.body.delivery_slot || 'tomorrow-morning', paymentMethod, status,
              t.subtotalPaise, t.gstPaise, t.deliveryFeePaise, t.totalPaise,
              rzpOrder ? rzpOrder.id : null, idempotencyKey || null,
            ],
          );
          for (const r of fresh) {
            await tx.run(
              `INSERT INTO order_items (order_id, variant_id, product_name, size_label,
                 unit_price_paise, qty, line_total_paise) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [inserted.id, r.variant_id, r.product_name, r.size_label, r.price_paise, r.qty, r.line_total_paise],
            );
          }
          const full = await fetchOrder(tx, inserted.id);
          const response = { ...full, razorpay_order: rzpOrder, razorpay_key_id: paymentMethod === 'cod' ? undefined : process.env.RAZORPAY_KEY_ID || 'rzp_test_mock' };
          if (idempotencyKey) {
            await tx.run('INSERT INTO idempotency_keys (key, order_id, response_json) VALUES (?, ?, ?)',
              [idempotencyKey, inserted.id, JSON.stringify(response)]);
          }
          return response;
        }),
      );
      return res.status(201).json(order);
    } catch (err) { next(err); }
  });

  // --- Read / list orders ------------------------------------------------
  app.get('/api/orders/:id', async (req, res, next) => {
    try {
      const order = await fetchOrder(db, Number(req.params.id));
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json(order);
    } catch (err) { next(err); }
  });

  app.get('/api/orders', async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
      const where = [];
      const params = [];
      if (req.query.phone) { where.push('phone = ?'); params.push(normalisePhone(req.query.phone)); }
      if (req.query.status) {
        if (!ORDER_STATUSES.includes(req.query.status)) return res.status(400).json({ error: 'Invalid status filter' });
        where.push('status = ?'); params.push(req.query.status);
      }
      const orders = await db.all(
        `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
        [...params, limit],
      );
      res.json({ orders });
    } catch (err) { next(err); }
  });

  // --- Cancel (restores stock) -------------------------------------------
  app.post('/api/orders/:id/cancel', async (req, res, next) => {
    try {
      const result = await withOrderLock(() =>
        withTransaction(async (tx) => {
          const order = await fetchOrder(tx, Number(req.params.id));
          if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
          if (['SHIPPED', 'DELIVERED', 'CANCELLED'].includes(order.status)) {
            throw Object.assign(new Error(`Cannot cancel an order in status ${order.status}`), { status: 409 });
          }
          await tx.run("UPDATE orders SET status = 'CANCELLED' WHERE id = ?", [order.id]);
          for (const it of order.items) {
            await tx.run('UPDATE variants SET stock = stock + ? WHERE id = ?', [it.qty, it.variant_id]);
          }
          return fetchOrder(tx, order.id);
        }),
      );
      res.json(result);
    } catch (err) { next(err); }
  });

  // --- Admin: advance fulfilment status ----------------------------------
  app.post('/api/orders/:id/status', async (req, res, next) => {
    try {
      const target = req.body?.status;
      if (!ORDER_STATUSES.includes(target)) return res.status(400).json({ error: 'Invalid status' });
      const order = await db.get('SELECT * FROM orders WHERE id = ?', [Number(req.params.id)]);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!(ALLOWED_TRANSITIONS[order.status] || []).includes(target)) {
        return res.status(409).json({ error: `Cannot move order from ${order.status} to ${target}` });
      }
      await db.run('UPDATE orders SET status = ? WHERE id = ?', [target, order.id]);
      res.json(await fetchOrder(db, order.id));
    } catch (err) { next(err); }
  });

  // --- Error handler (always JSON, never a stack trace to the client) -----
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
  });

  return { app, close: closeDb, db };
}

module.exports = { createApp };
