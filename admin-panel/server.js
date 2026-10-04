'use strict';
/**
 * PAINEL DO DONO — roda SÓ no seu computador (127.0.0.1). Usa o Admin SDK (serviceAccount.json) para:
 * gerar/cancelar keys, ver contas, conceder/revogar licença, bloquear usuário, mexer em dispositivos.
 * NUNCA coloque serviceAccount.json dentro do app que você distribui.
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), readline = require('readline');
const PORT = 4777, HOST = '127.0.0.1', CFG = path.join(__dirname, 'panel-config.json'), SA = path.join(__dirname, 'serviceAccount.json');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString('hex');

if (process.argv.includes('--set-password')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Nova senha do painel (mín. 12 caracteres): ', pw => { rl.close(); if (pw.length < 12) { console.log('Muito curta.'); process.exit(1); } const salt = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(CFG, JSON.stringify({ salt, hash: hashPw(pw, salt) })); console.log('Senha definida. Rode: npm start'); });
  return;
}
if (!fs.existsSync(SA)) { console.error('Falta serviceAccount.json nesta pasta (Firebase Console → Configurações do projeto → Contas de serviço → Gerar nova chave privada).'); process.exit(1); }
if (!fs.existsSync(CFG)) { console.error('Defina a senha primeiro: npm run set-password'); process.exit(1); }
const admin = require('firebase-admin'); admin.initializeApp({ credential: admin.credential.cert(require(SA)) });
const db = require('../functions/lib/fsdb')(admin); const fsx = db.raw; const L = require('../functions/lib/license'); const { makeCore } = require('../functions/lib/core');
const core = makeCore(db, Date.now, []); const conf = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const sessions = new Map(), tries = new Map();

const body = req => new Promise((res, rej) => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); });
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
const cookie = req => (/bz7panel=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1];
const authed = req => { const t = cookie(req); const e = t && sessions.get(t); if (e && e > Date.now()) { sessions.set(t, Date.now() + 30 * 60e3); return true; } return false; };

const ROUTES = {
  async 'overview'() {
    const [keys, lic, users] = await Promise.all([fsx.collection('keys').get(), fsx.collection('licenses').get(), admin.auth().listUsers(1000)]); const now = Date.now();
    const k = keys.docs.map(d => d.data()); return { keys: k.length, unused: k.filter(x => !x.redeemedBy && !x.revoked).length, used: k.filter(x => x.redeemedBy).length, accounts: users.users.length, activeLicenses: lic.docs.filter(d => L.isActive(d.data(), now)).length };
  },
  async 'keys/list'() { const s = await fsx.collection('keys').orderBy('createdAt', 'desc').limit(1000).get(); return s.docs.map(d => ({ id: d.id, ...d.data() })); },
  async 'keys/gen'(b) { const out = await core.admin.genKeys(b); const f = path.join(__dirname, `keys-export-${new Date().toISOString().slice(0, 10)}.csv`); fs.appendFileSync(f, out.map(k => `${k.code},${k.plan},${(b.note || '').replace(/[,\n]/g, ' ')}`).join('\n') + '\n'); return out; },
  async 'keys/revoke'(b) { await core.admin.revokeKey(String(b.id)); return { ok: true }; },
  async 'accounts/list'() {
    const [users, accs, lics] = await Promise.all([admin.auth().listUsers(1000), fsx.collection('accounts').get(), fsx.collection('licenses').get()]);
    const A = Object.fromEntries(accs.docs.map(d => [d.id, d.data()])), Lc = Object.fromEntries(lics.docs.map(d => [d.id, d.data()])); const now = Date.now();
    return users.users.map(u => ({ uid: u.uid, email: u.email, verified: u.emailVerified, disabled: u.disabled, created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime, devices: A[u.uid] ? Object.keys(A[u.uid].devices || {}).length : 0, plan: Lc[u.uid] ? Lc[u.uid].plan : null, active: L.isActive(Lc[u.uid], now), expiresAt: Lc[u.uid] ? Lc[u.uid].expiresAt : null, revoked: !!(Lc[u.uid] && Lc[u.uid].revoked) }));
  },
  async 'accounts/detail'(b) { const [a, l] = await Promise.all([fsx.doc('accounts/' + b.uid).get(), fsx.doc('licenses/' + b.uid).get()]); return { account: a.exists ? a.data() : null, license: l.exists ? l.data() : null }; },
  async 'accounts/grant'(b) { return core.admin.grant(String(b.uid), b.plan); },
  async 'accounts/revokeLicense'(b) { return core.admin.revokeLicense(String(b.uid)); },
  async 'accounts/restoreLicense'(b) { return core.admin.restoreLicense(String(b.uid)); },
  async 'accounts/disable'(b) { await admin.auth().updateUser(String(b.uid), { disabled: !!b.disabled }); if (b.disabled) await admin.auth().revokeRefreshTokens(String(b.uid)); return { ok: true }; },
  async 'accounts/logoutAll'(b) { await admin.auth().revokeRefreshTokens(String(b.uid)); return { ok: true }; },
  async 'accounts/device'(b) { // op: remove | admin | key
    const ar = fsx.doc('accounts/' + b.uid), lr = fsx.doc('licenses/' + b.uid); const [a, l] = await Promise.all([ar.get(), lr.get()]); if (!a.exists) throw new Error('Conta sem dispositivos.');
    const acc = a.data(), lic = l.exists ? l.data() : null; if (!acc.devices[b.deviceId]) throw new Error('Dispositivo não existe.');
    if (b.op === 'remove') { delete acc.devices[b.deviceId]; if (acc.adminDeviceId === b.deviceId) acc.adminDeviceId = Object.keys(acc.devices)[0] || null; if (lic && lic.activeDeviceId === b.deviceId) { lic.activeDeviceId = acc.adminDeviceId; await lr.set(lic); } }
    else if (b.op === 'admin') acc.adminDeviceId = b.deviceId; else if (b.op === 'key') { if (!lic) throw new Error('Sem licença.'); lic.activeDeviceId = b.deviceId; await lr.set(lic); } else throw new Error('op inválida');
    await ar.set(acc); return { ok: true };
  },
};
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
http.createServer(async (req, res) => {
  try {
    const host = (req.headers.host || '').toLowerCase(); if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'host' }); // anti DNS-rebinding
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'", 'Cache-Control': 'no-store' }); return res.end(PAGE); }
    if (req.method !== 'POST' || !req.url.startsWith('/api/') || req.headers['x-bz7'] !== '1') return send(res, 404, { error: 'not found' });
    const route = req.url.slice(5), b = await body(req);
    if (route === 'login') {
      const ip = req.socket.remoteAddress, t = tries.get(ip) || { n: 0, at: Date.now() }; if (Date.now() - t.at > 60e3) { t.n = 0; t.at = Date.now(); } if (t.n >= 5) return send(res, 429, { error: 'Muitas tentativas. Aguarde 1 minuto.' });
      const ok = crypto.timingSafeEqual(Buffer.from(hashPw(String(b.password || ''), conf.salt), 'hex'), Buffer.from(conf.hash, 'hex')); if (!ok) { t.n++; tries.set(ip, t); return send(res, 401, { error: 'Senha incorreta.' }); }
      const tok = crypto.randomBytes(32).toString('hex'); sessions.set(tok, Date.now() + 30 * 60e3); return send(res, 200, { ok: true }, { 'Set-Cookie': `bz7panel=${tok}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!authed(req)) return send(res, 401, { error: 'login' });
    const fn = ROUTES[route]; if (!fn) return send(res, 404, { error: 'rota' });
    send(res, 200, { result: await fn(b) });
  } catch (e) { send(res, 400, { error: e.message }); }
}).listen(PORT, HOST, () => console.log(`Painel BZ7 em http://localhost:${PORT}  (somente este computador)`));
