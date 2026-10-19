const db = require('./db');

class SuppressionManager {
  static isSuppressed(email) {
    if (!email) return false;
    const cleanEmail = email.toLowerCase().trim();
    const row = db.prepare('SELECT email FROM suppression_list WHERE email = ?').get(cleanEmail);
    return !!row;
  }

  static add(email, reason = 'manual', details = null) {
    const cleanEmail = email.toLowerCase().trim();
    const stmt = db.prepare(`
      INSERT INTO suppression_list (email, reason, details, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        reason = excluded.reason,
        details = excluded.details,
        created_at = excluded.created_at
    `);
    stmt.run(cleanEmail, reason, details, Date.now());
    return { email: cleanEmail, reason, status: 'suppressed' };
  }

  static remove(email) {
    const cleanEmail = email.toLowerCase().trim();
    const res = db.prepare('DELETE FROM suppression_list WHERE email = ?').run(cleanEmail);
    return res.changes > 0;
  }

  static list({ limit = 50, offset = 0, reason = null } = {}) {
    if (reason) {
      return db.prepare('SELECT * FROM suppression_list WHERE reason = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(reason, limit, offset);
    }
    return db.prepare('SELECT * FROM suppression_list ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  static count() {
    const res = db.prepare('SELECT COUNT(*) as total FROM suppression_list').get();
    return res.total || 0;
  }
}

module.exports = SuppressionManager;
