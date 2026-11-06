// Order tests — POST /api/orders, GET /api/orders, cancel, status.
//
// Covers: checkout validation, COD vs Razorpay order creation, stock
// decrement, order lookup by id/phone, cancel restoring stock, and the
// fulfilment state machine (see ARCHITECTURE.md).
const { checkoutBody, makeTestApp, stockOf, variantOf } = require('./helpers');

let api;
let products;
let teardown;

beforeAll(async () => {
  ({ api, products, teardown } = await makeTestApp());
});

afterAll(async () => {
  await teardown();
});

// Each test uses its own variant where stock matters, so tests stay
// independent even though they share one seeded database.
async function createCodOrder(variant, qty, overrides = {}) {
  const res = await api
    .post('/api/orders')
    .send(checkoutBody([{ variant_id: variant.id, qty }], overrides))
    .expect(201);
  return res.body;
}

describe('checkout validation — each bad field is a 400', () => {
  const v = () => variantOf(products, 'Tomato Pickle', '250g');
  const cases = [
    ['bad phone (too short)', { phone: '12345' }, /phone/],
    ['bad phone (starts with 1)', { phone: '1234567890' }, /phone/],
    ['bad pincode (starts with 0)', { pincode: '012345' }, /pincode/],
    ['bad pincode (5 digits)', { pincode: '50001' }, /pincode/],
    ['short address', { address: 'too short' }, /address/],
    ['missing customer name', { customer_name: '' }, /customer_name/],
    ['empty items', null, /items/],
    ['qty 0', 'qty0', /qty/],
    ['qty 11 (max is 10)', 'qty11', /qty/],
    ['bad payment method', { payment_method: 'cash' }, /payment_method/],
    ['bad delivery slot', { delivery_slot: 'next-year' }, /delivery_slot/],
  ];

  test.each(cases)('%s', async (_label, override, pattern) => {
    let body;
    if (override === null) {
      body = checkoutBody([]);
    } else if (override === 'qty0') {
      body = checkoutBody([{ variant_id: v().id, qty: 0 }]);
    } else if (override === 'qty11') {
      body = checkoutBody([{ variant_id: v().id, qty: 11 }]);
    } else {
      body = checkoutBody([{ variant_id: v().id, qty: 1 }], override);
    }
    const res = await api.post('/api/orders').send(body).expect(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details.join(' ')).toMatch(pattern);
  });

  test('unknown variant_id is a 400 (checked after validation)', async () => {
    const res = await api
      .post('/api/orders')
      .send(checkoutBody([{ variant_id: 999999, qty: 1 }]))
      .expect(400);
    expect(res.body.error).toMatch(/Unknown variant/);
  });
});

describe('COD order creation', () => {
  test('creates a CONFIRMED order with server-computed totals and items', async () => {
    const v = variantOf(products, 'Gongura Pickle', '500g'); // Rs 299
    const before = await stockOf(api, products, 'Gongura Pickle', '500g');
    const order = await createCodOrder(v, 1);

    expect(order.status).toBe('CONFIRMED'); // COD skips PENDING_PAYMENT
    expect(order.payment_method).toBe('cod');
    expect(order.customer_name).toBe('Test Customer');
    expect(order.subtotal_paise).toBe(29900);
    expect(order.gst_paise).toBe(1495);
    expect(order.delivery_fee_paise).toBe(4900);
    expect(order.total_paise).toBe(29900 + 1495 + 4900);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      variant_id: v.id,
      product_name: 'Gongura Pickle',
      size_label: '500g',
      unit_price_paise: 29900,
      qty: 1,
      line_total_paise: 29900,
    });

    // Stock went down by exactly 1.
    expect(await stockOf(api, products, 'Gongura Pickle', '500g')).toBe(before - 1);
  });

  test('phone is normalised (+91 prefix and spaces stripped)', async () => {
    const v = variantOf(products, 'Garlic Pickle', '250g');
    const order = await createCodOrder(v, 1, { phone: '+91 98490 12345' });
    expect(order.phone).toBe('9849012345');
  });

  test('duplicate variant lines are merged into one order item', async () => {
    const v = variantOf(products, 'Red Chilli Pickle', '250g');
    const before = await stockOf(api, products, 'Red Chilli Pickle', '250g');
    const res = await api
      .post('/api/orders')
      .send(checkoutBody([
        { variant_id: v.id, qty: 1 },
        { variant_id: v.id, qty: 1 },
      ]))
      .expect(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].qty).toBe(2);
    expect(await stockOf(api, products, 'Red Chilli Pickle', '250g')).toBe(before - 2);
  });

  test('ordering more than stock returns 409 and stock is unchanged', async () => {
    const v = variantOf(products, 'Amla Pickle', '1kg'); // stock 8
    const before = await stockOf(api, products, 'Amla Pickle', '1kg');
    const res = await api
      .post('/api/orders')
      .send(checkoutBody([{ variant_id: v.id, qty: 9 }]))
      .expect(409);
    expect(res.body.error).toMatch(/Insufficient stock/);
    expect(await stockOf(api, products, 'Amla Pickle', '1kg')).toBe(before);
  });
});

describe('Razorpay order creation (mock mode)', () => {
  test('creates a PENDING_PAYMENT order with a mock Razorpay order id', async () => {
    const v = variantOf(products, 'Mango Thokku', '250g');
    const res = await api
      .post('/api/orders')
      .send(checkoutBody([{ variant_id: v.id, qty: 1 }], { payment_method: 'razorpay' }))
      .expect(201);
    expect(res.body.status).toBe('PENDING_PAYMENT');
    expect(res.body.razorpay_order).toBeDefined();
    expect(res.body.razorpay_order.id).toMatch(/^order_mock_/);
    expect(res.body.razorpay_order.mock).toBe(true);
    expect(res.body.razorpay_key_id).toBe('rzp_test_mock');
    // Stock is reserved even while payment is pending.
    expect(res.body.razorpay_order_id).toBe(res.body.razorpay_order.id);
  });

  test('upi behaves like razorpay (PENDING_PAYMENT, mock order)', async () => {
    const v = variantOf(products, 'Curry Leaf Pickle', '250g');
    const res = await api
      .post('/api/orders')
      .send(checkoutBody([{ variant_id: v.id, qty: 1 }], { payment_method: 'upi' }))
      .expect(201);
    expect(res.body.status).toBe('PENDING_PAYMENT');
    expect(res.body.razorpay_order.id).toMatch(/^order_mock_/);
  });
});

describe('order lookup', () => {
  test('GET /api/orders/:id returns the order with items', async () => {
    const v = variantOf(products, 'Mixed Veg Pickle', '250g');
    const created = await createCodOrder(v, 2);
    const res = await api.get(`/api/orders/${created.id}`).expect(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].qty).toBe(2);
  });

  test('GET /api/orders?phone= lists that customer’s orders', async () => {
    const v = variantOf(products, 'Bitter Gourd Pickle', '250g');
    const created = await createCodOrder(v, 1, { phone: '9000011111' });
    const res = await api.get('/api/orders?phone=9000011111').expect(200);
    expect(res.body.orders.map((o) => o.id)).toContain(created.id);
    const other = await api.get('/api/orders?phone=9000022222').expect(200);
    expect(other.body.orders).toHaveLength(0);
  });

  test('GET /api/orders?status= filters by status', async () => {
    const res = await api.get('/api/orders?status=CONFIRMED').expect(200);
    expect(res.body.orders.length).toBeGreaterThan(0);
    expect(res.body.orders.every((o) => o.status === 'CONFIRMED')).toBe(true);
  });

  test('GET /api/orders?status=BOGUS is a 400', async () => {
    await api.get('/api/orders?status=BOGUS').expect(400);
  });
});

describe('cancel restores stock', () => {
  test('cancelling a CONFIRMED order returns stock and marks CANCELLED', async () => {
    const v = variantOf(products, 'Ridge Gourd Pickle', '500g');
    const before = await stockOf(api, products, 'Ridge Gourd Pickle', '500g');
    const order = await createCodOrder(v, 2);
    expect(await stockOf(api, products, 'Ridge Gourd Pickle', '500g')).toBe(before - 2);

    const res = await api.post(`/api/orders/${order.id}/cancel`).expect(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(await stockOf(api, products, 'Ridge Gourd Pickle', '500g')).toBe(before);
  });

  test('cancelling twice is a 409', async () => {
    const v = variantOf(products, 'Lemon Pickle', '250g');
    const order = await createCodOrder(v, 1);
    await api.post(`/api/orders/${order.id}/cancel`).expect(200);
    await api.post(`/api/orders/${order.id}/cancel`).expect(409);
  });

  test('cancelling a SHIPPED order is a 409 and stock stays out', async () => {
    const v = variantOf(products, 'Tomato Pickle', '500g');
    const before = await stockOf(api, products, 'Tomato Pickle', '500g');
    const order = await createCodOrder(v, 1);
    await api.post(`/api/orders/${order.id}/status`).send({ status: 'SHIPPED' }).expect(200);
    await api.post(`/api/orders/${order.id}/cancel`).expect(409);
    expect(await stockOf(api, products, 'Tomato Pickle', '500g')).toBe(before - 1);
  });

  test('cancelling an unknown order is a 404', async () => {
    await api.post('/api/orders/999999/cancel').expect(404);
  });
});

describe('fulfilment state machine', () => {
  test('COD order moves CONFIRMED -> SHIPPED -> DELIVERED', async () => {
    const v = variantOf(products, 'Avakaya Mango Pickle', '500g');
    const order = await createCodOrder(v, 1);
    const shipped = await api
      .post(`/api/orders/${order.id}/status`)
      .send({ status: 'SHIPPED' })
      .expect(200);
    expect(shipped.body.status).toBe('SHIPPED');
    const delivered = await api
      .post(`/api/orders/${order.id}/status`)
      .send({ status: 'DELIVERED' })
      .expect(200);
    expect(delivered.body.status).toBe('DELIVERED');
  });

  test('skipping a step is a 409 (CONFIRMED -> DELIVERED)', async () => {
    const v = variantOf(products, 'Avakaya Mango Pickle', '1kg');
    const order = await createCodOrder(v, 1);
    await api
      .post(`/api/orders/${order.id}/status`)
      .send({ status: 'DELIVERED' })
      .expect(409);
  });

  test('a PENDING_PAYMENT order cannot jump to CONFIRMED without payment', async () => {
    const v = variantOf(products, 'Gongura Pickle', '250g');
    const res = await api
      .post('/api/orders')
      .send(checkoutBody([{ variant_id: v.id, qty: 1 }], { payment_method: 'razorpay' }))
      .expect(201);
    await api
      .post(`/api/orders/${res.body.id}/status`)
      .send({ status: 'CONFIRMED' })
      .expect(409);
  });

  test('an invalid status value is a 400', async () => {
    const v = variantOf(products, 'Garlic Pickle', '500g');
    const order = await createCodOrder(v, 1);
    await api
      .post(`/api/orders/${order.id}/status`)
      .send({ status: 'FLYING' })
      .expect(400);
  });
});
