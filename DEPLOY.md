# Aether Ledger — real-use deploy checklist

This is the shortest honest path from the demo to a real deployment.
It does not make the ledger audited, licensed, or legally binding —
see LEGAL.md for what this system does NOT do.

## 1. Secret (required, fail-closed)

- Set `LEDGER_HMAC_SECRET` from a secret store, never in code and never
  committed to git (`.env` is already git-ignored).
- With `NODE_ENV=production` the server **refuses to start** without a
  stable secret. That is deliberate: an ephemeral secret would make
  attestations unverifiable after a restart.
- Changing the secret later breaks verification of attestations made
  under the old secret. A secret rotation means a new database, or a
  planned migration with a fresh chain — never a silent swap.

## 2. Run it for real

```bash
NODE_ENV=production PORT=3000 DB_FILE=/var/lib/aether/aether.db \
  LEDGER_HMAC_SECRET=<from your secret store> \
  node server.js
```

- Single process only. Rate limiting is in-memory and does not
  coordinate across processes.
- Put HTTPS in front (reverse proxy). Never expose this over plain HTTP.
- Restrict the database file's permissions to the service account only.
- Back up `aether.db` regularly and test a restore. A backup is the
  only recovery if the live database is lost or corrupted.

## 3. Operate it

- On startup, check `GET /health` and `GET /v1/verify` (admin/auditor).
  If `verify` ever returns invalid, stop and investigate — do not keep
  issuing against a broken chain.
- First identity bootstraps the system: create the admin first, then
  create issuers/auditors only as that admin. Anyone may self-register
  as a holder.
- A bearer token is shown exactly once, at creation. Store it in a
  secret store immediately. It never appears in listings or any other
  response, and only its hash is stored.
- If a token is stolen or leaked, kill it at once:
  `POST /v1/identities/:id/revoke` as admin. The token returns 401
  from that moment on. An admin cannot revoke themselves, so keep a
  second admin identity stored safely for recovery.
- Keep the audit log: `GET /v1/export` (admin/auditor) gives the
  operator an exportable history for review.

## 4. What this does NOT fix

- Transaction attestations are server-side HMAC, not signatures from
  user-held keys. Anyone holding the server secret can forge them.
  Do not present them as user signatures.
- Recording something here does not create legal title, does not
  register a security, and does not certify a carbon credit. Issuers
  carry the legal and standards compliance (see LEGAL.md).
- This code has not had an independent security audit. A real-money
  deployment wants one first, plus the licensing review LEGAL.md calls
  for.
