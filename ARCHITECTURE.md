# Architecture — Ammamma Gadhi

How the pieces fit together, and — more importantly — *why* they are arranged this way. This is the document to read if you want to understand the app end to end.

## Big picture

```
Customer's browser
      │  (1) loads page, fetches catalogue
      ▼
Nginx load balancer  (docker-compose only; local dev talks to the API directly)
      │  least_conn — sends each request to the least-busy replica
      ├──► API replica 1 (Node + Express, port 3000)
      └──► API replica 2 (Node + Express, port 3000)
                │  SQL over one shared connection pool
                ▼
           Postgres (prod) / SQLite file (local dev)
                │
                └── Razorpay (only for payment: create order + webhook)
```

**The one rule that shapes everything: the API servers are stateless.** No cart, no order, no session lives in a server's memory. All state lives in the database, so any request can be handled by any replica, a replica can be restarted or replaced at any time, and the load balancer can add more replicas without changing the code.

The frontend is also deliberately dumb: `client/app.js` is vanilla JS with no build step. It renders the catalogue from `GET /api/products`, keeps the cart in `localStorage`, and asks the server to price it (`POST /api/cart/validate`). It never computes a price itself.

## Request flows

### 1. Browse + cart (read-only)

```
Browser -> GET /api/products -> DB: products + variants (+ stock) -> JSON
Browser -> POST /api/cart/validate { items: [{ variant_id, qty }] }
        -> server re-reads prices + stock from the DB
        -> 200 { items, totals }  |  409 Insufficient stock
```

Prices come from the database, never from the request. A customer who edits the page in devtools and sends a lower price still gets charged the real one — the request body has no price field at all.

### 2. Checkout (the critical path)

```
Browser -> POST /api/orders  (Idempotency-Key: <uuid>)
        1. validateCheckout(): name, Indian phone, address, pincode,
           delivery slot, payment method, items (qty 1–10)
        2. Idempotency-Key seen before? -> return the stored response (201)
        3. Merge duplicate variant lines; price from the DB
        4. If Razorpay/UPI: create the Razorpay order FIRST (external call
           must never hold a DB lock). No money moves yet.
        5. DB transaction:
             - re-read each variant INSIDE the transaction
             - UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?
               (atomic: succeeds only if enough stock is STILL there)
             - INSERT order (PENDING_PAYMENT, or CONFIRMED for COD)
             - INSERT order_items
             - store the idempotency response
        6. 201 { order, razorpay_order, razorpay_key_id }
```

Why step 4 happens before step 5: a Razorpay call takes ~hundreds of milliseconds. Holding a database write lock across a network call would block every other checkout. If the DB step then fails, the Razorpay order is simply orphaned — harmless, because no money moves until `payment.captured`.

### 3. Payment (Razorpay webhook)

```
Customer pays in Razorpay Checkout
      -> Razorpay -> POST /api/webhooks/razorpay  (raw JSON body)
            1. Verify HMAC-SHA256 signature with RAZORPAY_WEBHOOK_SECRET
               (over the RAW body bytes — express.json() would break it,
               so this route uses express.raw() and is registered first)
            2. Ignore non-payment events (e.g. payment.failed)
            3. Transaction: if this razorpay_payment_id was already
               processed, return { duplicate: true } — no double effect
            4. Find the order by razorpay_order_id; if PENDING_PAYMENT,
               mark it PAID and store the payment id
```

**Only a verified webhook may mark an order PAID — never the browser.** A customer could fake a "payment succeeded" message from their browser; they cannot fake Razorpay's HMAC signature. See [PAYMENTS.md](PAYMENTS.md).

### 4. Fulfilment + cancel

```
Seller (or admin API) -> POST /api/orders/:id/status
  PAID -> CONFIRMED -> SHIPPED -> DELIVERED   (forward only, no skipping)

Customer -> POST /api/orders/:id/cancel
  Allowed from PENDING_PAYMENT / PAID / CONFIRMED only.
  Inside a transaction: order -> CANCELLED, stock restored per item.
  SHIPPED / DELIVERED / CANCELLED -> 409.
```

## Order state machine

```
                    webhook payment.captured
PENDING_PAYMENT ───────────────────────────────► PAID ──► CONFIRMED ──► SHIPPED ──► DELIVERED
  (Razorpay/UPI)                                   ▲           │
       │                                           │           │ cancel
       │ cancel                                    │           ▼
       ▼                              COD orders start here  CANCELLED
  CANCELLED ◄──────────────────────────────────────────────────┘
  (cancel also allowed from PENDING_PAYMENT and PAID)
```

## Database

One interface, two engines (`server/db.js`). App code calls `db.all/get/run` with `?` placeholders and `withTransaction(fn)`; the module translates `?` → `$1, $2…` for Postgres and normalises INSERT ids.

| Table | Purpose |
| --- | --- |
| `products` | Pickle name, description, spice level, veg, emoji |
| `variants` | One row per size: `product_id, size_label, price_paise, stock` |
| `orders` | Customer, address, totals (paise), status, payment ids |
| `order_items` | Snapshot of name/size/price/qty per order (prices frozen at order time) |
| `idempotency_keys` | `key → order_id + full response JSON` for safe retries |
| `processed_payments` | `razorpay_payment_id → order_id`, dedupes webhooks |

Local dev uses Node 22's built-in `node:sqlite` (WAL mode, `busy_timeout` 5s, no server to install). Production uses Postgres via `DATABASE_URL`. Money is always integer **paise** — never floats.

## Concurrency — how two people buying the last jar can't both win

This is the hardest part of the app, and it has three layers:

1. **Atomic stock decrement (the real guard, works across replicas).**
   ```sql
   UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?
   ```
   The database checks the condition and updates the row in one indivisible step. If two checkouts race for the last unit, one UPDATE affects 1 row and the other affects 0 — the loser gets a `409 Insufficient stock` and its transaction rolls back. Stock can never go negative. This is tested in `tests/concurrency.test.js`.
2. **Transactions.** The re-read, the decrement, the order INSERT and the order-items INSERT all happen in one transaction, so a failure halfway leaves nothing half-written. SQLite uses `BEGIN IMMEDIATE` (write lock up front) so two writers serialise instead of one failing with `SQLITE_BUSY`; Postgres uses a normal transaction on a pooled connection.
3. **Idempotency keys.** If the customer double-clicks *Place order*, or the network retries, the browser sends the same `Idempotency-Key` (`crypto.randomUUID()` per checkout in `client/app.js`). The server stores the first response and replays it — one order, one stock decrement, one charge. Without a key, two identical posts make two orders (also tested).

On top of that, `server/app.js` has a small in-process mutex (`withOrderLock`) around order mutations. It only serialises requests *inside one Node process* while SQLite is in use; the DB guard above is what actually protects you across replicas. In Postgres production the DB guard alone is enough.

## Load balancing

`nginx/nginx.conf` fronts two identical API containers (`api1`, `api2` in `docker-compose.yml`):

- **Policy: `least_conn`.** Each request goes to the replica with the fewest active connections. Round-robin would be fine for identical fast requests, but a checkout that calls Razorpay is much slower than a catalogue read — `least_conn` stops piling new work onto a busy replica.
- **Passive health checks:** `max_fails=3 fail_timeout=10s` — a replica that fails 3 times in 10s is marked down until it recovers. (Active health checks are an Nginx Plus feature; open-source Nginx doesn't have them.)
- **Retry:** `proxy_next_upstream` retries a failed request on the other replica. Safe here because order creation is idempotent when the client sends an `Idempotency-Key`.
- **Headers:** `X-Real-IP` / `X-Forwarded-For` forward the real client address; `keepalive 32` reuses upstream connections.
- **Scaling:** add `api3` to the upstream block (and compose file) and reload Nginx. No code changes — that is the payoff of stateless servers.

**What the load balancer does NOT do:** it doesn't share state, it doesn't fix the database being a single point of failure, and it doesn't help if the database itself is the bottleneck. For real production you would use a managed Postgres (with backups and read replicas if needed) and put the load balancer behind HTTPS.

## Known limitations (before going live)

- **No auth on the admin endpoints.** `GET /api/orders` and `POST /api/orders/:id/status` are open — anyone can list orders or advance them. Add seller login (or at least a secret token) before exposing this publicly.
- **No rate limiting.** Add it at Nginx (or a middleware) before launch.
- **SQLite is dev-only.** It is a single file; it works for learning and for one small server, but the two-replica compose stack uses Postgres for a reason.
- **The compose `db` container is not a production database.** Use a managed Postgres with backups.
- **No HTTPS in the compose stack.** Terminate TLS at Nginx (add certificates) or at your cloud load balancer.
- **No email/SMS notifications.** Order confirmation is shown on screen only; add a notification step (after payment confirmation) for a real shop.
