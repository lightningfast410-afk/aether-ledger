# Aether Ledger

A secure, append-only blockchain engine for tokenizing **Real Estate**, **Supply Chain**, and **Carbon Credits**.

This first runnable slice provides a dependency-free Node.js prototype with a tamper-evident hash chain, durable local storage, asset issuance, transfers, integrity verification, and a small HTTP API. It is deliberately a foundation—not a production financial or compliance system.

## Run

```bash
npm start
# Aether Ledger listening on http://localhost:3000
```

The ledger is stored in `ledger.json` (override with `LEDGER_FILE=/path/to/file`). Set `PORT` to change the port. Node.js 20+ is required.

## API

- `GET /health` — service status and chain integrity
- `GET /v1/verify` — validate every block hash and chain link
- `GET /v1/blocks` — inspect the append-only chain
- `GET /v1/assets` and `GET /v1/assets/:id` — list or retrieve tokenized assets
- `POST /v1/assets` — issue an asset
- `POST /v1/transfers` — transfer units between owners

Issue an asset:

```bash
curl -X POST localhost:3000/v1/assets -H 'content-type: application/json' \
  -d '{"vertical":"carbon_credits","name":"Forest Project 2026","owner":"org-green","supply":1000,"metadata":{"registry":"demo"}}'
```

Transfer units using the returned asset ID:

```bash
curl -X POST localhost:3000/v1/transfers -H 'content-type: application/json' \
  -d '{"assetId":"ast_...","from":"org-green","to":"buyer-1","amount":25}'
```

Supported verticals are `real_estate`, `supply_chain`, and `carbon_credits`. Every mutation is represented by a block containing a SHA-256 hash and the previous block hash. Writes use a temporary file and atomic rename to avoid partially written ledgers.

## Roadmap

Next production-hardening milestones are authenticated identities and signatures, a database-backed transactional store, role-based authorization, compliance/retirement workflows for carbon credits, oracle/event integrations, encrypted backups, and a multi-node consensus/network layer.

## Test

```bash
npm test
```
