// Hash-chained receipt log: every guard decision and every execution is appended here.
// Anyone can re-verify the chain with GET /api/audit/verify (or verifyChain() below).
// The chain head is signed with an Ed25519 key (AUDIT_SIGNING_KEY, PEM; otherwise generated
// at boot) whose public key is published at GET /api/audit/pubkey, so an exported chain can
// be checked by someone who does not trust this server's /verify endpoint.
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class AuditLog {
  constructor({ signingKeyPem } = {}) {
    this.entries = [];
    try {
      this.privateKey = signingKeyPem ? crypto.createPrivateKey(signingKeyPem) : crypto.generateKeyPairSync('ed25519').privateKey;
    } catch { this.privateKey = crypto.generateKeyPairSync('ed25519').privateKey; }
    this.publicKeyPem = crypto.createPublicKey(this.privateKey).export({ type: 'spki', format: 'pem' });
  }
  append(entry) {
    const prev = this.entries.length ? this.entries[this.entries.length - 1].hash : 'GENESIS';
    const body = { seq: this.entries.length + 1, ts: new Date().toISOString(), ...entry, prev };
    const hash = sha(JSON.stringify(body));
    const rec = { ...body, hash };
    this.entries.push(rec);
    return rec;
  }
  tail(n = 200) { return this.entries.slice(-n); }
  signedHead() {
    const head = this.entries.length ? this.entries[this.entries.length - 1].hash : 'GENESIS';
    const msg = `countersign-audit-head:${this.entries.length}:${head}`;
    return { length: this.entries.length, head, message: msg, signature: crypto.sign(null, Buffer.from(msg), this.privateKey).toString('base64'), alg: 'ed25519' };
  }
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

export function verifyHeadSignature(signed, publicKeyPem) {
  try { return crypto.verify(null, Buffer.from(signed.message), crypto.createPublicKey(publicKeyPem), Buffer.from(signed.signature, 'base64')); }
  catch { return false; }
}
