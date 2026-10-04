'use strict';
/**
 * Regras de negócio do BZ7 (contas, dispositivos, keys). Toda a lógica de segurança vive AQUI (servidor).
 * `db` é uma interface estilo Firestore: db.doc(path), db.runTransaction(fn). Em produção vem do firebase-admin;
 * nos testes, de um banco em memória (backend/tests/fakedb.js).
 */
const crypto = require('crypto');
const L = require('./license');

class HErr extends Error { constructor(code, message) { super(message); this.code = code; } }
const MAX_DEVICES = 5, FAIL_LIMIT = 5, LOCK_MS = 15 * 60e3, SEEN_EVERY = 5 * 60e3;
const DEVICE_RE = /^[a-f0-9]{32,64}$/;
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';             // Crockford: sem I, L, O, U
const KEY_RE = /^BZ7[0-9A-HJKMNP-TV-Z]{16}$/;
const normKey = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const keyHash = k => crypto.createHash('sha256').update(normKey(k)).digest('hex');
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
function genKeyCode() { const b = crypto.randomBytes(16); let s = ''; for (const x of b) s += ALPHA[x % 32]; return 'BZ7-' + s.match(/.{4}/g).join('-'); }
const fail = (code, msg) => { throw new HErr(code, msg); };

function makeCore(db, clock = Date.now, catalog = []) {
  const accRef = uid => db.doc(`accounts/${uid}`), licRef = uid => db.doc(`licenses/${uid}`), keyRef = k => db.doc(`keys/${keyHash(k)}`);
  const need = a => { if (!a || !a.uid) fail('unauthenticated', 'Faça login novamente.'); };
  const needDevice = id => { if (!DEVICE_RE.test(String(id || ''))) fail('invalid-argument', 'Dispositivo inválido.'); };

  function view(acc, lic, deviceId, now) {
    const active = L.isActive(lic, now);
    return {
      email: acc.email, username: acc.username, adminDeviceId: acc.adminDeviceId, isAdmin: deviceId === acc.adminDeviceId,
      devices: Object.entries(acc.devices || {}).map(([id, d]) => ({ id, name: d.name, os: d.os, addedAt: d.addedAt, lastSeen: d.lastSeen, isAdmin: id === acc.adminDeviceId, hasKey: !!lic && id === lic.activeDeviceId, isThis: id === deviceId })).sort((a, b) => a.addedAt - b.addedAt),
      license: lic ? { plan: lic.plan, planLabel: L.planLabel(lic.plan), active, expiresAt: lic.expiresAt ?? null, activeDeviceId: lic.activeDeviceId || null } : null,
      entitled: !!active && lic.activeDeviceId === deviceId, serverTime: now,
    };
  }
  // garante coerência: admin válido e key apontando para dispositivo existente
  function repair(acc, lic) {
    const ids = Object.keys(acc.devices);
    if (!acc.devices[acc.adminDeviceId]) acc.adminDeviceId = ids.sort((a, b) => acc.devices[a].addedAt - acc.devices[b].addedAt)[0] || null;
    if (lic && !acc.devices[lic.activeDeviceId]) lic.activeDeviceId = acc.adminDeviceId;
  }
  async function load(uid) { const a = await accRef(uid).get(), l = await licRef(uid).get(); return { acc: a.exists ? a.data() : null, lic: l.exists ? l.data() : null }; }

  const api = {
    async register(auth, { deviceId, name, os } = {}) {
      need(auth); needDevice(deviceId); const now = clock(); name = clean(name, 40) || 'PC'; os = clean(os, 40);
      const out = await db.runTransaction(async tx => {
        const a = await tx.get(accRef(auth.uid)), l = await tx.get(licRef(auth.uid));
        let acc = a.exists ? a.data() : { email: auth.email || '', username: clean(auth.name, 32) || String(auth.email || '').split('@')[0], createdAt: now, adminDeviceId: null, devices: {} };
        const lic = l.exists ? l.data() : null; acc.email = auth.email || acc.email;
        if (!acc.devices[deviceId]) { if (Object.keys(acc.devices).length >= MAX_DEVICES) return { err: ['resource-exhausted', `Limite de ${MAX_DEVICES} dispositivos nesta conta. Peça ao administrador para remover um.`] }; acc.devices[deviceId] = { name, os, addedAt: now, lastSeen: now }; }
        else acc.devices[deviceId] = { ...acc.devices[deviceId], name, os, lastSeen: now };
        repair(acc, lic); tx.set(accRef(auth.uid), acc); if (lic) tx.set(licRef(auth.uid), lic);
        return { acc, lic };
      });
      if (out.err) fail(...out.err); return view(out.acc, out.lic, deviceId, now);
    },
    async state(auth, { deviceId } = {}) {
      need(auth); needDevice(deviceId); const now = clock(); let { acc, lic } = await load(auth.uid);
      if (!acc || !acc.devices[deviceId]) fail('failed-precondition', 'DEVICE_NOT_REGISTERED');
      if (now - (acc.devices[deviceId].lastSeen || 0) > SEEN_EVERY) {
        await db.runTransaction(async tx => { const a = await tx.get(accRef(auth.uid)); const x = a.data(); if (x.devices[deviceId]) { x.devices[deviceId].lastSeen = now; tx.set(accRef(auth.uid), x); acc = x; } });
      }
      return view(acc, lic, deviceId, now);
    },
    async redeem(auth, { deviceId, key } = {}) {
      need(auth); needDevice(deviceId);
      if (!auth.emailVerified) fail('failed-precondition', 'EMAIL_NOT_VERIFIED: verifique seu e-mail antes de ativar uma key.');
      const now = clock(), code = normKey(key), formatOk = KEY_RE.test(code);
      const res = await db.runTransaction(async tx => {
        const a = await tx.get(accRef(auth.uid)); if (!a.exists) return { err: ['failed-precondition', 'DEVICE_NOT_REGISTERED'] };
        const acc = a.data(); if (!acc.devices[deviceId]) return { err: ['failed-precondition', 'DEVICE_NOT_REGISTERED'] };
        const rf = acc.redeemFails || { count: 0, lockUntil: 0 };
        if (rf.lockUntil > now) return { err: ['resource-exhausted', `Muitas tentativas. Tente de novo em ${Math.ceil((rf.lockUntil - now) / 60000)} min.`] };
        const k = formatOk ? await tx.get(keyRef(code)) : null; const kd = k && k.exists ? k.data() : null;
        const l = await tx.get(licRef(auth.uid)); const lic = l.exists ? l.data() : null;
        if (!kd || kd.revoked || kd.redeemedBy) {
          const count = rf.count + 1; acc.redeemFails = count >= FAIL_LIMIT ? { count: 0, lockUntil: now + LOCK_MS } : { count, lockUntil: 0 }; tx.set(accRef(auth.uid), acc);
          return { err: ['not-found', !kd ? 'Key inválida.' : kd.revoked ? 'Esta key foi cancelada.' : 'Esta key já foi utilizada.'] };
        }
        const next = L.applyPlan(lic, kd.plan, now); if (!next) return { err: ['failed-precondition', 'Sua conta já possui licença Lifetime ativa.'] };
        next.activeDeviceId = L.isActive(lic, now) && lic.activeDeviceId && acc.devices[lic.activeDeviceId] ? lic.activeDeviceId : deviceId;
        acc.redeemFails = { count: 0, lockUntil: 0 };
        tx.set(accRef(auth.uid), acc); tx.set(licRef(auth.uid), next); tx.set(keyRef(code), { ...kd, redeemedBy: auth.uid, redeemedEmail: acc.email, redeemedAt: now });
        return { acc, lic: next };
      });
      if (res.err) fail(...res.err); return view(res.acc, res.lic, deviceId, now);
    },
    async _adminOp(auth, deviceId, targetId, mut) {
      need(auth); needDevice(deviceId); const now = clock();
      const res = await db.runTransaction(async tx => {
        const a = await tx.get(accRef(auth.uid)), l = await tx.get(licRef(auth.uid)); if (!a.exists) return { err: ['failed-precondition', 'DEVICE_NOT_REGISTERED'] };
        const acc = a.data(), lic = l.exists ? l.data() : null; if (!acc.devices[deviceId]) return { err: ['failed-precondition', 'DEVICE_NOT_REGISTERED'] };
        if (acc.adminDeviceId !== deviceId) return { err: ['permission-denied', 'Somente o dispositivo administrador pode fazer isso.'] };
        if (!targetId || !acc.devices[targetId]) return { err: ['not-found', 'Dispositivo não encontrado nesta conta.'] };
        const e = mut(acc, lic, targetId, now); if (e) return { err: e };
        repair(acc, lic); tx.set(accRef(auth.uid), acc); if (lic) tx.set(licRef(auth.uid), lic); return { acc, lic };
      });
      if (res.err) fail(...res.err); return view(res.acc, res.lic, deviceId, now);
    },
    moveKey(auth, { deviceId, targetDeviceId } = {}) {
      return api._adminOp(auth, deviceId, targetDeviceId, (acc, lic, t, now) => { if (!lic || !L.isActive(lic, now)) return ['failed-precondition', 'Não há licença ativa para mover.']; lic.activeDeviceId = t; return null; });
    },
    removeDevice(auth, { deviceId, targetDeviceId } = {}) {
      return api._adminOp(auth, deviceId, targetDeviceId, (acc, lic, t) => { if (t === acc.adminDeviceId) return ['failed-precondition', 'Transfira a administração antes de remover o dispositivo administrador.']; delete acc.devices[t]; if (lic && lic.activeDeviceId === t) lic.activeDeviceId = acc.adminDeviceId; return null; });
    },
    transferAdmin(auth, { deviceId, targetDeviceId } = {}) {
      return api._adminOp(auth, deviceId, targetDeviceId, (acc, lic, t) => { if (t === acc.adminDeviceId) return ['failed-precondition', 'Este dispositivo já é o administrador.']; acc.adminDeviceId = t; return null; });
    },
    async leave(auth, { deviceId } = {}) {
      need(auth); needDevice(deviceId);
      const res = await db.runTransaction(async tx => {
        const a = await tx.get(accRef(auth.uid)), l = await tx.get(licRef(auth.uid)); if (!a.exists) return { ok: true };
        const acc = a.data(), lic = l.exists ? l.data() : null; if (!acc.devices[deviceId]) return { ok: true };
        if (acc.adminDeviceId === deviceId && Object.keys(acc.devices).length > 1) return { err: ['failed-precondition', 'Transfira a administração para outro dispositivo antes de sair.'] };
        delete acc.devices[deviceId]; if (lic && lic.activeDeviceId === deviceId) lic.activeDeviceId = null; if (acc.adminDeviceId === deviceId) acc.adminDeviceId = null;
        repair(acc, lic); tx.set(accRef(auth.uid), acc); if (lic) tx.set(licRef(auth.uid), lic); return { ok: true };
      });
      if (res.err) fail(...res.err); return { ok: true };
    },
    /** Conteúdo premium: só sai do servidor para o dispositivo que detém a key ativa. */
    async premium(auth, { deviceId } = {}) {
      const s = await api.state(auth, { deviceId });
      if (!s.entitled) fail('permission-denied', 'LOCKED');
      return { version: 1, tweaks: catalog, state: s };
    },
    // ---------- operações do painel do dono (Admin SDK) ----------
    admin: {
      async genKeys({ plan, qty = 1, note = '' }) {
        if (!L.PLANS[plan]) throw new Error('Plano inválido'); qty = Math.max(1, Math.min(500, parseInt(qty) || 1)); const out = [];
        for (let i = 0; i < qty; i++) { const code = genKeyCode(); await keyRef(code).set({ code, plan, note: clean(note, 80), createdAt: clock(), revoked: false, redeemedBy: null }); out.push({ code, plan }); }
        return out;
      },
      async grant(uid, plan) {
        const now = clock(); const { acc, lic } = await load(uid); if (!acc) throw new Error('Conta ainda não abriu o app (sem dispositivo registrado).');
        const next = L.applyPlan(lic, plan, now); if (!next) throw new Error('A conta já é Lifetime.');
        next.activeDeviceId = L.isActive(lic, now) && acc.devices[lic.activeDeviceId] ? lic.activeDeviceId : acc.adminDeviceId; await licRef(uid).set(next); return next;
      },
      async revokeLicense(uid) { const { lic } = await load(uid); if (!lic) throw new Error('Sem licença.'); lic.revoked = true; await licRef(uid).set(lic); return lic; },
      async restoreLicense(uid) { const { lic } = await load(uid); if (!lic) throw new Error('Sem licença.'); lic.revoked = false; await licRef(uid).set(lic); return lic; },
      async revokeKey(hash) { const r = db.doc(`keys/${hash}`); const s = await r.get(); if (!s.exists) throw new Error('Key não existe'); await r.set({ ...s.data(), revoked: true }); },
    },
  };
  return api;
}
module.exports = { makeCore, HErr, normKey, keyHash, genKeyCode, KEY_RE, MAX_DEVICES };
