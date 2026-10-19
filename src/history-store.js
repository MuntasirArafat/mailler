const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '..', 'config', 'delivery-history.json');
    this.history = [];
    this.maxItems = 100;
    this.init();
  }

  init() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this.history = JSON.parse(raw);
      }
    } catch (e) {
      this.history = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.history.slice(0, this.maxItems), null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save history:', e.message);
    }
  }

  addRecord(record) {
    const item = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...record
    };
    this.history.unshift(item);
    if (this.history.length > this.maxItems) {
      this.history.pop();
    }
    this.save();
    return item;
  }

  getRecent(limit = 25) {
    return this.history.slice(0, limit);
  }

  getById(id) {
    return this.history.find(h => h.id === id) || null;
  }

  clear() {
    this.history = [];
    this.save();
  }
}

module.exports = new HistoryStore();
