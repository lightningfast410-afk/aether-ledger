# Aether Ledger v1.0

A secure, multi-vertical blockchain engine to tokenize **Real Estate**, **Supply Chain**, and **Carbon Credits**.

> **Status: working prototype, not production-ready.** This is a single-process
> demo ledger: authentication is bearer-token based, transaction attestations
> are server-side HMAC (not signatures from user-held keys), rate limiting is
> in-memory only, and there is no TLS — run it behind a reverse proxy with
> HTTPS, a stable `LEDGER_HMAC_SECRET`, and a real secret store before any
> real use. See "Security & Compliance" below for the honest limits.

## Features

✅ **Append-only ledger** with cryptographic hash chaining
✅ **Role-based access control** (admin, issuer, auditor, holder)
✅ **Three verticals** fully supported:
  - Real Estate: Property tokens with transfer & ownership tracking
  - Supply Chain: Unit tracking through production & distribution networks
  - Carbon Credits: Retirement and offset accounting
✅ **Tamper-evident blocks** with SHA-256 hashing
✅ **Persistent SQLite database** with WAL journaling
✅ **Identity & authentication** framework
✅ **Asset lifecycle** (issue → transfer → retire)
✅ **Audit trail** with full transaction history
✅ **Chain validation** & integrity verification
✅ **TypeScript-ready** JSON API
✅ **Comprehensive test suite** (integration tests included)

## Install & Run

```bash
npm install
npm start
# Aether Ledger v1.0 listening on http://localhost:3000
```

Env vars:
- `PORT` — server port (default: 3000)
- `DB_FILE` — database path (default: `./aether.db`)
- `LEDGER_HMAC_SECRET` — server secret for transaction attestations. If unset,
  the server generates an ephemeral per-process secret and logs a warning:
  attestations created in that run will NOT verify after a restart. Set a
  stable secret for any database you intend to keep.

## Quick Start

### 1. Create an Identity (Issuer)

```bash
curl -X POST http://localhost:3000/v1/identities \
  -H 'content-type: application/json' \
  -d '{"name": "Solar Corp", "role": "issuer"}'
```

Response:
```json
{
  "identity": {
    "id": "id_...",
    "name": "Solar Corp",
    "role": "issuer",
    "publicKey": "...",
    "createdAt": "2026-09-30T..."
  },
  "block": { ... }
}
```

### 2. Issue Carbon Credits

```bash
curl -X POST http://localhost:3000/v1/assets \
  -H 'content-type: application/json' \
  -d '{
    "vertical": "carbon_credits",
    "name": "Solar Farm 2026",
    "issuerId": "id_<issuer-id>",
    "supply": 5000,
    "metadata": {"location": "Arizona", "type": "solar"}
  }'
```

### 3. Create a Holder & Transfer Credits

```bash
curl -X POST http://localhost:3000/v1/identities \
  -H 'content-type: application/json' \
  -d '{"name": "Buyer Corp", "role": "holder"}'
```

```bash
curl -X POST http://localhost:3000/v1/transfers \
  -H 'content-type: application/json' \
  -d '{
    "assetId": "ast_<asset-id>",
    "from": "id_<issuer-id>",
    "to": "id_<buyer-id>",
    "amount": 500
  }'
```

### 4. Retire Credits (Carbon Only)

```bash
curl -X POST http://localhost:3000/v1/retire \
  -H 'content-type: application/json' \
  -d '{
    "assetId": "ast_<asset-id>",
    "holderId": "id_<holder-id>",
    "amount": 100
  }'
```

### 5. Audit an Asset

```bash
curl -X POST http://localhost:3000/v1/audit \
  -H 'content-type: application/json' \
  -d '{
    "assetId": "ast_<asset-id>",
    "auditorId": "id_<auditor-id>"
  }'
```

## API Reference

### Identities
- `GET /v1/identities` — list all identities
- `POST /v1/identities` — create a new identity (issuer, auditor, holder, admin)
- `GET /v1/identities/:id` — retrieve identity by ID

### Assets
- `GET /v1/assets` — list all assets (supports `?vertical=carbon_credits` filter)
- `POST /v1/assets` — issue a new asset
- `GET /v1/assets/:id` — get asset details & holder balances

### Transfers
- `POST /v1/transfers` — transfer units between holders
- `POST /v1/retire` — retire carbon credits (carbon_credits vertical only)

### Chain & Audit
- `GET /v1/blocks` — inspect the blockchain
- `GET /v1/transactions` — list all transactions (supports `?assetId=ast_...` filter)
- `GET /v1/verify` — validate chain integrity (all hashes & links)
- `POST /v1/audit` — full audit of an asset (balance reconciliation, chain check)
- `GET /health` — service status

## Verticals

### Real Estate (`real_estate`)
- Token-based property ownership
- Divisible; can be fractional
- Non-retireable
- Use case: tokenized real estate, property shares, REITs

### Supply Chain (`supply_chain`)
- Unit tracking for goods/materials
- Fully divisible
- Non-retireable
- Use case: product provenance, lot tracking, material origin

### Carbon Credits (`carbon_credits`)
- Metric tons of CO₂ equivalent (tCO2e)
- Divisible to fractional tCO2e
- **Retireable** — can be permanently removed from circulation
- Use case: carbon offsets, emissions reduction projects, compliance trading

## Security & Compliance

- **Cryptographic hashing**: SHA-256 for immutability
- **Role-based access**: issuer, auditor, holder, admin. Registration is
  bootstrapped: the very first identity may be any role (this is what makes
  the quick-start work); after that, creating an issuer, auditor, or admin
  requires an authenticated admin, while anyone may self-register as a
  holder. Transfers, retirements, and asset issuance additionally require
  the caller to be the owner named in the request, unless the caller is an
  admin.
- **Bearer tokens, not publicKeys**: each identity gets a random bearer
  token at creation. Only the token's SHA-256 is stored; the raw token is
  shown exactly once, at creation, and never appears in identity listings
  or any other response. The `publicKey` field is a non-secret identifier
  and is NOT accepted as a credential.
- **Tamper detection**: every block stores a `txRoot` — the SHA-256 root
  over that block's transactions (`id:signature` pairs) — and the block
  hash commits to the `txRoot`. Chain validation recomputes each block's
  `txRoot` from the transactions table and re-verifies each transaction
  attestation, so editing a transaction row fails validation.
- **Attestations, not user signatures**: transaction "signatures" are
  HMAC-SHA256 values computed server-side under `LEDGER_HMAC_SECRET`.
  They prove the server recorded the transaction; they do NOT prove a
  holder signed anything with a key they hold, and anyone with the server
  secret can forge them. Do not present them as user-held-key signatures.
- **Audit trail**: full transaction history with attestations
- **Chain validation**: automatic verification of all blocks, links,
  transaction roots, and attestations
- **Integer amounts**: supplies and transfer/retirement amounts must be
  positive integers at the API boundary (columns stay REAL for storage).
- **Rate limiting**: in-memory, single-process only (100 requests per
  route per identity per 60 seconds). It resets on restart and does not
  coordinate across processes.
- **WAL database**: atomic writes; no partial updates
- **Metadata**:  arbitrary JSON for regulatory info, certificates, etc.

## Architecture

```
┌─────────────────────────────────────────────┐
│         HTTP API (Express-like)             │
│   /v1/{identities,assets,transfers,...}    │
└──────────────┬──────────────────────────────┘
               │
         ┌─────▼─────────┐
         │  Transaction  │
         │  Validation   │
         └─────┬─────────┘
               │
         ┌─────▼──────────┐
         │   Blockchain   │
         │  (Hash Chain)  │
         └─────┬──────────┘
               │
        ┌──────▼──────────┐
        │  SQLite 3 + WAL │
        │   (aether.db)   │
        └─────────────────┘
```

## Testing

```bash
npm test
# Runs integration tests for all three verticals,
# authorization checks, and chain integrity
```

Includes:
- Real Estate: issue & transfer
- Supply Chain: multi-party flow
- Carbon Credits: retire & offset accounting
- Authorization: role-based checks
- Integrity: chain validation

## Production Notes

✅ **Use SQLite** for embedded deployments
✅ **Add HTTPS** in front (reverse proxy)
✅ **Implement mTLS** for identity verification
✅ **Backup** `aether.db` regularly
✅ **Monitor** chain integrity on startup
✅ **Use auditor role** for compliance reviews
✅ **Set `LEDGER_HMAC_SECRET`** to a stable value (see env vars above)
✅ **Replace in-memory rate limiting** with a shared store if you ever run
   more than one process
✅ **Add observability**: logs, metrics, traces

## License

MIT
