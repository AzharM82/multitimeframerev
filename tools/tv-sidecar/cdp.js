'use strict';

/**
 * Minimal Chrome DevTools Protocol client for TradingView Desktop.
 *
 * Deliberately dependency-free: Node 22 ships a global WebSocket, so the
 * sidecar needs no npm install to run under Task Scheduler.
 *
 * Verified constraints on TradingView Desktop 3.3.0.7992 (Chrome/140):
 *   - PUT /json/new          -> 500
 *   - Target.createTarget    -> {"code":-32000,"message":"Not supported"}
 *   The app blocks tab creation, so the sidecar BINDS to an existing tab and
 *   must never assume it can make one.
 */

const http = require('http');
const os = require('os');
const { execFile, spawn } = require('child_process');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;

function getJSON(path, port = DEFAULT_PORT, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON from ${path}: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout on ${path}`)); });
    req.on('error', reject);
  });
}

async function isUp(port = DEFAULT_PORT) {
  try { await getJSON('/json/version', port, 1500); return true; } catch { return false; }
}

/**
 * Resolve the Store (AppX) install path. It is version-stamped
 * (TradingView.Desktop_3.3.0.7992_x64__n534cwy3pjxzj), so hardcoding it breaks
 * on the next auto-update - always resolve dynamically.
 */
function resolveExe() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-AppxPackage -Name TradingView.Desktop).InstallLocation'],
      { timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err);
        const dir = String(stdout).trim();
        if (!dir) return reject(new Error('TradingView.Desktop AppX package not found'));
        resolve(`${dir}\\TradingView.exe`);
      }
    );
  });
}

/** Is TradingView running at all (regardless of CDP)? */
function isProcessRunning() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        '@(Get-Process -Name TradingView -ErrorAction SilentlyContinue).Count'],
      { timeout: 15000 },
      (err, stdout) => resolve(!err && Number(String(stdout).trim()) > 0)
    );
  });
}

/** Close every TradingView process. Needed before relaunching with the flag. */
function killAll() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-Process -Name TradingView -ErrorAction SilentlyContinue | Stop-Process -Force'],
      { timeout: 30000 },
      (err) => (err ? reject(err) : setTimeout(resolve, 3000))
    );
  });
}

/**
 * Launch TradingView with CDP enabled. The flag only takes effect at launch -
 * an already-running instance started from the Start Menu can never be
 * attached to, so callers must treat "running but no CDP" as fatal rather
 * than silently launching a second instance.
 */
async function launch(port = DEFAULT_PORT) {
  const exe = await resolveExe();

  // MUST be detached with stdio ignored. Launching via execFile attaches
  // TradingView's stdout/stderr to this Node process; when the sidecar exits,
  // those pipes close and TradingView dies with
  //   "App has crashed due to unexpected error" / EPIPE: broken pipe, write
  // on its next console.debug. Observed for real - it killed a live session.
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    // Chromium writes debug.log into its working directory. Without this it
    // inherits the sidecar's cwd and litters the repo with crash-reporter noise.
    cwd: os.tmpdir()
  });
  child.unref();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isUp(port)) return true;
  }
  throw new Error('TradingView launched but CDP never came up within 90s');
}

/**
 * All TradingView chart page targets, in tab order.
 *
 * Generous timeout: during a cold start the CDP port answers /json/version
 * almost immediately while /json/list still blocks for many seconds, because
 * the app is busy restoring saved tabs.
 */
async function listChartTargets(port = DEFAULT_PORT, timeoutMs = 15000) {
  const targets = await getJSON('/json/list', port, timeoutMs);
  return targets.filter(
    (t) => t.type === 'page' && /tradingview\.com\/chart\//.test(t.url || '')
  );
}

function chartIdOf(target) {
  const m = /tradingview\.com\/chart\/([^/?#]+)/.exec(target.url || '');
  return m ? m[1] : null;
}

class Session {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('CDP websocket open timeout')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(to); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('CDP websocket error')); }, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); }
      });
      this.ws.send(payload);
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      const t = res.exceptionDetails.exception || {};
      throw new Error(`page exception: ${t.description || t.value || 'unknown'}`);
    }
    return res.result ? res.result.value : undefined;
  }

  close() { try { this.ws && this.ws.close(); } catch { /* already gone */ } }
}

module.exports = {
  DEFAULT_PORT, getJSON, isUp, launch, resolveExe,
  isProcessRunning, killAll,
  listChartTargets, chartIdOf, Session
};
