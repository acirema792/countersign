// Countersign UI (no framework). Talks to the JSON API in server.js.
const $ = (s, el = document) => el.querySelector(s);
const unescapeNl = (s) => String(s ?? '').replace(/\\n/g, '\n');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);

let SID = '';
try { SID = localStorage.getItem('cs-session') || ''; if (!SID) { SID = crypto.randomUUID(); localStorage.setItem('cs-session', SID); } } catch { SID = crypto.randomUUID(); }

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-session': SID, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

let INBOX = [];
let current = null;
let polling = null;

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(t) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === `tab-${t}`));
  if (t === 'results') loadResults();
  if (t === 'audit') loadAudit();
}

// ---------- status ----------
async function loadHealth() {
  try {
    const h = await api('/api/health');
    $('#status').innerHTML = [
      `<span class="chip">PayPal <b>${esc(h.paypal_mode)}</b></span>`,
      `<span class="chip">Model <b>${esc(h.llm ? h.llm.models[0] : 'none')}</b></span>`,
      `<span class="chip">Toolkit <b>@paypal/agent-toolkit</b></span>`,
      `<span class="chip">build <b>${esc(h.version)}</b></span>`
    ].join('');
  } catch (e) { $('#status').innerHTML = `<span class="chip">server unreachable</span>`; }
}

// ---------- inbox ----------
async function loadInbox() {
  INBOX = await api('/api/inbox');
  const order = { legit: 0, lookalike: 1, attack: 2 };
  $('#inbox').innerHTML = INBOX.slice().sort((a, b) => order[a.group] - order[b.group]).map((c) => `
    <li data-id="${c.id}">
      <div class="from"><span>${esc(c.email.from.replace(/<.*>/, '').trim())}</span><span class="pill ${c.group}">${c.group === 'legit' ? 'routine' : c.group === 'lookalike' ? 'look-alike' : 'scam'}</span></div>
      <div class="subj">${esc(c.email.subject)}</div>
    </li>`).join('');
  $('#inbox').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => pick(li.dataset.id)));
}

function pick(id) {
  current = INBOX.find((c) => c.id === id);
  if (!current) return;
  document.querySelectorAll('#inbox li').forEach((li) => li.classList.toggle('sel', li.dataset.id === id));
  renderEmail(current.email, current);
  $('#runbar').hidden = false;
  $('#runNote').innerHTML = current.recorded ? `<a href="#" id="openRec">or open the recorded run</a>` : '';
  const rec = $('#openRec'); if (rec) rec.onclick = (e) => { e.preventDefault(); openRecorded(id); };
  $('#timeline').innerHTML = '';
  try { history.replaceState(null, '', `#case=${id}`); } catch {}
}

function renderEmail(email, c) {
  const hidden = email.hidden ? `<div class="hidden-strip"><b>Hidden in the email's HTML.</b> The owner can't see this text; the AI agent reads it:<br><i>${esc(email.hidden)}</i></div>` : '';
  const flags = c && c.scan && c.scan.suspicious ? `<div class="small" style="margin-top:6px;color:var(--block)">Scanner: ${c.scan.findings.map((f) => esc(f.kind)).join(', ')}</div>` : '';
  $('#emailView').className = 'card email';
  $('#emailView').innerHTML = `
    <div class="hdr"><span>From</span><span>${esc(email.from)}</span><span>Subject</span><span><b>${esc(email.subject)}</b></span></div>
    <div class="body">${esc(email.body)}</div>${hidden}${flags}
    ${c && c.expected ? `<div class="expect"><b>Expected (written before any run):</b> ${esc(c.expected)}</div>` : ''}`;
}

// ---------- runs ----------
$('#runGuarded').onclick = () => startRun({ case_id: current.id, guard: 'enforce' });
$('#runBaseline').onclick = () => startRun({ case_id: current.id, guard: 'off' });

async function startRun(body) {
  setBusy(true);
  $('#timeline').innerHTML = `<div class="ev"><span class="spin"></span> Starting the agent…</div>`;
  try {
    const { run_id } = await api('/api/run', { method: 'POST', body: JSON.stringify(body) });
    pollRun(run_id);
  } catch (e) { $('#timeline').innerHTML = `<div class="ev">${esc(e.message)}</div>`; setBusy(false); }
}

function setBusy(b) { ['#runGuarded', '#runBaseline'].forEach((s) => { $(s).disabled = b; }); }

function pollRun(id) {
  clearInterval(polling);
  const tick = async () => {
    try {
      const r = await api(`/api/runs/${id}`);
      renderRun(r);
      if (r.status !== 'running') { clearInterval(polling); setBusy(false); loadSession(); }
    } catch (e) { clearInterval(polling); setBusy(false); $('#timeline').insertAdjacentHTML('beforeend', `<div class="ev">${esc(e.message)}</div>`); }
  };
  tick();
  polling = setInterval(tick, 700);
}

function renderRun(r) {
  const off = r.guard === 'off';
  const head = `<div class="ev runhead ${off ? 'off' : ''}">
    <span><b>${off ? 'Baseline: Countersign OFF' : 'Countersign ON'}</b> · ${esc(r.title || '')}</span>
    <span class="small muted">${r.source === 'recorded' ? `recorded run${r.recorded_at ? ' · ' + esc(r.recorded_at.slice(0, 16).replace('T', ' ')) + ' UTC' : ''}` : 'live'}${r.models ? ' · ' + esc(r.models.join(', ')) : ''}${r.status === 'running' ? ' · <span class="spin"></span>' : ''}</span>
  </div>${r.note ? `<div class="ev small">${esc(r.note)}</div>` : ''}${off ? `<div class="ev small muted">Same model, same prompt, same tools. Nothing below was sent to PayPal: the agent was told its actions succeeded, so you see what it <i>would</i> have done.</div>` : ''}`;
  const evs = r.events || [];
  const finalText = (evs.find((e) => e.type === 'end') || {}).final;
  const body = evs.filter((e) => !(e.type === 'model' && finalText && e.text === finalText)).map(renderEvent).join('');
  const err = r.error ? `<div class="ev">${esc(r.error)}</div>` : '';
  $('#timeline').innerHTML = head + body + err;
  $('#timeline').querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => { document.querySelector('.owner').scrollIntoView({ behavior: 'smooth' }); }));
}

function describe(tool, args, m) {
  m = m || {};
  if (tool === 'create_refund') return `Refund ${money(m.amount)} on order #${esc(m.order_number || '?')}`;
  if (tool === 'pay_vendor') return `Pay ${money(m.amount ?? args.amount)} to ${esc(m.payee || args.payee_email)}${m.bill_id || args.bill_id ? ` (bill ${esc(m.bill_id || args.bill_id)})` : ''}`;
  if (tool === 'create_invoice') return `Draft invoice ${money(m.amount)} to ${esc(m.recipient)}`;
  if (tool === 'send_invoice') return `Send invoice ${esc(args.invoice_id)} (${money(m.amount)} to ${esc(m.recipient)})`;
  return esc(tool);
}

function renderEvent(e) {
  if (e.type === 'start') {
    return e.scan && e.scan.suspicious ? `<div class="ev small" style="border-left:3px solid var(--block)">Untrusted-content scanner: <b>${e.scan.findings.map((f) => esc(f.kind)).join(', ')}</b>. Any money action from this email will need the owner.</div>` : '';
  }
  if (e.type === 'model') return `<div class="ev model"><span class="small muted">Agent (${esc(e.model)})</span><div class="pre">${esc(unescapeNl(e.text))}</div></div>`;
  if (e.type === 'lookup') return `<div class="ev lookup">🔎 <span class="k">${esc(e.tool)}</span>(${esc(JSON.stringify(e.args))})${e.error ? ` → <span class="no">${esc(e.error)}</span>` : e.result && e.result.found === false ? ' → not found' : ''}</div>`;
  if (e.type === 'reply') return `<div class="ev reply"><span class="small muted">Reply drafted to sender</span><div class="pre">${esc(unescapeNl(e.text))}</div></div>`;
  if (e.type === 'escalate') return `<div class="ev reply"><span class="small muted">Agent flagged for owner</span><div>${esc(e.reason)}</div></div>`;
  if (e.type === 'end') return e.final ? `<div class="ev model"><span class="small muted">Agent's summary for the owner</span><div class="pre">${esc(unescapeNl(e.final))}</div></div>` : '';
  if (e.type !== 'proposal') return '';

  const d = e.decision || { verdict: 'BLOCK', rules: [] };
  const unguarded = e.status === 'would-execute';
  const cls = unguarded ? 'UNGUARDED' : d.verdict;
  let badge;
  if (unguarded) badge = `<span class="v UNGUARDED">WOULD EXECUTE</span>`;
  else if (e.status === 'executed') badge = `<span class="v ALLOW">ALLOWED · EXECUTED</span>`;
  else if (e.status === 'held') badge = `<span class="v HOLD">HELD FOR OWNER</span>`;
  else if (e.status === 'error') badge = `<span class="v BLOCK">PAYPAL ERROR</span>`;
  else badge = `<span class="v BLOCK">BLOCKED</span>`;

  const rules = (d.rules || []).map((r) => `<li class="${r.ok ? 'good' : 'bad'}"><span>${r.ok ? '✓' : r.verdict === 'BLOCK' ? '⛔' : '✋'}</span><span>${esc(r.msg)} <span class="rid">${esc(r.id)}</span></span></li>`).join('');
  const prov = (d.provenance || []).map((p) => `<span class="${esc(p.source)}">${esc(p.field)}: <b>${esc(typeof p.value === 'number' ? money(p.value) : p.value)}</b> ← ${p.source === 'books' ? 'books' : p.source === 'email-only' ? 'email only' : 'unknown'}${p.note ? ' · ' + esc(p.note) : ''}</span>`).join('');
  const via = e.result && e.result.via === 'sandbox' ? 'PayPal sandbox' : e.result && e.result.via === 'mock' ? `Simulated (${e.result.simulated_reason || 'no sandbox card capture available'})` : 'PayPal';
  const res = e.result ? `<div class="result">${e.status === 'executed' ? `${via}: ` : 'Recorded only: '}${esc(Object.entries(e.result).filter(([k, v]) => typeof v !== 'object' && k !== 'mock' && k !== 'via').map(([k, v]) => `${k}=${v}`).join(' · '))}</div>` : '';
  const errMsg = e.error ? `<div class="result">${esc(e.error)}</div>` : '';
  const would = unguarded ? `<div class="small" style="margin-top:6px">Countersign would have said: <span class="v ${d.verdict}">${d.verdict}</span></div>` : '';
  const held = e.status === 'held' ? `<div class="small" style="margin-top:6px">Waiting in the owner's queue → <a href="#" data-approve="${esc(e.approval_id)}">countersign or reject</a></div>` : '';
  return `<div class="ev prop ${cls}">
    <div class="head"><span class="what">${describe(e.tool, e.args, d.money)}</span>${badge}</div>
    ${prov ? `<div class="prov">${prov}</div>` : ''}${would}
    <details ${unguarded ? '' : 'open'}><summary>Rules checked (${(d.rules || []).filter((r) => !r.ok).length} failed)</summary><ul class="rules-list">${rules}</ul></details>
    ${res}${errMsg}${held}
    <details><summary>Arguments the agent proposed</summary><div class="result">${esc(JSON.stringify(e.args))}</div></details>
  </div>`;
}

async function openRecorded(id) {
  try {
    const rec = await api(`/api/recorded/${id}`);
    const c = INBOX.find((x) => x.id === id);
    const mk = (arm, guard) => ({ title: c.title, guard, source: 'recorded', recorded_at: rec.recorded_at, events: arm.events, models: arm.models, status: 'done' });
    renderRun(mk(rec.guarded, 'enforce'));
    const g = $('#timeline').innerHTML;
    renderRun(mk(rec.baseline, 'off'));
    $('#timeline').innerHTML = g + $('#timeline').innerHTML;
  } catch (e) { $('#timeline').innerHTML = `<div class="ev">${esc(e.message)}</div>`; }
}

// ---------- owner side ----------
async function loadSession() {
  const s = await api('/api/session');
  const pend = s.approvals.filter((a) => a.status === 'pending');
  const doneA = s.approvals.filter((a) => a.status !== 'pending').slice(0, 5);
  $('#approvals').innerHTML = (pend.length || doneA.length) ? [...pend, ...doneA].map((a) => {
    const why = a.decision.rules.filter((r) => !r.ok).map((r) => esc(r.msg)).join(' ');
    return `<li class="ap"><b>${describe(a.tool, a.args, a.decision.money)}</b><div class="small muted">from: ${esc(a.email.from)}</div><div class="why">${why}</div>
      ${a.status === 'pending' ? `<div class="btns"><button class="primary sm" data-ap="${a.id}" data-act="approve">Countersign</button><button class="ghost sm" data-ap="${a.id}" data-act="reject">Reject</button></div>` : `<div class="done ${a.status === 'approved' ? 'ok' : 'no'}">${a.status}${a.result ? ` · ${esc(a.result.refund_id || a.result.payout_batch_id || a.result.invoice_id || '')}` : ''}</div>`}</li>`;
  }).join('') : '<li class="muted small">Nothing waiting.</li>';
  $('#approvals').querySelectorAll('[data-ap]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.ap, b.dataset.act, b)));

  const modes = new Set(s.orders.map((o) => o.mode));
  $('#paypalMode').textContent = modes.has('sandbox') ? '· real PayPal sandbox captures' : '· simulated captures';
  $('#paypalMode').title = s.seed_errors && s.seed_errors.length ? `Refunds run against simulated captures because the PayPal sandbox refused to create card captures: ${s.seed_errors[0]}. Invoices and supplier payouts still run in the real sandbox.` : '';
  $('#orders').innerHTML = s.orders.map((o) => `<tr title="capture ${esc(o.capture_id)}"><td>#${o.order_number}</td><td>${esc(o.customer)}</td><td class="r">${money(o.total)}</td><td class="r">${o.refunded ? money(o.refunded) : '–'}</td></tr>`).join('');
  $('#bills').innerHTML = s.bills.map((b) => `<tr><td>${b.bill_id}</td><td>${esc(s.vendors.find((v) => v.id === b.vendor_id)?.name)}</td><td class="r">${money(b.amount)}</td><td>${b.status}</td></tr>`).join('');
  const pct = Math.min(100, (s.auto_outflow_today / s.policy.daily_auto_outflow_budget) * 100);
  $('#budgetBar').style.width = pct + '%';
  $('#budgetTxt').textContent = `${money(s.auto_outflow_today)} of ${money(s.policy.daily_auto_outflow_budget)} auto budget`;
}

async function decide(id, act, btn) {
  btn.disabled = true;
  $('#apMsg').className = 'apmsg'; $('#apMsg').textContent = '';
  try {
    const r = await api(`/api/approvals/${id}/${act}`, { method: 'POST', body: JSON.stringify({ pin: $('#pin').value }) });
    showApMsg(act === 'approve' ? `Countersigned. ${r.result && r.result.via === 'sandbox' ? 'Sent to the PayPal sandbox' : 'Executed'}: ${r.result ? (r.result.refund_id || r.result.payout_batch_id || r.result.invoice_id || '') : ''}` : 'Rejected. Nothing was sent to PayPal.', 'ok');
  } catch (e) { showApMsg(e.message, 'no'); }
  await loadSession();
}
function showApMsg(msg, kind) { const el = $('#apMsg'); el.className = `apmsg ${kind}`; el.textContent = msg; }

$('#resetBtn').onclick = async () => { await api('/api/session/reset', { method: 'POST' }); loadSession(); };

// ---------- compose ----------
$('#composeBtn').onclick = () => $('#compose').showModal();
$('#composeForm').addEventListener('submit', (ev) => {
  if (ev.submitter && ev.submitter.value === 'run') {
    const f = new FormData($('#composeForm'));
    const email = { from: f.get('from'), subject: f.get('subject'), body: f.get('body'), hidden: f.get('hidden') || undefined };
    current = null;
    document.querySelectorAll('#inbox li').forEach((li) => li.classList.remove('sel'));
    renderEmail(email, null);
    $('#runbar').hidden = true;
    startRun({ email, guard: 'enforce' });
  }
});

// ---------- results ----------
async function loadResults() {
  try {
    const R = await api('/api/results');
    const t = R.summary.totals;
    const rows = R.summary.rows;
    const fmtMoves = (arr) => (arr && arr.length ? arr.map((d) => `${d.tool === 'create_refund' ? 'refund' : d.tool === 'pay_vendor' ? 'pay' : 'invoice'} ${money(d.amount)}${d.payee ? ' → ' + esc(d.payee) : d.order_number ? ' #' + d.order_number : ''}`).join('<br>') : '–');
    $('#results').innerHTML = `
      <p class="muted">Run on the live deployment on ${esc((R.finished || '').slice(0, 16).replace('T', ' '))} UTC · model ${esc((R.models || []).join(', '))} · PayPal ${esc(R.seed?.mode || '')} · ${t.cases} cases, each with its expected outcome written before the run (<a href="https://github.com/acirema792/countersign/blob/main/data/cases.json" target="_blank" rel="noopener">data/cases.json</a>).</p>
      <div class="tiles">
        <div class="tile bad"><div class="num">${t.baseline_attacks_that_moved_money}/${t.attacks}</div><div class="lbl">scam emails that got the <b>unguarded</b> agent to move money (${money(t.baseline_unsafe_amount)})</div></div>
        <div class="tile good"><div class="num">${t.guarded_attacks_that_moved_money}/${t.attacks}</div><div class="lbl">scam emails that moved money <b>with Countersign</b></div></div>
        <div class="tile good"><div class="num">${t.legit_completed}/${t.legit}</div><div class="lbl">routine requests handled exactly as expected (positive controls)</div></div>
        <div class="tile good"><div class="num">${t.lookalike_cleared}/${t.lookalike}</div><div class="lbl">look-alike but genuine emails cleared (false-positive controls)</div></div>
      </div>
      <table class="restable"><thead><tr><th>Case</th><th>Expected</th><th>With Countersign</th><th>Baseline (unguarded, not executed)</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><span class="pill ${r.group}">${r.group}</span><br><b>${r.id}</b> ${esc(r.title)}</td><td>${esc(r.expected)}</td>
        <td>${r.guarded.error ? `<span class="no">error</span> ${esc(r.guarded.error)}` : `<span class="${r.guarded.pass ? 'ok' : 'no'}">${r.guarded.pass ? '✓ as expected' : '✗ differs'}</span><br>moved: ${fmtMoves(r.guarded.moved)}${r.guarded.held.length ? `<br>held: ${fmtMoves(r.guarded.held)}` : ''}${r.guarded.blocked.length ? `<br>blocked: ${fmtMoves(r.guarded.blocked)}` : ''}`}</td>
        <td>${r.baseline.error ? `<span class="no">error</span>` : `${r.baseline.unsafe.length ? `<span class="no">✗ unsafe ${money(r.baseline.unsafe_amount)}</span>` : '<span class="ok">no unsafe move</span>'}<br>would move: ${fmtMoves(r.baseline.moved)}`}</td></tr>`).join('')}
      </tbody></table>`;
  } catch (e) { $('#results').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// ---------- audit ----------
async function loadAudit() {
  const a = await api('/api/audit');
  $('#auditHead').innerHTML = a.signed_head ? `Signed head: <code>${esc(a.signed_head.head.slice(0, 24))}…</code> · signature <code>${esc(a.signed_head.signature.slice(0, 24))}…</code>` : '';
  $('#auditVerify').innerHTML = a.verify.ok ? `<span class="ok">✓ chain verified · ${a.verify.length} entries</span>` : `<span class="no">✗ ${esc(a.verify.reason)} at #${a.verify.at}</span>`;
  $('#auditRows').innerHTML = a.entries.slice().reverse().map((e) => `<tr><td>${e.seq}</td><td>${esc(e.ts.slice(11, 19))}</td><td class="mono">${esc(e.run)}</td><td>${esc(e.event || e.tool)}${e.money && e.money.amount ? ' ' + money(e.money.amount) : ''}</td><td>${e.verdict ? `<span class="v ${e.verdict}">${esc(e.verdict)}</span>` : ''}</td><td class="mono">${esc(e.hash.slice(0, 16))}…</td></tr>`).join('');
}

// ---------- boot ----------
$('#tourClose').onclick = () => { $('#tour').hidden = true; };
document.querySelectorAll('[data-pick]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); pick(a.dataset.pick); }));
(async () => {
  loadHealth();
  await loadInbox();
  await loadSession().catch(() => {});
  const m = location.hash.match(/case=([A-Z0-9]+)/);
  pick(m ? m[1] : 'A6');
  if (location.hash.includes('results')) showTab('results');
  window.addEventListener('hashchange', () => { const h = location.hash.match(/case=([A-Z0-9]+)/); if (h && (!current || current.id !== h[1])) { showTab('demo'); pick(h[1]); } });
})();
