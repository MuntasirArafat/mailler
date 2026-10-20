const fs = require('fs');
const path = require('path');

class SuppressionManager {
  static getConfigFile() {
    const configDir = path.join(__dirname, '..', 'config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    return path.join(configDir, 'suppression.json');
  }

  static loadList() {
    const file = this.getConfigFile();
    if (!fs.existsSync(file)) return {};
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  static saveList(list) {
    const file = this.getConfigFile();
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  }

  static isSuppressed(email) {
    if (!email) return false;
    const cleanEmail = email.toLowerCase().trim();
    const list = this.loadList();
    return !!list[cleanEmail];
  }

  static add(email, reason = 'manual', details = null) {
    const cleanEmail = email.toLowerCase().trim();
    const list = this.loadList();
    const item = { email: cleanEmail, reason, details, created_at: Date.now() };
    list[cleanEmail] = item;
    this.saveList(list);
    return { email: cleanEmail, reason, status: 'suppressed' };
  }

  static remove(email) {
    const cleanEmail = email.toLowerCase().trim();
    const list = this.loadList();
    if (list[cleanEmail]) {
      delete list[cleanEmail];
      this.saveList(list);
      return true;
    }
    return false;
  }

  static list({ limit = 50, offset = 0, reason = null } = {}) {
    const list = this.loadList();
    let items = Object.values(list);
    if (reason) {
      items = items.filter(i => i.reason === reason);
    }
    items.sort((a, b) => b.created_at - a.created_at);
    return items.slice(offset, offset + limit);
  }

  static count() {
    const list = this.loadList();
    return Object.keys(list).length;
  }
}

module.exports = SuppressionManager;
