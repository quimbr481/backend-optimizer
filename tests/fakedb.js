'use strict';
// Banco em memória com a mesma interface usada pelo core. Simula a regra do Firestore: leituras antes de escritas na transação.
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
class FakeDb {
  constructor() { this.m = new Map(); }
  doc(path) { const m = this.m; return { path, get: async () => ({ exists: m.has(path), data: () => clone(m.get(path)) }), set: async v => { m.set(path, clone(v)); } }; }
  async runTransaction(fn) {
    const writes = []; const m = this.m;
    const tx = { get: async ref => { if (writes.length) throw new Error('Firestore: leituras devem vir antes de escritas'); return { exists: m.has(ref.path), data: () => clone(m.get(ref.path)) }; }, set: (ref, v) => { writes.push([ref.path, clone(v)]); } };
    const r = await fn(tx); for (const [p, v] of writes) m.set(p, v); return r;
  }
}
module.exports = { FakeDb };
