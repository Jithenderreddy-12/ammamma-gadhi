// Pricing — all money is integer paise (1 rupee = 100 paise) so there is
// never a floating-point rounding surprise. Display with formatINR().
// Rules (see ARCHITECTURE.md): GST 5% on food, free delivery >= Rs 499,
// otherwise Rs 49 delivery. Change the constants here, not in routes.
const GST_RATE = 0.05;
const FREE_DELIVERY_THRESHOLD_PAISE = 49900; // Rs 499
const DELIVERY_FEE_PAISE = 4900; // Rs 49

function calculateTotals(items) {
  // items: [{ unit_price_paise, qty }]
  const subtotalPaise = items.reduce(
    (sum, it) => sum + it.unit_price_paise * it.qty,
    0,
  );
  const gstPaise = Math.round(subtotalPaise * GST_RATE);
  const deliveryFeePaise =
    subtotalPaise === 0
      ? 0
      : subtotalPaise >= FREE_DELIVERY_THRESHOLD_PAISE
        ? 0
        : DELIVERY_FEE_PAISE;
  return {
    deliveryFeePaise,
    gstPaise,
    subtotalPaise,
    totalPaise: subtotalPaise + gstPaise + deliveryFeePaise,
  };
}

function formatINR(paise) {
  return `₹${(paise / 100).toFixed(2)}`;
}

module.exports = {
  DELIVERY_FEE_PAISE,
  FREE_DELIVERY_THRESHOLD_PAISE,
  GST_RATE,
  calculateTotals,
  formatINR,
};
