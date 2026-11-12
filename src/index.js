// Countersign as a library: put it in front of PayPal's Agent Toolkit in any agent.
//
//   import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
//   import { guardToolkit, createState, loadWorld } from 'countersign';
//   const guarded = guardToolkit(new PayPalAgentToolkit({...}), { state: createState(loadWorld(), captures) });
//   // captures: { [order_number]: { capture_id, amount } } from your PayPal account (refunds need them)
//   // pass guarded.getTools() to your model; for each tool call:
//   const msg = await guarded.handleToolCall(toolCall, { email });   // same shape as the toolkit's
//
// ALLOW executes the policy-built payload through the toolkit; HOLD and BLOCK return a tool
// message explaining why, and nothing reaches PayPal. Read-only tools (get_/list_/show_) pass
// through; every other toolkit tool is blocked (fail closed).
import crypto from 'node:crypto';
import { evaluate, reserve, recordResult, scanEmail, MONEY_TOOLS } from './policy.js';
import { parseToolkitContent, isToolkitError, invoiceIdOf } from './paypal.js';

export { evaluate, reserve, recordResult, scanEmail } from './policy.js';
export { createState, loadWorld, loadCases, newLedger } from './state.js';
export { AuditLog, verifyChain } from './audit.js';

const READ_ONLY = /^(get|list|show)_/;
const toolName = (t) => t?.function?.name || t?.name || '';

export function guardToolkit(toolkit, { state, onHold = () => {}, audit = null } = {}) {
  return {
    // Offer the model only tools Countersign guards or that are read-only.
    getTools: () => toolkit.getTools().filter((t) => MONEY_TOOLS.has(toolName(t)) || READ_ONLY.test(toolName(t))),
    async handleToolCall(toolCall, { email = { from: '', subject: '', body: '' } } = {}) {
      const name = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
      if (!MONEY_TOOLS.has(name)) {
        // Fail closed: only read-only toolkit tools pass through. Anything else that can move money
        // or change state (accept_dispute_claim, pay_order, cancel_subscription...) is not guarded here.
        if (READ_ONLY.test(name)) return toolkit.handleToolCall(toolCall);
        audit?.append({ tool: name, verdict: 'BLOCK', reason: 'not guarded' });
        return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ status: 'BLOCKED', reasons: [`Tool ${name} is not guarded by Countersign, so it is not allowed.`] }) };
      }
      const decision = evaluate(name, args, { state, email, scan: scanEmail(email) });
      audit?.append({ tool: name, verdict: decision.verdict, money: decision.money });
      const reply = (content) => ({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(content) });
      if (decision.verdict === 'BLOCK') return reply({ status: 'BLOCKED', reasons: decision.rules.filter((r) => !r.ok).map((r) => r.msg) });
      if (decision.verdict === 'HOLD') { const id = crypto.randomUUID(); onHold({ id, name, args, decision, email }); return reply({ status: 'HELD_FOR_OWNER', approval_id: id, reasons: decision.rules.filter((r) => !r.ok).map((r) => r.msg) }); }
      const undo = reserve(name, decision, state);
      try {
        const out = await toolkit.handleToolCall({ ...toolCall, function: { name, arguments: JSON.stringify(decision.exec) } });
        const parsed = parseToolkitContent(out.content);
        // PayPal refused: release the reservation so the books and the budget stay true.
        if (isToolkitError(parsed)) { undo(); return reply({ status: 'PAYPAL_ERROR', detail: parsed }); }
        recordResult(name, decision, state, { invoice_id: invoiceIdOf(parsed) });
        return out;
      } catch (e) { undo(); throw e; }
    }
  };
}
