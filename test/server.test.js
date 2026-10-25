const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Fixed secret for this test process so attestations verify across the
// whole run. Set BEFORE requiring the server (it reads env at load).
process.env.LEDGER_HMAC_SECRET = 'test-only-hmac-secret';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-server-test-'));
process.env.DB_FILE = path.join(tmpDir, 'test.db');

const { server, db } = require('../server');

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function req(method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json };
}

const ctx = {};

test('fresh boot creates a genesis block with NULL miner', async () => {
  const { status, json } = await req('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.chainLength, 1);
  assert.deepEqual(json.integrity, { valid: true, length: 1 });
  const genesis = db.prepare('SELECT "index", miner, txRoot FROM blocks ORDER BY "index"').get();
  assert.equal(genesis.index, 0);
  assert.equal(genesis.miner, null);
  assert.equal(genesis.txRoot, crypto.createHash('sha256').update('').digest('hex'));
});

test('bootstrap: first identity may be admin without auth', async () => {
  const { status, json } = await req('POST', '/v1/identities', { name: 'Root Admin', role: 'admin' });
  assert.equal(status, 201);
  ctx.admin = json.identity;
  ctx.adminToken = json.token;
  assert.match(json.token, /^[0-9a-f]{64}$/);
  assert.notEqual(json.token, json.identity.publicKey);
  assert.equal('token' in json.identity, false);
  assert.equal('tokenHash' in json.identity, false);
});

test('second privileged creation blocked without admin', async () => {
  // No credentials at all -> 401.
  const noAuth = await req('POST', '/v1/identities', { name: 'Sneaky Issuer', role: 'issuer' });
  assert.equal(noAuth.status, 401);
  // Holders may still self-register without auth.
  const holder = await req('POST', '/v1/identities', { name: 'Early Holder', role: 'holder' });
  assert.equal(holder.status, 201);
  ctx.earlyHolder = holder.json.identity;
  ctx.earlyHolderToken = holder.json.token;
  // A non-admin caller may not create privileged identities -> 403.
  const asHolder = await req('POST', '/v1/identities', { name: 'Sneaky Issuer', role: 'issuer' }, ctx.earlyHolderToken);
  assert.equal(asHolder.status, 403);
});

test('admin can create issuer, holders, and auditor', async () => {
  const issuer = await req('POST', '/v1/identities', { name: 'Green Energy Corp', role: 'issuer' }, ctx.adminToken);
  assert.equal(issuer.status, 201);
  ctx.issuer = issuer.json.identity;
  ctx.issuerToken = issuer.json.token;

  const holderA = await req('POST', '/v1/identities', { name: 'Climate Fund A', role: 'holder' }, ctx.adminToken);
  assert.equal(holderA.status, 201);
  ctx.holderA = holderA.json.identity;
  ctx.holderAToken = holderA.json.token;

  const holderB = await req('POST', '/v1/identities', { name: 'Carbon Investor LLC', role: 'holder' }, ctx.adminToken);
  assert.equal(holderB.status, 201);
  ctx.holderB = holderB.json.identity;
  ctx.holderBToken = holderB.json.token;

  const auditor = await req('POST', '/v1/identities', { name: 'Compliance Audit Inc', role: 'auditor' }, ctx.adminToken);
  assert.equal(auditor.status, 201);
  ctx.auditorToken = auditor.json.token;
});

test('issuer can issue only as itself, and only integer supplies', async () => {
  const ok = await req('POST', '/v1/assets', {
    vertical: 'carbon_credits', name: 'Solar Farm 2026',
    issuerId: ctx.issuer.id, supply: 1000
  }, ctx.issuerToken);
  assert.equal(ok.status, 201);
  ctx.assetId = ok.json.asset.id;
  assert.equal(ok.json.asset.supply, 1000);
  assert.equal(ok.json.asset.circulatingSupply, 1000);

  // Issuer naming someone else as issuer -> 403 (ownership).
  const mismatch = await req('POST', '/v1/assets', {
    vertical: 'carbon_credits', name: 'Fake Asset',
    issuerId: ctx.holderA.id, supply: 100
  }, ctx.issuerToken);
  assert.equal(mismatch.status, 403);

  // Fractional supply -> 400 (integer rule).
  const fractional = await req('POST', '/v1/assets', {
    vertical: 'carbon_credits', name: 'Fractional Asset',
    issuerId: ctx.issuer.id, supply: 10.5
  }, ctx.issuerToken);
  assert.equal(fractional.status, 400);
});

test('holder cannot transfer another holder\'s funds', async () => {
  // Issuer funds holder A (caller == from, allowed).
  const fund = await req('POST', '/v1/transfers', {
    assetId: ctx.assetId, from: ctx.issuer.id, to: ctx.holderA.id, amount: 100
  }, ctx.issuerToken);
  assert.equal(fund.status, 201);

  // Holder B moving holder A's funds -> 403 (ownership).
  const steal = await req('POST', '/v1/transfers', {
    assetId: ctx.assetId, from: ctx.holderA.id, to: ctx.holderB.id, amount: 50
  }, ctx.holderBToken);
  assert.equal(steal.status, 403);

  // Holder A moving its own funds -> 201.
  const own = await req('POST', '/v1/transfers', {
    assetId: ctx.assetId, from: ctx.holderA.id, to: ctx.holderB.id, amount: 40
  }, ctx.holderAToken);
  assert.equal(own.status, 201);

  // Fractional amount -> 400.
  const fractional = await req('POST', '/v1/transfers', {
    assetId: ctx.assetId, from: ctx.holderA.id, to: ctx.holderB.id, amount: 1.5
  }, ctx.holderAToken);
  assert.equal(fractional.status, 400);

  const asset = await req('GET', `/v1/assets/${ctx.assetId}`, null, ctx.adminToken);
  const balances = Object.fromEntries(asset.json.balances.map((b) => [b.holderId, b.amount]));
  assert.equal(balances[ctx.issuer.id], 900);
  assert.equal(balances[ctx.holderA.id], 60);
  assert.equal(balances[ctx.holderB.id], 40);
});

test('holder cannot retire another holder\'s credits', async () => {
  // Issuer holds retire permission but names holder A -> 403 (ownership).
  const mismatch = await req('POST', '/v1/retire', {
    assetId: ctx.assetId, holderId: ctx.holderA.id, amount: 10
  }, ctx.issuerToken);
  assert.equal(mismatch.status, 403);

  // Holders have no retire permission at all -> 403 (role).
  const holderRetire = await req('POST', '/v1/retire', {
    assetId: ctx.assetId, holderId: ctx.holderA.id, amount: 10
  }, ctx.holderAToken);
  assert.equal(holderRetire.status, 403);

  // Issuer retiring its own credits -> 201.
  const own = await req('POST', '/v1/retire', {
    assetId: ctx.assetId, holderId: ctx.issuer.id, amount: 10
  }, ctx.issuerToken);
  assert.equal(own.status, 201);

  const asset = await req('GET', `/v1/assets/${ctx.assetId}`, null, ctx.adminToken);
  assert.equal(asset.json.asset.circulatingSupply, 990);
  assert.equal(asset.json.asset.retiredSupply, 10);
});

test('token != publicKey and listing identities leaks no token', async () => {
  const list = await req('GET', '/v1/identities', null, ctx.holderAToken);
  assert.equal(list.status, 200);
  for (const ident of list.json.identities) {
    assert.equal('token' in ident, false);
    assert.equal('tokenHash' in ident, false);
  }
  const raw = JSON.stringify(list.json);
  assert.equal(raw.includes(ctx.adminToken), false);
  assert.equal(raw.includes(ctx.issuerToken), false);
  assert.equal(raw.includes(ctx.holderAToken), false);

  // A publicKey is not a credential anymore.
  const withPublicKey = await req('GET', '/v1/identities', null, ctx.holderA.publicKey);
  assert.equal(withPublicKey.status, 401);
});

test('tampering a transaction row fails validateChain', async () => {
  const tx = db.prepare("SELECT id, signature, amount FROM transactions WHERE type = 'transfer' ORDER BY blockIndex LIMIT 1").get();
  assert.ok(tx);

  // Tamper the signature -> txRoot mismatch.
  db.prepare('UPDATE transactions SET signature = ? WHERE id = ?').run('tampered', tx.id);
  let verify = await req('GET', '/v1/verify', null, ctx.adminToken);
  assert.equal(verify.json.valid, false);
  db.prepare('UPDATE transactions SET signature = ? WHERE id = ?').run(tx.signature, tx.id);
  verify = await req('GET', '/v1/verify', null, ctx.adminToken);
  assert.equal(verify.json.valid, true);

  // Tamper the amount (signature untouched) -> attestation mismatch.
  db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(tx.amount + 1, tx.id);
  verify = await req('GET', '/v1/verify', null, ctx.adminToken);
  assert.equal(verify.json.valid, false);
  db.prepare('UPDATE transactions SET amount = ? WHERE id = ?').run(tx.amount, tx.id);
  verify = await req('GET', '/v1/verify', null, ctx.adminToken);
  assert.equal(verify.json.valid, true);
});

test('audit supply conservation holds', async () => {
  const { status, json } = await req('POST', '/v1/audit', { assetId: ctx.assetId }, ctx.adminToken);
  assert.equal(status, 200);
  assert.equal(json.audit.valid, true);
  assert.equal(json.audit.chainValid, true);
  assert.equal(json.audit.supply, 1000);
  assert.equal(json.audit.totalBalance, 1000);
  assert.equal(json.audit.retired, 10);
});

test('revoke kills a stolen token immediately (anti-theft)', async () => {
  // Fresh victim holder, created by admin, so nothing else depends on it.
  const victim = await req('POST', '/v1/identities', { name: 'Victim Holder', role: 'holder' }, ctx.adminToken);
  assert.equal(victim.status, 201);
  const victimToken = victim.json.token;
  const victimId = victim.json.identity.id;

  // Non-admin may not revoke -> 403, token still works.
  const asHolder = await req('POST', `/v1/identities/${victimId}/revoke`, null, ctx.holderAToken);
  assert.equal(asHolder.status, 403);
  const stillWorks = await req('GET', '/v1/identities', null, victimToken);
  assert.equal(stillWorks.status, 200);

  // Admin may not revoke themselves -> 400, admin token still works.
  const selfRevoke = await req('POST', `/v1/identities/${ctx.admin.id}/revoke`, null, ctx.adminToken);
  assert.equal(selfRevoke.status, 400);

  // Admin revokes the victim -> 200, and the token dies immediately.
  const revoked = await req('POST', `/v1/identities/${victimId}/revoke`, null, ctx.adminToken);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.revoked, true);
  const dead = await req('GET', '/v1/identities', null, victimToken);
  assert.equal(dead.status, 401);

  // Revoking twice -> 400.
  const again = await req('POST', `/v1/identities/${victimId}/revoke`, null, ctx.adminToken);
  assert.equal(again.status, 400);
});
