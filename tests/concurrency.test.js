// Concurrency + idempotency tests — the two guards that stop double-selling.
//
// 1. Oversell race: two concurrent orders for the LAST unit of a variant.
//    The conditional UPDATE inside a DB transaction
//    (UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?)
//    is atomic, so exactly one order can succeed.
// 2. Idempotency: retrying the same request with the same Idempotency-Key
//    returns the SAME order — no second order, no second stock decrement.
const { checkoutBody, makeTestApp, stockOf, variantOf } = require('./helpers');

let api;
let products;
let db;
let teardown;

beforeAll(async () => {
  ({ api, products, db, teardown } = await makeTestApp());
});

afterAll(async () => {
  await teardown();
});

describe('oversell race', () => {
  test('two concurrent orders for the last unit — exactly one succeeds', async () => {
    const v = variantOf(products, 'Bitter Gourd Pickle', '1kg'); // seed stock 5
    await db.run('UPDATE variants SET stock = 1 WHERE id = ?', [v.id]);

    const bodyA = checkoutBody([{ variant_id: v.id, qty: 1 }], { phone: '9000010001' });
    const bodyB = checkoutBody([{ variant_id: v.id, qty: 1 }], { phone: '9000010002' });
    const [resA, resB] = await Promise.all([
      api.post('/api/orders').set('Idempotency-Key', 'race-a').send(bodyA),
      api.post('/api/orders').set('Idempotency-Key', 'race-b').send(bodyB),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]); // one winner, one clean rejection
    const loser = resA.status === 409 ? resA : resB;
    expect(loser.body.error).toMatch(/Insufficient stock/);

    // Stock is exactly 0 — never negative, never double-decremented.
    expect(await stockOf(api, products, 'Bitter Gourd Pickle', '1kg')).toBe(0);

    // Exactly one order exists across both customers.
    const listA = await api.get('/api/orders?phone=9000010001').expect(200);
    const listB = await api.get('/api/orders?phone=9000010002').expect(200);
    expect(listA.body.orders.length + listB.body.orders.length).toBe(1);
  });

  test('a failed race leaves the loser able to order a different pickle', async () => {
    const v = variantOf(products, 'Amla Pickle', '250g');
    const order = await api
      .post('/api/orders')
      .send(checkoutBody([{ variant_id: v.id, qty: 1 }], { phone: '9000010003' }))
      .expect(201);
    expect(order.body.status).toBe('CONFIRMED');
  });
});

describe('idempotency', () => {
  test('same Idempotency-Key retried returns the same order, stock cut once', async () => {
    const v = variantOf(products, 'Mixed Veg Pickle', '500g');
    const before = await stockOf(api, products, 'Mixed Veg Pickle', '500g');
    const body = checkoutBody([{ variant_id: v.id, qty: 2 }], { phone: '9000010004' });

    const first = await api
      .post('/api/orders')
      .set('Idempotency-Key', 'idem-001')
      .send(body)
      .expect(201);
    const second = await api
      .post('/api/orders')
      .set('Idempotency-Key', 'idem-001')
      .send(body)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.total_paise).toBe(first.body.total_paise);
    // Stock went down by 2 (one order), not by 4 (two orders).
    expect(await stockOf(api, products, 'Mixed Veg Pickle', '500g')).toBe(before - 2);

    const list = await api.get('/api/orders?phone=9000010004').expect(200);
    expect(list.body.orders).toHaveLength(1);
  });

  test('a different key creates a genuinely new order', async () => {
    const v = variantOf(products, 'Mixed Veg Pickle', '250g');
    const body = checkoutBody([{ variant_id: v.id, qty: 1 }], { phone: '9000010005' });
    const first = await api
      .post('/api/orders')
      .set('Idempotency-Key', 'idem-002')
      .send(body)
      .expect(201);
    const second = await api
      .post('/api/orders')
      .set('Idempotency-Key', 'idem-003')
      .send(body)
      .expect(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  test('no key means no dedup — two identical posts make two orders', async () => {
    const v = variantOf(products, 'Tomato Pickle', '1kg');
    const body = checkoutBody([{ variant_id: v.id, qty: 1 }], { phone: '9000010006' });
    const first = await api.post('/api/orders').send(body).expect(201);
    const second = await api.post('/api/orders').send(body).expect(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});
