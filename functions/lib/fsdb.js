'use strict';
// Adaptador firebase-admin → interface usada pelo core (compartilhado entre Cloud Functions e painel do dono).
module.exports = function makeDb(admin) {
  const fs = admin.firestore();
  return {
    raw: fs,
    doc: path => { const r = fs.doc(path); return { path, get: async () => { const s = await r.get(); return { exists: s.exists, data: () => s.data() }; }, set: v => r.set(v) }; },
    runTransaction: fn => fs.runTransaction(async t => fn({
      get: async ref => { const s = await t.get(fs.doc(ref.path)); return { exists: s.exists, data: () => s.data() }; },
      set: (ref, v) => t.set(fs.doc(ref.path), v),
    })),
  };
};
