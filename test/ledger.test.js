const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { genesis, validateChain } = require('../server');

test('genesis block is deterministic and linked correctly', () => {
  const block = genesis();
  assert.equal(block.index, 0);
  assert.equal(block.previousHash, '0'.repeat(64));
  assert.equal(block.hash.length, 64);
});

test('a ledger with the genesis block passes validation', () => {
  const original = require('../server');
  const ledger = { chain: [genesis()] };
  const previous = process.env.LEDGER_FILE;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aether-')), 'ledger.json');
  fs.writeFileSync(file, JSON.stringify(ledger));
  process.env.LEDGER_FILE = file;
  assert.equal(original.loadLedger().chain.length, 1);
  if (previous === undefined) delete process.env.LEDGER_FILE; else process.env.LEDGER_FILE = previous;
});
