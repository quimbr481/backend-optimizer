'use strict';

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { makeCore, HErr } = require('./lib/core');

admin.initializeApp();

const app = express();

// Middlewares para aceitar requisições JSON e CORS
app.use(cors({ origin: true }));
app.use(express.json());

const db = require('./lib/fsdb')(admin);
let catalog = []; 
try { 
  catalog = require('./catalog.json'); 
} catch { 
  /* sem catálogo: premium vazio */ 
}

const core = makeCore(db, Date.now, catalog);

// Middleware para simular a autenticação do Firebase no Render
const parseAuth = async (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    return {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: !!decodedToken.email_verified,
      name: decodedToken.name
    };
  } catch {
    return null;
  }
};

// Helper para executar as rotas mantendo a lógica de erros HErr
const handleRequest = (fn) => async (req, res) => {
  try {
    const auth = await parseAuth(req);
    const data = req.body || {};
    const result = await fn(auth, data);
    res.json({ result });
  } catch (e) {
    if (e instanceof HErr) {
      res.status(400).json({ error: { status: e.code, message: e.message } });
    } else {
      console.error(e);
      res.status(500).json({ error: { status: 'internal', message: 'Erro interno. Tente novamente.' } });
    }
  }
};

// Rota de teste para ver se o servidor está online no navegador
app.get('/', (req, res) => {
  res.send('Servidor BZ7 Backend rodando no Render!');
});

// Endpoint único estilo Firebase Functions (mantém compatibilidade)
app.post('/bz7Call', async (req, res) => {
  const { action, data } = req.body || {};
  const routes = {
    register: (a, d) => core.register(a, d),
    state: (a, d) => core.state(a, d),
    redeem: (a, d) => core.redeem(a, d),
    moveKey: (a, d) => core.moveKey(a, d),
    removeDevice: (a, d) => core.removeDevice(a, d),
    transferAdmin: (a, d) => core.transferAdmin(a, d),
    leave: (a, d) => core.leave(a, d),
    premium: (a, d) => core.premium(a, d)
  };

  if (!routes[action]) {
    return res.status(404).json({ error: 'Ação não encontrada' });
  }

  return handleRequest(routes[action])(req, res);
});

// Rotas HTTP individuais
app.post('/bz7Register', handleRequest((a, d) => core.register(a, d)));
app.post('/bz7State', handleRequest((a, d) => core.state(a, d)));
app.post('/bz7Redeem', handleRequest((a, d) => core.redeem(a, d)));
app.post('/bz7MoveKey', handleRequest((a, d) => core.moveKey(a, d)));
app.post('/bz7RemoveDevice', handleRequest((a, d) => core.removeDevice(a, d)));
app.post('/bz7TransferAdmin', handleRequest((a, d) => core.transferAdmin(a, d)));
app.post('/bz7Leave', handleRequest((a, d) => core.leave(a, d)));
app.post('/bz7Premium', handleRequest((a, d) => core.premium(a, d)));

// ==========================================
// INICIALIZAÇÃO DA PORTA PARA O RENDER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando com sucesso na porta ${PORT}`);
});
