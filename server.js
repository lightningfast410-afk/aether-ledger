#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.LEDGER_FILE || path.join(__dirname, 'ledger.json');
const MAX_BODY_BYTES = 1024 * 1024;
const VERTICALS = new Set(['real_estate', 'supply_chain', 'carbon_credits']);
const ALLOWED_TYPES = new Set(['issue', 'transfer']);

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const now = () => new Date().toISOString();

function genesis() {
  const block = { index: 0, timestamp: '2026-01-01T00:00:00.000Z', previousHash: '0'.repeat(64), transactions: [], nonce: 0 };
  return { ...block, hash: sha256(canonical(block)) };
}

function loadLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed.chain) || parsed.chain.length === 0) throw new Error('invalid ledger');
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Ledger reset: ${error.message}`);
    return { chain: [genesis()], assets: {}, balances: {} };
  }
}

let state = loadLedger();
let writeQueue = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  writeQueue = writeQueue.then(async () => {
    await fs.promises.writeFile(temporary, snapshot, { mode: 0o600 });
    await fs.promises.rename(temporary, DATA_FILE);
  });
  return writeQueue;
}

function error(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function requiredString(value, name, max = 256) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw error(`${name} must be a non-empty string (max ${max} characters)`);
  return value.trim();
}
function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw error(`${name} must be a positive number`);
  return value;
}
function safeMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('metadata must be an object');
  if (JSON.stringify(value).length > 10000) throw error('metadata is too large');
  return value;
}
function append(transactions) {
  const previous = state.chain[state.chain.length - 1];
  const body = { index: previous.index + 1, timestamp: now(), previousHash: previous.hash, transactions, nonce: 0 };
  const block = { ...body, hash: sha256(canonical(body)) };
  state.chain.push(block);
  return block;
}
function validateChain() {
  for (let i = 0; i < state.chain.length; i += 1) {
    const block = state.chain[i];
    const body = { index: block.index, timestamp: block.timestamp, previousHash: block.previousHash, transactions: block.transactions, nonce: block.nonce };
    if (block.hash !== sha256(canonical(body))) return { valid: false, index: i, reason: 'hash mismatch' };
    if (i === 0 && (block.index !== 0 || block.previousHash !== '0'.repeat(64))) return { valid: false, index: i, reason: 'invalid genesis' };
    if (i > 0 && (block.index !== i || block.previousHash !== state.chain[i - 1].hash)) return { valid: false, index: i, reason: 'broken link' };
  }
  return { valid: true, length: state.chain.length };
}
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
async function readJson(req) {
  let size = 0; let body = '';
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw error('request body is too large', 413); body += chunk; }
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { throw error('request body must be valid JSON'); }
}
async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', service: 'aether-ledger', chainLength: state.chain.length, integrity: validateChain() });
  if (req.method === 'GET' && url.pathname === '/v1/blocks') return send(res, 200, { blocks: state.chain });
  if (req.method === 'GET' && url.pathname === '/v1/verify') return send(res, 200, validateChain());
  if (req.method === 'GET' && url.pathname === '/v1/assets') return send(res, 200, { assets: Object.values(state.assets) });
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'assets' && parts[2]) {
    const asset = state.assets[parts[2]]; if (!asset) throw error('asset not found', 404); return send(res, 200, asset);
  }
  if (req.method !== 'POST') throw error('route not found', 404);
  const input = await readJson(req);
  if (url.pathname === '/v1/assets') {
    const vertical = requiredString(input.vertical, 'vertical');
    if (!VERTICALS.has(vertical)) throw error(`vertical must be one of: ${[...VERTICALS].join(', ')}`);
    const owner = requiredString(input.owner, 'owner', 128);
    const supply = positiveNumber(input.supply, 'supply');
    const asset = { id: `ast_${crypto.randomUUID()}`, vertical, name: requiredString(input.name, 'name', 200), owner, supply, metadata: safeMetadata(input.metadata), createdAt: now() };
    state.assets[asset.id] = asset;
    state.balances[asset.id] = { [owner]: supply };
    const block = append([{ id: `tx_${crypto.randomUUID()}`, type: 'issue', assetId: asset.id, owner, amount: supply, timestamp: now() }]);
    await persist(); return send(res, 201, { asset, block });
  }
  if (url.pathname === '/v1/transfers') {
    const assetId = requiredString(input.assetId, 'assetId'); const asset = state.assets[assetId]; if (!asset) throw error('asset not found', 404);
    const from = requiredString(input.from, 'from', 128); const to = requiredString(input.to, 'to', 128); const amount = positiveNumber(input.amount, 'amount');
    const balances = state.balances[assetId] || {}; if ((balances[from] || 0) < amount) throw error('insufficient balance');
    balances[from] = (balances[from] || 0) - amount; balances[to] = (balances[to] || 0) + amount;
    const transaction = { id: `tx_${crypto.randomUUID()}`, type: 'transfer', assetId, from, to, amount, timestamp: now() };
    const block = append([transaction]); await persist(); return send(res, 201, { transaction, balances, block });
  }
  throw error('route not found', 404);
}
const server = http.createServer((req, res) => handler(req, res).catch(e => send(res, e.status || 500, { error: e.message || 'internal server error' })));
if (require.main === module) server.listen(PORT, () => console.log(`Aether Ledger listening on http://localhost:${PORT}`));
module.exports = { server, genesis, validateChain, loadLedger };
