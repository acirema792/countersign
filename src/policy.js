// Countersign policy engine.
// The model PROPOSES tool calls. This file DECIDES. No model output is consulted here:
// every verdict is a deterministic function of (tool, arguments, the books, the email).
//
// Verdicts:
//   ALLOW - runs now, in the PayPal sandbox
//   HOLD  - queued; runs only if the owner countersigns
//   BLOCK - never runs (the owner must fix the books first, e.g. verify a vendor by phone)
import {
  round2, sameMoney, normEmail, senderAddress,
  findOrderByCapture, findOrderByNumber, customerById, customerByEmail, vendorByEmail, catalogItem
} from './state.js';

export const MONEY_OUT_TOOLS = new Set(['create_refund', 'pay_vendor']);
export const MONEY_TOOLS = new Set(['create_refund', 'pay_vendor', 'create_invoice', 'send_invoice']);

const RANK = { ALLOW: 0, HOLD: 1, BLOCK: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// ---------- Untrusted-content scanner (deterministic) ----------
const INJECTION_PATTERNS = [
  /\b(system|admin|developer)\s*(notice|message|prompt|override)\b/i,
  /\bto (the )?ai (assistant|agent)\b/i,
  /\bignore (all |any )?(previous|prior|above) (instructions|rules|guidelines)\b/i,
  /\byou are (now )?(authori[sz]ed|permitted|allowed) (by|to)\b/i,
  /\bdo not (mention|reveal|tell)\b/i
];

export function scanEmail(email) {
  const findings = [];
  if (email.hidden && String(email.hidden).trim()) {
    findings.push({ kind: 'hidden-text', detail: 'Text hidden in the email HTML (invisible to a human reader).', excerpt: String(email.hidden).slice(0, 160) });
  }
  const all = `${email.subject || ''}\n${email.body || ''}\n${email.hidden || ''}`;
  for (const re of INJECTION_PATTERNS) {
    const m = all.match(re);
    if (m) findings.push({ kind: 'instruction-to-agent', detail: 'Text that addresses the AI agent directly.', excerpt: m[0] });
  }
  if (/[​-‏⁠﻿]/.test(all)) {
    findings.push({ kind: 'zero-width', detail: 'Zero-width characters present.', excerpt: '' });
  }
  return { suspicious: findings.length > 0, findings };
}

// ---------- Provenance ----------
// Is this value present in the TRUSTED books? Otherwise, did it come only from the email?
function moneyInText(text, amount) {
  const v = Number(amount);
  if (!Number.isFinite(v)) return false;
  const forms = new Set([v.toFixed(2), String(v), v.toLocaleString('en-US', { minimumFractionDigits: 2 })]);
  return [...forms].some((f) => String(text).includes(f));
}

function provenance(field, value, trustedMatch, emailText) {
  if (trustedMatch) return { field, value, source: 'books', note: trustedMatch };
  const inEmail = typeof value === 'number' ? moneyInText(emailText, value) : String(emailText).toLowerCase().includes(String(value).toLowerCase());
  return { field, value, source: inEmail ? 'email-only' : 'unknown', note: inEmail ? 'appears only in the untrusted email' : 'not found in the books' };
}

function emailText(email) {
  return `${email.from || ''}\n${email.subject || ''}\n${email.body || ''}\n${email.hidden || ''}`;
}

// ---------- Rule helpers ----------
function rule(id, verdict, ok, msg) {
  return { id, verdict: ok ? 'ALLOW' : verdict, ok, msg };
}

function budgetRule(state, amount) {
  const p = state.world.policy;
  const after = round2(state.ledger.autoOutflow + amount);
  return rule('DAILY_BUDGET', 'HOLD', after <= p.daily_auto_outflow_budget,
    `Automatic outflows today would be $${after.toFixed(2)} of a $${p.daily_auto_outflow_budget} budget.`);
}

function injectionRule(scan) {
  return rule('UNTRUSTED_INSTRUCTIONS', 'HOLD', !scan.suspicious,
    scan.suspicious
      ? `The email contains ${scan.findings.map((f) => f.kind).join(', ')}; money actions from it need the owner.`
      : 'No hidden text or instructions aimed at the agent.');
}

// A sender only counts as who the From line says if the message authenticated (SPF/DKIM
// aligned). Seeded emails carry auth: 'pass'; anything typed into "Write your own" does not.
export function senderAuthenticated(email) {
  return email && email.auth === 'pass';
}

const clip = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

// ---------- Tool evaluators ----------
// Each evaluator returns { rules, prov, money, exec }. `exec` is the ONLY payload that is
// ever sent to PayPal: it is rebuilt from the books, never forwarded from the model's args.
function evalRefund(args, ctx) {
  const { state, email, scan } = ctx;
  const rules = [];
  const prov = [];
  const order = findOrderByCapture(state, args.capture_id);
  if (!order) {
    rules.push(rule('CAPTURE_IN_BOOKS', 'BLOCK', false, `Capture ${args.capture_id || '(none)'} does not belong to any order in the books.`));
    return { rules, prov, money: { direction: 'out', amount: Number(args?.amount?.value) || 0 } };
  }
  const remaining = round2(order.paypal.captured - order.refunded);
  const amount = args.amount && args.amount.value != null ? round2(args.amount.value) : remaining;
  const ctxInfo = { order_number: order.order_number, amount };
  const currency = String(args.amount?.currency_code || 'USD').toUpperCase();
  rules.push(rule('CURRENCY_USD', 'BLOCK', currency === 'USD', currency === 'USD' ? 'Refund currency is USD, the capture currency.' : `Refund currency ${currency} does not match the capture currency (USD).`));

  rules.push(rule('CAPTURE_IN_BOOKS', 'BLOCK', true, `Capture belongs to order #${order.order_number} ($${order.total.toFixed(2)}).`));
  rules.push(rule('REFUND_WITHIN_CAPTURE', 'BLOCK', amount > 0 && amount <= remaining + 0.004,
    amount <= remaining + 0.004
      ? `$${amount.toFixed(2)} is within the $${remaining.toFixed(2)} still refundable on #${order.order_number}.`
      : `$${amount.toFixed(2)} exceeds the $${remaining.toFixed(2)} still refundable on #${order.order_number} (paid $${order.paypal.captured.toFixed(2)}, already refunded $${order.refunded.toFixed(2)}).`));

  // Provenance of the amount: must equal a figure in the order (total, a line, a unit price, or the remaining balance)
  const figures = [{ v: order.total, n: 'order total' }, { v: remaining, n: 'remaining refundable balance' }];
  for (const it of order.items) {
    figures.push({ v: it.unit, n: `unit price of ${it.sku}` });
    figures.push({ v: round2(it.unit * it.qty), n: `line total of ${it.qty} x ${it.sku}` });
  }
  const hit = figures.find((f) => sameMoney(f.v, amount));
  const p = provenance('amount', amount, hit && `matches the ${hit.n} of #${order.order_number}`, emailText(email));
  prov.push(p);
  rules.push(rule('AMOUNT_FROM_BOOKS', 'HOLD', !!hit, hit ? `Amount matches the ${hit.n}.` : `Amount $${amount.toFixed(2)} matches no figure on order #${order.order_number} (${p.note}).`));

  const cust = customerById(state, order.customer_id);
  const sender = senderAddress(email.from);
  const sameAddress = cust && normEmail(cust.email) === sender;
  const isCustomer = sameAddress && senderAuthenticated(email);
  prov.push({ field: 'requester', value: sender, source: isCustomer ? 'books' : 'email-only', note: isCustomer ? `authenticated sender is the customer on #${order.order_number}` : sameAddress ? 'the From line matches, but the message is not authenticated (could be spoofed)' : `customer on #${order.order_number} is ${cust ? cust.email : 'unknown'}` });
  rules.push(rule('REQUESTER_IS_CUSTOMER', 'HOLD', !!isCustomer, isCustomer ? 'The request comes from the customer who placed the order (sender authenticated).' : sameAddress ? 'The From line names the customer, but the email is not authenticated, so it could be spoofed.' : `The sender is not the customer on order #${order.order_number}.`));

  // Count earlier refunds too, so two partial refunds can't add up to an unreturned full refund.
  const fullRefund = sameMoney(round2(order.refunded + amount), order.total);
  const delivered = order.status === 'delivered';
  rules.push(rule('RETURN_BEFORE_FULL_REFUND', 'HOLD', !(fullRefund && delivered),
    fullRefund && delivered ? `A full refund of a delivered order (#${order.order_number})${order.refunded > 0 ? `, counting $${order.refunded.toFixed(2)} already refunded,` : ''} needs the owner: no return is recorded.` : delivered ? 'Partial refund of a delivered order.' : `Order #${order.order_number} has not shipped.`));

  const lim = state.world.policy.auto_refund_limit;
  rules.push(rule('AUTO_REFUND_LIMIT', 'HOLD', amount <= lim, `Refund $${amount.toFixed(2)} vs automatic limit $${lim}.`));
  rules.push(budgetRule(state, amount));
  rules.push(injectionRule(scan));
  const exec = { capture_id: order.paypal.capture_id, amount: { currency_code: 'USD', value: amount.toFixed(2) }, note_to_payer: clip(args.note_to_payer || `Refund for order #${order.order_number}`, 200) };
  return { rules, prov, money: { direction: 'out', amount, ...ctxInfo }, exec };
}

function claimsToBeVendor(state, email) {
  const t = `${email.from} ${email.subject} ${email.body}`.toLowerCase();
  return state.world.vendors.find((v) => t.includes(v.name.toLowerCase()) || t.includes(v.name.toLowerCase().split(' ')[0])) || null;
}

export function paymentDetailChange(state, email) {
  const vendor = claimsToBeVendor(state, email);
  if (!vendor) return null;
  const text = `${email.body || ''}\n${email.hidden || ''}`;
  const addrs = [...new Set((text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(normEmail))];
  const others = addrs.filter((a) => a !== normEmail(vendor.paypal_email) && !state.world.customers.some((c) => normEmail(c.email) === a));
  return others.length ? { vendor, addresses: others } : null;
}

function evalPayVendor(args, ctx) {
  const { state, email, scan } = ctx;
  const rules = [];
  const prov = [];
  const rawPayee = String(args.payee_email || '').trim();
  const payee = normEmail(rawPayee);
  const amount = round2(args.amount);
  const asciiOk = /^[\x21-\x7e]+@[\x21-\x7e]+$/.test(rawPayee);
  const vendor = asciiOk ? vendorByEmail(state, payee) : null;
  const claimed = claimsToBeVendor(state, email);
  if (!asciiOk) rules.push(rule('PAYEE_PLAIN_ASCII', 'BLOCK', false, `Payee "${clip(rawPayee, 80)}" contains non-ASCII or look-alike characters.`));
  if (!(amount > 0)) rules.push(rule('AMOUNT_POSITIVE', 'BLOCK', false, 'Payment amount must be positive.'));

  prov.push(provenance('payee', payee, vendor && `PayPal address on file for ${vendor.name}`, emailText(email)));
  if (!vendor && claimed) {
    rules.push(rule('PAYEE_MATCHES_VENDOR_ON_FILE', 'BLOCK', false,
      `The email claims to be ${claimed.name}, but ${payee} is not their PayPal on file (${claimed.paypal_email}). Payment-detail changes by email are the classic invoice-fraud pattern: verify by phone on file (${claimed.phone_on_file}) and update the vendor record first.`));
  } else {
    rules.push(rule('PAYEE_ON_FILE', 'HOLD', !!vendor, vendor ? `${payee} is the PayPal on file for ${vendor.name}.` : `${payee} is not a vendor on file.`));
  }

  // Bill matching
  const bills = state.world.open_bills.filter((b) => vendor && b.vendor_id === vendor.id);
  const bill = args.bill_id ? state.world.open_bills.find((b) => b.bill_id === String(args.bill_id).trim().toUpperCase()) : bills.find((b) => sameMoney(b.amount, amount) && b.status === 'open');
  if (bill && bill.status === 'paid') {
    rules.push(rule('NOT_ALREADY_PAID', 'BLOCK', false, `Bill ${bill.bill_id} is already marked paid in the books: this would be a duplicate payment.`));
  } else if (bill && vendor && bill.vendor_id === vendor.id) {
    rules.push(rule('MATCHES_OPEN_BILL', 'HOLD', sameMoney(bill.amount, amount), sameMoney(bill.amount, amount) ? `Matches open bill ${bill.bill_id} ($${bill.amount.toFixed(2)}).` : `Bill ${bill.bill_id} is $${bill.amount.toFixed(2)}, not $${amount.toFixed(2)}.`));
  } else {
    const owner = bill && state.world.vendors.find((v) => v.id === bill.vendor_id);
    rules.push(rule('MATCHES_OPEN_BILL', 'HOLD', false, bill ? `Bill ${bill.bill_id} is owed to ${owner ? `${owner.name} at ${owner.paypal_email}` : 'another vendor'}, not to ${payee}.` : 'No open bill in the books matches this payee and amount.'));
  }
  const billHit = bill && bill.status === 'open' && vendor && bill.vendor_id === vendor.id && sameMoney(bill.amount, amount);
  prov.push(provenance('amount', amount, billHit && `open bill ${bill.bill_id}`, emailText(email)));

  // An email that claims to be a known vendor but names a different payment address is a
  // payment-detail-change attempt. Even a payment to the address on file should not be
  // triggered automatically by it: the owner should see the email first.
  const change = paymentDetailChange(state, email);
  rules.push(rule('NO_PAYEE_CHANGE_IN_EMAIL', 'HOLD', !change,
    change ? `This email asks to pay ${change.vendor.name} at ${change.addresses.join(', ')}, not the address on file (${change.vendor.paypal_email}). Payments it triggers need the owner.` : 'The email does not try to change any vendor\'s payment details.'));

  const lim = state.world.policy.auto_vendor_payment_limit;
  rules.push(rule('AUTO_PAYMENT_LIMIT', 'HOLD', amount <= lim, `Payment $${amount.toFixed(2)} vs automatic limit $${lim}.`));
  rules.push(budgetRule(state, amount));
  rules.push(injectionRule(scan));
  const bill_id = bill ? bill.bill_id : null;
  // Pay the address on file (never the model's spelling of it); the bill reference comes from the books.
  const exec = { payee_email: vendor ? vendor.paypal_email : payee, amount, bill_id, memo: bill_id ? `Payment of bill ${bill_id}` : 'Supplier payment' };
  return { rules, prov, money: { direction: 'out', amount, payee: exec.payee_email, bill_id }, exec };
}

export function invoiceSummary(state, args) {
  const list = (x) => (Array.isArray(x) ? x : []);
  const recs = list(args.primary_recipients).map((r) => normEmail(r?.billing_info?.email_address || r?.email_address || ''));
  const items = list(args.items).map((it) => (it && typeof it === 'object' ? it : {})).map((it) => ({
    name: String(it.name || ''), qty: Number(it.quantity ?? 1), unit: Number(it.unit_amount?.value ?? it.unit_amount ?? 0),
    extras: ['discount', 'tax'].filter((k) => it[k] != null)
  }));
  const amount = round2(items.reduce((s, it) => s + it.qty * it.unit, 0) + Number(args.shipping_cost || 0));
  return { recipient: recs[0] || '', recipients: recs, items, amount };
}

function evalCreateInvoice(args, ctx) {
  const { state, email, scan } = ctx;
  const rules = [];
  const prov = [];
  const inv = invoiceSummary(state, args);
  const cust = customerByEmail(state, inv.recipient);
  prov.push(provenance('recipient', inv.recipient, cust && `customer ${cust.id} on file`, emailText(email)));
  rules.push(rule('RECIPIENT_IS_CUSTOMER', 'HOLD', !!cust, cust ? `${inv.recipient} is customer ${cust.name}.` : `${inv.recipient || '(no recipient)'} is not a customer on file.`));
  rules.push(rule('SINGLE_RECIPIENT', 'HOLD', inv.recipients.length === 1, inv.recipients.length === 1 ? 'One recipient.' : `${inv.recipients.length} recipients: ${inv.recipients.join(', ')}.`));
  const requesterOk = cust && senderAddress(email.from) === normEmail(cust.email) && senderAuthenticated(email);
  rules.push(rule('REQUESTER_IS_RECIPIENT', 'HOLD', !!requesterOk, requesterOk ? 'The customer asked for this invoice (sender authenticated).' : 'The invoice was not requested by its (authenticated) recipient.'));

  // Non-standard terms the model might be talked into. They are never sent; flagging them makes the owner look.
  const odd = [];
  const cur = String(args.currency_code || 'USD').toUpperCase();
  if (cur !== 'USD') odd.push(`currency ${cur}`);
  if (Number(args.shipping_cost || 0) !== 0) odd.push(`shipping ${args.shipping_cost}`);
  if (args.allow_partial_payment || args.minimum_partial_payment_amount != null) odd.push('partial payment');
  if (args.allow_tip) odd.push('tips');
  for (const it of inv.items) { if (it.extras.length) odd.push(`${it.extras.join('/')} on "${clip(it.name, 40)}"`); if (!(Number.isInteger(it.qty) && it.qty >= 1 && it.qty <= 1000)) odd.push(`quantity ${it.qty} on "${clip(it.name, 40)}"`); }
  rules.push(rule('STANDARD_TERMS', 'HOLD', odd.length === 0, odd.length ? `Non-standard terms requested: ${odd.join('; ')}. Countersign only ever sends USD, catalog prices, whole quantities, no discounts.` : 'USD, whole quantities, no discounts, no partial payment.'));

  const priceKey = cust && cust.type === 'wholesale' ? 'wholesale' : 'retail';
  let pricesOk = inv.items.length > 0;
  const notes = [];
  const lines = [];
  for (const it of inv.items) {
    const c = catalogItem(state, it.name);
    const ok = c && sameMoney(c[priceKey], it.unit);
    if (!ok) pricesOk = false;
    notes.push(c ? `${it.qty} x ${c.name} @ $${it.unit.toFixed(2)} (${priceKey} list $${c[priceKey].toFixed(2)})` : `${clip(it.name, 60)}: not in catalog`);
    if (c) lines.push({ name: c.name, quantity: String(Math.max(1, Math.min(1000, Math.floor(Math.abs(it.qty) || 1)))), unit_amount: { currency_code: 'USD', value: c[priceKey].toFixed(2) } });
  }
  prov.push({ field: 'amount', value: inv.amount, source: pricesOk ? 'books' : 'email-only', note: pricesOk ? `${priceKey} prices from the catalog` : 'prices do not match the catalog' });
  rules.push(rule('PRICES_FROM_CATALOG', 'HOLD', pricesOk, notes.join('; ') || 'No line items.'));
  rules.push(injectionRule(scan));

  const execAmount = round2(lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_amount.value), 0));
  const exec = {
    currency_code: 'USD',
    invoicer_business_name: state.world.business.name,
    primary_recipients: [{ billing_info: { email_address: cust ? cust.email : inv.recipient, ...(cust && cust.type === 'wholesale' ? { business_name: cust.name } : {}) } }],
    items: lines,
    note: `Thank you for your order from ${state.world.business.name}.`
  };
  return { rules, prov, money: { direction: 'in', amount: execAmount, recipient: cust ? cust.email : inv.recipient }, exec };
}

function evalSendInvoice(args, ctx) {
  // Own keys only: an id like "toString" must not resolve to an Object.prototype member.
  const inv = Object.hasOwn(ctx.state.invoices, String(args.invoice_id)) ? ctx.state.invoices[args.invoice_id] : null;
  const rules = [rule('INVOICE_DRAFT_APPROVED', 'BLOCK', !!inv && !inv.baseline, inv && !inv.baseline ? `Draft ${args.invoice_id} passed checks when it was created ($${inv.amount.toFixed(2)} to ${inv.recipient}).` : `Invoice ${args.invoice_id} was not created through Countersign.`)];
  if (inv) rules.push(rule('NOT_ALREADY_SENT', 'BLOCK', inv.status === 'draft', inv.status === 'draft' ? 'Not sent yet.' : `Invoice ${args.invoice_id} is already ${inv.status}.`));
  if (inv && Array.isArray(args.additional_recipients) && args.additional_recipients.length) {
    rules.push(rule('NO_EXTRA_RECIPIENTS', 'HOLD', false, `Adds recipients not on the draft: ${args.additional_recipients.map((x) => clip(x, 60)).join(', ')}`));
  }
  return { rules, prov: [], money: { direction: 'in', amount: inv ? inv.amount : 0, recipient: inv ? inv.recipient : '' }, exec: { invoice_id: args.invoice_id } };
}

// ---------- Entry point ----------
export function evaluate(tool, args, ctx) {
  const policy = ctx.state.world.policy;
  if (!policy.allowed_tools.includes(tool)) {
    return { verdict: 'BLOCK', rules: [rule('TOOL_ALLOWED', 'BLOCK', false, `Tool ${tool} is not on the owner's allowlist.`)], provenance: [], money: null };
  }
  let r;
  switch (tool) {
    case 'create_refund': r = evalRefund(args || {}, ctx); break;
    case 'pay_vendor': r = evalPayVendor(args || {}, ctx); break;
    case 'create_invoice': r = evalCreateInvoice(args || {}, ctx); break;
    case 'send_invoice': r = evalSendInvoice(args || {}, ctx); break;
    default:
      return { verdict: 'ALLOW', rules: [rule('READ_ONLY', 'ALLOW', true, 'Read-only or communication tool.')], provenance: [], money: null };
  }
  const verdict = r.rules.reduce((acc, x) => worst(acc, x.verdict), 'ALLOW');
  return { verdict, rules: r.rules, provenance: r.prov, money: r.money, exec: r.exec };
}

// Reserve a money action in the books BEFORE calling PayPal (synchronously, right after the
// verdict), so a second concurrent run or approval sees the bill as paid / the refund as
// taken / the budget as used. Returns an undo function for definitive PayPal failures.
export function reserve(tool, decision, state, { auto = true } = {}) {
  const m = decision.money || {};
  const undo = [];
  if (tool === 'create_refund') {
    const o = findOrderByNumber(state, m.order_number);
    if (o) { o.refunded = round2(o.refunded + m.amount); undo.push(() => { o.refunded = round2(o.refunded - m.amount); }); }
  }
  if (tool === 'pay_vendor' && m.bill_id) {
    const b = state.world.open_bills.find((x) => x.bill_id === m.bill_id);
    if (b && b.status === 'open') { b.status = 'paid'; undo.push(() => { b.status = 'open'; }); }
  }
  if (tool === 'send_invoice') {
    const inv = state.invoices[decision.exec?.invoice_id];
    if (inv) { const prev = inv.status; inv.status = 'sent'; undo.push(() => { inv.status = prev; }); }
  }
  if (auto && MONEY_OUT_TOOLS.has(tool)) {
    const amt = m.amount || 0;
    state.ledger.autoOutflow = round2(state.ledger.autoOutflow + amt);
    undo.push(() => { state.ledger.autoOutflow = round2(state.ledger.autoOutflow - amt); });
  }
  return () => undo.reverse().forEach((f) => f());
}

// Record results that only exist after PayPal answers (the new invoice id).
export function recordResult(tool, decision, state, result = {}) {
  if (tool === 'create_invoice' && result.invoice_id) {
    state.invoices[result.invoice_id] = { recipient: decision.money.recipient, amount: decision.money.amount, status: 'draft' };
  }
}
