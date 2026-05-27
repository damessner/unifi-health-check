'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'optimizer-runs');
const MAX_PROGRESS = 1000;
const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Persistent background job manager for optimizer runs.
 *
 * - Each run gets a unique job ID and runs asynchronously on the server.
 * - Progress events are stored for reconnection; SSE clients can subscribe
 *   to live updates or replay history after page refresh.
 * - Completed jobs have their result saved to disk (JSON + XLSX) with
 *   stable download URLs that survive server restarts.
 * - Old jobs are cleaned up after JOB_TTL_MS.
 */
class OptimizerManager {
  constructor() {
    this._jobs = new Map();

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    this._restoreJobs();
    setInterval(() => this._cleanup(), 3600000).unref();
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Create a new job in 'running' state. Returns the job record. */
  createJob(params) {
    const id = crypto.randomUUID();
    const job = {
      id,
      status: 'running',
      params: { ...params },
      createdAt: Date.now(),
      completedAt: null,
      progress: [],
      result: null,
      error: null,
      sseClients: new Set(),
      // Paths set after completion
      resultPath: null,
      xlsxPath: null,
    };
    this._jobs.set(id, job);
    this._saveMeta(job);
    return this._sanitize(job);
  }

  /** Return a sanitised copy (no sseClients, truncated progress). */
  getJob(id) {
    const j = this._jobs.get(id);
    return j ? this._sanitize(j) : null;
  }

  /** Check if any running/queued job has the given searchMode. */
  hasRunningJob(searchMode) {
    for (const j of this._jobs.values()) {
      if ((j.status === 'running' || j.status === 'queued') && j.params?.searchMode === searchMode) {
        return true;
      }
    }
    return false;
  }

  /** Cancel a running/queued job. */
  cancelJob(id) {
    const j = this._jobs.get(id);
    if (!j) return false;
    if (j.status !== 'running' && j.status !== 'queued') return false;
    j.status = 'cancelled';
    j.completedAt = Date.now();
    j.error = 'Cancelled by user';
    // Kill underlying child process if any
    if (j._childProcess && typeof j._childProcess.kill === 'function') {
      try { j._childProcess.kill('SIGTERM'); } catch (_) {}
    }
    this._saveMeta(j);
    this._broadcast(j, 'cancelled', { jobId: id, error: 'Cancelled by user' });
    this._closeClients(j);
    return true;
  }

  /** Return up to `limit` recent jobs. */
  listJobs(limit = 100) {
    return Array.from(this._jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(j => this._sanitize(j));
  }

  /** Store a progress event for later replay. */
  addProgress(id, event) {
    const j = this._jobs.get(id);
    if (!j) return;
    if (j.progress.length < MAX_PROGRESS) j.progress.push(event);
    this._broadcast(j, 'progress', event);
  }

  /** Mark completed, save result & XLSX paths. */
  completeJob(id, result, xlsxPath) {
    const j = this._jobs.get(id);
    if (!j) return;
    j.status = 'completed';
    j.completedAt = Date.now();
    j.result = result;
    j.resultPath = this._writeResultFile(id, result);
    j.xlsxPath = xlsxPath || null;
    this._saveMeta(j);
    this._broadcast(j, 'complete', { success: true, jobId: id, ...result });
    this._closeClients(j);
  }

  /** Mark failed. */
  failJob(id, error) {
    const j = this._jobs.get(id);
    if (!j) return;
    j.status = 'failed';
    j.error = String(error);
    this._saveMeta(j);
    this._broadcast(j, 'error', { error: String(error) });
    this._closeClients(j);
  }

  /**
   * Subscribe an SSE response to a job.
   * - Replays current status + all stored progress events.
   * - If terminal, sends complete/error and ends.
   * - Otherwise wires up for live forwarding.
   */
  subscribe(id, res) {
    const j = this._jobs.get(id);
    if (!j) {
      this._writeSse(res, 'error', { error: 'Job not found' });
      res.end();
      return null;
    }

    // Current status
    this._writeSse(res, 'status', this._sanitize(j));

    // Replay progress
    for (const ev of j.progress) {
      this._writeSse(res, 'progress', ev);
    }

    // Terminal states — send final event and close
    if (j.status === 'completed') {
      this._writeSse(res, 'complete', { success: true, jobId: id, ...j.result });
      res.end();
      return j;
    }
    if (j.status === 'failed') {
      this._writeSse(res, 'error', { error: j.error });
      res.end();
      return j;
    }

    // Running/queued — wire up live
    j.sseClients.add(res);
    res.on('close', () => { j.sseClients.delete(res); });
    return j;
  }

  /** Resolve the on-disk result path for a job, or null. */
  getResultPath(id) {
    const j = this._jobs.get(id);
    return j ? j.resultPath : null;
  }

  getXlsxPath(id) {
    const j = this._jobs.get(id);
    return j ? j.xlsxPath : null;
  }

  // ── Internal ─────────────────────────────────────────────────────

  _broadcast(job, event, data) {
    if (!job.sseClients.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of job.sseClients) {
      try { res.write(msg); } catch (_) { job.sseClients.delete(res); }
    }
  }

  _closeClients(job) {
    for (const res of job.sseClients) {
      try { res.end(); } catch (_) {}
    }
    job.sseClients.clear();
  }

  _writeSse(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Return a plain-object copy safe for JSON serialisation. */
  _sanitize(job) {
    return {
      id: job.id,
      status: job.status,
      params: job.params,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
      progressCount: job.progress.length,
      hasResult: !!job.result,
      resultPath: job.resultPath,
      xlsxPath: job.xlsxPath,
    };
  }

  // ── Disk persistence ─────────────────────────────────────────────

  _saveMeta(job) {
    try {
      const { sseClients, progress, result, ...safe } = job;
      const payload = {
        ...safe,
        progressCount: (progress || []).length,
        _hasResult: !!result,
      };
      fs.writeFileSync(
        path.join(DATA_DIR, `${job.id}.json`),
        JSON.stringify(payload, null, 2),
      );
    } catch (e) {
      console.error('[JobMgr] meta save error:', e.message);
    }
  }

  _writeResultFile(id, result) {
    const filePath = path.join(DATA_DIR, `${id}-result.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
      return filePath;
    } catch (e) {
      console.error('[JobMgr] result save error:', e.message);
      return null;
    }
  }

  _restoreJobs() {
    try {
      const files = fs.readdirSync(DATA_DIR).filter(
        f => f.endsWith('.json') && !f.includes('-result') && !f.startsWith('.'),
      );
      for (const file of files) {
        const filePath = path.join(DATA_DIR, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (!data.id || data.createdAt < Date.now() - JOB_TTL_MS) {
            fs.unlinkSync(filePath);
            continue;
          }
          // Reconstruct in-memory state
          const job = {
            id: data.id,
            status: data.status || 'unknown',
            params: data.params || {},
            createdAt: data.createdAt,
            completedAt: data.completedAt || null,
            progress: [],
            result: null,
            error: data.error || null,
            sseClients: new Set(),
            resultPath: data.resultPath || null,
            xlsxPath: data.xlsxPath || null,
          };
          // If status says completed but no result path, try to locate
          if (job.status === 'completed' && !job.resultPath) {
            const rp = path.join(DATA_DIR, `${job.id}-result.json`);
            if (fs.existsSync(rp)) job.resultPath = rp;
          }
          this._jobs.set(job.id, job);
        } catch (_) { /* skip corrupt files */ }
      }
    } catch (_) {}
  }

  _cleanup() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of this._jobs) {
      if (job.createdAt < cutoff) {
        this._jobs.delete(id);
        ['.json', '-result.json'].forEach(suffix => {
          try { fs.unlinkSync(path.join(DATA_DIR, id + suffix)); } catch (_) {}
        });
      }
    }
  }
}

// Singleton
module.exports = new OptimizerManager();
