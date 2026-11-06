// Razorpay integration.
//
// TEST MODE is the default: with no keys in .env, createOrder() returns a
// fake `order_mock_*` id and no network call is made, so the full checkout
// flow works locally. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET to use the
// real test-mode API (see PAYMENTS.md).
// NEVER trust the browser's claim that payment succeeded. Only the webhook
// (verified by HMAC signature, see verifyWebhookSignature) may flip an
// order to PAID. See server/app.js POST /api/webhooks/razorpay.
const crypto = require('crypto');

function isConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function createOrder(amountPaise, receipt) {
  if (!isConfigured()) {
    // Mock mode — clearly labelled, never mistaken for a real payment.
    return {
      amount: amountPaise,
      currency: 'INR',
      id: `order_mock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      mock: true,
      receipt,
    };
  }
  // Real Razorpay SDK call (test keys -> test mode, live keys -> live).
  const Razorpay = require('razorpay');
  const rzp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  return rzp.orders.create({ amount: amountPaise, currency: 'INR', receipt });
}

// Razorpay signs the *raw* webhook body: HMAC-SHA256(secret, rawBody),
// hex-encoded, sent as the `x-razorpay-signature` header.
// The app must verify against the RAW bytes, not a re-serialised JSON
// object — that is why the webhook route uses express.raw().
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // timingSafeEqual prevents timing attacks; buffers must be same length.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createOrder, isConfigured, verifyWebhookSignature };
