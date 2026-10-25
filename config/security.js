/**
 * Security Configuration & Enforcement
 * Centralizes auth, validation, and policy checks
 *
 * Fixed copy notes (see FIXES.md):
 * - This is now the ONLY authentication path: server.js calls
 *   security.authenticate(). The server's duplicate authenticateRequest /
 *   getIdentityByToken were removed.
 * - Bearer tokens are random values; only their SHA-256 (tokenHash) is
 *   stored. publicKey is a non-secret identifier and is NOT a credential.
 * - Dead methods from the original (validateTransaction, signTransaction,
 *   generateNonce, verifyNonce) were deleted: they were never called and
 *   duplicated logic the server already implements inline.
 * - Auth errors carry HTTP status (401 authentication, 403 authorization)
 *   instead of plain Errors that the handler mapped to 500.
 * - The rate limiter is in-memory and single-process only: it does not
 *   survive restarts and does not coordinate across processes. Documented
 *   as such; do not rely on it as a distributed control.
 */

const crypto = require('node:crypto');

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const ROLES = {
  admin: { label: 'Administrator', permissions: ['*'] },
  // NOTE: the original issuer permission 'audit:self' never matched any
  // authorize() check and was removed.
  issuer: { label: 'Asset Issuer', permissions: ['issue', 'transfer', 'retire'] },
  holder: { label: 'Asset Holder', permissions: ['transfer', 'view'] },
  auditor: { label: 'Compliance Auditor', permissions: ['audit', 'view', 'export'] },
  retired: { label: 'Retired Account', permissions: ['view'] }
};

const VERTICALS = {
  real_estate: {
    name: 'Real Estate',
    unit: 'token',
    retireable: false,
    requiresIdentityVerification: true,
    complianceNotes: 'Does not transfer legal title. Proper deed recording required.'
  },
  supply_chain: {
    name: 'Supply Chain',
    unit: 'unit',
    retireable: false,
    requiresIdentityVerification: false,
    complianceNotes: 'Records provenance and custody transfer history.'
  },
  carbon_credits: {
    name: 'Carbon Credits',
    unit: 'tCO2e',
    retireable: true,
    requiresIdentityVerification: true,
    complianceNotes: 'Must comply with carbon credit standards (Verra, Gold Standard, etc.).'
  }
};

class SecurityEngine {
  constructor(db) {
    this.db = db;
  }

  /**
   * Authenticate a request by bearer token.
   * The presented token is hashed and compared against the stored
   * tokenHash; the raw token is never stored and publicKey is NOT
   * accepted as a credential.
   */
  authenticate(req) {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      throw httpError('Missing or invalid Authorization header', 401);
    }

    const token = authHeader.slice(7);
    const identity = this.db.prepare(
      'SELECT id, name, role FROM identities WHERE tokenHash = ? AND active = 1'
    ).get(sha256(token));

    if (!identity) {
      throw httpError('Invalid or revoked API token', 401);
    }

    return identity;
  }

  /**
   * Authorize an action based on role and permission
   */
  authorize(identity, action, resource = null) {
    const role = ROLES[identity.role];
    if (!role) throw httpError('Invalid role', 403);

    if (role.permissions.includes('*')) return true;
    if (!role.permissions.includes(action)) {
      this.logAudit('UNAUTHORIZED_ACTION', identity.id, action, resource, false);
      throw httpError(`Identity ${identity.id} (${identity.role}) is not authorized for ${action}`, 403);
    }

    return true;
  }

  /**
   * Log audit event
   */
  logAudit(eventType, identityId, action, resource, success, metadata = {}) {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      eventType,
      identityId,
      action,
      resource,
      success,
      metadata,
      ipAddress: metadata.ipAddress || 'unknown'
    };

    try {
      const stmt = this.db.prepare(
        'INSERT INTO audit_log (timestamp, eventType, identityId, action, resource, success, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      stmt.run(
        auditEntry.timestamp,
        auditEntry.eventType,
        auditEntry.identityId,
        auditEntry.action,
        auditEntry.resource,
        auditEntry.success ? 1 : 0,
        JSON.stringify(auditEntry.metadata)
      );
    } catch (error) {
      console.error('Audit log error:', error);
    }

    return auditEntry;
  }

  /**
   * Check if account is rate-limited.
   * IN-MEMORY, SINGLE-PROCESS ONLY: counters reset on restart and are
   * not shared between processes. Do not treat this as a distributed
   * rate limit.
   */
  checkRateLimit(identityId, action, limit = 100, windowSeconds = 60) {
    const key = `ratelimit:${identityId}:${action}`;
    const now = Date.now();

    if (!this.rateLimitStore) this.rateLimitStore = {};

    if (!this.rateLimitStore[key]) {
      this.rateLimitStore[key] = { count: 0, resetTime: now + windowSeconds * 1000 };
    }

    const bucket = this.rateLimitStore[key];

    if (now > bucket.resetTime) {
      bucket.count = 0;
      bucket.resetTime = now + windowSeconds * 1000;
    }

    bucket.count++;
    if (bucket.count > limit) {
      this.logAudit('RATE_LIMIT_EXCEEDED', identityId, action, null, false, { limit, actual: bucket.count });
      throw httpError(`Rate limit exceeded: ${limit} ${action} per ${windowSeconds}s`, 429);
    }

    return true;
  }

  /**
   * Export audit logs for compliance
   */
  exportAuditLog(startDate, endDate, filter = {}) {
    let query = 'SELECT * FROM audit_log WHERE timestamp >= ? AND timestamp <= ?';
    const params = [startDate, endDate];

    if (filter.identityId) {
      query += ' AND identityId = ?';
      params.push(filter.identityId);
    }
    if (filter.eventType) {
      query += ' AND eventType = ?';
      params.push(filter.eventType);
    }
    if (filter.success !== undefined) {
      query += ' AND success = ?';
      params.push(filter.success ? 1 : 0);
    }

    query += ' ORDER BY timestamp DESC';

    const logs = this.db.prepare(query).all(...params);
    return logs.map(log => ({
      ...log,
      metadata: JSON.parse(log.metadata || '{}')
    }));
  }
}

module.exports = { SecurityEngine, ROLES, VERTICALS };
