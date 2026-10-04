'use strict';
// Regras de licença (puras, sem I/O) — testadas em backend/tests.
const DAY = 86400000;
const PLANS = {
  daily:    { days: 1,    label: 'Diária' },
  weekly:   { days: 7,    label: 'Semanal' },
  monthly:  { days: 30,   label: 'Mensal' },
  yearly:   { days: 365,  label: 'Anual' },
  lifetime: { days: null, label: 'Lifetime' },
};
const planLabel = p => (PLANS[p] ? PLANS[p].label : String(p));
function isActive(lic, now) {
  if (!lic || lic.revoked) return false;
  if (lic.plan === 'lifetime') return true;
  return Number(lic.expiresAt || 0) > now;
}
/** Soma o plano à licença atual. Retorna null se a conta já é Lifetime ativa (a key não deve ser gasta à toa). */
function applyPlan(lic, plan, now) {
  const p = PLANS[plan]; if (!p) throw new Error('Plano inválido: ' + plan);
  const active = isActive(lic, now);
  if (plan === 'lifetime') return { ...(lic || {}), plan, expiresAt: null, revoked: false, activatedAt: active && lic.activatedAt ? lic.activatedAt : now };
  if (active && lic.plan === 'lifetime') return null;
  const base = active ? lic.expiresAt : now;
  return { ...(lic || {}), plan, expiresAt: base + p.days * DAY, revoked: false, activatedAt: active && lic.activatedAt ? lic.activatedAt : now };
}
module.exports = { PLANS, DAY, planLabel, isActive, applyPlan };
