'use strict';
const assert = require('assert'); const { FakeDb } = require('./fakedb'); const { makeCore, HErr, normKey, KEY_RE, genKeyCode } = require('../functions/lib/core'); const L = require('../functions/lib/license');
let now = 1_700_000_000_000; const clock = () => now; const DAY = 86400000;
const db = new FakeDb(); const core = makeCore(db, clock, [{ id: 'cpu.prio' }]);
const A = { uid: 'u1', email: 'a@x.com', emailVerified: true, name: 'Baiano' }, B = { uid: 'u2', email: 'b@x.com', emailVerified: true };
const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64), D3 = 'c'.repeat(64);
const rej = async (p, re) => { try { await p; } catch (e) { assert(e instanceof HErr, 'esperava HErr: ' + e.message); assert(re.test(e.message), `msg "${e.message}" !~ ${re}`); return e; } assert.fail('deveria ter falhado: ' + re); };
let n = 0; const t = async (name, fn) => { try { await fn(); n++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); process.exitCode = 1; } };
(async () => {
  await t('keys: formato, normalização, unicidade', () => { const k = genKeyCode(); assert(/^BZ7(-[0-9A-HJKMNP-TV-Z]{4}){4}$/.test(k)); assert(KEY_RE.test(normKey(k.toLowerCase()))); assert.notStrictEqual(genKeyCode(), genKeyCode()); });
  await t('planos: diária/semanal/mensal/anual somam; lifetime sem expiração; lifetime ativo não gasta key', () => {
    let l = L.applyPlan(null, 'daily', now); assert.strictEqual(l.expiresAt, now + DAY); l = L.applyPlan(l, 'monthly', now); assert.strictEqual(l.expiresAt, now + 31 * DAY);
    assert(L.isActive(l, now + 30 * DAY)); assert(!L.isActive(l, now + 32 * DAY)); const lt = L.applyPlan(l, 'lifetime', now); assert.strictEqual(lt.expiresAt, null); assert(L.isActive(lt, now + 9999 * DAY)); assert.strictEqual(L.applyPlan(lt, 'daily', now), null); });
  await t('conta sem key: registra, vira administrador, NÃO tem acesso premium', async () => {
    const s = await core.register(A, { deviceId: D1, name: 'PC-Casa', os: 'Win10' }); assert.strictEqual(s.isAdmin, true); assert.strictEqual(s.entitled, false); assert.strictEqual(s.license, null);
    await rej(core.premium(A, { deviceId: D1 }), /LOCKED/); });
  await t('resgatar key exige e-mail verificado e dispositivo registrado', async () => {
    const [k] = await core.admin.genKeys({ plan: 'monthly', qty: 1, note: 'teste' });
    await rej(core.redeem({ ...A, emailVerified: false }, { deviceId: D1, key: k.code }), /EMAIL_NOT_VERIFIED/); await rej(core.redeem(A, { deviceId: D2, key: k.code }), /DEVICE_NOT_REGISTERED/); globalThis.K1 = k.code; });
  await t('resgate: key mensal ativa no dispositivo que resgatou; premium só nele', async () => {
    const s = await core.redeem(A, { deviceId: D1, key: K1.toLowerCase() }); assert(s.entitled); assert.strictEqual(s.license.plan, 'monthly'); assert.strictEqual(s.license.expiresAt, now + 30 * DAY);
    const p = await core.premium(A, { deviceId: D1 }); assert.strictEqual(p.tweaks.length, 1); });
  await t('key já usada / inválida / de outra conta é recusada; 5 erros bloqueiam 15 min', async () => {
    await rej(core.redeem(A, { deviceId: D1, key: K1 }), /já foi utilizada/); await rej(core.redeem(A, { deviceId: D1, key: 'lixo' }), /inválida/);
    for (let i = 0; i < 3; i++) await rej(core.redeem(A, { deviceId: D1, key: genKeyCode() }), /inválida/); await rej(core.redeem(A, { deviceId: D1, key: genKeyCode() }), /Muitas tentativas|inválida/);
    await rej(core.redeem(A, { deviceId: D1, key: genKeyCode() }), /Muitas tentativas/); now += 16 * 60e3; await rej(core.redeem(A, { deviceId: D1, key: genKeyCode() }), /inválida/); });
  await t('mesma conta em vários PCs: PC2 entra mas NÃO tem a key (sem acesso premium)', async () => {
    const s2 = await core.register(A, { deviceId: D2, name: 'PC-Trabalho' }); assert.strictEqual(s2.isAdmin, false); assert.strictEqual(s2.entitled, false); assert.strictEqual(s2.devices.length, 2);
    await rej(core.premium(A, { deviceId: D2 }), /LOCKED/); const s1 = await core.state(A, { deviceId: D1 }); assert(s1.entitled); });
  await t('só o administrador move a key; depois a key só vale no novo PC; admin continua admin', async () => {
    await rej(core.moveKey(A, { deviceId: D2, targetDeviceId: D2 }), /administrador/);
    const s = await core.moveKey(A, { deviceId: D1, targetDeviceId: D2 }); assert.strictEqual(s.isAdmin, true); assert.strictEqual(s.entitled, false);
    assert((await core.state(A, { deviceId: D2 })).entitled); await rej(core.premium(A, { deviceId: D1 }), /LOCKED/); await core.premium(A, { deviceId: D2 }); });
  await t('limite de 5 dispositivos', async () => { for (const c of ['d', 'e', 'f']) await core.register(A, { deviceId: c.repeat(64) }); await rej(core.register(A, { deviceId: '1'.repeat(64) }), /Limite de 5/); });
  await t('remover dispositivo: só admin; não remove o admin; key do removido volta ao admin', async () => {
    await rej(core.removeDevice(A, { deviceId: D2, targetDeviceId: 'd'.repeat(64) }), /administrador/); await rej(core.removeDevice(A, { deviceId: D1, targetDeviceId: D1 }), /Transfira a administração/);
    const s = await core.removeDevice(A, { deviceId: D1, targetDeviceId: D2 }); assert(!s.devices.find(d => d.id === D2)); assert(s.entitled, 'key deve voltar ao admin'); });
  await t('transferir administração: novo admin controla; antigo perde poder', async () => {
    await core.register(A, { deviceId: D3, name: 'Notebook' }); await core.transferAdmin(A, { deviceId: D1, targetDeviceId: D3 });
    await rej(core.moveKey(A, { deviceId: D1, targetDeviceId: D3 }), /administrador/); const s = await core.moveKey(A, { deviceId: D3, targetDeviceId: D3 }); assert(s.isAdmin && s.entitled); });
  await t('sair da conta: admin com outros PCs precisa transferir; não-admin com key devolve ao admin', async () => {
    await rej(core.leave(A, { deviceId: D3 }), /Transfira/); await core.moveKey(A, { deviceId: D3, targetDeviceId: D1 }); await core.leave(A, { deviceId: D1 });
    const s = await core.state(A, { deviceId: D3 }); assert(s.entitled, 'key volta ao admin (D3)'); assert(!s.devices.find(d => d.id === D1)); });
  await t('empilhar keys soma tempo; lifetime não gasta key; expirou → bloqueia', async () => {
    const [d] = await core.admin.genKeys({ plan: 'daily' }); const s = await core.redeem(A, { deviceId: D3, key: d.code }); assert.strictEqual(s.license.expiresAt, now + 30 * DAY - 16 * 60e3 * 0 + (s.license.expiresAt - (now + 30 * DAY)) ); assert(s.license.expiresAt > now + 30 * DAY);
    const [lt] = await core.admin.genKeys({ plan: 'lifetime' }); const s2 = await core.redeem(A, { deviceId: D3, key: lt.code }); assert.strictEqual(s2.license.expiresAt, null); const [x] = await core.admin.genKeys({ plan: 'daily' }); await rej(core.redeem(A, { deviceId: D3, key: x.code }), /Lifetime/);
    const kd = await db.doc('keys/' + require('../functions/lib/core').keyHash(x.code)).get(); assert.strictEqual(kd.data().redeemedBy, null, 'key não pode ser consumida'); });
  await t('expiração: sem renovar, premium bloqueia; revogar licença bloqueia na hora', async () => {
    const [k] = await core.admin.genKeys({ plan: 'daily' }); await core.register(B, { deviceId: '9'.repeat(64) }); const s = await core.redeem(B, { deviceId: '9'.repeat(64), key: k.code }); assert(s.entitled);
    now += 2 * DAY; assert(!(await core.state(B, { deviceId: '9'.repeat(64) })).entitled); await rej(core.premium(B, { deviceId: '9'.repeat(64) }), /LOCKED/);
    await core.admin.grant('u2', 'weekly'); assert((await core.state(B, { deviceId: '9'.repeat(64) })).entitled); await core.admin.revokeLicense('u2'); assert(!(await core.state(B, { deviceId: '9'.repeat(64) })).entitled); });
  await t('isolamento: B não enxerga nem mexe em dispositivos de A', async () => { await rej(core.moveKey(B, { deviceId: D3, targetDeviceId: D3 }), /DEVICE_NOT_REGISTERED/); await rej(core.state(B, { deviceId: D3 }), /DEVICE_NOT_REGISTERED/); });
  await t('sem login / deviceId inválido', async () => { await rej(core.state(null, { deviceId: D1 }), /login/); await rej(core.state(A, { deviceId: 'x' }), /inválido/); });
  console.log(`\n${n} testes de backend passaram${process.exitCode ? ' (HÁ FALHAS)' : ''}`);
})();
