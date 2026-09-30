# Aether Ledger — Quick Start

## What is Aether Ledger?

A secure, append-only ledger system for tokenizing and tracking carbon credits, supply chain assets, and real estate ownership. Built with a real blockchain chain-of-custody model, cryptographic verification, and audit trails.

**Current Focus:** Carbon Credits MVP

## Installation

```bash
git clone https://github.com/lightningfast410-afk/aether-ledger.git
cd aether-ledger
npm install
```

## Quick Start

### 1. Start the server

```bash
npm start
```

Server runs on `http://localhost:3000`

### 2. Bootstrap sample data (optional)

In another terminal:

```bash
node scripts/bootstrap.js
```

This creates sample identities and carbon credit assets for testing.

### 3. Create your first identity

```bash
curl -X POST http://localhost:3000/v1/identities \
  -H "Content-Type: application/json" \
  -d '{"name": "My Company", "role": "issuer"}'
```

Response:
```json
{
  "identity": {
    "id": "id_...",
    "name": "My Company",
    "role": "issuer",
    "publicKey": "...",
    "createdAt": "2026-09-30T...",
    "token": "..."
  },
  "token": "...",
  "block": { ... }
}
```

**Save the `token` — you'll need it for all authenticated requests.**

### 4. Issue carbon credits

Replace `YOUR_TOKEN` with the token from step 3, and `YOUR_ISSUER_ID` with the identity ID:

```bash
curl -X POST http://localhost:3000/v1/assets \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "vertical": "carbon_credits",
    "name": "Solar Farm Credits 2026",
    "issuerId": "YOUR_ISSUER_ID",
    "supply": 1000,
    "description": "Credits from 50MW solar farm"
  }'
```

Response:
```json
{
  "asset": {
    "id": "ast_...",
    "vertical": "carbon_credits",
    "name": "Solar Farm Credits 2026",
    "supply": 1000,
    "circulatingSupply": 1000,
    "retiredSupply": 0
  },
  "block": { ... }
}
```

### 5. Transfer credits to a holder

First, create a holder identity:

```bash
curl -X POST http://localhost:3000/v1/identities \
  -H "Content-Type: application/json" \
  -d '{"name": "Carbon Investor", "role": "holder"}'
```

Then transfer:

```bash
curl -X POST http://localhost:3000/v1/transfers \
  -H "Authorization: Bearer YOUR_ISSUER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "assetId": "ast_...",
    "from": "YOUR_ISSUER_ID",
    "to": "HOLDER_ID",
    "amount": 500
  }'
```

### 6. Retire credits

Once a holder has credits, they can retire them:

```bash
curl -X POST http://localhost:3000/v1/retire \
  -H "Authorization: Bearer HOLDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "assetId": "ast_...",
    "holderId": "HOLDER_ID",
    "amount": 100
  }'
```

### 7. Run an audit

Create an auditor identity:

```bash
curl -X POST http://localhost:3000/v1/identities \
  -H "Content-Type: application/json" \
  -d '{"name": "Compliance Auditor", "role": "auditor"}'
```

Then run an audit:

```bash
curl -X POST http://localhost:3000/v1/audit \
  -H "Authorization: Bearer AUDITOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "assetId": "ast_..."
  }'
```

Response:
```json
{
  "audit": {
    "valid": true,
    "assetId": "ast_...",
    "supply": 1000,
    "totalBalance": 1000,
    "retired": 0,
    "holders": 1,
    "transactions": 0,
    "chainValid": true
  }
}
```

### 8. Verify the blockchain

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/v1/verify
```

Response:
```json
{
  "valid": true,
  "length": 5
}
```

## API Reference

### Public Endpoints

#### POST /v1/identities
Create a new identity (issuer, holder, or auditor).

**Request:**
```json
{
  "name": "string (required)",
  "role": "holder | issuer | auditor (default: holder)"
}
```

**Response:**
```json
{
  "identity": { ... },
  "token": "string (use for authentication)",
  "block": { ... }
}
```

#### GET /health
Check service health.

### Authenticated Endpoints
(All require `Authorization: Bearer <token>` header)

#### GET /v1/identities
List all active identities.

#### GET /v1/identities/:id
Get details for a specific identity.

#### GET /v1/assets
List all assets. Optional query: `?vertical=carbon_credits`

#### POST /v1/assets
Issue a new asset.

**Request:**
```json
{
  "vertical": "carbon_credits | supply_chain | real_estate",
  "name": "string",
  "issuerId": "string (identity ID)",
  "supply": "number",
  "description": "string (optional)"
}
```

#### GET /v1/assets/:id
Get details for a specific asset including all balances.

#### POST /v1/transfers
Transfer assets between holders.

**Request:**
```json
{
  "assetId": "string",
  "from": "string (identity ID)",
  "to": "string (identity ID)",
  "amount": "number"
}
```

#### POST /v1/retire
Retire carbon credits (permanent removal from circulation).

**Request:**
```json
{
  "assetId": "string",
  "holderId": "string",
  "amount": "number"
}
```

#### GET /v1/blocks
View the full blockchain.

#### GET /v1/transactions
List all transactions. Optional: `?assetId=ast_...`

#### GET /v1/verify
Verify blockchain integrity.

#### POST /v1/audit
Run a compliance audit on an asset.

**Request:**
```json
{
  "assetId": "string"
}
```

#### GET /v1/export
Export audit logs. Optional: `?start=2026-01-01T00:00:00Z&end=2026-12-31T23:59:59Z`

## Data Model

### Identity
- `id`: unique identifier
- `name`: display name
- `role`: holder | issuer | auditor | admin
- `publicKey`: bearer token for authentication
- `createdAt`: timestamp
- `active`: boolean

### Asset
- `id`: unique identifier
- `vertical`: carbon_credits | supply_chain | real_estate
- `name`: display name
- `description`: metadata
- `issuerId`: identity that created the asset
- `supply`: total issued
- `circulatingSupply`: amount in active circulation
- `retiredSupply`: amount permanently removed
- `metadata`: custom JSON
- `createdAt`: timestamp

### Transaction
- `id`: unique identifier
- `type`: transfer | retire | issue
- `assetId`: asset being transferred
- `from`: sender identity
- `to`: recipient identity (null for retirement)
- `amount`: quantity transferred
- `signature`: cryptographic signature
- `blockIndex`: which block this transaction belongs to
- `timestamp`: when transaction occurred
- `status`: confirmed | pending

### Block
- `index`: block number in chain
- `hash`: SHA-256 hash of block data
- `previousHash`: hash of previous block (chain link)
- `timestamp`: when block was created
- `transactionCount`: number of transactions in block
- `miner`: identity that created the block
- `nonce`: proof-of-work nonce (future)

## Security & Compliance

**Authentication:** Bearer token (public key from identity creation)

**Authorization:** Role-based access control
- Issuer: can issue assets, transfer, retire, audit
- Holder: can transfer, view
- Auditor: can audit, view, export
- Admin: all permissions

**Audit Trail:** Every action is logged with timestamp, actor, and result

**Chain Verification:** Full blockchain can be verified for integrity

**Immutability:** Blocks are cryptographically linked; tampering is detectable

## Compliance Notes

See [LEGAL.md](./LEGAL.md) for important legal and compliance boundaries.

**Key points:**
- This is a ledger system, not a legal title transfer system
- Operators must comply with local securities, financial services, and environmental regulations
- Carbon credit issuers must comply with carbon credit standards (Verra, Gold Standard, etc.)
- Real estate tokenization does not transfer legal title without proper deed recording

## Testing

```bash
npm test
```

Runs full test suite covering:
- Identity creation and lifecycle
- Asset issuance
- Transfer and balance updates
- Credit retirement
- Audit validation
- Blockchain verification

## Roadmap

**Phase 1 (Current): Carbon Credits MVP**
- ✅ Core ledger engine
- ✅ Identity and authentication
- ✅ Issue, transfer, retire flows
- ✅ Audit and verification
- 🔲 Dashboard UI connection
- 🔲 Compliance export

**Phase 2: Supply Chain Branch**
- Lot/batch tracking
- Custody transfer
- Provenance metadata

**Phase 3: Real Estate Branch**
- Fractional ownership
- Title history tracking
- Share transfer rules

## Support

For questions or issues, open a GitHub issue or consult [LEGAL.md](./LEGAL.md) for compliance guidance.

---

**Aether Ledger v1.0 — A secure, auditable, immutable ledger for trusted asset provenance.**
