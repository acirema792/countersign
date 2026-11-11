// PayPal layer.
//  - Agent-facing PayPal tools come from PayPal's official Agent Toolkit (@paypal/agent-toolkit).
//  - Vendor payments use the PayPal Payouts REST API (the toolkit has no payouts tool).
//  - Demo orders are created and captured in the sandbox at boot so refunds hit real captures.
// MODE:
//   sandbox - real calls to api-m.sandbox.paypal.com (needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)
//   mock    - offline stand-in used by the test suite; every result is labelled "mock"
import crypto from 'node:crypto';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';

export const TOOLKIT_TOOLS = ['get_order', 'create_refund', 'create_invoice', 'send_invoice'];
const BASE = 'https://api-m.sandbox.paypal.com';

export function makePayPal(env = process.env) {
  const id = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  if (id && secret && env.PAYPAL_MODE !== 'mock') return new SandboxPayPal(id, secret);
  return new MockPayPal();
}

// JSON schemas for the toolkit tools, straight from the toolkit (no credentials needed to read them).
export function toolkitSchemas() {
  const tk = new PayPalAgentToolkit({
    clientId: 'schema-only', clientSecret: 'schema-only',
    configuration: { actions: { orders: { get: true }, payments: { createRefund: true }, invoices: { create: true, send: true } }, context: { sandbox: true } }
  });
  return tk.getTools().filter((t) => TOOLKIT_TOOLS.includes(t.function.name));
}

class SandboxPayPal {
  constructor(id, secret) {
    this.mode = 'sandbox';
    this.id = id;
    this.secret = secret;
    this.toolkit = new PayPalAgentToolkit({
      clientId: id, clientSecret: secret,
      configuration: { actions: { orders: { get: true }, payments: { createRefund: true }, invoices: { create: true, send: true } }, context: { sandbox: true } }
    });
    this._tok = null;
  }

  async token() {
    if (this._tok && this._tok.exp > Date.now() + 60_000) return this._tok.v;
    const r = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.id}:${this.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`PayPal auth failed: ${j.error_description || r.status}`);
    this._tok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return this._tok.v;
  }

  async rest(method, p, body, extraHeaders = {}) {
    const r = await fetch(`${BASE}${p}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID(), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
    if (!r.ok) {
      const msg = j.details?.[0]?.description || j.message || j.error_description || r.statusText;
      const e = new Error(`PayPal ${method} ${p} -> ${r.status}: ${msg}`);
      e.status = r.status; e.body = j; throw e;
    }
    return j;
  }

  // Create and immediately capture a sandbox order paid by a PayPal test card.
  async seedCapture(order, business) {
    const res = await this.rest('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: `MM-${order.order_number}`,
        invoice_id: `MM-${order.order_number}-${Date.now()}`,
        description: `${business.name} order #${order.order_number}`,
        amount: { currency_code: 'USD', value: order.total.toFixed(2) }
      }],
      payment_source: { card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: 'Demo Customer', billing_address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } } }
    }, { Prefer: 'return=representation' });
    const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
    if (!cap || cap.status !== 'COMPLETED') throw new Error(`Seed capture for #${order.order_number} not completed (status ${cap?.status || res.status})`);
    return { order_id: res.id, capture_id: cap.id, amount: Number(cap.amount.value), mode: 'sandbox' };
  }

  async callToolkit(name, args) {
    const out = await this.toolkit.handleToolCall({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } });
    let parsed; try { parsed = JSON.parse(out.content); } catch { parsed = { raw: out.content }; }
    if (parsed && (parsed.error || parsed.name === 'UNPROCESSABLE_ENTITY' || parsed.name === 'INVALID_REQUEST' || /error/i.test(parsed.raw || ''))) {
      const e = new Error(`PayPal ${name} failed: ${JSON.stringify(parsed).slice(0, 300)}`); e.body = parsed; throw e;
    }
    return parsed;
  }

  async payout({ payee_email, amount, memo }) {
    const res = await this.rest('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: `cs-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, email_subject: 'Payment from Maple & Moss Candle Co.' },
      items: [{ recipient_type: 'EMAIL', receiver: payee_email, amount: { value: Number(amount).toFixed(2), currency: 'USD' }, note: memo || 'Supplier payment' }]
    });
    return { payout_batch_id: res.batch_header?.payout_batch_id, status: res.batch_header?.batch_status };
  }

  async execute(tool, args) {
    if (tool === 'pay_vendor') return this.payout(args);
    if (tool === 'create_invoice') {
      const r = await this.callToolkit('create_invoice', args);
      const id = r.id || (r.href && r.href.split('/').pop()) || r.links?.[0]?.href?.split('/').pop();
      return { invoice_id: id, status: r.status || 'DRAFT', raw: r };
    }
    if (tool === 'send_invoice') {
      const r = await this.callToolkit('send_invoice', { ...args, send_to_recipient: true });
      return { invoice_id: args.invoice_id, status: 'SENT', raw: r };
    }
    if (tool === 'create_refund') {
      const r = await this.callToolkit('create_refund', args);
      return { refund_id: r.id, status: r.status, raw: r };
    }
    if (tool === 'get_order') return this.callToolkit('get_order', args);
    throw new Error(`No PayPal executor for ${tool}`);
  }
}

class MockPayPal {
  constructor() { this.mode = 'mock'; this.n = 0; }
  id(prefix) { this.n += 1; return `${prefix}${String(Date.now()).slice(-8)}${String(this.n).padStart(6, '0')}`; }
  async seedCapture(order) {
    return { order_id: this.id('MOCKORD'), capture_id: this.id('MOCKCAP'), amount: order.total, mode: 'mock' };
  }
  async execute(tool, args) {
    if (tool === 'pay_vendor') return { payout_batch_id: this.id('MOCKPAYOUT'), status: 'SUCCESS', mock: true };
    if (tool === 'create_invoice') return { invoice_id: this.id('INV2-MOCK'), status: 'DRAFT', mock: true };
    if (tool === 'send_invoice') return { invoice_id: args.invoice_id, status: 'SENT', mock: true };
    if (tool === 'create_refund') return { refund_id: this.id('MOCKREF'), status: 'COMPLETED', mock: true };
    if (tool === 'get_order') return { id: args.id, status: 'COMPLETED', mock: true };
    throw new Error(`No mock executor for ${tool}`);
  }
}

export async function seedCaptures(paypal, world) {
  const out = {};
  const errors = [];
  for (const o of world.orders) {
    try { out[o.order_number] = await paypal.seedCapture(o, world.business); }
    catch (e) { errors.push(`#${o.order_number}: ${e.message}`); }
  }
  return { captures: out, errors };
}
