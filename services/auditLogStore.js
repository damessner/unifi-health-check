const fs = require('fs');
const path = require('path');

class AuditLogStore {
  constructor() {
    this.filePath = path.join(__dirname, '..', 'data', 'audit.json');
    this.writeQueue = Promise.resolve();
  }

  async ensureFile() {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.promises.access(this.filePath, fs.constants.F_OK);
    } catch (_) {
      await fs.promises.writeFile(this.filePath, '[]\n', 'utf8');
    }
  }

  async readAll() {
    await this.ensureFile();
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn(`[Audit Log] Failed to read ${this.filePath}: ${err.message}`);
      return [];
    }
  }

  async append(entry) {
    this.writeQueue = this.writeQueue.then(async () => {
      const items = await this.readAll();
      items.unshift(entry);
      await fs.promises.writeFile(this.filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
    });

    return this.writeQueue;
  }
}

module.exports = new AuditLogStore();
