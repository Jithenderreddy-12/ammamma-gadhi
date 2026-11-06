# Payments — Ammamma Gadhi

How money works in this app: Razorpay for UPI / cards / netbanking, Cash on Delivery as the offline fallback, and a strict rule — **only a verified Razorpay webhook may mark an order PAID**.

## The payment flow

```
1. Customer checks out (payment_method = razorpay or upi)
2. Server creates a Razorpay order FIRST (server/lib/razorpay.js)
   — amount in paise, currency INR, receipt "pickles_<timestamp>"
3. Server creates the app order as PENDING_PAYMENT and reserves stock
4. Customer pays in Razorpay Checkout (UPI / card / netbanking)
5. Razorpay calls POST /api/webhooks/razorpay with payment.captured
6. Server verifies the HMAC-SHA256 signature, then marks the order PAID
7. Seller moves it CONFIRMED -> SHIPPED -> DELIVERED
```

COD skips steps 2, 4, 5, 6: the order is created as `CONFIRMED` immediately and the customer pays the delivery person.

## Mock mode (default — what you get with no keys)

With `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` blank, `createOrder()` returns a fake order (`order_mock_*`, `mock: true`) and makes **no network call**. The full checkout flow works locally and in tests, and the storefront labels it "(test/mock — no real charge)". This is the mode the app runs in until you configure keys.

## Razorpay test mode (recommended next step)

Test mode uses real Razorpay APIs but **no real money moves**. Do this before going live:

1. Create an account at https://dashboard.razorpay.com and switch it to **Test Mode**.
2. Go to **Settings → API Keys → Generate Test Key**. Copy the Key ID (`rzp_test_...`) and Key Secret.
3. Go to **Settings → Webhooks → Add New Webhook**:
   - **Webhook URL:** your public URL + `/api/webhooks/razorpay` (for local testing, expose your machine with `ngrok http 3000` and use the ngrok URL — Razorpay cannot reach `localhost`).
   - **Active events:** tick `payment.captured` and `payment.authorized`.
   - **Secret:** generate one and copy it — this is `RAZORPAY_WEBHOOK_SECRET`.
4. Put all three values in `.env` (copy `.env.example` first — never commit `.env`):
   ```
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   RAZORPAY_WEBHOOK_SECRET=...
   ```
5. Restart the server (`npm start`) and place a test order with payment method **Razorpay / UPI**. The server log will show `Razorpay: configured`.
6. Pay with a Razorpay test card (e.g. `4111 1111 1111 1111`, any future expiry, any CVV) or test UPI (`success@razorpay`).
7. Check the order: it should flip from `PENDING_PAYMENT` to `PAID`. In the Razorpay dashboard, **Developers → Webhooks** should show the delivery as `200`.

## How the webhook is verified

Razorpay signs the **raw** request body: `HMAC-SHA256(webhook_secret, raw_body)`, hex-encoded, sent as the `x-razorpay-signature` header. The server (`server/lib/razorpay.js` → `verifyWebhookSignature`) recomputes it with a timing-safe comparison.

That is why the webhook route in `server/app.js` is registered **before** `express.json()` and uses `express.raw()`: parsing the JSON first and re-serialising it would change the bytes and break the signature.

The server also defends against duplicate deliveries: each `razorpay_payment_id` is recorded in `processed_payments`, and a second delivery of the same payment returns `{ duplicate: true }` with no second effect. Events other than `payment.captured` / `payment.authorized` are acknowledged but ignored. These behaviours are all covered in `tests/webhook.test.js`.

## Going live checklist

- [ ] Test-mode payment works end to end (order flips to `PAID`, webhook shows `200`).
- [ ] In the Razorpay dashboard, switch to **Live Mode** and generate **live** keys (`rzp_live_...`) — they are different keys, not the test ones.
- [ ] Create a **separate live webhook** with a new secret, and update `.env` (or your hosting provider's environment variables — never put live secrets in the repo).
- [ ] Do one small real payment (e.g. ₹10) with your own card/UPI and refund it from the dashboard, to prove the live path.
- [ ] Check Razorpay's settlement cycle and fees for your account (fees are per transaction; UPI is typically cheaper than cards).
- [ ] Keep COD if your friend's customers expect it — many pickle buyers in India do.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Order stays `PENDING_PAYMENT` after paying | Webhook never arrived or failed verification. Check Razorpay dashboard → Webhooks for the delivery status; check the server log; confirm `RAZORPAY_WEBHOOK_SECRET` matches the secret for that webhook (test vs live secrets differ). |
| Webhook returns `401` | Signature mismatch — wrong secret, or a proxy re-wrote the body. Nginx must proxy the raw body untouched (it does by default). |
| Webhook returns `404` | No order has that `razorpay_order_id` — e.g. the order was created against test keys but the webhook came from live, or vice versa. |
| `Razorpay: MOCK mode` in the log | Keys aren't loaded — check `.env` is in the project root and the server was restarted after editing it. |
| Payment succeeds but stock wasn't reserved | Stock is reserved at order creation, before payment — if the order is `PENDING_PAYMENT`, stock is already down. If a payment fails and the customer abandons it, cancel the order (or add an expiry job) to release the stock. |
