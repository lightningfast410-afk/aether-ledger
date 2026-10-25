# Aether Ledger — Fixed Copy: What Was Wrong and What Changed

This is a LOCAL fixed copy of the public repo `lightningfast410-afk/aether-ledger`
(main branch, last commit `22a7d6c`). Nothing was pushed, committed, or
changed in the GitHub repo, and the GitHub account was never touched. The
fixes below were verified by running the test suite in this directory.

How to run it:

```bash
npm install
npm test        # full suite, see "Test evidence" at the bottom
LEDGER_HMAC_SECRET=<a stable secret> npm start
```

---

## 1. Open privileged registration — FIXED

**Flaw (server.js, `POST /v1/identities`):** the route ran before any
authentication, so anyone could create an identity with any role,
including `admin`, and receive a working admin token.

**Fix:** a bootstrap rule. If the identities table is empty, the requested
role is allowed (this keeps the README quick-start working: the first
identity may be an issuer, exactly as the guide shows). Once bootstrapped,
creating an `issuer`, `auditor`, or `admin` requires an authenticated
admin (401 without credentials, 403 for a non-admin caller). Anyone may
still self-register as a `holder` without auth.

**Evidence:** `test/server.test.js` — "bootstrap: first identity may be
admin without auth" (201) and "second privileged creation blocked without
admin" (401 with no token, 403 with a holder token).

## 2. Token equals publicKey — FIXED

**Flaw:** `issueIdentity` returned `token: publicKey`, and `GET
/v1/identities` exposed `publicKey` to any authenticated user, so anyone
who could list identities could impersonate anyone.

**Fix:**
- `issueIdentity` now generates an independent bearer token
  (`crypto.randomBytes(32)` hex, 64 chars) and stores only its SHA-256 in
  a new `identities.tokenHash` column (nullable, UNIQUE; a migration in
  `config/database.js` adds it to pre-existing databases).
- `publicKey` remains as a non-secret identifier and is never accepted
  as a credential.
- Authentication hashes the presented token and looks up `tokenHash`
  (`config/security.js` `authenticate()` — the single auth path).
- The raw token is returned exactly once, at creation, as a top-level
  `token` field; it is deliberately NOT part of the identity object, and
  no other endpoint returns it or the stored hash. The identity
  list/detail queries select explicit columns and never touch
  `tokenHash`.

**Evidence:** `test/server.test.js` — "token != publicKey and listing
identities leaks no token" (token is 64 hex chars, differs from
publicKey, no `token`/`tokenHash` keys in listings, and authenticating
with a publicKey returns 401). The bootstrap check additionally verified
against the database that `tokenHash == sha256(printed token)` and
`tokenHash != publicKey` for every seeded identity.

## 3. No ownership checks — FIXED

**Flaw:** `POST /v1/transfers` trusted `body.from`, `POST /v1/retire`
trusted `body.holderId`, and `POST /v1/assets` trusted `body.issuerId`,
with no check against the caller — any holder with `transfer`
permission could move anyone's funds.

**Fix:** a shared `requireOwnerOrAdmin()` gate in the three routes: the
caller must be the owner named in the body, unless the caller is an
admin (403 otherwise). This sits after the role check, so both layers
apply.

**Evidence:** `test/server.test.js` — "issuer can issue only as itself"
(403 on issuerId mismatch), "holder cannot transfer another holder's
funds" (403 moving another holder's funds, 201 moving its own),
"holder cannot retire another holder's credits" (403 for an issuer
naming another holder; 403 for a holder, which also lacks the `retire`
role permission; 201 for an issuer retiring its own credits).

## 4. Genesis foreign-key crash — FIXED

**Flaw:** `blocks.miner` had `FOREIGN KEY (miner) REFERENCES
identities(id)` with `NOT NULL`, but the genesis block used miner
`'genesis'`, which is not an identity — and `createGenesisBlock()` runs
at module load. A fresh database could not boot.

**Fix:** `blocks.miner` is now nullable and the genesis block uses `NULL`
for miner. All other blocks use the creating identity's id, which
exists, so the FK still holds where it matters.

**Evidence:** `test/server.test.js` — "fresh boot creates a genesis block
with NULL miner" (health check: chainLength 1, integrity valid; direct
DB check: genesis row miner is NULL). A real `node server.js` boot
against a fresh database was also verified manually (`/health` returned
chainLength 1, integrity valid).

## 5. Chain did not commit to transaction contents — FIXED

**Flaw:** blocks stored only `transactionCount`, and `validateChain`
only rehashed block headers, so editing a transaction row passed
validation.

**Fix:**
- New `blocks.txRoot` column: the SHA-256 root over that block's
  transactions, as `id:signature` pairs in `(timestamp, id)` order
  (`computeTxRoot()`); blocks with no transaction rows (identity/asset
  blocks) use the SHA-256 of the empty string.
- `txRoot` is part of the block hash payload, and `validateChain`
  recomputes it from the transactions table per block and compares.
- Defense in depth: `validateChain` additionally re-verifies each
  transaction's HMAC attestation from its fields, so an edit that
  leaves the root intact is still caught (e.g. editing `amount`
  without touching `signature`).
- Transaction rows are inserted BEFORE `createBlock()` is called in
  the transfer/retire routes, so the root commits to them.

**Evidence:** `test/server.test.js` — "tampering a transaction row fails
validateChain" (tampering `signature` → invalid via txRoot mismatch;
tampering `amount` → invalid via attestation mismatch; restoring each
→ valid again).

## 6. Fake signatures + shallow canonicalization — FIXED

**Flaw:** the "signature" was a plain SHA-256 of the transaction fields
— anyone can compute it, so it proves nothing — and `canonical()` used
`JSON.stringify(obj, Object.keys(obj).sort())`, which passes the sorted
top-level keys as a REPLACER ARRAY: nested objects were serialized
using only the keys listed at the top level, silently dropping nested
keys.

**Fix:**
- `canonical()` now sorts keys recursively at every depth.
- Transaction attestations are HMAC-SHA256 under `LEDGER_HMAC_SECRET`
  (env). If the variable is unset, the server generates an ephemeral
  per-process secret and logs a loud warning that attestations created
  in that run will NOT verify after a restart.
- The README documents this honestly: these are SERVER ATTESTATIONS,
  not signatures made with user-held private keys. They prove the
  server recorded the transaction; they do not prove a holder signed
  anything, and anyone holding the server secret can forge them.

**Evidence:** tamper tests in §5 above; manual boot without
`LEDGER_HMAC_SECRET` printed the warning and still booted and verified.

## 7. Dead / duplicated security code — FIXED

**Flaw:** `security.js` had `authenticate`, `validateTransaction`,
`signTransaction`, `generateNonce`, and `verifyNonce`, none of which
`server.js` called — the server had its own `authenticateRequest` /
`getIdentityByToken` and inline checks, leaving two auth paths.

**Fix:** the server now authenticates exclusively through
`security.authenticate()` (updated to the tokenHash lookup); the
server's duplicate `authenticateRequest` / `getIdentityByToken` were
deleted. The dead `validateTransaction`, `signTransaction`,
`generateNonce`, and `verifyNonce` methods were deleted from
`security.js` (their checks already exist inline in the server's
transfer/retire paths). The rate limiter and audit log were kept.
The `nonces` table remains in the schema for forward compatibility only
and is noted as such in `config/database.js`.

## 8. Auth failures returned 500 — FIXED

**Flaw:** `authorize()` threw plain `Error`s and the handler mapped
unknown errors to 500, so authentication/authorization failures came
back as 500s.

**Fix:** `security.js` errors carry HTTP status via an `httpError`
helper — 401 for authentication failures, 403 for authorization
failures — and the handler's existing `err.status || 500` mapping now
returns them correctly. Rate-limit failures return 429.

**Evidence:** negative tests throughout `test/server.test.js` assert
401/403/400 statuses (visible in the TAP output as expected error
traces with `status: 401/403/400`).

## 9. Float money — FIXED (at the boundary)

**Flaw:** amounts and supplies were `REAL` columns with no integer
enforcement, so fractional values and float rounding could split units.

**Fix:** a new `integerAmount()` validator at the API boundary rejects
non-integer or non-positive values for `supply` (asset issuance) and
`amount` (transfers, retirements) with 400. Columns stay REAL for
storage; the integer rule is documented in the README.

**Evidence:** `test/server.test.js` — fractional supply → 400,
fractional transfer amount → 400.

## 10. Clean ROLES — FIXED

**Flaw:** the issuer permission `'audit:self'` never matched any
`authorize()` check (checks use `'audit'`, `'issue'`, etc.).

**Fix:** removed from the issuer permission list in `config/security.js`
(issuer is now `['issue', 'transfer', 'retire']`). No behavior change:
that permission never granted anything.

## 11. scripts/bootstrap.js used the token == publicKey pattern — FIXED

**Flaw:** the seed script duplicated the old pattern: it inserted
identities directly with `token: publicKey`.

**Fix:** `createIdentity` in `scripts/bootstrap.js` now generates a
random token, stores only its SHA-256 in `tokenHash`, and returns the
raw token, which the script prints exactly once per identity for demo
use (the existing `Token:` lines are unchanged in format). Nothing
else in the script changed; it still seeds one issuer, two holders, one
auditor, and two carbon-credit assets.

**Evidence:** manual run — `DB_FILE=<temp> node scripts/bootstrap.js`
seeded 4 identities and 2 assets; booting the server on that database
and calling `GET /v1/assets` and `GET /v1/identities` with the printed
holder token returned 200, with no `token`/`tokenHash` keys in the
listing; direct DB check confirmed `tokenHash == sha256(printed token)`
and `tokenHash != publicKey` for all four identities.

## 12. Bare SQLite keyword column names broke fresh boot — FIXED

**Investigation (as requested):** the schema used bare `index`
(blocks), `from`, and `to` (transactions) as column names. These are
SQLite keywords, and the original statements fail:

- System SQLite 3.45.1 (Python `sqlite3`): `CREATE TABLE blocks`
  → `near "index": syntax error`; `CREATE TABLE transactions` →
  `near "from": syntax error`; every `SELECT`/`INSERT`/`ORDER BY`
  touching those columns failed the same way.
- better-sqlite3's bundled SQLite 3.53.2: identical failures for the
  bare names, and success for the quoted forms.

So the original code could never create a fresh database under
better-sqlite3 either — this is a real boot bug, not a theoretical one.
(Note: the genesis FK bug in §4 was masked by this one; the schema
failed before genesis was ever attempted.)

**Fix:** `"index"`, `"from"`, and `"to"` are double-quoted in every
statement that names them: `config/database.js` (both `CREATE TABLE`s
and the `idx_transactions_from` / `idx_transactions_to` indexes),
`server.js` (`MAX("index")`, `WHERE "index" = ?`, `ORDER BY "index"`,
all block/transaction column lists), and the integration test's own
`CREATE TABLE blocks` DDL in `test/integration.test.js` (same bug
class; assertion logic untouched).

## 13. public/dashboard.html is not served — NOTED, left alone

`server.js` has no static-file route: nothing serves `public/` over
HTTP. `public/dashboard.html` (a 19 KB dashboard UI) is therefore
unconnected dead weight in the repo as shipped — opening it only works
as a local file, and it cannot talk to the API unless served. It was
left exactly as-is per the brief; wiring it up (e.g. a static route or
a note in the README pointing at it) is a separate decision, not made
here.

## 14. Dependency bump required by the environment — NOTED

`package.json` pinned `better-sqlite3@^9.2.2`. That version cannot build
against Node 24.22.1 in this environment, for two independent reasons:

1. No prebuilt binary exists for Node 24 (prebuild-install: "No
   prebuilt binaries found (target=24.22.1 runtime=node arch=x64)"),
   and the source fallback first failed extracting Node headers
   (`TAR_ENTRY_ERROR EPERM: fchown` in this sandbox), worked around
   by pre-extracting headers with system `tar` and passing `--nodedir`.
2. With headers available, the 9.2.2 source itself fails to compile
   against Node 24's V8 API (removed APIs, e.g. `CopyablePersistent`
   no longer names a type; `struct Addon` has no member `Statement` /
   `Backup` / `SqliteError`). This is a source-level incompatibility,
   not a flag problem — patching the C++ standard to C++20 got past
   the headers but not the removed APIs.

The pin was therefore bumped to `better-sqlite3@^12.0.0`, which ships a
Node 24 prebuilt and loads cleanly (bundled SQLite 3.53.2). The repo
code uses only the stable better-sqlite3 API (`new Database`,
`pragma`, `exec`, `prepare`/`get`/`all`/`run`), so no source changes
were needed for the bump. `package-lock.json` (new, generated by the
install) is included. The original 9.2.2 pin is untouched in the GitHub
repo — this change exists only in this fixed copy.

## Kept as-is (deliberately not changed)

- Prepared statements everywhere; no string-interpolated SQL.
- Input validation helpers (`requiredString`, `positiveNumber`) and
  the 1 MB request-body cap with 413 + connection destroy.
- Rate limiting (100 per route per identity per 60 s) — documented in
  code and README as in-memory, single-process only.
- Supply-conservation audit (`makeAudit`) and WAL + foreign keys +
  indexes in the schema.
- `no-store` / `nosniff` response headers.
- No `publicKey` exposure change beyond the token fix: listings still
  return `publicKey` as an identifier, which is now harmless because it
  is not a credential.

## Files changed

| File | Change |
|---|---|
| `server.js` | Bootstrap rule; single auth path; ownership gates; integer amounts; txRoot + HMAC attestations; deep canonicalization; genesis NULL miner; quoted keyword columns; HMAC secret handling + warning |
| `config/database.js` | `tokenHash` column + migration; nullable `miner`; `txRoot` column + migration; quoted `"index"`/`"from"`/`"to"` |
| `config/security.js` | Token-hash auth (401/403 statuses); removed dead methods and `'audit:self'`; kept rate limiter + audit log |
| `scripts/bootstrap.js` | Random token + stored hash, printed once |
| `test/integration.test.js` | Quoted `"index"` in its own blocks DDL (same bug class) |
| `test/server.test.js` | NEW: 10 HTTP-level tests against the real server |
| `README.md` | "Production-ready" qualified; txRoot/HMAC truthfully described; HMAC-vs-user-signature distinction; token/bootstrap/integer/in-memory-rate-limit notes; `LEDGER_HMAC_SECRET` documented |
| `package.json` | `better-sqlite3` ^9.2.2 → ^12.0.0 (Node 24 build, see §14) |
| `package-lock.json` | NEW, generated by install |
| `FIXES.md` | This file |
| `public/dashboard.html`, `LEGAL.md`, `README-STARTUP.md`, `.vscode/launch.json`, `.gitignore` | Untouched |

No commits were made and nothing was pushed. `git status` in this
directory shows the above as uncommitted modifications, which is
intentional.

## Test evidence

Command: `npm test` (`node --test --test-reporter=tap`) in this directory.

Final run — verbatim summary:

```
1..19
# tests 19
# suites 0
# pass 19
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Breakdown: 5 pre-existing `test/ledger.test.js` tests (identity
lifecycle, asset issuance, transfer and balance, retirement flow,
audit validation), 4 pre-existing `test/integration.test.js` tests
(real estate issue/transfer, supply chain multi-party flow, carbon
issue/retire, authorization role check), and 10 new
`test/server.test.js` tests (fresh boot + genesis; bootstrap first
identity; second privileged creation blocked; admin creates
issuer/holders/auditor; issuer issues only as itself + integer
supplies; holder cannot transfer another's funds; holder cannot retire
another's credits; token != publicKey + no token leak in listings;
tampering a transaction row fails validation; audit supply
conservation holds).

An earlier run (before a one-line test fix) showed 9 pass / 1 fail:
`test/server.test.js` failed to load with `ReferenceError: before is
not defined` because the file imported only `test` from `node:test`.
Fixed by importing `{ test, before, after }`; no production code was
involved. The expected 401/403/400 error traces printed to stderr by
the server's `console.error` in its catch handler during negative
tests are normal and pre-existing behavior.

Manual checks beyond the suite (all passed):

- Real `node server.js` boot on a fresh database: `/health` →
  `{"status":"ok","chainLength":1,"integrity":{"valid":true,"length":1}}`.
- Boot without `LEDGER_HMAC_SECRET` prints the loud ephemeral-secret
  warning and still boots and verifies.
- `scripts/bootstrap.js` on a fresh database + server boot on that
  database: printed holder token authenticates (200 on `/v1/assets`
  and `/v1/identities`); listings contain no token material; DB check
  confirms `tokenHash == sha256(printed token)`.
- No stray `aether.db` files were left in the repo tree by the test
  runs (the server test uses a temp directory; the ledger test's
  leftover `-wal`/`-shm` files were removed after the run).
