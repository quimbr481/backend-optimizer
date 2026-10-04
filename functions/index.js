'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { makeCore, HErr } = require('./lib/core');
admin.initializeApp();

const db = require('./lib/fsdb')(admin);
let catalog = []; try { catalog = require('./catalog.json'); } catch { /* sem catálogo: premium vazio */ }
const core = makeCore(db, Date.now, catalog);

const wrap = fn => onCall({ region: 'southamerica-east1', maxInstances: 10, memory: '256MiB', timeoutSeconds: 30 }, async req => {
  const a = req.auth; const auth = a ? { uid: a.uid, email: a.token.email, emailVerified: !!a.token.email_verified, name: a.token.name } : null;
  try { return await fn(auth, req.data || {}); }
  catch (e) { if (e instanceof HErr) throw new HttpsError(e.code, e.message); console.error(e); throw new HttpsError('internal', 'Erro interno. Tente novamente.'); }
});
exports.bz7Register = wrap((a, d) => core.register(a, d));
exports.bz7State = wrap((a, d) => core.state(a, d));
exports.bz7Redeem = wrap((a, d) => core.redeem(a, d));
exports.bz7MoveKey = wrap((a, d) => core.moveKey(a, d));
exports.bz7RemoveDevice = wrap((a, d) => core.removeDevice(a, d));
exports.bz7TransferAdmin = wrap((a, d) => core.transferAdmin(a, d));
exports.bz7Leave = wrap((a, d) => core.leave(a, d));
exports.bz7Premium = wrap((a, d) => core.premium(a, d));
