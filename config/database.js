/**
 * Database initialization and schema
 *
 * Fixed copy notes (see FIXES.md):
 * - Column names that are SQLite keywords ("index", "from", "to") are
 *   double-quoted everywhere. The original bare names made CREATE TABLE
 *   fail with `syntax error near "index"` / `near "from"` on a fresh
 *   database, so the original code could never boot from scratch.
 * - identities gains tokenHash (SHA-256 of the bearer token; the token
 *   itself is never stored). The bearer token is NOT the publicKey.
 * - blocks.miner is nullable so the genesis block can use NULL instead
 *   of the string 'genesis', which violated the identities FK.
 * - blocks gains txRoot: the SHA-256 root over that block's transactions.
 */

const Database = require('better-sqlite3');
const path = require('node:path');

function initializeDatabase(dbFile) {
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Identities (users, issuers, auditors)
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'holder',
      email TEXT UNIQUE,
      publicKey TEXT NOT NULL UNIQUE,
      tokenHash TEXT UNIQUE,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      metadata TEXT
    );

    -- Assets (tokenized real estate, supply chain goods, carbon credits)
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      vertical TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      issuerId TEXT NOT NULL,
      supply REAL NOT NULL,
      circulatingSupply REAL NOT NULL,
      retiredSupply REAL NOT NULL DEFAULT 0,
      metadata TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (issuerId) REFERENCES identities(id)
    );

    -- Balances (asset ownership)
    CREATE TABLE IF NOT EXISTS balances (
      assetId TEXT NOT NULL,
      holderId TEXT NOT NULL,
      amount REAL NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (assetId, holderId),
      FOREIGN KEY (assetId) REFERENCES assets(id),
      FOREIGN KEY (holderId) REFERENCES identities(id)
    );

    -- Transactions (transfers, retirements, issuances)
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      assetId TEXT NOT NULL,
      "from" TEXT,
      "to" TEXT,
      amount REAL NOT NULL,
      signature TEXT NOT NULL,
      blockIndex INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'confirmed',
      metadata TEXT,
      FOREIGN KEY (assetId) REFERENCES assets(id),
      FOREIGN KEY ("from") REFERENCES identities(id),
      FOREIGN KEY ("to") REFERENCES identities(id)
    );

    -- Blocks (immutable chain)
    CREATE TABLE IF NOT EXISTS blocks (
      "index" INTEGER PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      previousHash TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      transactionCount INTEGER NOT NULL,
      miner TEXT,
      nonce INTEGER NOT NULL DEFAULT 0,
      txRoot TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (miner) REFERENCES identities(id)
    );

    -- Audits (compliance and integrity checks)
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      assetId TEXT NOT NULL,
      auditorId TEXT NOT NULL,
      result TEXT NOT NULL,
      status TEXT DEFAULT 'completed',
      timestamp TEXT NOT NULL,
      expiresAt TEXT,
      FOREIGN KEY (assetId) REFERENCES assets(id),
      FOREIGN KEY (auditorId) REFERENCES identities(id)
    );

    -- Audit Log (all actions for compliance)
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      eventType TEXT NOT NULL,
      identityId TEXT,
      action TEXT NOT NULL,
      resource TEXT,
      success INTEGER DEFAULT 1,
      metadata TEXT,
      FOREIGN KEY (identityId) REFERENCES identities(id)
    );

    -- Nonces (replay attack prevention)
    -- NOTE: the nonce helpers were dead code and were removed from
    -- security.js; this table is kept for forward compatibility only.
    CREATE TABLE IF NOT EXISTS nonces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identityId TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      FOREIGN KEY (identityId) REFERENCES identities(id)
    );

    -- Indices for performance
    CREATE INDEX IF NOT EXISTS idx_assets_vertical ON assets(vertical);
    CREATE INDEX IF NOT EXISTS idx_assets_issuer ON assets(issuerId);
    CREATE INDEX IF NOT EXISTS idx_balances_holder ON balances(holderId);
    CREATE INDEX IF NOT EXISTS idx_transactions_asset ON transactions(assetId);
    CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions("from");
    CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions("to");
    CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_identity ON audit_log(identityId);
    CREATE INDEX IF NOT EXISTS idx_nonces_expiry ON nonces(expiresAt);
  `);

  // Best-effort migration for databases created before the fix: add the
  // new columns if they are missing. (In practice no valid database could
  // have been created by the original schema, because its CREATE TABLE
  // statements failed on the bare keyword column names.)
  const identityColumns = db.prepare('PRAGMA table_info(identities)').all().map((c) => c.name);
  if (!identityColumns.includes('tokenHash')) {
    db.exec('ALTER TABLE identities ADD COLUMN tokenHash TEXT UNIQUE');
  }
  const blockColumns = db.prepare('PRAGMA table_info(blocks)').all().map((c) => c.name);
  if (!blockColumns.includes('txRoot')) {
    db.exec("ALTER TABLE blocks ADD COLUMN txRoot TEXT NOT NULL DEFAULT ''");
  }

  return db;
}

module.exports = { initializeDatabase };
