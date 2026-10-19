/**
 * Domain Rate Limiter & Concurrency Manager
 * Prevents destination MX servers (Gmail, Yahoo, Outlook) from rate-limiting (421) or spam-filtering.
 */
class DomainRateLimiter {
  constructor() {
    this.activePerDomain = new Map();
    this.lastSentPerDomain = new Map();

    // Default concurrency limits per recipient domain
    this.limits = {
      'gmail.com': { maxConcurrent: 5, minIntervalMs: 50 },
      'googlemail.com': { maxConcurrent: 5, minIntervalMs: 50 },
      'yahoo.com': { maxConcurrent: 3, minIntervalMs: 100 },
      'outlook.com': { maxConcurrent: 5, minIntervalMs: 50 },
      'hotmail.com': { maxConcurrent: 5, minIntervalMs: 50 },
      'default': { maxConcurrent: 4, minIntervalMs: 50 }
    };
  }

  getLimit(domain) {
    return this.limits[domain] || this.limits['default'];
  }

  canSend(domain) {
    const limit = this.getLimit(domain);
    const active = this.activePerDomain.get(domain) || 0;
    if (active >= limit.maxConcurrent) {
      return false;
    }

    const lastSent = this.lastSentPerDomain.get(domain) || 0;
    const elapsed = Date.now() - lastSent;
    if (elapsed < limit.minIntervalMs) {
      return false;
    }

    return true;
  }

  acquire(domain) {
    const current = this.activePerDomain.get(domain) || 0;
    this.activePerDomain.set(domain, current + 1);
    this.lastSentPerDomain.set(domain, Date.now());
  }

  release(domain) {
    const current = this.activePerDomain.get(domain) || 1;
    this.activePerDomain.set(domain, Math.max(0, current - 1));
  }

  getActiveCount(domain) {
    return this.activePerDomain.get(domain) || 0;
  }
}

module.exports = new DomainRateLimiter();
