# Testing — Ammamma Gadhi

## How to run

```bash
npm install
npm test                 # all tests, one file at a time (--runInBand)
npx jest tests/orders.test.js        # a single file
npx jest -t "oversell race"         # a single test by name
```

Every test file builds a **fresh app on a fresh temp SQLite database** (see `tests/helpers.js`), seeded from `data/seed.json`. Tests never touch `data/pickles.db` and never touch each other — each file gets its own database, and tests that mutate stock use different variants where it matters.

Razorpay runs in **mock mode** in tests (real keys are stripped from the environment), so no network calls and no real money. The webhook tests set `RAZORPAY_WEBHOOK_SECRET` to a test value and sign payloads themselves.

## Test list

| File | What it proves |
| --- | --- |
| `tests/pricing.test.js` | GST 5% math, free delivery at exactly ₹499 (inclusive) vs ₹49 below it, multi-line sums, empty cart = ₹0, GST rounds to whole paise |
| `tests/products.test.js` | `/health` answers ok; catalogue has 12 pickles × 3 sizes with prices/stock; Avakaya prices match the seed (₹149/₹279/₹529); unknown order is 404 |
| `tests/cart.test.js` | `POST /api/cart/validate` prices from the DB (Avakaya 250g → ₹149 + ₹7.45 GST + ₹49 delivery = ₹205.45); free delivery over ₹499; empty cart / unknown variant → 400; qty above stock → 409 with availability reported; validation has no side effects |
| `tests/orders.test.js` | Every validation failure is a 400 (bad phone, bad pincode, short address, missing name, empty items, qty 0 / 11, bad payment method, bad slot); COD creates a `CONFIRMED` order with server totals and decrements stock; phone is normalised (`+91 98490 12345` → `9849012345`); duplicate variant lines merge; ordering above stock → 409 with stock unchanged; Razorpay/UPI create `PENDING_PAYMENT` orders with a mock `order_mock_*` id; lookup by id and by phone; status filter; cancel restores stock, double-cancel → 409, cancelling a shipped order → 409; state machine `CONFIRMED → SHIPPED → DELIVERED`, skipping a step → 409, unpaid order can't jump to `CONFIRMED` |
| `tests/concurrency.test.js` | **Oversell race:** two concurrent orders for the last unit — exactly one 201 and one 409, stock ends at 0, never negative; **idempotency:** same key retried returns the same order id with stock cut once; different keys make different orders; no key means no dedup |
| `tests/webhook.test.js` | Correctly signed `payment.captured` marks the order `PAID`; bad / missing / wrong-secret signatures → 401 and the order stays `PENDING_PAYMENT`; the same webhook twice is safe (`duplicate: true`); unknown Razorpay order → 404; missing ids → 400; `payment.failed` is acknowledged but ignored; `payment.authorized` is accepted |

## The race test, in detail

`tests/concurrency.test.js` sets one variant's stock to 1, then fires two `POST /api/orders` at the same time with `Promise.all`. The guard under test is the conditional UPDATE inside a transaction in `server/app.js`:

```sql
UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?
```

One UPDATE matches 1 row; the other matches 0 and throws `409 Insufficient stock`. The test asserts the status pair is exactly `[201, 409]`, final stock is `0`, and only one order exists across both customers. If you ever change the stock logic, this test is the one that must still pass.

## What is NOT covered by automated tests

- **Real Razorpay network calls.** Mock mode covers the flow; a real test-mode payment is a manual step — see [PAYMENTS.md](PAYMENTS.md).
- **The browser UI.** Click through it manually: search, size buttons, cart drawer, checkout, tracking. Checklist:
  - [ ] Search "gongura" filters the catalogue
  - [ ] Out-of-stock sizes are disabled
  - [ ] Cart totals match the server (subtotal + 5% GST + delivery)
  - [ ] Checkout with a bad phone shows the error inline
  - [ ] COD order shows a confirmation with the order ID
  - [ ] Tracking by phone lists the order
- **Load balancing under real traffic.** `docker compose up`, then `curl http://localhost/api/products` repeatedly while stopping one replica (`docker compose stop api1`) — requests should keep succeeding via `api2`.
- **Postgres.** The suite runs on SQLite (same SQL interface, `?` placeholders translated by `server/db.js`). Before relying on Postgres in production, run `docker compose up` and place a real order through Nginx to prove the Postgres path end to end.
