// Shared test setup for Ammamma Gadhi.
//
// Every test file gets a FRESH app backed by a FRESH temp SQLite file, so
// tests never see each other's orders or stock changes. The app is built
// with createApp({ dbPath }) — the same entry point as the real server —
// so tests exercise the real routes, the real DB layer and the real
// pricing/validation code, not mocks of them.
//
// Razorpay runs in MOCK mode in tests: any real keys are removed from the
// environment before the app is built, so createOrder() returns a fake
// `order_mock_*` id and no network call is made.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

async function makeTestApp() {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ammamma-gadhi-test-'));
  const dbPath = path.join(dir, 'test.db');
  // Require inside the function so each test file gets its own module
  // instance (db.js keeps module-level state for the SQLite handle).
  const { createApp } = require('../server/app');
  const { app, db, close } = await createApp({ dbPath });
  const api = request(app);
  const catalog = await api.get('/api/products').expect(200);

  async function teardown() {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { api, app, db, close, teardown, products: catalog.body.products };
}

// Find a variant from a GET /api/products response.
function variantOf(products, name, sizeLabel) {
  const product = products.find((p) => p.name === name);
  if (!product) throw new Error(`no product named ${name}`);
  const variant = product.variants.find((v) => v.size_label === sizeLabel);
  if (!variant) throw new Error(`no ${sizeLabel} variant for ${name}`);
  return variant;
}

// Read the current stock of one variant straight from the catalogue API.
async function stockOf(api, products, name, sizeLabel) {
  const fresh = await api.get('/api/products').expect(200);
  return variantOf(fresh.body.products, name, sizeLabel).stock;
}

// A valid checkout body. Override any field (phone, items, ...) per test.
function checkoutBody(items, overrides = {}) {
  return {
    customer_name: 'Test Customer',
    phone: '9849012345',
    address: '12-3-456, Street 4, Hyderabad, Telangana',
    pincode: '500001',
    delivery_slot: 'tomorrow-morning',
    payment_method: 'cod',
    items,
    ...overrides,
  };
}

module.exports = { checkoutBody, makeTestApp, stockOf, variantOf };
