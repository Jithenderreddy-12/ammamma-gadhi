// Catalogue + health tests — GET /health and GET /api/products.
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

describe('health', () => {
  test('GET /health returns ok', async () => {
    const res = await api.get('/health').expect(200);
    expect(res.body).toEqual({ ok: true, status: 'ok' });
  });
});

describe('GET /api/products', () => {
  test('returns the 12 seeded pickles', async () => {
    const res = await api.get('/api/products').expect(200);
    expect(res.body.products).toHaveLength(12);
    const names = res.body.products.map((p) => p.name);
    expect(names).toContain('Avakaya Mango Pickle');
    expect(names).toContain('Gongura Pickle');
    expect(names).toContain('Lemon Pickle');
  });

  test('every product has 3 size variants with prices and stock', async () => {
    const res = await api.get('/api/products').expect(200);
    for (const p of res.body.products) {
      expect(p.variants).toHaveLength(3);
      expect(p.variants.map((v) => v.size_label).sort()).toEqual([
        '1kg',
        '250g',
        '500g',
      ]);
      for (const v of p.variants) {
        expect(v.price_paise).toBeGreaterThan(0);
        expect(Number.isInteger(v.price_paise)).toBe(true);
        expect(v.stock).toBeGreaterThan(0);
      }
    }
  });

  test('Avakaya prices match the seed data (250g Rs 149 / 500g Rs 279 / 1kg Rs 529)', async () => {
    expect(variantOf(products, 'Avakaya Mango Pickle', '250g').price_paise).toBe(14900);
    expect(variantOf(products, 'Avakaya Mango Pickle', '500g').price_paise).toBe(27900);
    expect(variantOf(products, 'Avakaya Mango Pickle', '1kg').price_paise).toBe(52900);
  });

  test('veg is a boolean and spice_level is one of mild/medium/hot', async () => {
    const res = await api.get('/api/products').expect(200);
    for (const p of res.body.products) {
      expect(typeof p.veg).toBe('boolean');
      expect(['mild', 'medium', 'hot']).toContain(p.spice_level);
    }
  });
});

describe('unknown order', () => {
  test('GET /api/orders/999999 returns 404', async () => {
    await api.get('/api/orders/999999').expect(404);
  });
});
