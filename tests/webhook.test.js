// Razorpay webhook tests — POST /api/webhooks/razorpay.
//
// The rule under test: ONLY a webhook whose HMAC-SHA256 signature verifies
// against RAZORPAY_WEBHOOK_SECRET may flip an order to PAID. The browser's
// claim that payment succeeded is never trusted.
//
// The signature is computed over the RAW request body (see
// server/lib/razorpay.js verifyWebhookSignature), so tests send a raw JSON
// string and sign exactly those bytes.
const crypto = require('crypto');
const { checkoutBody, makeTestApp, variantOf } = require('./helpers');

const WEBHOOK_SECRET = 'whsec_test_ammamma_gadhi';
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

let api;
let products;
let teardown;

beforeAll(async () => {
  ({ api, products, teardown } = await makeTestApp());
});

afterAll(async () => {
  await teardown();
});

function sign(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function paymentPayload(razorpayOrderId, paymentId, event = 'payment.captured') {
  return {
    event,
    payload: { payment: { entity: { order_id: razorpayOrderId, id: paymentId } } },
  };
}

// NOTE: NOT async — it must return the supertest request object itself,
// so callers can chain .expect(200) on it. An async helper would return
// a Promise, and .expect would not exist on it.
function sendWebhook(payload, signature) {
  const raw = JSON.stringify(payload);
  let req = api
    .post('/api/webhooks/razorpay')
    .set('Content-Type', 'application/json');
  if (signature !== undefined) req = req.set('x-razorpay-signature', signature);
  return req.send(raw);
}

// Create a fresh PENDING_PAYMENT order and return its Razorpay order id.
async function createPendingOrder(variantName, size, phone) {
  const v = variantOf(products, variantName, size);
  const res = await api
    .post('/api/orders')
    .send(checkoutBody([{ variant_id: v.id, qty: 1 }], { payment_method: 'razorpay', phone }))
    .expect(201);
  expect(res.body.status).toBe('PENDING_PAYMENT');
  return { order: res.body, razorpayOrderId: res.body.razorpay_order.id };
}

describe('webhook signature verification', () => {
  test('a correctly signed payment.captured marks the order PAID', async () => {
    const { order, razorpayOrderId } = await createPendingOrder(
      'Avakaya Mango Pickle', '250g', '9000020001',
    );
    const payload = paymentPayload(razorpayOrderId, 'pay_test_ok_001');
    const res = await sendWebhook(payload, sign(JSON.stringify(payload))).expect(200);
    expect(res.body.received).toBe(true);
    expect(res.body.status).toBe('PAID');

    const fresh = await api.get(`/api/orders/${order.id}`).expect(200);
    expect(fresh.body.status).toBe('PAID');
    expect(fresh.body.razorpay_payment_id).toBe('pay_test_ok_001');
  });

  test('a bad signature is rejected with 401 and the order stays unpaid', async () => {
    const { order, razorpayOrderId } = await createPendingOrder(
      'Lemon Pickle', '250g', '9000020002',
    );
    const payload = paymentPayload(razorpayOrderId, 'pay_test_bad_001');
    await sendWebhook(payload, 'deadbeef-not-a-real-signature').expect(401);

    const fresh = await api.get(`/api/orders/${order.id}`).expect(200);
    expect(fresh.body.status).toBe('PENDING_PAYMENT');
    expect(fresh.body.razorpay_payment_id).toBeNull();
  });

  test('a missing signature is rejected with 401', async () => {
    const { order, razorpayOrderId } = await createPendingOrder(
      'Tomato Pickle', '250g', '9000020003',
    );
    const payload = paymentPayload(razorpayOrderId, 'pay_test_nosig_001');
    await sendWebhook(payload, undefined).expect(401);

    const fresh = await api.get(`/api/orders/${order.id}`).expect(200);
    expect(fresh.body.status).toBe('PENDING_PAYMENT');
  });

  test('a signature made with the wrong secret is rejected', async () => {
    const { order, razorpayOrderId } = await createPendingOrder(
      'Gongura Pickle', '250g', '9000020004',
    );
    const payload = paymentPayload(razorpayOrderId, 'pay_test_wrong_001');
    const wrongSig = crypto
      .createHmac('sha256', 'a-different-secret')
      .update(JSON.stringify(payload))
      .digest('hex');
    await sendWebhook(payload, wrongSig).expect(401);

    const fresh = await api.get(`/api/orders/${order.id}`).expect(200);
    expect(fresh.body.status).toBe('PENDING_PAYMENT');
  });
});

describe('webhook idempotency and payload handling', () => {
  test('the same webhook delivered twice is safe — one effect only', async () => {
    const { order, razorpayOrderId } = await createPendingOrder(
      'Garlic Pickle', '250g', '9000020005',
    );
    const payload = paymentPayload(razorpayOrderId, 'pay_test_dup_001');
    const raw = JSON.stringify(payload);

    const first = await sendWebhook(payload, sign(raw)).expect(200);
    expect(first.body.status).toBe('PAID');
    const second = await sendWebhook(payload, sign(raw)).expect(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.order_id).toBe(order.id);

    const fresh = await api.get(`/api/orders/${order.id}`).expect(200);
    expect(fresh.body.status).toBe('PAID');
    expect(fresh.body.razorpay_payment_id).toBe('pay_test_dup_001');
  });

  test('a webhook for an unknown Razorpay order id is a 404', async () => {
    const payload = paymentPayload('order_mock_does_not_exist', 'pay_test_404_001');
    const res = await sendWebhook(payload, sign(JSON.stringify(payload))).expect(404);
    expect(res.body.error).toMatch(/No order/);
  });

  test('a webhook missing the payment/order ids is a 400', async () => {
    const payload = { event: 'payment.captured', payload: { payment: { entity: {} } } };
    await sendWebhook(payload, sign(JSON.stringify(payload))).expect(400);
  });

  test('a non-payment event is acknowledged but ignored', async () => {
    const { order, razorpayOrderId } = await createPendingOrder(
      'Mixed Veg Pickle', '250g', '9000020006',
    );
    const payload = paymentPayload(razorpayOrderId, 'pay_test_ignored_001', 'payment.failed');
    const res = await sendWebhook(payload, sign(JSON.stringify(payload))).expect(200);
    expect(res.body.received).toBe(true);
    expect(res.body.ignored_event).toBe('payment.failed');

    const fresh = await api.get(`/api/orders/${order.id}`).expect(200);
    expect(fresh.body.status).toBe('PENDING_PAYMENT');
  });

  test('payment.authorized is accepted like payment.captured', async () => {
    const { order, razorpayOrderId } = await createPendingOrder(
      'Red Chilli Pickle', '250g', '9000020007',
    );
    const payload = paymentPayload(razorpayOrderId, 'pay_test_auth_001', 'payment.authorized');
    const res = await sendWebhook(payload, sign(JSON.stringify(payload))).expect(200);
    expect(res.body.status).toBe('PAID');

    const fresh = await api.get(`/api/orders/${order.id}`).expect(200);
    expect(fresh.body.status).toBe('PAID');
  });
});
