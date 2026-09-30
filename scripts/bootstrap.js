#!/usr/bin/env node
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { initializeDatabase } = require('../config/database');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'aether.db');
const db = initializeDatabase(DB_FILE);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function createIdentity(name, role) {
  const id = randomId('id');
  const publicKey = sha256(`${id}:${name}:${role}:${now()}`);
  const createdAt = now();
  
  db.prepare(`
    INSERT INTO identities (id, name, role, publicKey, createdAt, updatedAt, active, metadata)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, name, role, publicKey, createdAt, createdAt, JSON.stringify({ createdVia: 'bootstrap' }));
  
  return { id, name, role, publicKey, createdAt, token: publicKey };
}

function createAsset(vertical, name, issuerId, supply, description = '') {
  const assetId = randomId('ast');
  const timestamp = now();
  
  db.prepare(`
    INSERT INTO assets (id, vertical, name, description, issuerId, supply, circulatingSupply, retiredSupply, metadata, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(assetId, vertical, name, description, issuerId, supply, supply, JSON.stringify({}), timestamp, timestamp);
  
  db.prepare(`
    INSERT INTO balances (assetId, holderId, amount, updatedAt)
    VALUES (?, ?, ?, ?)
  `).run(assetId, issuerId, supply, timestamp);
  
  return { assetId, name, vertical, supply, timestamp };
}

console.log('\n🚀 Aether Ledger Bootstrap\n');

console.log('Creating identities...');
const issuer = createIdentity('Green Energy Corp', 'issuer');
console.log(`  ✓ Issuer: ${issuer.id}`);
console.log(`    Token: ${issuer.token}`);

const holder1 = createIdentity('Climate Fund A', 'holder');
console.log(`  ✓ Holder 1: ${holder1.id}`);
console.log(`    Token: ${holder1.token}`);

const holder2 = createIdentity('Carbon Investor LLC', 'holder');
console.log(`  ✓ Holder 2: ${holder2.id}`);
console.log(`    Token: ${holder2.token}`);

const auditor = createIdentity('Compliance Audit Inc', 'auditor');
console.log(`  ✓ Auditor: ${auditor.id}`);
console.log(`    Token: ${auditor.token}`);

console.log('\nCreating carbon credit assets...');
const asset1 = createAsset('carbon_credits', 'Solar Farm Project 2026', issuer.id, 5000, 'Credits from 50MW solar installation');
console.log(`  ✓ Asset 1: ${asset1.assetId}`);
console.log(`    Supply: ${asset1.supply} tCO2e`);

const asset2 = createAsset('carbon_credits', 'Wind Energy Offset', issuer.id, 3000, 'Credits from wind energy generation');
console.log(`  ✓ Asset 2: ${asset2.assetId}`);
console.log(`    Supply: ${asset2.supply} tCO2e`);

console.log('\n✅ Bootstrap complete!\n');
console.log('API Endpoints:');
console.log('  POST /v1/identities    - Create new identity');
console.log('  GET  /v1/identities    - List identities (requires auth)');
console.log('  POST /v1/assets        - Issue new asset (requires auth)');
console.log('  GET  /v1/assets        - List assets (requires auth)');
console.log('  POST /v1/transfers     - Transfer asset (requires auth)');
console.log('  POST /v1/retire        - Retire credits (requires auth)');
console.log('  GET  /v1/blocks        - View blockchain (requires auth)');
console.log('  POST /v1/audit         - Run audit (requires auth)');
console.log('  GET  /v1/verify        - Verify chain (requires auth)');
console.log('\nExample curl (create identity):');
console.log('  curl -X POST http://localhost:3000/v1/identities \\');
console.log('    -H "Content-Type: application/json" \\');
console.log('    -d \'{\'name\': \'My Company\', \'role\': \'holder\'}\'');
console.log('\nExample curl (list identities with auth):');
console.log(`  curl -H "Authorization: Bearer ${issuer.token}" \\`);
console.log('    http://localhost:3000/v1/identities');
console.log('');
