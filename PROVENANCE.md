# Provenance — Aether Ledger

Author: Zackariah Partridge
Repository: github.com/lightningfast410-afk/aether-ledger
Original code: September 2026
Security fix published: October 25, 2026, main branch, commits
2a0aacf, 3ec6af0, d52afc0, ae2314d (repo 8 → 12 commits)
Anti-theft hardening: October 25, 2026 (token revoke, production
fail-closed secret, this manifest, DEPLOY.md)

## What this proves

Public code can always be copied. This manifest does not prevent
copying — it proves origin. If this code appears elsewhere claimed
as someone else's work, the dated commit history plus the hashes
below identify this repository as the source. Removing authorship
or attribution is not permitted under the license in README.md
(MIT, unchanged by the hardening round).

## File manifest (SHA-256, hardening round)

- server.js: 1cc333d11c0512ff18cb111ec3bc809095fceacceb378b0097739039a6193a71
- config/database.js: 85ce85937127bbb6d2800ed31bdc6bbd110ce663cae1c99607c68593ed5e0f17
- config/security.js: 9750ce3ca56cd51b26a126d228de61ce05f3d9790745be56e27976646d1a14c6
- scripts/bootstrap.js: 691516ddde290e0cdf1e310cb3791b7390b86e83796d8962d2519bfe679e90c7
- test/ledger.test.js: fb83c4f7c1a23cea8c36e71af133d68dfedb5437d7d9acc6497752e01e8544be
- test/integration.test.js: 00f7b3700fe0b2525238a5477aa4f80ed7af42300078dbcfdcfd1beeb1ecb5bc
- test/server.test.js: 19d5cdbd41a93524ec99154003c825fec3a7850570537ca9accb90fb4407ef7c
- README.md: 72f828171b4613b3255e861747774fdb7eb3db7230cdfd92e7a52d57f6e59cfc
- README-STARTUP.md: ff183718f4904b630995c7c1f0e60e76b9bc6c357d625b3a65ca8c94a9f516b6
- LEGAL.md: 1500a36f2eec51f23ca09f111593a9f3512c3e8680ae46e907c5c42e03ba0561
- FIXES.md: d936f2af8d78efd90d60df141563f34a5086195022d9486214d58440d47615e5
- DEPLOY.md: 55e7fa99ce93350465efddcbc297cd9577b61a67a7d473b67863ad28c510d13a
- package.json: b217e153802be4e1621de3808ee89b56ce4c1cd7e741f8a78df121cd2c812cc3
- package-lock.json: e6d2816dabb5832d940c31c6e6c5182df7ea35d91a950b45a832296249d23a87

This file's own hash is established by the commit that publishes it;
it cannot list itself. Verify any file with `sha256sum <file>` and
compare against the list above.

## What was NOT changed

- The license (MIT in README.md) was not changed. Code already
  published under MIT stays MIT-licensed to anyone who already
  received it. A future license change would only govern later
  versions and is a separate decision.
- No credentials, private keys, or provider tokens are in this
  repository. The server secret is supplied by environment at run
  time and is never committed.
