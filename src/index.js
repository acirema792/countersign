// Countersign as a library: put it in front of PayPal's Agent Toolkit in any agent.
//
//   import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
//   import { guardToolkit, createState, loadWorld } from 'countersign';
//   const guarded = guardToolkit(new PayPalAgentToolkit({...}), { state: createState(loadWorld()) });
//   // pass guarded.getTools() to your model; for each tool call:
//   const msg = await guarded.handleToolCall(toolCall, { email });   // same shape as the toolkit's
//
// ALLOW executes the policy-built payload through the toolkit; HOLD and BLOCK return a tool
// message explaining why, and nothing reaches PayPal.
import crypto from 'node:crypto';
import { evaluate, reserve, recordResult, scanEmail, MONEY_TOOLS } from './policy.js';

export { evaluate, reserve, recordResult, scanEmail } from './policy.js';
export { createState, loadWorld, loadCases, newLedger } from './state.js';
export { AuditLog, verifyChain } from './audit.js';

export function guardToolkit(toolkit, { state, onHold = () => {}, audit = null } = {}) {
  return {
    getTools: () => toolkit.getTools(),
    async handleToolCall(toolCall, { email = { from: '', subject: '', body: '' } } = {}) {
      const name = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
      if (!MONEY_TOOLS.has(name)) return toolkit.handleToolCall(toolCall); // read-only toolkit calls pass through
      const decision = evaluate(name, args, { state, email, scan: scanEmail(email) });
      audit?.append({ tool: name, verdict: decision.verdict, money: decision.money });
      const reply = (content) => ({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(content) });
      if (decision.verdict === 'BLOCK') return reply({ status: 'BLOCKED', reasons: decision.rules.filter((r) => !r.ok).map((r) => r.msg) });
      if (decision.verdict === 'HOLD') { const id = crypto.randomUUID(); onHold({ id, name, args, decision, email }); return reply({ status: 'HELD_FOR_OWNER', approval_id: id, reasons: decision.rules.filter((r) => !r.ok).map((r) => r.msg) }); }
      const undo = reserve(name, decision, state);
      try {
        const out = await toolkit.handleToolCall({ ...toolCall, function: { name, arguments: JSON.stringify(decision.exec) } });
        let parsed = {}; try { parsed = JSON.parse(out.content); } catch {}
        recordResult(name, decision, state, { invoice_id: parsed.id });
        return out;
      } catch (e) { undo(); throw e; }
    }
  };
}
