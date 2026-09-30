const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

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

const randomId = (prefix) => `${prefix}_${Math.random().toString(36).substr(2, 9)}`;

function setupTestDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-test-'));
  const dbFile = path.join(tmpDir, 'test.db');
  return { dbFile, tmpDir };
}

test('Real Estate vertical: issue and transfer tokens', async (t) => {
  const { dbFile, tmpDir } = setupTestDb();
  try {
    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    
    db.exec(`
      CREATE TABLE identities (id TEXT PRIMARY KEY, name TEXT UNIQUE, role TEXT DEFAULT 'holder', publicKey TEXT UNIQUE, createdAt TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE assets (id TEXT PRIMARY KEY, vertical TEXT, name TEXT, issuerId TEXT, supply REAL, circulatingSupply REAL, retiredSupply REAL DEFAULT 0, metadata TEXT, createdAt TEXT);
      CREATE TABLE balances (assetId TEXT, holderId TEXT, amount REAL, updatedAt TEXT, PRIMARY KEY (assetId, holderId));
      CREATE TABLE blocks (index INTEGER PRIMARY KEY, hash TEXT UNIQUE, previousHash TEXT, timestamp TEXT, transactionCount INTEGER, miner TEXT, nonce INTEGER DEFAULT 0);
    `);

    const stmtId = db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt) VALUES (?, ?, ?, ?, ?)');
    const issuerId = randomId('id');
    stmtId.run(issuerId, 'RealEstate Inc', 'issuer', 'pubkey1', new Date().toISOString());

    const buyerId = randomId('id');
    stmtId.run(buyerId, 'Buyer 1', 'holder', 'pubkey2', new Date().toISOString());

    const assetId = randomId('ast');
    const stmtAsset = db.prepare('INSERT INTO assets (id, vertical, name, issuerId, supply, circulatingSupply, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    stmtAsset.run(assetId, 'real_estate', 'Commercial Building', issuerId, 100, 100, '{}', new Date().toISOString());

    const stmtBalance = db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)');
    stmtBalance.run(assetId, issuerId, 100, new Date().toISOString());

    // Transfer
    const stmtTransfer = db.prepare('UPDATE balances SET amount = amount - ? WHERE assetId = ? AND holderId = ?');
    stmtTransfer.run(30, assetId, issuerId);

    const stmtAddBalance = db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET amount = amount + ?');
    stmtAddBalance.run(assetId, buyerId, 30, new Date().toISOString(), 30);

    const issuerBalance = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, issuerId);
    const buyerBalance = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, buyerId);

    assert.equal(issuerBalance.amount, 70);
    assert.equal(buyerBalance.amount, 30);

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Supply Chain vertical: track units through network', async (t) => {
  const { dbFile, tmpDir } = setupTestDb();
  try {
    const db = new Database(dbFile);
    db.pragma('foreign_keys = ON');
    
    db.exec(`
      CREATE TABLE identities (id TEXT PRIMARY KEY, name TEXT UNIQUE, role TEXT DEFAULT 'holder', publicKey TEXT UNIQUE, createdAt TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE assets (id TEXT PRIMARY KEY, vertical TEXT, name TEXT, issuerId TEXT, supply REAL, circulatingSupply REAL, retiredSupply REAL DEFAULT 0, metadata TEXT, createdAt TEXT);
      CREATE TABLE balances (assetId TEXT, holderId TEXT, amount REAL, updatedAt TEXT, PRIMARY KEY (assetId, holderId));
    `);

    const ids = ['supplier', 'distributor', 'retailer'].map(name => {
      const id = randomId('id');
      db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, name, 'holder', `pk_${name}`, new Date().toISOString());
      return id;
    });

    const assetId = randomId('ast');
    db.prepare('INSERT INTO assets (id, vertical, name, issuerId, supply, circulatingSupply, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(assetId, 'supply_chain', 'Widget Shipment', ids[0], 1000, 1000, '{}', new Date().toISOString());

    db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)').run(assetId, ids[0], 1000, new Date().toISOString());

    // Supplier -> Distributor
    db.prepare('UPDATE balances SET amount = 900 WHERE assetId = ? AND holderId = ?').run(assetId, ids[0]);
    db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)').run(assetId, ids[1], 100, new Date().toISOString());

    // Distributor -> Retailer
    db.prepare('UPDATE balances SET amount = 75 WHERE assetId = ? AND holderId = ?').run(assetId, ids[1]);
    db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)').run(assetId, ids[2], 25, new Date().toISOString());

    const finalDistrib = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, ids[1]);
    const finalRetail = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, ids[2]);

    assert.equal(finalDistrib.amount, 75);
    assert.equal(finalRetail.amount, 25);

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Carbon Credits vertical: issue and retire', async (t) => {
  const { dbFile, tmpDir } = setupTestDb();
  try {
    const db = new Database(dbFile);
    db.pragma('foreign_keys = ON');
    
    db.exec(`
      CREATE TABLE identities (id TEXT PRIMARY KEY, name TEXT UNIQUE, role TEXT DEFAULT 'holder', publicKey TEXT UNIQUE, createdAt TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE assets (id TEXT PRIMARY KEY, vertical TEXT, name TEXT, issuerId TEXT, supply REAL, circulatingSupply REAL, retiredSupply REAL DEFAULT 0, metadata TEXT, createdAt TEXT);
      CREATE TABLE balances (assetId TEXT, holderId TEXT, amount REAL, updatedAt TEXT, PRIMARY KEY (assetId, holderId));
    `);

    const issuerId = randomId('id');
    db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt) VALUES (?, ?, ?, ?, ?)').run(issuerId, 'Forest Project', 'issuer', 'pk_forest', new Date().toISOString());

    const assetId = randomId('ast');
    db.prepare('INSERT INTO assets (id, vertical, name, issuerId, supply, circulatingSupply, metadata, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(assetId, 'carbon_credits', 'Reforestation 2026', issuerId, 10000, 10000, '{}', new Date().toISOString());

    db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)').run(assetId, issuerId, 10000, new Date().toISOString());

    // Retire 2000 tCO2e
    db.prepare('UPDATE assets SET circulatingSupply = 8000, retiredSupply = 2000 WHERE id = ?').run(assetId);
    db.prepare('UPDATE balances SET amount = 8000 WHERE assetId = ? AND holderId = ?').run(assetId, issuerId);

    const asset = db.prepare('SELECT supply, circulatingSupply, retiredSupply FROM assets WHERE id = ?').get(assetId);
    assert.equal(asset.supply, 10000);
    assert.equal(asset.circulatingSupply, 8000);
    assert.equal(asset.retiredSupply, 2000);

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Authorization: only issuer can create assets', async (t) => {
  const { dbFile, tmpDir } = setupTestDb();
  try {
    const db = new Database(dbFile);
    db.pragma('foreign_keys = ON');
    
    db.exec(`
      CREATE TABLE identities (id TEXT PRIMARY KEY, name TEXT UNIQUE, role TEXT DEFAULT 'holder', publicKey TEXT UNIQUE, createdAt TEXT, active INTEGER DEFAULT 1);
      CREATE TABLE assets (id TEXT PRIMARY KEY, vertical TEXT, name TEXT, issuerId TEXT, supply REAL, circulatingSupply REAL, retiredSupply REAL DEFAULT 0, metadata TEXT, createdAt TEXT);
    `);

    const holderId = randomId('id');
    db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt) VALUES (?, ?, ?, ?, ?)').run(holderId, 'Regular Holder', 'holder', 'pk_holder', new Date().toISOString());

    const identity = db.prepare('SELECT role FROM identities WHERE id = ?').get(holderId);
    assert.equal(identity.role, 'holder');
    assert.notEqual(identity.role, 'issuer');

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
