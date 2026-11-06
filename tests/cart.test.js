// Cart validation tests — POST /api/cart/validate.
//
// This endpoint is read-only: it prices the cart from the DATABASE and
// checks stock. Prices the browser sends are never trusted (the request
// body carries only variant_id + qty — there is no price field to forge).
const { makeTestApp, variantOf } = require('./helpers');

let api;
let products;
let teardown;

beforeAll(async () => {
  ({ api, products, teardown } = await makeTestApp());
});

afterAll(async () => {
  await teardown();
});

describe('POST /api/cart/validate', () => {
  test('validates a single item and returns server-side totals', async () => {
    const v = variantOf(products, 'Avakaya Mango Pickle', '250g'); // Rs 149
    const res = await api
      .post('/api/cart/validate')
      .send({ items: [{ variant_id: v.id, qty: 1 }] })
      .expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].product_name).toBe('Avakaya Mango Pickle');
    expect(res.body.items[0].line_total_paise).toBe(14900);
    // 14900 + 5% GST (745) + Rs 49 delivery (below Rs 499) = 20545
    expect(res.body.totals).toEqual({
      deliveryFeePaise: 4900,
      gstPaise: 745,
      subtotalPaise: 14900,
      totalPaise: 20545,
    });
  });

  test('free delivery when subtotal reaches Rs 499', async () => {
    const v = variantOf(products, 'Avakaya Mango Pickle', '1kg'); // Rs 529
    const res = await api
      .post('/api/cart/validate')
      .send({ items: [{ variant_id: v.id, qty: 1 }] })
      .expect(200);
    expect(res.body.totals.subtotalPaise).toBe(52900);
    expect(res.body.totals.deliveryFeePaise).toBe(0);
    expect(res.body.totals.totalPaise).toBe(52900 + 2645);
  });

  test('rejects an empty cart with 400', async () => {
    const res = await api.post('/api/cart/validate').send({ items: [] }).expect(400);
    expect(res.body.error).toMatch(/non-empty/);
  });

  test('rejects a missing items array with 400', async () => {
    await api.post('/api/cart/validate').send({}).expect(400);
  });

  test('rejects an unknown variant_id with 400', async () => {
    const res = await api
      .post('/api/cart/validate')
      .send({ items: [{ variant_id: 999999, qty: 1 }] })
      .expect(400);
    expect(res.body.error).toMatch(/Unknown variant/);
  });

  test('rejects a quantity above stock with 409 and reports availability', async () => {
    const v = variantOf(products, 'Avakaya Mango Pickle', '250g'); // stock 20
    const res = await api
      .post('/api/cart/validate')
      .send({ items: [{ variant_id: v.id, qty: 999 }] })
      .expect(409);
    expect(res.body.error).toMatch(/Insufficient stock/);
    expect(res.body.items[0]).toEqual({
      variant_id: v.id,
      requested: 999,
      available: v.stock,
    });
  });

  test('validation has no side effects — stock is unchanged afterwards', async () => {
    const v = variantOf(products, 'Lemon Pickle', '500g');
    await api
      .post('/api/cart/validate')
      .send({ items: [{ variant_id: v.id, qty: 2 }] })
      .expect(200);
    const fresh = await api.get('/api/products').expect(200);
    expect(variantOf(fresh.body.products, 'Lemon Pickle', '500g').stock).toBe(v.stock);
  });
});
