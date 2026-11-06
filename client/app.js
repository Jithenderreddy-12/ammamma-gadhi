// Vanilla JS storefront — no build step, no framework.
// Flow: load products -> render catalogue -> cart in localStorage ->
// POST /api/orders with an Idempotency-Key -> confirmation + tracking.
// Prices are ALWAYS taken from the server response, never typed in here.
const inr = (paise) => `₹${(paise / 100).toFixed(2)}`;
const $ = (s) => document.querySelector(s);
let PRODUCTS = [];
let cart = JSON.parse(localStorage.getItem('pickle-cart') || '[]'); // [{variant_id, qty}]
let selectedSize = {}; // productId -> variantId

function saveCart() { localStorage.setItem('pickle-cart', JSON.stringify(cart)); renderCartCount(); }
function cartQty() { return cart.reduce((n, i) => n + i.qty, 0); }
function renderCartCount() { $('#cartCount').textContent = cartQty(); }
function variantById(id) { for (const p of PRODUCTS) { const v = p.variants.find((x) => x.id === id); if (v) return { ...v, product: p }; } return null; }

async function loadProducts() {
  const res = await fetch('/api/products');
  const data = await res.json();
  PRODUCTS = data.products || [];
  for (const p of PRODUCTS) selectedSize[p.id] = p.variants[0]?.id;
  renderCatalog();
}

function filteredProducts() {
  const q = ($('#search').value || '').toLowerCase();
  const spice = $('#spiceFilter').value;
  return PRODUCTS.filter((p) =>
    (!spice || p.spice_level === spice) &&
    (!q || (p.name + ' ' + p.description).toLowerCase().includes(q)));
}

function renderCatalog() {
  const list = filteredProducts();
  $('#catalog').innerHTML = list.length ? '' : '<p>No pickles match that search.</p>';
  for (const p of list) {
    const v = p.variants.find((x) => x.id === selectedSize[p.id]) || p.variants[0];
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <div class="emoji">${p.image_emoji}</div>
      <h3>${p.name}</h3>
      <p>${p.description}</p>
      <div><span class="badge ${p.spice_level}">${p.spice_level === 'hot' ? '🌶️ Hot' : p.spice_level === 'medium' ? 'Medium' : 'Mild'}</span>
      <span class="badge">Veg</span></div>
      <div class="size-row">${p.variants.map((x) => `<button data-vid="${x.id}" class="${x.id === v.id ? 'sel' : ''}" ${x.stock <= 0 ? 'disabled' : ''}>${x.size_label} • ${inr(x.price_paise)}</button>`).join('')}</div>
      <div class="price">${inr(v.price_paise)} <span class="stock">${v.stock > 0 ? `${v.stock} in stock` : 'Out of stock'}</span></div>
      <button class="btn primary" ${v.stock <= 0 ? 'disabled' : ''}>Add to Cart</button>`;
    card.querySelectorAll('.size-row button').forEach((b) => b.onclick = () => { selectedSize[p.id] = Number(b.dataset.vid); renderCatalog(); });
    card.querySelector('.btn.primary').onclick = () => {
      const line = cart.find((i) => i.variant_id === v.id);
      if (line) line.qty = Math.min(line.qty + 1, 10); else cart.push({ variant_id: v.id, qty: 1 });
      saveCart(); renderCart();
    };
    $('#catalog').appendChild(card);
  }
}

async function renderCart() {
  const box = $('#cartItems');
  if (!cart.length) { box.innerHTML = '<p>Your cart is empty. Add a pickle!</p>'; $('#cartTotals').innerHTML = ''; return; }
  // Ask the server for authoritative prices + totals (never trust local math).
  const res = await fetch('/api/cart/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: cart }) });
  const data = await res.json();
  if (!res.ok) { box.innerHTML = `<p class="error">${data.error || 'Cart could not be validated.'}</p>`; return; }
  box.innerHTML = data.items.map((it) => `
    <div class="cart-line"><div><b>${it.product_name}</b><br><small>${it.size_label} • ${inr(it.unit_price_paise)}</small></div>
    <div class="qty"><button data-dec="${it.variant_id}">−</button><span>${it.qty}</span><button data-inc="${it.variant_id}">+</button></div>
    <div>${inr(it.line_total_paise)}</div></div>`).join('');
  box.querySelectorAll('[data-inc]').forEach((b) => b.onclick = () => { cart.find((i) => i.variant_id === Number(b.dataset.inc)).qty++; saveCart(); renderCart(); });
  box.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => {
    const line = cart.find((i) => i.variant_id === Number(b.dataset.dec));
    line.qty--; if (line.qty <= 0) cart = cart.filter((i) => i !== line);
    saveCart(); renderCart();
  });
  const t = data.totals;
  $('#cartTotals').innerHTML = `<div>Subtotal: ${inr(t.subtotalPaise)}</div><div>GST (5%): ${inr(t.gstPaise)}</div><div>Delivery: ${t.deliveryFeePaise ? inr(t.deliveryFeePaise) : 'FREE'}</div><div class="grand">Total: ${inr(t.totalPaise)}</div>`;
}

$('#checkoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#checkoutError'); err.textContent = '';
  if (!cart.length) { err.textContent = 'Your cart is empty.'; return; }
  const fd = new FormData(e.target);
  const body = { customer_name: fd.get('customer_name'), phone: fd.get('phone'), address: fd.get('address'), pincode: fd.get('pincode'), delivery_slot: fd.get('delivery_slot'), payment_method: fd.get('payment_method'), items: cart };
  // Idempotency-Key: if the user double-clicks or the network retries, the
  // server returns the SAME order instead of creating a second one.
  const key = crypto.randomUUID();
  const res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { err.textContent = (data.details || [data.error]).join(' • '); return; }
  cart = []; saveCart(); renderCart();
  $('#cartDrawer').hidden = true;
  showOrder(data);
});

function showOrder(order) {
  $('#orderModal').hidden = false;
  $('#orderResult').innerHTML = `
    <h2>✅ Order placed!</h2>
    <p>Order ID: <b>#${order.id}</b> • Status: <span class="status">${order.status}</span></p>
    <p>Total: <b>${inr(order.total_paise)}</b> • Payment: ${order.payment_method === 'cod' ? 'Cash on Delivery' : 'Razorpay / UPI'}</p>
    ${order.payment_method !== 'cod' && order.razorpay_order ? `<p>Razorpay order: <code>${order.razorpay_order.id}</code>${order.razorpay_order.mock ? ' (test/mock — no real charge)' : ''}. In production the Razorpay Checkout popup opens here and the webhook confirms payment.</p>` : ''}
    <p>Delivery slot: ${order.delivery_slot} • ${order.address}, ${order.pincode}</p>
    <p>Save your order ID <b>#${order.id}</b> to track it.</p>`;
}

async function track() {
  const id = $('#trackId').value.trim();
  const phone = $('#trackPhone').value.trim();
  const out = $('#trackResult');
  let res;
  if (id) res = await fetch(`/api/orders/${encodeURIComponent(id)}`);
  else if (phone) res = await fetch(`/api/orders?phone=${encodeURIComponent(phone)}`);
  else { out.textContent = 'Enter an order ID or a phone number.'; return; }
  const data = await res.json();
  if (!res.ok) { out.textContent = data.error || 'Order not found.'; return; }
  const orders = data.orders || [data];
  out.innerHTML = orders.map((o) => `<p><b>#${o.id}</b> • <span class="status">${o.status}</span> • ${inr(o.total_paise)} • ${o.delivery_slot}<br><small>${o.customer_name} • ${o.address}, ${o.pincode}</small></p>`).join('') || 'No orders found.';
}

$('#cartBtn').onclick = () => { $('#cartDrawer').hidden = false; renderCart(); };
$('#closeCart').onclick = () => { $('#cartDrawer').hidden = true; };
$('#trackBtn').onclick = () => { $('#orderModal').hidden = false; };
$('#closeOrder').onclick = () => { $('#orderModal').hidden = true; };
$('#doTrack').onclick = track;
$('#search').addEventListener('input', renderCatalog);
$('#spiceFilter').addEventListener('change', renderCatalog);
loadProducts(); renderCartCount();
