/**
 * Security Configuration & Enforcement
 * Centralizes auth, validation, and policy checks
 */

const crypto = require('node:crypto');

const ROLES = {
  admin: { label: 'Administrator', permissions: ['*'] },
  issuer: { label: 'Asset Issuer', permissions: ['issue', 'transfer', 'retire', 'audit:self'] },
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
    this.auditLog = [];
  }

  /**
   * Authenticate a request based on API key or signature
   */
  authenticate(req) {
    const authHeader = req.headers.authorization || '';
    
    if (!authHeader.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    
    const token = authHeader.slice(7);
    const identity = this.db.prepare('SELECT id, name, role FROM identities WHERE publicKey = ? AND active = 1').get(token);
    
    if (!identity) {
      throw new Error('Invalid or revoked API token');
    }
    
    return identity;
  }

  /**
   * Authorize an action based on role and permission
   */
  authorize(identity, action, resource = null) {
    const role = ROLES[identity.role];
    if (!role) throw new Error('Invalid role');
    
    if (role.permissions.includes('*')) return true;
    if (!role.permissions.includes(action)) {
      this.logAudit('UNAUTHORIZED_ACTION', identity.id, action, resource, false);
      throw new Error(`Identity ${identity.id} (${identity.role}) is not authorized for ${action}`);
    }
    
    return true;
  }

  /**
   * Validate a transaction against ledger rules
   */
  validateTransaction(txType, identity, assetId, from, to, amount) {
    const asset = this.db.prepare('SELECT vertical, supply, circulatingSupply FROM assets WHERE id = ?').get(assetId);
    if (!asset) throw new Error('Asset not found');
    
    const vertical = VERTICALS[asset.vertical];
    if (!vertical) throw new Error('Invalid vertical');
    
    // Check balance
    const balance = this.db.prepare('SELECT amount FROM balances WHERE assetId = ? AND holderId = ?').get(assetId, from)?.amount || 0;
    if (balance < amount) {
      this.logAudit('INSUFFICIENT_BALANCE', identity.id, txType, assetId, false, { from, amount, balance });
      throw new Error('Insufficient balance');
    }
    
    // Check if retirement is allowed
    if (txType === 'retire' && !vertical.retireable) {
      this.logAudit('RETIRE_NOT_ALLOWED', identity.id, txType, assetId, false, { vertical: asset.vertical });
      throw new Error(`${vertical.name} tokens cannot be retired`);
    }
    
    // Check if amount exceeds circulating supply for retirement
    if (txType === 'retire' && amount > asset.circulatingSupply) {
      this.logAudit('RETIRE_EXCEEDS_SUPPLY', identity.id, txType, assetId, false, { amount, circulatingSupply: asset.circulatingSupply });
      throw new Error('Retirement amount exceeds circulating supply');
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
   * Generate a secure nonce to prevent replay attacks
   */
  generateNonce(identityId) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const stmt = this.db.prepare('INSERT INTO nonces (identityId, nonce, createdAt, expiresAt) VALUES (?, ?, ?, ?)');
    const now = new Date();
    const expires = new Date(now.getTime() + 5 * 60 * 1000); // 5 min expiry
    stmt.run(identityId, nonce, now.toISOString(), expires.toISOString());
    return nonce;
  }

  /**
   * Verify nonce is valid and not reused
   */
  verifyNonce(identityId, nonce) {
    const storedNonce = this.db.prepare('SELECT nonce, expiresAt FROM nonces WHERE identityId = ? AND nonce = ?').get(identityId, nonce);
    if (!storedNonce) throw new Error('Invalid or expired nonce');
    
    if (new Date(storedNonce.expiresAt) < new Date()) {
      throw new Error('Nonce expired');
    }
    
    // Invalidate nonce after use
    this.db.prepare('DELETE FROM nonces WHERE identityId = ? AND nonce = ?').run(identityId, nonce);
    
    return true;
  }

  /**
   * Generate a signature for a transaction (server-side signing)
   */
  signTransaction(payload) {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 32);
  }

  /**
   * Check if account is rate-limited
   */
  checkRateLimit(identityId, action, limit = 100, windowSeconds = 60) {
    const key = `ratelimit:${identityId}:${action}`;
    const now = Date.now();
    
    // Simple in-memory rate limit (upgrade to Redis for production)
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
      throw new Error(`Rate limit exceeded: ${limit} ${action} per ${windowSeconds}s`);
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
