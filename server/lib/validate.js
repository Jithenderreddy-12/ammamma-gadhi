// Input validation — the server re-checks EVERYTHING the browser sends.
// Never trust the client: prices come from the DB, not the request body.
const PHONE_RE = /^[6-9]\d{9}$/; // Indian mobile, 10 digits, starts 6-9
const PINCODE_RE = /^[1-9]\d{5}$/; // 6 digits, first digit != 0
const DELIVERY_SLOTS = ['today-evening', 'tomorrow-morning', 'tomorrow-evening', 'weekend'];

function normalisePhone(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\s-]/g, '').replace(/^\+91/, '').replace(/^91(?=\d{10}$)/, '');
}

function isValidPhone(raw) {
  return PHONE_RE.test(normalisePhone(raw));
}

function isValidPincode(raw) {
  return typeof raw === 'string' && PINCODE_RE.test(raw.trim());
}

function validateCheckout(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Request body must be a JSON object'];
  if (!body.customer_name || String(body.customer_name).trim().length < 2)
    errors.push('customer_name is required (at least 2 characters)');
  if (!isValidPhone(body.phone)) errors.push('phone must be a valid 10-digit Indian mobile number');
  if (!body.address || String(body.address).trim().length < 10)
    errors.push('address is required (at least 10 characters)');
  if (!isValidPincode(body.pincode)) errors.push('pincode must be a valid 6-digit Indian pincode');
  if (body.delivery_slot && !DELIVERY_SLOTS.includes(body.delivery_slot))
    errors.push(`delivery_slot must be one of: ${DELIVERY_SLOTS.join(', ')}`);
  if (!['cod', 'razorpay', 'upi'].includes(body.payment_method))
    errors.push("payment_method must be 'cod', 'razorpay' or 'upi'");
  if (!Array.isArray(body.items) || body.items.length === 0)
    errors.push('items must be a non-empty array');
  else {
    for (const [i, it] of body.items.entries()) {
      if (!Number.isInteger(it.variant_id) || it.variant_id <= 0)
        errors.push(`items[${i}].variant_id must be a positive integer`);
      if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 10)
        errors.push(`items[${i}].qty must be an integer between 1 and 10`);
    }
  }
  return errors;
}

module.exports = { DELIVERY_SLOTS, isValidPhone, isValidPincode, normalisePhone, validateCheckout };
