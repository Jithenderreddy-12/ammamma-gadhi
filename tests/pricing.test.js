// Unit tests for server/lib/pricing.js — the money math.
//
// Rules (from pricing.js): GST 5% on food, free delivery on subtotal
// >= Rs 499 (49900 paise), otherwise Rs 49 (4900 paise). All money is
// integer paise, so there is no floating-point rounding surprise.
const { calculateTotals, formatINR } = require('../server/lib/pricing');

describe('calculateTotals', () => {
  test('single 250g Avakaya (Rs 149) — GST 5% + Rs 49 delivery', () => {
    const t = calculateTotals([{ unit_price_paise: 14900, qty: 1 }]);
    expect(t.subtotalPaise).toBe(14900);
    expect(t.gstPaise).toBe(745); // 14900 * 0.05
    expect(t.deliveryFeePaise).toBe(4900);
    expect(t.totalPaise).toBe(14900 + 745 + 4900);
  });

  test('1kg Avakaya (Rs 529) — free delivery above the Rs 499 threshold', () => {
    const t = calculateTotals([{ unit_price_paise: 52900, qty: 1 }]);
    expect(t.subtotalPaise).toBe(52900);
    expect(t.gstPaise).toBe(2645);
    expect(t.deliveryFeePaise).toBe(0);
    expect(t.totalPaise).toBe(52900 + 2645);
  });

  test('exactly Rs 499 subtotal gets free delivery (threshold is inclusive)', () => {
    const t = calculateTotals([{ unit_price_paise: 49900, qty: 1 }]);
    expect(t.deliveryFeePaise).toBe(0);
  });

  test('Rs 498 subtotal still pays delivery', () => {
    const t = calculateTotals([{ unit_price_paise: 49800, qty: 1 }]);
    expect(t.deliveryFeePaise).toBe(4900);
  });

  test('multiple lines sum, quantities multiply', () => {
    const t = calculateTotals([
      { unit_price_paise: 14900, qty: 2 }, // 29800
      { unit_price_paise: 12900, qty: 1 }, // 12900
    ]);
    expect(t.subtotalPaise).toBe(42700);
    expect(t.gstPaise).toBe(2135); // 42700 * 0.05
    expect(t.deliveryFeePaise).toBe(4900);
    expect(t.totalPaise).toBe(42700 + 2135 + 4900);
  });

  test('empty cart totals zero with no delivery fee', () => {
    const t = calculateTotals([]);
    expect(t).toEqual({
      deliveryFeePaise: 0,
      gstPaise: 0,
      subtotalPaise: 0,
      totalPaise: 0,
    });
  });

  test('GST rounds to the nearest paise (no fractions of a paise)', () => {
    // 199 * 0.05 = 9.95 -> 10
    const t = calculateTotals([{ unit_price_paise: 199, qty: 1 }]);
    expect(t.gstPaise).toBe(10);
    expect(Number.isInteger(t.totalPaise)).toBe(true);
  });
});

describe('formatINR', () => {
  test('formats paise as rupees with 2 decimals', () => {
    expect(formatINR(14900)).toBe('₹149.00');
    expect(formatINR(20545)).toBe('₹205.45');
    expect(formatINR(0)).toBe('₹0.00');
  });
});
