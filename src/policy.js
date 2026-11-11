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
  const after = round2(state.autoOutflowToday + amount);
  return rule('DAILY_BUDGET', 'HOLD', after <= p.daily_auto_outflow_budget,
    `Automatic outflows today would be $${after.toFixed(2)} of a $${p.daily_auto_outflow_budget} budget.`);
}

function injectionRule(scan) {
  return rule('UNTRUSTED_INSTRUCTIONS', 'HOLD', !scan.suspicious,
    scan.suspicious
      ? `The email contains ${scan.findings.map((f) => f.kind).join(', ')}; money actions from it need the owner.`
      : 'No hidden text or instructions aimed at the agent.');
}

// ---------- Tool evaluators ----------
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
  const isCustomer = cust && normEmail(cust.email) === sender;
  prov.push({ field: 'requester', value: sender, source: isCustomer ? 'books' : 'email-only', note: isCustomer ? `sender is the customer on #${order.order_number}` : `customer on #${order.order_number} is ${cust ? cust.email : 'unknown'}` });
  rules.push(rule('REQUESTER_IS_CUSTOMER', 'HOLD', !!isCustomer, isCustomer ? 'The request comes from the customer who placed the order.' : `The sender is not the customer on order #${order.order_number}.`));

  const lim = state.world.policy.auto_refund_limit;
  rules.push(rule('AUTO_REFUND_LIMIT', 'HOLD', amount <= lim, `Refund $${amount.toFixed(2)} vs automatic limit $${lim}.`));
  rules.push(budgetRule(state, amount));
  rules.push(injectionRule(scan));
  return { rules, prov, money: { direction: 'out', amount, ...ctxInfo } };
}

function claimsToBeVendor(state, email) {
  const t = `${email.from} ${email.subject} ${email.body}`.toLowerCase();
  return state.world.vendors.find((v) => t.includes(v.name.toLowerCase()) || t.includes(v.name.toLowerCase().split(' ')[0])) || null;
}

function evalPayVendor(args, ctx) {
  const { state, email, scan } = ctx;
  const rules = [];
  const prov = [];
  const payee = normEmail(args.payee_email);
  const amount = round2(args.amount);
  const vendor = vendorByEmail(state, payee);
  const claimed = claimsToBeVendor(state, email);

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

  const lim = state.world.policy.auto_vendor_payment_limit;
  rules.push(rule('AUTO_PAYMENT_LIMIT', 'HOLD', amount <= lim, `Payment $${amount.toFixed(2)} vs automatic limit $${lim}.`));
  rules.push(budgetRule(state, amount));
  rules.push(injectionRule(scan));
  return { rules, prov, money: { direction: 'out', amount, payee, bill_id: bill ? bill.bill_id : null } };
}

export function invoiceSummary(state, args) {
  const rec = args.primary_recipients?.[0]?.billing_info?.email_address || args.primary_recipients?.[0]?.email_address || '';
  const items = (args.items || []).map((it) => ({
    name: it.name, qty: Number(it.quantity || 1), unit: Number(it.unit_amount?.value ?? it.unit_amount ?? 0)
  }));
  const amount = round2(items.reduce((s, it) => s + it.qty * it.unit, 0) + Number(args.shipping_cost || 0));
  return { recipient: normEmail(rec), items, amount };
}

function evalCreateInvoice(args, ctx) {
  const { state, email, scan } = ctx;
  const rules = [];
  const prov = [];
  const inv = invoiceSummary(state, args);
  const cust = customerByEmail(state, inv.recipient);
  prov.push(provenance('recipient', inv.recipient, cust && `customer ${cust.id} on file`, emailText(email)));
  rules.push(rule('RECIPIENT_IS_CUSTOMER', 'HOLD', !!cust, cust ? `${inv.recipient} is customer ${cust.name}.` : `${inv.recipient || '(no recipient)'} is not a customer on file.`));
  const priceKey = cust && cust.type === 'wholesale' ? 'wholesale' : 'retail';
  let pricesOk = inv.items.length > 0;
  const notes = [];
  for (const it of inv.items) {
    const c = catalogItem(state, it.name);
    const ok = c && sameMoney(c[priceKey], it.unit);
    if (!ok) pricesOk = false;
    notes.push(c ? `${it.qty} x ${c.name} @ $${it.unit.toFixed(2)} (${priceKey} list $${c[priceKey].toFixed(2)})` : `${it.name}: not in catalog`);
  }
  prov.push({ field: 'amount', value: inv.amount, source: pricesOk ? 'books' : 'email-only', note: pricesOk ? `${priceKey} prices from the catalog` : 'prices do not match the catalog' });
  rules.push(rule('PRICES_FROM_CATALOG', 'HOLD', pricesOk, notes.join('; ') || 'No line items.'));
  rules.push(injectionRule(scan));
  return { rules, prov, money: { direction: 'in', amount: inv.amount, recipient: inv.recipient } };
}

function evalSendInvoice(args, ctx) {
  const inv = ctx.state.invoices[args.invoice_id];
  const rules = [rule('INVOICE_DRAFT_APPROVED', 'BLOCK', !!inv, inv ? `Draft ${args.invoice_id} passed checks when it was created ($${inv.amount.toFixed(2)} to ${inv.recipient}).` : `Invoice ${args.invoice_id} was not created through Countersign.`)];
  if (inv && args.additional_recipients?.length) {
    rules.push(rule('NO_EXTRA_RECIPIENTS', 'HOLD', false, `Adds recipients not on the draft: ${args.additional_recipients.join(', ')}`));
  }
  return { rules, prov: [], money: { direction: 'in', amount: inv ? inv.amount : 0, recipient: inv ? inv.recipient : '' } };
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
  return { verdict, rules: r.rules, provenance: r.prov, money: r.money };
}

// Apply bookkeeping once a money action actually executes.
export function commit(tool, args, decision, state, result = {}) {
  const m = decision.money || {};
  if (tool === 'create_refund') {
    const o = findOrderByNumber(state, m.order_number);
    if (o) o.refunded = round2(o.refunded + m.amount);
  }
  if (tool === 'pay_vendor' && m.bill_id) {
    const b = state.world.open_bills.find((x) => x.bill_id === m.bill_id);
    if (b) b.status = 'paid';
  }
  if (tool === 'create_invoice' && result.invoice_id) {
    const s = invoiceSummary(state, args);
    state.invoices[result.invoice_id] = { ...s, status: 'draft' };
  }
  if (tool === 'send_invoice' && state.invoices[args.invoice_id]) {
    state.invoices[args.invoice_id].status = 'sent';
  }
}
