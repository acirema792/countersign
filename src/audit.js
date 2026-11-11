// Hash-chained receipt log: every guard decision and every execution is appended here.
// Anyone can re-verify the chain with GET /api/audit/verify (or verifyChain() below).
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class AuditLog {
  constructor() { this.entries = []; }
  append(entry) {
    const prev = this.entries.length ? this.entries[this.entries.length - 1].hash : 'GENESIS';
    const body = { seq: this.entries.length + 1, ts: new Date().toISOString(), ...entry, prev };
    const hash = sha(JSON.stringify(body));
    const rec = { ...body, hash };
    this.entries.push(rec);
    return rec;
  }
  tail(n = 200) { return this.entries.slice(-n); }
}

export function verifyChain(entries) {
  let prev = 'GENESIS';
  for (const e of entries) {
    const { hash, ...body } = e;
    if (body.prev !== prev) return { ok: false, at: e.seq, reason: 'broken link' };
    if (sha(JSON.stringify(body)) !== hash) return { ok: false, at: e.seq, reason: 'hash mismatch' };
    prev = hash;
  }
  return { ok: true, length: entries.length, head: prev };
}
