const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('../config');

class HistoryStore {
  constructor() {
    this.db = null;
    this.enabled = false;
  }

  async init() {
    if (this.db) {
      return true;
    }

    const dbPath = config.server.historyDbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(db);
      });
    });

    await this.run(`
      CREATE TABLE IF NOT EXISTS history_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        total_all_clients INTEGER NOT NULL,
        total_apple_clients INTEGER NOT NULL,
        avg_util_24 INTEGER NOT NULL,
        avg_util_5 INTEGER NOT NULL,
        total_download_mbps INTEGER NOT NULL,
        total_upload_mbps INTEGER NOT NULL,
        critical_count INTEGER NOT NULL,
        warning_count INTEGER NOT NULL,
        congested_radios_count INTEGER NOT NULL
      )
    `);

    await this.run(`
      CREATE INDEX IF NOT EXISTS idx_history_snapshots_timestamp
      ON history_snapshots (timestamp DESC)
    `);

    this.enabled = true;
    return true;
  }

  run(sql, params = []) {
    if (!this.db) {
      return Promise.reject(new Error('HistoryStore database is not initialized'));
    }

    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this);
      });
    });
  }

  get(sql, params = []) {
    if (!this.db) {
      return Promise.reject(new Error('HistoryStore database is not initialized'));
    }

    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row);
      });
    });
  }

  all(sql, params = []) {
    if (!this.db) {
      return Promise.reject(new Error('HistoryStore database is not initialized'));
    }

    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows);
      });
    });
  }

  mapRow(row) {
    return {
      timestamp: row.timestamp,
      totalAllClients: row.total_all_clients,
      totalAppleClients: row.total_apple_clients,
      avgUtil24: row.avg_util_24,
      avgUtil5: row.avg_util_5,
      totalDownloadMbps: row.total_download_mbps,
      totalUploadMbps: row.total_upload_mbps,
      criticalCount: row.critical_count,
      warningCount: row.warning_count,
      congestedRadiosCount: row.congested_radios_count
    };
  }

  async appendSnapshot(snapshot) {
    if (!this.enabled) {
      return;
    }

    await this.run(
      `INSERT INTO history_snapshots (
        timestamp,
        total_all_clients,
        total_apple_clients,
        avg_util_24,
        avg_util_5,
        total_download_mbps,
        total_upload_mbps,
        critical_count,
        warning_count,
        congested_radios_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.timestamp,
        snapshot.totalAllClients,
        snapshot.totalAppleClients,
        snapshot.avgUtil24,
        snapshot.avgUtil5,
        snapshot.totalDownloadMbps,
        snapshot.totalUploadMbps,
        snapshot.criticalCount,
        snapshot.warningCount,
        snapshot.congestedRadiosCount
      ]
    );

    await this.prune();
  }

  async prune() {
    if (!this.enabled) {
      return;
    }

    await this.run(
      `DELETE FROM history_snapshots
       WHERE id NOT IN (
         SELECT id
         FROM history_snapshots
         ORDER BY timestamp DESC
         LIMIT ?
       )`,
      [config.server.historyRetentionSamples]
    );
  }

  async getSnapshots(limit = config.server.historyApiLimit) {
    if (!this.enabled) {
      return { samples: [], count: 0 };
    }

    const safeLimit = Math.max(1, Math.min(limit, config.server.historyRetentionSamples));
    const rows = await this.all(
      `SELECT
        timestamp,
        total_all_clients,
        total_apple_clients,
        avg_util_24,
        avg_util_5,
        total_download_mbps,
        total_upload_mbps,
        critical_count,
        warning_count,
        congested_radios_count
       FROM history_snapshots
       ORDER BY timestamp DESC
       LIMIT ?`,
      [safeLimit]
    );
    const countRow = await this.get('SELECT COUNT(*) AS total FROM history_snapshots');

    return {
      samples: rows.reverse().map((row) => this.mapRow(row)),
      count: countRow?.total || 0
    };
  }
}

module.exports = new HistoryStore();
