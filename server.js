#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { SecurityEngine, VERTICALS } = require('./config/security');
const { initializeDatabase } = require('./config/database');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'aether.db');
const MAX_BODY_BYTES = 1024 * 1024;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (obj) => JSON.stringify(obj, Object.keys(obj).sort());
const now = () => new Date().toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

const db = initializeDatabase(DB_FILE);
const security = new SecurityEngine(db);

function error(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requiredString(value, name, max = 256) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw error(`${name} must be a non-empty string (max ${max} characters)`);
  }
  return value.trim();
}

function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw error(`${name} must be a positive number`);
  }
  return value;
}

function send(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(error('request body is too large', 413));
        req.destroy();
      }
      body += chunk;
    });

    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(error('request body must be valid JSON'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function ensureIdentityExists(id) {
  const identity = db.prepare('SELECT id, name, role, publicKey, createdAt FROM identities WHERE id = ? AND active = 1').get(id);
  if (!identity) throw error('identity not found', 404);
  return identity;
}

function getIdentityByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT id, name, role, publicKey FROM identities WHERE publicKey = ? AND active = 1').get(token);
}

function authenticateRequest(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (!token) throw error('Missing Authorization header. Use Bearer <token>', 401);

  const identity = getIdentityByToken(token);
  if (!identity) throw error('Invalid or expired bearer token', 401);
  return identity;
}

function issueIdentity(name, role = 'holder') {
  const allowedRoles = ['holder', 'issuer', 'auditor', 'admin'];
  if (!allowedRoles.includes(role)) throw error('invalid role');

  const id = randomId('id');
  const publicKey = sha256(`${id}:${name}:${role}:${now()}`);
  const createdAt = now();

  db.prepare(`
    INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, role, publicKey, createdAt, createdAt, JSON.stringify({ createdVia: 'api' }));

  return { id, name, role, publicKey, createdAt, token: publicKey };
}

function getAsset(assetId) {
  const asset = db.prepare(`
    SELECT id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt
    FROM assets WHERE id = ?
  `).get(assetId);

  if (!asset) return null;
  asset.metadata = asset.metadata ? JSON.parse(asset.metadata) : {};
  return asset;
}

function listAssets(vertical = null) {
  let query = 'SELECT id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt FROM assets';
  const params = [];
  if (vertical) {
    query += ' WHERE vertical = ?';
    params.push(vertical);
  }
  const rows = db.prepare(query).all(...params);
  return rows.map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : {} }));
}

function getBalances(assetId) {
  return db.prepare('SELECT holderId, amount FROM balances WHERE assetId = ? ORDER BY holderId').all(assetId);
}

function getLatestBlockIndex() {
  return db.prepare('SELECT MAX(index) AS maxIndex FROM blocks').get()?.maxIndex ?? -1;
}

function createGenesisBlock() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM blocks').get().count;
  if (count > 0) return null;
  const block = createBlock(0, 'genesis');
  return block;
}

function createBlock(transactionCount, miner) {
  const index = getLatestBlockIndex() + 1;
  const previous = db.prepare('SELECT hash FROM blocks WHERE index = ?').get(index - 1);
  const previousHash = previous?.hash || '0'.repeat(64);
  const timestamp = now();
  const payload = { index, timestamp, previousHash, transactionCount, miner, nonce: 0 };
  const hash = sha256(canonical(payload));

  db.prepare(`
    INSERT INTO blocks (index, hash, previousHash, timestamp, transactionCount, miner, nonce)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(index, hash, previousHash, timestamp, transactionCount, miner, 0);

  return { index, hash, previousHash, timestamp, transactionCount, miner };
}

function validateChain() {
  const blocks = db.prepare('SELECT index, hash, previousHash, timestamp, transactionCount, miner, nonce FROM blocks ORDER BY index').all();
  if (blocks.length === 0) return { valid: true, length: 0 };

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const payload = {
      index: block.index,
      timestamp: block.timestamp,
      previousHash: block.previousHash,
      transactionCount: block.transactionCount,
      miner: block.miner,
      nonce: block.nonce
    };
    const computedHash = sha256(canonical(payload));
    if (computedHash !== block.hash) return { valid: false, index: i, reason: 'hash mismatch' };
    if (i === 0 && block.previousHash !== '0'.repeat(64)) return { valid: false, index: i, reason: 'invalid genesis' };
    if (i > 0 && block.previousHash !== blocks[i - 1].hash) return { valid: false, index: i, reason: 'broken link' };
  }

  return { valid: true, length: blocks.length };
}

function createAssetRecord({ vertical, name, issuerId, supply, metadata = {}, description = '' }) {
  if (!VERTICALS[vertical]) throw error('invalid vertical');

  const issuer = ensureIdentityExists(issuerId);
  if (issuer.role !== 'issuer' && issuer.role !== 'admin') {
    throw error('issuer role required');
  }

  const assetId = randomId('ast');
  const timestamp = now();

  db.prepare(`
    INSERT INTO assets (id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(assetId, vertical, name, description, issuerId, supply, supply, JSON.stringify(metadata), timestamp, timestamp);

  db.prepare(`
    INSERT INTO balances (assetId, holderId, amount, updatedAt)
    VALUES (?, ?, ?, ?)
  `).run(assetId, issuerId, supply, timestamp);

  return getAsset(assetId);
}

function doTransfer({ assetId, from, to, amount, actorId }) {
  const asset = getAsset(assetId);
  if (!asset) throw error('asset not found', 404);

  ensureIdentityExists(from);
  ensureIdentityExists(to);

  const currentBalance = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, from)?.amount || 0;
  if (currentBalance < amount) throw error('insufficient balance');

  const txId = randomId('tx');
  const timestamp = now();
  const blockIndex = getLatestBlockIndex() + 1;
  const signature = sha256(`${txId}:${assetId}:${from}:${to}:${amount}:${timestamp}`);

  db.prepare(`
    INSERT INTO transactions (id, type, assetId, from, to, amount, signature, blockIndex, timestamp, status, metadata)
    VALUES (?, 'transfer', ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)
  `).run(txId, assetId, from, to, amount, signature, blockIndex, timestamp, JSON.stringify({ actorId }));

  db.prepare('UPDATE balances SET amount = amount - ?, updatedAt = ? WHERE assetId = ? AND holderId = ?').run(amount, timestamp, assetId, from);
  db.prepare(`
    INSERT INTO balances (assetId, holderId, amount, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(assetId, holderId)
    DO UPDATE SET amount = amount + excluded.amount, updatedAt = excluded.updatedAt
  `).run(assetId, to, amount, timestamp);

  return { id: txId, type: 'transfer', assetId, from, to, amount, signature, timestamp };
}

function retireCredits({ assetId, holderId, amount, actorId }) {
  const asset = getAsset(assetId);
  if (!asset) throw error('asset not found', 404);
  if (!VERTICALS[asset.vertical].retireable) throw error(`${asset.vertical} cannot be retired`);

  const currentBalance = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, holderId)?.amount || 0;
  if (currentBalance < amount) throw error('insufficient balance');

  const txId = randomId('tx');
  const timestamp = now();
  const blockIndex = getLatestBlockIndex() + 1;
  const signature = sha256(`${txId}:${assetId}:${holderId}:retire:${amount}:${timestamp}`);

  db.prepare(`
    INSERT INTO transactions (id, type, assetId, from, to, amount, signature, blockIndex, timestamp, status, metadata)
    VALUES (?, 'retire', ?, ?, NULL, ?, ?, ?, ?, 'confirmed', ?)
  `).run(txId, assetId, holderId, amount, signature, blockIndex, timestamp, JSON.stringify({ actorId, retirement: true }));

  db.prepare('UPDATE balances SET amount = amount - ?, updatedAt = ? WHERE assetId = ? AND holderId = ?').run(amount, timestamp, assetId, holderId);
  db.prepare('UPDATE assets SET circulatingSupply = circulatingSupply - ?, retiredSupply = retiredSupply + ?, updatedAt = ? WHERE id = ?').run(amount, amount, timestamp, assetId);

  return { id: txId, type: 'retire', assetId, holderId, amount, signature, timestamp };
}

function makeAudit(assetId, auditorId) {
  const asset = getAsset(assetId);
  if (!asset) throw error('asset not found', 404);

  const balances = getBalances(assetId);
  const totalBalance = balances.reduce((sum, row) => sum + Number(row.amount), 0) + Number(asset.retiredSupply || 0);
  const txCount = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE assetId = ?').get(assetId).count;
  const result = {
    valid: Number(totalBalance) === Number(asset.supply),
    assetId,
    supply: Number(asset.supply),
    totalBalance,
    retired: Number(asset.retiredSupply || 0),
    holders: balances.length,
    transactions: txCount,
    chainValid: validateChain().valid
  };

  db.prepare(`
    INSERT INTO audits (id, assetId, auditorId, result, status, timestamp)
    VALUES (?, ?, ?, ?, 'completed', ?)
  `).run(randomId('audit'), assetId, auditorId, JSON.stringify(result), now());

  return result;
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        status: 'ok',
        service: 'aether-ledger',
        chainLength: getLatestBlockIndex() + 1,
        integrity: validateChain()
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/identities') {
      const body = await parseJsonBody(req);
      const name = requiredString(body.name, 'name', 128);
      const role = body.role || 'holder';
      const created = issueIdentity(name, role);
      const block = createBlock(1, created.id);
      security.logAudit('IDENTITY_CREATED', created.id, 'create-identity', 'identities', true, { role });
      return send(res, 201, { identity: created, token: created.token, block });
    }

    const identity = authenticateRequest(req);
    security.checkRateLimit(identity.id, `${req.method}:${url.pathname}`, 100, 60);

    if (req.method === 'GET' && url.pathname === '/v1/identities') {
      security.authorize(identity, 'view', 'identities');
      const rows = db.prepare('SELECT id, name, role, publicKey, createdAt FROM identities WHERE active = 1 ORDER BY createdAt DESC').all();
      return send(res, 200, { identities: rows });
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'identities' && parts[2]) {
      security.authorize(identity, 'view', 'identity');
      const row = db.prepare('SELECT id, name, role, publicKey, createdAt FROM identities WHERE id = ?').get(parts[2]);
      if (!row) throw error('identity not found', 404);
      return send(res, 200, row);
    }

    if (req.method === 'GET' && url.pathname === '/v1/assets') {
      security.authorize(identity, 'view', 'assets');
      return send(res, 200, { assets: listAssets(url.searchParams.get('vertical') || null), verticals: VERTICALS });
    }

    if (req.method === 'POST' && url.pathname === '/v1/assets') {
      const body = await parseJsonBody(req);
      security.authorize(identity, 'issue', 'asset');
      const asset = createAssetRecord({
        vertical: requiredString(body.vertical, 'vertical'),
        name: requiredString(body.name, 'name', 200),
        issuerId: requiredString(body.issuerId, 'issuerId'),
        supply: positiveNumber(body.supply, 'supply'),
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
        description: typeof body.description === 'string' ? body.description : ''
      });
      const block = createBlock(1, identity.id);
      security.logAudit('ASSET_ISSUED', identity.id, 'issue', asset.id, true, { vertical: asset.vertical, supply: asset.supply });
      return send(res, 201, { asset, block });
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'assets' && parts[2]) {
      security.authorize(identity, 'view', 'asset');
      const asset = getAsset(parts[2]);
      if (!asset) throw error('asset not found', 404);
      return send(res, 200, { asset, balances: getBalances(asset.id) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/transfers') {
      const body = await parseJsonBody(req);
      security.authorize(identity, 'transfer', 'asset-transfer');
      const transfer = doTransfer({
        assetId: requiredString(body.assetId, 'assetId'),
        from: requiredString(body.from, 'from'),
        to: requiredString(body.to, 'to'),
        amount: positiveNumber(body.amount, 'amount'),
        actorId: identity.id
      });
      const block = createBlock(1, identity.id);
      security.logAudit('TRANSFER', identity.id, 'transfer', transfer.assetId, true, { from: transfer.from, to: transfer.to, amount: transfer.amount });
      return send(res, 201, { transaction: transfer, block, balances: getBalances(transfer.assetId) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/retire') {
      const body = await parseJsonBody(req);
      security.authorize(identity, 'retire', 'asset-retirement');
      const retire = retireCredits({
        assetId: requiredString(body.assetId, 'assetId'),
        holderId: requiredString(body.holderId, 'holderId'),
        amount: positiveNumber(body.amount, 'amount'),
        actorId: identity.id
      });
      const block = createBlock(1, identity.id);
      security.logAudit('RETIRE', identity.id, 'retire', retire.assetId, true, { holderId: retire.holderId, amount: retire.amount });
      return send(res, 201, { transaction: retire, block });
    }

    if (req.method === 'GET' && url.pathname === '/v1/blocks') {
      security.authorize(identity, 'view', 'blocks');
      const rows = db.prepare('SELECT index, hash, previousHash, timestamp, transactionCount, miner FROM blocks ORDER BY index').all();
      return send(res, 200, { blocks: rows });
    }

    if (req.method === 'GET' && url.pathname === '/v1/transactions') {
      security.authorize(identity, 'view', 'transactions');
      const assetId = url.searchParams.get('assetId');
      if (assetId) {
        const rows = db.prepare('SELECT * FROM transactions WHERE assetId = ? ORDER BY blockIndex DESC').all(assetId);
        return send(res, 200, { transactions: rows });
      }
      const rows = db.prepare('SELECT * FROM transactions ORDER BY blockIndex DESC').all();
      return send(res, 200, { transactions: rows });
    }

    if (req.method === 'GET' && url.pathname === '/v1/verify') {
      security.authorize(identity, 'audit', 'verify');
      return send(res, 200, validateChain());
    }

    if (req.method === 'POST' && url.pathname === '/v1/audit') {
      const body = await parseJsonBody(req);
      security.authorize(identity, 'audit', 'audit');
      const assetId = requiredString(body.assetId, 'assetId');
      const asset = getAsset(assetId);
      if (!asset) throw error('asset not found', 404);
      const result = makeAudit(assetId, identity.id);
      security.logAudit('AUDIT', identity.id, 'audit', assetId, true, result);
      return send(res, 200, { audit: result });
    }

    if (req.method === 'GET' && url.pathname === '/v1/export') {
      security.authorize(identity, 'export', 'audit-export');
      const start = url.searchParams.get('start') || '2000-01-01T00:00:00.000Z';
      const end = url.searchParams.get('end') || now();
      const logs = security.exportAuditLog(start, end);
      return send(res, 200, { export: logs });
    }

    throw error('route not found', 404);
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: err.message || 'internal server error' });
  }
}

const server = http.createServer(handler);
createGenesisBlock();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Aether Ledger listening on http://localhost:${PORT}`);
    console.log(`DB: ${DB_FILE}`);
  });
}

module.exports = { server, db, security, createGenesisBlock, createBlock, validateChain };

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => process.exit(0));
});
