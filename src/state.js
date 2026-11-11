// Business state ("the books") for one run or one demo session.
// Everything in here is TRUSTED: it comes from the owner's own records or from PayPal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(here, '..', 'data');

export function loadWorld() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'world.json'), 'utf8'));
}

export function loadCases() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cases.json'), 'utf8'));
}

export const round2 = (n) => Math.round(Number(n) * 100) / 100;
export const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
export const normEmail = (s) => String(s || '').trim().toLowerCase();

// Build a fresh, mutable copy of the books. `captures` maps order_number -> PayPal capture info.
export function createState(world, captures = {}) {
  const w = structuredClone(world);
  for (const o of w.orders) {
    const c = captures[o.order_number] || {};
    o.paypal = {
      order_id: c.order_id || null,
      capture_id: c.capture_id || null,
      captured: c.amount != null ? round2(c.amount) : o.total,
      mode: c.mode || 'unseeded'
    };
    o.refunded = 0;
  }
  return {
    world: w,
    autoOutflowToday: 0,
    invoices: {}, // invoice_id -> { recipient, amount, items, status }
    paidBills: [],
    log: []
  };
}

export function findOrderByNumber(state, num) {
  const n = String(num || '').replace(/[^0-9]/g, '');
  return state.world.orders.find((o) => o.order_number === n) || null;
}

export function findOrderByCapture(state, captureId) {
  return state.world.orders.find((o) => o.paypal.capture_id && o.paypal.capture_id === captureId) || null;
}

export function customerById(state, id) {
  return state.world.customers.find((c) => c.id === id) || null;
}

export function customerByEmail(state, email) {
  return state.world.customers.find((c) => normEmail(c.email) === normEmail(email)) || null;
}

export function vendorByEmail(state, email) {
  return state.world.vendors.find((v) => normEmail(v.paypal_email) === normEmail(email)) || null;
}

const STOP = new Set(['candle', 'candles', 'oz', 'the', 'and', 'of', 'set', 'mini', 'x']);
const keyTokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w));

export function catalogItem(state, nameOrSku) {
  const q = String(nameOrSku || '').toLowerCase();
  if (!q) return null;
  const bySku = state.world.catalog.find((c) => q.includes(c.sku.toLowerCase()));
  if (bySku) return bySku;
  const qt = new Set(keyTokens(q));
  // Every distinctive word of the product name (before the size) must appear in the query.
  const tokensOf = (c) => keyTokens(c.name.split(',')[0]);
  const all = state.world.catalog.filter((c) => tokensOf(c).every((w) => qt.has(w)));
  if (all.length === 1) return all[0];
  // Fallback: exactly one product shares a distinctive word with the query ("Fig", "Pine candle").
  const some = state.world.catalog.filter((c) => tokensOf(c).some((w) => qt.has(w)));
  return some.length === 1 ? some[0] : null;
}

// Parse "Name <addr@x>" -> addr
export function senderAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return normEmail(m ? m[1] : from);
}
