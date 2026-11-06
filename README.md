# Ammamma Gadhi 🥒

A complete, end-to-end pickle ordering app for a new Indian pickles business — built to learn how a real application fits together.

Customers browse 12 pickles (Avakaya, Gongura, Lemon, Tomato, Garlic, …) in 250g / 500g / 1kg sizes, add them to a cart, check out with UPI / card via Razorpay or Cash on Delivery, and track their order by ID or phone number. The seller sees orders land live and moves them through packing and delivery.

**Stack:** Node.js + Express API · vanilla JS frontend (no build step) · SQLite for local dev / Postgres in production · Razorpay + COD · Jest + Supertest tests · Nginx load balancer + Docker Compose.

> This is a learning project. The checkout in the demo records the payment method but charges no real money until Razorpay keys are configured — see [PAYMENTS.md](PAYMENTS.md).

## Quick start (local dev)

```bash
npm install
npm start
# Open http://localhost:3000
```

The first run creates `data/pickles.db` (SQLite) and seeds the 12 pickles from `data/seed.json`. Prices are in INR, GST is 5%, delivery is free on orders of ₹499+ and ₹49 below that.

Try it:

1. Add **Avakaya Mango Pickle 500g** to the cart.
2. Check out as a test customer — phone `9849012345`, pincode `500001`.
3. Pay with **Cash on Delivery** (order becomes `CONFIRMED` immediately) or **Razorpay / UPI** (order stays `PENDING_PAYMENT` in mock mode until a webhook confirms it — see [PAYMENTS.md](PAYMENTS.md)).
4. Track it with the order ID or phone number on the same page.

## Run the tests

```bash
npm test
```

65 tests covering the catalogue, pricing, checkout validation, order creation, stock, the oversell race, idempotency, the Razorpay webhook, cancel, and the fulfilment state machine. Details in [TESTING.md](TESTING.md).

## Run the production-like stack (Docker)

Two API replicas behind an Nginx load balancer, backed by Postgres:

```bash
docker compose up --build
curl http://localhost/health   # -> {"ok":true,"status":"ok"}
```

Open http://localhost in a browser. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the load balancing and concurrency guards work.

## Project structure

```
ammamma-gadhi/
├── client/                 # Vanilla JS storefront (no build step)
│   ├── index.html          # Catalogue, cart drawer, checkout, tracking
│   ├── app.js              # Fetch products, cart in localStorage, checkout
│   └── styles.css
├── server/
│   ├── app.js              # All routes: products, cart, orders, webhook
│   ├── index.js            # Entry point: `npm start`
│   ├── db.js               # SQLite (dev) / Postgres (prod), one interface
│   ├── seed.js             # `npm run seed` — rebuild the DB from seed.json
│   └── lib/
│       ├── pricing.js      # GST 5%, free delivery >= Rs 499, else Rs 49
│       ├── validate.js     # Indian phone / pincode / checkout validation
│       └── razorpay.js     # Razorpay orders + webhook signature check
├── data/seed.json          # 12 pickles x 3 sizes, prices + stock
├── tests/                  # Jest + Supertest (see TESTING.md)
├── nginx/nginx.conf        # least_conn load balancer for api1 + api2
├── Dockerfile
├── docker-compose.yml      # nginx + 2 APIs + Postgres + one-shot seed
├── ARCHITECTURE.md         # How it all fits together
├── TESTING.md              # Test list + how to run them
└── PAYMENTS.md             # Razorpay test mode, webhooks, going live
```

## API at a glance

| Method | Route | What it does |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/api/products` | Catalogue with variants + stock |
| POST | `/api/cart/validate` | Server-side prices + stock check (read-only) |
| POST | `/api/orders` | Create order (send `Idempotency-Key` header) |
| GET | `/api/orders/:id` | One order with its items |
| GET | `/api/orders?phone=&status=` | List orders (admin — add auth before prod!) |
| POST | `/api/orders/:id/cancel` | Cancel + restore stock |
| POST | `/api/orders/:id/status` | Advance fulfilment status |
| POST | `/api/webhooks/razorpay` | Razorpay webhook (HMAC-verified) |

Order flow: `PENDING_PAYMENT` → `PAID` → `CONFIRMED` → `SHIPPED` → `DELIVERED` (or `CANCELLED`). COD orders start at `CONFIRMED`.

## Configuration

Copy `.env.example` to `.env`. Local dev works with everything blank (SQLite + mock Razorpay). See the comments in `.env.example` and [PAYMENTS.md](PAYMENTS.md).

| Variable | Purpose |
| --- | --- |
| `PORT` | API port (default `3000`) |
| `DATABASE_URL` | Set to use Postgres; blank = local SQLite (`DB_PATH`) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay test/live keys (blank = mock mode) |
| `RAZORPAY_WEBHOOK_SECRET` | Secret used to verify webhook signatures |

## Before going live

- [ ] Add auth to `GET /api/orders` and the status endpoint (today anyone can list orders).
- [ ] Set real Razorpay **test** keys, test a payment end to end, then switch to **live** keys — [PAYMENTS.md](PAYMENTS.md).
- [ ] Use a managed Postgres (not the compose `db` container) and back it up.
- [ ] Point a domain at the server and terminate HTTPS at Nginx / the cloud load balancer.
- [ ] Add the real pickle photos, business name, address, and delivery areas.
