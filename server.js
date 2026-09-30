#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'aether.db');
const MAX_BODY_BYTES = 1024 * 1024;

const VERTICALS = {
  real_estate: { name: 'Real Estate', unit: 'token', retireable: false },
  supply_chain: { name: 'Supply Chain', unit: 'unit', retireable: false },
  carbon_credits: { name: 'Carbon Credits', unit: 'tCO2e', retireable: true }
};

const ROLES = {
  admin: { permissions: ['*'] },
  issuer: { permissions: ['issue', 'transfer', 'audit'] },
  holder: { permissions: ['transfer', 'view'] },
  auditor: { permissions: ['audit', 'view'] },
  retired: { permissions: ['view'] }
};

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const now = () => new Date().toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

class Database_ {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'holder',
        publicKey TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        vertical TEXT NOT NULL,
        name TEXT NOT NULL,
        issuerId TEXT NOT NULL,
        supply REAL NOT NULL,
        circulatingSupply REAL NOT NULL,
        retiredSupply REAL NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (issuerId) REFERENCES identities(id)
      );

      CREATE TABLE IF NOT EXISTS balances (
        assetId TEXT NOT NULL,
        holderId TEXT NOT NULL,
        amount REAL NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (assetId, holderId),
        FOREIGN KEY (assetId) REFERENCES assets(id),
        FOREIGN KEY (holderId) REFERENCES identities(id)
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        assetId TEXT NOT NULL,
        from TEXT,
        to TEXT,
        amount REAL NOT NULL,
        signature TEXT NOT NULL,
        blockIndex INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY (assetId) REFERENCES assets(id),
        FOREIGN KEY (from) REFERENCES identities(id),
        FOREIGN KEY (to) REFERENCES identities(id)
      );

      CREATE TABLE IF NOT EXISTS blocks (
        index INTEGER PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        previousHash TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        transactionCount INTEGER NOT NULL,
        miner TEXT NOT NULL,
        nonce INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS audits (
        id TEXT PRIMARY KEY,
        assetId TEXT NOT NULL,
        auditorId TEXT NOT NULL,
        result TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (assetId) REFERENCES assets(id),
        FOREIGN KEY (auditorId) REFERENCES identities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_balances_holder ON balances(holderId);
      CREATE INDEX IF NOT EXISTS idx_transactions_asset ON transactions(assetId);
      CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from);
      CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to);
      CREATE INDEX IF NOT EXISTS idx_assets_vertical ON assets(vertical);
    `);
  }

  createIdentity(name, role = 'holder') {
    if (!ROLES[role]) throw new Error('invalid role');
    const id = randomId('id');
    const publicKey = sha256(id).substring(0, 32);
    const stmt = this.db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt) VALUES (?, ?, ?, ?, ?)');
    stmt.run(id, name, role, publicKey, now());
    return { id, name, role, publicKey };
  }

  getIdentity(id) {
    return this.db.prepare('SELECT id, name, role, publicKey, createdAt FROM identities WHERE id = ?').get(id);
  }

  listIdentities() {
    return this.db.prepare('SELECT id, name, role, publicKey, createdAt, active FROM identities WHERE active = 1').all();
  }

  deactivateIdentity(id) {
    const stmt = this.db.prepare('UPDATE identities SET active = 0 WHERE id = ?');
    stmt.run(id);
  }

  issueAsset(vertical, name, issuerId, supply, metadata = {}) {
    if (!VERTICALS[vertical]) throw new Error('invalid vertical');
    const identity = this.getIdentity(issuerId);
    if (!identity) throw new Error('issuer not found');
    if (identity.role !== 'issuer' && identity.role !== 'admin') throw new Error('unauthorized to issue');

    const id = randomId('ast');
    const stmt = this.db.prepare(
      'INSERT INTO assets (id, vertical, name, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(id, vertical, name, issuerId, supply, supply, 0, JSON.stringify(metadata), now());

    const balanceStmt = this.db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)');
    balanceStmt.run(id, issuerId, supply, now());

    return this.getAsset(id);
  }

  getAsset(id) {
    const asset = this.db.prepare(
      'SELECT id, vertical, name, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt FROM assets WHERE id = ?'
    ).get(id);
    if (asset) asset.metadata = JSON.parse(asset.metadata);
    return asset;
  }

  listAssets(vertical = null) {
    let query = 'SELECT id, vertical, name, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt FROM assets';
    const params = [];
    if (vertical) {
      query += ' WHERE vertical = ?';
      params.push(vertical);
    }
    const assets = this.db.prepare(query).all(...params);
    return assets.map(a => ({ ...a, metadata: JSON.parse(a.metadata) }));
  }

  getBalance(assetId, holderId) {
    return this.db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, holderId)?.amount || 0;
  }

  getAssetBalances(assetId) {
    return this.db.prepare('SELECT holderId, amount FROM balances WHERE assetId = ?').all(assetId);
  }

  transfer(assetId, from, to, amount, fromIdentity) {
    const fromBalance = this.getBalance(assetId, from);
    if (fromBalance < amount) throw new Error('insufficient balance');

    const txId = randomId('tx');
    const signature = sha256(`${txId}${from}${to}${amount}`).substring(0, 32);
    const blockIndex = this.getLatestBlockIndex() + 1;

    const txStmt = this.db.prepare(
      'INSERT INTO transactions (id, type, assetId, from, to, amount, signature, blockIndex, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    txStmt.run(txId, 'transfer', assetId, from, to, amount, signature, blockIndex, now());

    const updateFromStmt = this.db.prepare('UPDATE balances SET amount = amount - ?, updatedAt = ? WHERE assetId = ? AND holderId = ?');
    updateFromStmt.run(amount, now(), assetId, from);

    const updateToStmt = this.db.prepare(
      'INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(assetId, holderId) DO UPDATE SET amount = amount + ?, updatedAt = ?'
    );
    updateToStmt.run(assetId, to, amount, now(), amount, now());

    return { id: txId, type: 'transfer', assetId, from, to, amount, signature, timestamp: now() };
  }

  retireCredits(assetId, holderId, amount) {
    const asset = this.getAsset(assetId);
    if (!VERTICALS[asset.vertical].retireable) throw new Error('asset cannot be retired');

    const balance = this.getBalance(assetId, holderId);
    if (balance < amount) throw new Error('insufficient balance');

    const txId = randomId('tx');
    const signature = sha256(`${txId}${holderId}retire${amount}`).substring(0, 32);
    const blockIndex = this.getLatestBlockIndex() + 1;

    const txStmt = this.db.prepare(
      'INSERT INTO transactions (id, type, assetId, from, to, amount, signature, blockIndex, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    txStmt.run(txId, 'retire', assetId, holderId, null, amount, signature, blockIndex, now());

    const updateBalanceStmt = this.db.prepare('UPDATE balances SET amount = amount - ?, updatedAt = ? WHERE assetId = ? AND holderId = ?');
    updateBalanceStmt.run(amount, now(), assetId, holderId);

    const updateAssetStmt = this.db.prepare('UPDATE assets SET circulatingSupply = circulatingSupply - ?, retiredSupply = retiredSupply + ? WHERE id = ?');
    updateAssetStmt.run(amount, amount, assetId);

    return { id: txId, type: 'retire', assetId, holderId, amount, signature, timestamp: now() };
  }

  getLatestBlockIndex() {
    return this.db.prepare('SELECT MAX(index) as maxIndex FROM blocks').get().maxIndex || -1;
  }

  createBlock(transactionCount, miner) {
    const index = this.getLatestBlockIndex() + 1;
    const previous = this.db.prepare('SELECT hash FROM blocks WHERE index = ?').get(index - 1);
    const previousHash = previous?.hash || ('0'.repeat(64));
    const blockData = { index, timestamp: now(), previousHash, transactionCount, miner, nonce: 0 };
    const hash = sha256(canonical(blockData));

    const stmt = this.db.prepare('INSERT INTO blocks (index, hash, previousHash, timestamp, transactionCount, miner, nonce) VALUES (?, ?, ?, ?, ?, ?, ?)');
    stmt.run(index, hash, previousHash, blockData.timestamp, transactionCount, miner, 0);

    return { index, hash, previousHash, timestamp: blockData.timestamp, transactionCount, miner };
  }

  getBlocks() {
    return this.db.prepare('SELECT index, hash, previousHash, timestamp, transactionCount, miner FROM blocks ORDER BY index').all();
  }

  getTransactions(assetId = null) {
    let query = 'SELECT id, type, assetId, from, to, amount, signature, blockIndex, timestamp FROM transactions';
    const params = [];
    if (assetId) {
      query += ' WHERE assetId = ?';
      params.push(assetId);
    }
    return this.db.prepare(query + ' ORDER BY blockIndex DESC').all(...params);
  }

  audit(assetId, auditorId) {
    const identity = this.getIdentity(auditorId);
    if (identity.role !== 'auditor' && identity.role !== 'admin') throw new Error('unauthorized to audit');

    const asset = this.getAsset(assetId);
    const balances = this.getAssetBalances(assetId);
    const transactions = this.getTransactions(assetId);
    const blocks = this.getBlocks();

    let totalBalance = 0;
    for (const b of balances) totalBalance += b.amount;
    totalBalance += asset.retiredSupply;

    const result = {
      valid: totalBalance === asset.supply,
      assetId,
      supply: asset.supply,
      totalBalance,
      retired: asset.retiredSupply,
      holders: balances.length,
      transactions: transactions.length,
      chainValid: this.validateChain().valid
    };

    const auditId = randomId('audit');
    const stmt = this.db.prepare('INSERT INTO audits (id, assetId, auditorId, result, timestamp) VALUES (?, ?, ?, ?, ?)');
    stmt.run(auditId, assetId, auditorId, JSON.stringify(result), now());

    return result;
  }

  validateChain() {
    const blocks = this.getBlocks();
    if (blocks.length === 0) return { valid: true, length: 0 };

    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i];
      const blockData = { index: block.index, timestamp: block.timestamp, previousHash: block.previousHash, transactionCount: block.transactionCount, miner: block.miner, nonce: block.nonce };
      const hash = sha256(canonical(blockData));
      if (hash !== block.hash) return { valid: false, index: i, reason: 'hash mismatch' };
      if (i === 0 && block.previousHash !== '0'.repeat(64)) return { valid: false, index: i, reason: 'invalid genesis' };
      if (i > 0 && block.previousHash !== blocks[i - 1].hash) return { valid: false, index: i, reason: 'broken link' };
    }
    return { valid: true, length: blocks.length };
  }

  close() {
    this.db.close();
  }
}

const db = new Database_(DB_FILE);

function error(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requiredString(value, name, max = 256) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw error(`${name} must be a non-empty string (max ${max} characters)`);
  return value.trim();
}

function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw error(`${name} must be a positive number`);
  return value;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  let body = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw error('request body is too large', 413);
    body += chunk;
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw error('request body must be valid JSON');
  }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // Health & Status
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { status: 'ok', service: 'aether-ledger', chainLength: db.getLatestBlockIndex() + 1, integrity: db.validateChain() });
    }

    // Identities
    if (req.method === 'GET' && url.pathname === '/v1/identities') {
      return send(res, 200, { identities: db.listIdentities() });
    }

    if (req.method === 'POST' && url.pathname === '/v1/identities') {
      const input = await readJson(req);
      const name = requiredString(input.name, 'name', 128);
      const role = input.role || 'holder';
      const identity = db.createIdentity(name, role);
      const block = db.createBlock(1, identity.id);
      return send(res, 201, { identity, block });
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'identities' && parts[2]) {
      const identity = db.getIdentity(parts[2]);
      if (!identity) throw error('identity not found', 404);
      return send(res, 200, identity);
    }

    // Assets
    if (req.method === 'GET' && url.pathname === '/v1/assets') {
      const vertical = url.searchParams.get('vertical');
      return send(res, 200, { assets: db.listAssets(vertical), verticals: VERTICALS });
    }

    if (req.method === 'POST' && url.pathname === '/v1/assets') {
      const input = await readJson(req);
      const vertical = requiredString(input.vertical, 'vertical');
      if (!VERTICALS[vertical]) throw error('invalid vertical');
      const name = requiredString(input.name, 'name', 200);
      const issuerId = requiredString(input.issuerId, 'issuerId');
      const supply = positiveNumber(input.supply, 'supply');
      const metadata = input.metadata || {};
      const asset = db.issueAsset(vertical, name, issuerId, supply, metadata);
      const block = db.createBlock(1, issuerId);
      return send(res, 201, { asset, block });
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'assets' && parts[2]) {
      const asset = db.getAsset(parts[2]);
      if (!asset) throw error('asset not found', 404);
      const balances = db.getAssetBalances(parts[2]);
      return send(res, 200, { asset, balances });
    }

    // Transfers
    if (req.method === 'POST' && url.pathname === '/v1/transfers') {
      const input = await readJson(req);
      const assetId = requiredString(input.assetId, 'assetId');
      const from = requiredString(input.from, 'from', 128);
      const to = requiredString(input.to, 'to', 128);
      const amount = positiveNumber(input.amount, 'amount');
      const fromIdentity = db.getIdentity(from);
      if (!fromIdentity) throw error('sender not found', 404);
      const transaction = db.transfer(assetId, from, to, amount, fromIdentity);
      const block = db.createBlock(1, from);
      const balances = db.getAssetBalances(assetId);
      return send(res, 201, { transaction, balances, block });
    }

    // Retire
    if (req.method === 'POST' && url.pathname === '/v1/retire') {
      const input = await readJson(req);
      const assetId = requiredString(input.assetId, 'assetId');
      const holderId = requiredString(input.holderId, 'holderId');
      const amount = positiveNumber(input.amount, 'amount');
      const transaction = db.retireCredits(assetId, holderId, amount);
      const block = db.createBlock(1, holderId);
      return send(res, 201, { transaction, block });
    }

    // Blocks
    if (req.method === 'GET' && url.pathname === '/v1/blocks') {
      return send(res, 200, { blocks: db.getBlocks() });
    }

    // Transactions
    if (req.method === 'GET' && url.pathname === '/v1/transactions') {
      const assetId = url.searchParams.get('assetId');
      return send(res, 200, { transactions: db.getTransactions(assetId) });
    }

    // Verify
    if (req.method === 'GET' && url.pathname === '/v1/verify') {
      return send(res, 200, db.validateChain());
    }

    // Audit
    if (req.method === 'POST' && url.pathname === '/v1/audit') {
      const input = await readJson(req);
      const assetId = requiredString(input.assetId, 'assetId');
      const auditorId = requiredString(input.auditorId, 'auditorId');
      const result = db.audit(assetId, auditorId);
      return send(res, 200, { audit: result });
    }

    throw error('route not found', 404);
  } catch (e) {
    send(res, e.status || 500, { error: e.message || 'internal server error' });
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Aether Ledger v1.0 listening on http://localhost:${PORT}`);
    console.log(`Database: ${DB_FILE}`);
    console.log(`Verticals: ${Object.keys(VERTICALS).join(', ')}`);
  });
}

module.exports = { server, db };

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  server.close(() => process.exit(0));
});
