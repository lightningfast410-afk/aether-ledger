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

// Deep canonicalization: recursively sorts object keys. The original used
// JSON.stringify(obj, Object.keys(obj).sort()), which passes the sorted
// top-level keys as a REPLACER ARRAY: nested objects were serialized with
// only the keys listed at the top level, silently dropping nested keys.
// This version sorts at every depth.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const now = () => new Date().toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// Transaction attestations are HMAC-SHA256 under a server-side secret.
// These are SERVER ATTESTATIONS, not signatures made with user-held
// private keys: anyone holding the secret can forge them, and a holder
// cannot independently prove authorship. See README.md.
let HMAC_SECRET = process.env.LEDGER_HMAC_SECRET || null;
if (!HMAC_SECRET && process.env.NODE_ENV === 'production') {
  console.error(
    'ERROR: LEDGER_HMAC_SECRET is not set and NODE_ENV=production. Refusing to start: ' +
    'transaction attestations would not verify after a restart. ' +
    'Set LEDGER_HMAC_SECRET to a stable secret from a secret store and restart.'
  );
  process.exit(1);
}
if (!HMAC_SECRET) {
  HMAC_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    'WARNING: LEDGER_HMAC_SECRET is not set. Using an ephemeral per-process HMAC secret: ' +
    'transaction attestations created by this process will NOT verify after a restart. ' +
    'Set LEDGER_HMAC_SECRET to a stable secret for persistent attestations.'
  );
}
const hmac = (value) => crypto.createHmac('sha256', HMAC_SECRET).update(value).digest('hex');

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

// Amounts and supplies are integers at the API boundary (the README
// examples already use integers). Columns stay REAL for storage, but
// fractional values are rejected here so float rounding can never split
// a unit.
function integerAmount(value, name) {
  positiveNumber(value, name);
  if (!Number.isInteger(value)) {
    throw error(`${name} must be a positive integer`);
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

function issueIdentity(name, role = 'holder') {
  const allowedRoles = ['holder', 'issuer', 'auditor', 'admin'];
  if (!allowedRoles.includes(role)) throw error('invalid role');

  const id = randomId('id');
  // publicKey is a NON-SECRET identifier. It is not a credential and is
  // never accepted for authentication.
  const publicKey = sha256(`${id}:${name}:${role}:${now()}`);
  // The bearer token is random and independent of the publicKey. Only
  // its SHA-256 is stored; the raw token is returned exactly once, at
  // creation, and never appears in any other response.
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const createdAt = now();

  db.prepare(`
    INSERT INTO identities (id, name, role, publicKey, tokenHash, createdAt, updatedAt, active, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, role, publicKey, tokenHash, createdAt, createdAt, JSON.stringify({ createdVia: 'api' }));

  return { id, name, role, publicKey, createdAt, token };
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
  return db.prepare('SELECT MAX("index") AS maxIndex FROM blocks').get()?.maxIndex ?? -1;
}

function createGenesisBlock() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM blocks').get().count;
  if (count > 0) return null;
  // Genesis has no miner identity, so miner is NULL (the column is
  // nullable). The original used the string 'genesis', which violated
  // the blocks.miner -> identities(id) foreign key on a fresh database.
  const block = createBlock(0, null);
  return block;
}

// SHA-256 over a block's transactions, as "id:signature" pairs in
// (timestamp, id) order. Empty string hash when the block has no
// transactions (identity/asset blocks carry no transaction rows).
function computeTxRoot(blockIndex) {
  const txs = db.prepare('SELECT id, signature FROM transactions WHERE blockIndex = ? ORDER BY timestamp, id').all(blockIndex);
  if (txs.length === 0) return sha256('');
  return sha256(txs.map((t) => `${t.id}:${t.signature}`).join('|'));
}

// Recomputes the server attestation a transaction row should carry.
// Returns null for unknown types (no re-verification possible).
function expectedTxSignature(tx) {
  if (tx.type === 'transfer') {
    return hmac(`${tx.id}:${tx.assetId}:${tx.from}:${tx.to}:${tx.amount}:${tx.timestamp}`);
  }
  if (tx.type === 'retire') {
    return hmac(`${tx.id}:${tx.assetId}:${tx.from}:retire:${tx.amount}:${tx.timestamp}`);
  }
  return null;
}

function createBlock(transactionCount, miner) {
  const index = getLatestBlockIndex() + 1;
  const previous = db.prepare('SELECT hash FROM blocks WHERE "index" = ?').get(index - 1);
  const previousHash = previous?.hash || '0'.repeat(64);
  const timestamp = now();
  // Transaction rows for this block are inserted BEFORE createBlock is
  // called (see the transfer/retire routes), so the root commits to them.
  const txRoot = computeTxRoot(index);
  const payload = { index, timestamp, previousHash, transactionCount, miner, nonce: 0, txRoot };
  const hash = sha256(canonical(payload));

  db.prepare(`
    INSERT INTO blocks ("index", hash, previousHash, timestamp, transactionCount, miner, nonce, txRoot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(index, hash, previousHash, timestamp, transactionCount, miner, 0, txRoot);

  return { index, hash, previousHash, timestamp, transactionCount, miner, txRoot };
}

function validateChain() {
  const blocks = db.prepare('SELECT "index", hash, previousHash, timestamp, transactionCount, miner, nonce, txRoot FROM blocks ORDER BY "index"').all();
  if (blocks.length === 0) return { valid: true, length: 0 };

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    // The chain commits to transaction contents: recompute this block's
    // txRoot from the transactions table and compare.
    const txRoot = computeTxRoot(block.index);
    if (txRoot !== block.txRoot) return { valid: false, index: i, reason: 'txRoot mismatch' };
    const payload = {
      index: block.index,
      timestamp: block.timestamp,
      previousHash: block.previousHash,
      transactionCount: block.transactionCount,
      miner: block.miner,
      nonce: block.nonce,
      txRoot: block.txRoot
    };
    const computedHash = sha256(canonical(payload));
    if (computedHash !== block.hash) return { valid: false, index: i, reason: 'hash mismatch' };
    if (i === 0 && block.previousHash !== '0'.repeat(64)) return { valid: false, index: i, reason: 'invalid genesis' };
    if (i > 0 && block.previousHash !== blocks[i - 1].hash) return { valid: false, index: i, reason: 'broken link' };
    // Defense in depth: re-verify each transaction attestation, so even
    // an edit that leaves the txRoot intact (impossible without the
    // signature, but checked anyway) or a row whose amount was edited
    // without touching its signature is caught.
    const txs = db.prepare('SELECT id, type, assetId, "from", "to", amount, signature, timestamp FROM transactions WHERE blockIndex = ?').all(block.index);
    for (const tx of txs) {
      const expected = expectedTxSignature(tx);
      if (expected !== null && expected !== tx.signature) {
        return { valid: false, index: i, reason: 'transaction signature mismatch' };
      }
    }
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
  const signature = hmac(`${txId}:${assetId}:${from}:${to}:${amount}:${timestamp}`);

  db.prepare(`
    INSERT INTO transactions (id, type, assetId, "from", "to", amount, signature, blockIndex, timestamp, status, metadata)
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
  const signature = hmac(`${txId}:${assetId}:${holderId}:retire:${amount}:${timestamp}`);

  db.prepare(`
    INSERT INTO transactions (id, type, assetId, "from", "to", amount, signature, blockIndex, timestamp, status, metadata)
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

// Ownership rule shared by the transfer/retire/asset routes: the caller
// must be the owner named in the body, unless the caller is an admin.
function requireOwnerOrAdmin(identity, ownerId, what) {
  if (identity.role !== 'admin' && identity.id !== ownerId) {
    throw error(`${what} must match the caller unless admin`, 403);
  }
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
      // Bootstrap rule: while the identities table is empty, any role
      // may be created (this is what makes the README quick-start work
      // for the first identity). Once bootstrapped, creating an
      // issuer/auditor/admin requires an authenticated admin; anyone
      // may still self-register as a holder.
      const identityCount = db.prepare('SELECT COUNT(*) AS count FROM identities').get().count;
      if (identityCount > 0 && role !== 'holder') {
        const caller = security.authenticate(req);
        if (caller.role !== 'admin') {
          throw error('admin role required to create privileged identities', 403);
        }
      }
      const created = issueIdentity(name, role);
      const block = createBlock(1, created.id);
      security.logAudit('IDENTITY_CREATED', created.id, 'create-identity', 'identities', true, { role });
      // The token is returned exactly once, here, at creation. It is
      // deliberately NOT part of the identity object, and no other
      // endpoint returns it (or the stored tokenHash) anywhere.
      const { token, ...identity } = created;
      return send(res, 201, { identity, token, block });
    }

    // Single authentication path (security.authenticate); the server's
    // old duplicate authenticateRequest was removed.
    const identity = security.authenticate(req);
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
      const vertical = requiredString(body.vertical, 'vertical');
      const name = requiredString(body.name, 'name', 200);
      const issuerId = requiredString(body.issuerId, 'issuerId');
      const supply = integerAmount(body.supply, 'supply');
      security.authorize(identity, 'issue', 'asset');
      requireOwnerOrAdmin(identity, issuerId, 'issuerId');
      const asset = createAssetRecord({
        vertical,
        name,
        issuerId,
        supply,
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
      const assetId = requiredString(body.assetId, 'assetId');
      const from = requiredString(body.from, 'from');
      const to = requiredString(body.to, 'to');
      const amount = integerAmount(body.amount, 'amount');
      security.authorize(identity, 'transfer', 'asset-transfer');
      requireOwnerOrAdmin(identity, from, 'from');
      const transfer = doTransfer({ assetId, from, to, amount, actorId: identity.id });
      const block = createBlock(1, identity.id);
      security.logAudit('TRANSFER', identity.id, 'transfer', transfer.assetId, true, { from: transfer.from, to: transfer.to, amount: transfer.amount });
      return send(res, 201, { transaction: transfer, block, balances: getBalances(transfer.assetId) });
    }

    if (req.method === 'POST' && url.pathname === '/v1/retire') {
      const body = await parseJsonBody(req);
      const assetId = requiredString(body.assetId, 'assetId');
      const holderId = requiredString(body.holderId, 'holderId');
      const amount = integerAmount(body.amount, 'amount');
      security.authorize(identity, 'retire', 'asset-retirement');
      requireOwnerOrAdmin(identity, holderId, 'holderId');
      const retire = retireCredits({ assetId, holderId, amount, actorId: identity.id });
      const block = createBlock(1, identity.id);
      security.logAudit('RETIRE', identity.id, 'retire', retire.assetId, true, { holderId: retire.holderId, amount: retire.amount });
      return send(res, 201, { transaction: retire, block });
    }

    if (req.method === 'GET' && url.pathname === '/v1/blocks') {
      security.authorize(identity, 'view', 'blocks');
      const rows = db.prepare('SELECT "index", hash, previousHash, timestamp, transactionCount, miner, txRoot FROM blocks ORDER BY "index"').all();
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

    if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'identities' && parts[2] && parts[3] === 'revoke') {
      // Anti-theft kill switch: a stolen bearer token is killed here.
      // Authentication already rejects inactive identities, so a revoked
      // token stops working immediately on every later request.
      if (identity.role !== 'admin') throw error('admin role required to revoke identities', 403);
      const targetId = parts[2];
      if (targetId === identity.id) throw error('an admin cannot revoke their own identity', 400);
      const target = db.prepare('SELECT id, active FROM identities WHERE id = ?').get(targetId);
      if (!target) throw error('identity not found', 404);
      if (!target.active) throw error('identity already revoked', 400);
      db.prepare('UPDATE identities SET active = 0, updatedAt = ? WHERE id = ?').run(now(), targetId);
      security.logAudit('IDENTITY_REVOKED', identity.id, 'revoke', targetId, true, {});
      return send(res, 200, { identity: { id: targetId, active: false }, revoked: true });
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
