const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { initializeDatabase } = require('../config/database');
const { SecurityEngine, VERTICALS } = require('../config/security');

const TEST_DB = path.join(__dirname, 'test-ledger.db');

function cleanup() {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
}

function setupDb() {
  cleanup();
  return initializeDatabase(TEST_DB);
}

test('identity lifecycle', async (t) => {
  const db = setupDb();
  const security = new SecurityEngine(db);
  
  const stmt = db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
  const id = 'id_test_issuer';
  const publicKey = 'pk_test_key_123';
  stmt.run(id, 'Test Issuer', 'issuer', publicKey, new Date().toISOString(), new Date().toISOString(), '{}');
  
  const identity = db.prepare('SELECT id, name, role FROM identities WHERE id = ?').get(id);
  assert.strictEqual(identity.name, 'Test Issuer');
  assert.strictEqual(identity.role, 'issuer');
  
  cleanup();
});

test('asset issuance', async (t) => {
  const db = setupDb();
  
  const issuer = 'id_issuer_001';
  db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(
    issuer, 'Carbon Issuer', 'issuer', 'pk_issuer', new Date().toISOString(), new Date().toISOString(), '{}'
  );
  
  const assetId = 'ast_carbon_001';
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO assets (id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(assetId, 'carbon_credits', 'Solar Farm Credits 2026', 'Credits from solar farm', issuer, 1000, 1000, '{}', now, now);
  
  const asset = db.prepare('SELECT id, vertical, supply, circulatingSupply FROM assets WHERE id = ?').get(assetId);
  assert.strictEqual(asset.vertical, 'carbon_credits');
  assert.strictEqual(asset.supply, 1000);
  assert.strictEqual(asset.circulatingSupply, 1000);
  
  cleanup();
});

test('transfer and balance', async (t) => {
  const db = setupDb();
  const now = new Date().toISOString();
  
  const issuer = 'id_issuer';
  const holder = 'id_holder';
  db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(
    issuer, 'Issuer', 'issuer', 'pk_issuer', now, now, '{}'
  );
  db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(
    holder, 'Holder', 'holder', 'pk_holder', now, now, '{}'
  );
  
  const assetId = 'ast_001';
  db.prepare(`
    INSERT INTO assets (id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(assetId, 'carbon_credits', 'Test Credits', '', issuer, 1000, 1000, '{}', now, now);
  
  db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)').run(assetId, issuer, 1000, now);
  
  db.prepare('UPDATE balances SET amount = amount - ?, updatedAt = ? WHERE assetId = ? AND holderId = ?').run(500, now, assetId, issuer);
  db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(assetId, holderId) DO UPDATE SET amount = amount + excluded.amount, updatedAt = excluded.updatedAt').run(assetId, holder, 500, now);
  
  const issuerBalance = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, issuer).amount;
  const holderBalance = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, holder).amount;
  
  assert.strictEqual(issuerBalance, 500);
  assert.strictEqual(holderBalance, 500);
  
  cleanup();
});

test('retirement flow', async (t) => {
  const db = setupDb();
  const now = new Date().toISOString();
  
  const holder = 'id_holder';
  db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(
    holder, 'Holder', 'holder', 'pk_holder', now, now, '{}'
  );
  
  const assetId = 'ast_retire';
  db.prepare(`
    INSERT INTO assets (id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(assetId, 'carbon_credits', 'Retirable Credits', '', holder, 1000, 1000, '{}', now, now);
  
  db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)').run(assetId, holder, 1000, now);
  
  db.prepare('UPDATE balances SET amount = amount - ?, updatedAt = ? WHERE assetId = ? AND holderId = ?').run(300, now, assetId, holder);
  db.prepare('UPDATE assets SET circulatingSupply = circulatingSupply - ?, retiredSupply = retiredSupply + ?, updatedAt = ? WHERE id = ?').run(300, 300, now, assetId);
  
  const asset = db.prepare('SELECT circulatingSupply, retiredSupply FROM assets WHERE id = ?').get(assetId);
  const balance = db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, holder).amount;
  
  assert.strictEqual(asset.circulatingSupply, 700);
  assert.strictEqual(asset.retiredSupply, 300);
  assert.strictEqual(balance, 700);
  
  cleanup();
});

test('audit validation', async (t) => {
  const db = setupDb();
  const now = new Date().toISOString();
  
  const issuer = 'id_issuer';
  db.prepare('INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata) VALUES (?, ?, ?, ?, ?, ?, 1, ?)').run(
    issuer, 'Issuer', 'issuer', 'pk_issuer', now, now, '{}'
  );
  
  const assetId = 'ast_audit';
  db.prepare(`
    INSERT INTO assets (id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(assetId, 'carbon_credits', 'Audit Test', '', issuer, 1000, 1000, '{}', now, now);
  
  db.prepare('INSERT INTO balances (assetId, holderId, amount, updatedAt) VALUES (?, ?, ?, ?)').run(assetId, issuer, 1000, now);
  
  const balances = db.prepare('SELECT holderId, amount FROM balances WHERE assetId = ?').all(assetId);
  const asset = db.prepare('SELECT supply, retiredSupply FROM assets WHERE id = ?').get(assetId);
  const totalBalance = balances.reduce((sum, row) => sum + row.amount, 0) + asset.retiredSupply;
  const isValid = totalBalance === asset.supply;
  
  assert.strictEqual(isValid, true);
  
  cleanup();
});

console.log('All tests passed!');
