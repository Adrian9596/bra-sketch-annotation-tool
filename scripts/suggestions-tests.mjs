#!/usr/bin/env node
// Verifies the Tier-0 library-value suggestion layer end to end:
//   A. auto_mode_rules/sizeL-suggestions.json has the expected shape (18 POMs;
//      1..14 carry a corpus median, 15-18 are "no data").
//   B. the committed JSON is up to date with the corpus generator — but only
//      when the sibling "Measurements 2" corpus is present (skips cleanly
//      otherwise, mirroring how accuracy-tests skips with no ground truth).
//   C. in headless Chrome, the panel pre-fills each POM's Size L / TOL from its
//      suggestion (muted + "library" badge), a POM with no data shows blank +
//      a "no data" badge, and a TD override wins and is reversible.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CORPUS_ROOT = path.resolve(appDir, '../Measurements 2');
const CORPUS_FILE = path.join(CORPUS_ROOT, 'library/_raw_intake/measurements_size_l.csv');

let failures = 0;
const cleanupTasks = [];

const REQUIRED_FIELDS = ['concept', 'median', 'min', 'max', 'tol', 'tolType', 'sketchReliable', 'n', 'confidence', 'source'];
const CONF_SET = new Set(['very_low', 'low', 'medium', 'high']);
// Mirror of formatSuggestion() in src/ui/spec-panel.js (inches, up to 3 dp).
const fmt = (inchValue) => (inchValue == null ? '' : String(Math.round(inchValue * 1000) / 1000));
// US-048: mirror the app's inch-mode fraction display (1/16 grid, else decimal)
// so the panel-input assertions expect what the TD now sees.
const fracFmt = (inchValue) => {
  const n = Number(inchValue);
  const scaled = n * 16;
  if (!Number.isFinite(n) || n < 0 || Math.abs(scaled - Math.round(scaled)) > 1e-6) return fmt(inchValue);
  const DEN = 16;
  const whole = Math.floor(n + 1e-9);
  const num = Math.round((n - whole) * DEN);
  if (num === 0) return String(whole);
  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; };
  const g = gcd(num, DEN);
  const frac = (num / g) + '/' + (DEN / g);
  return whole > 0 ? (whole + ' ' + frac) : frac;
};
const fracToNum = (raw) => {
  if (raw == null) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

async function main() {
  // ---- A. JSON shape ----
  const jsonPath = path.join(appDir, 'auto_mode_rules/sizeL-suggestions.json');
  check(existsSync(jsonPath), 'A: sizeL-suggestions.json exists');
  const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  check(!!data.poms && typeof data.poms === 'object', 'A: has poms map');
  check(data.unit === 'in', 'A: unit is inches');

  for (let id = 1; id <= 18; id += 1) {
    const p = data.poms[String(id)];
    check(!!p, `A: POM ${id} present`);
    if (!p) continue;
    for (const f of REQUIRED_FIELDS) {
      check(Object.prototype.hasOwnProperty.call(p, f), `A: POM ${id} has field ${f}`);
    }
    check(CONF_SET.has(p.confidence), `A: POM ${id} confidence valid (${p.confidence})`);
    if (id <= 14) {
      check(p.source === 'library' && p.n > 0 && p.median != null,
        `A: POM ${id} has corpus data (n=${p.n}, median=${p.median})`);
      check(p.median > 0 && p.median < 40, `A: POM ${id} median in a sane inch range (${p.median})`);
    } else {
      check(p.source === 'none' && p.n === 0 && p.median == null,
        `A: POM ${id} is "no data"`);
    }
  }

  // ---- B. generator determinism (only when the corpus is present) ----
  if (!existsSync(CORPUS_FILE)) {
    console.log('  SKIP B: corpus not found at "Measurements 2" — cannot verify regeneration.');
  } else {
    const res = spawnSync(process.execPath, [path.join(scriptDir, 'generate-sizeL-suggestions.mjs'), '--check'],
      { cwd: appDir, encoding: 'utf8' });
    check(res.status === 0,
      'B: committed JSON matches a fresh generation from the corpus',
      (res.stderr || res.stdout || '').trim());
  }

  // ---- C. panel behavior in headless Chrome ----
  await runBrowserChecks(data);

  if (failures > 0) {
    console.error(`FAIL  suggestions-tests: ${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('PASS  suggestions-tests');
  }
}

async function runBrowserChecks(data) {
  if (!existsSync(CHROME)) {
    console.log('  SKIP C: Chrome not found — set CHROME_PATH to run the panel checks.');
    return;
  }
  const started = await startStaticServer(appDir);
  cleanupTasks.push(() => new Promise((r) => started.server.close(r)));
  const cdpPort = await getFreePort();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'suggestions-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`,
    `${started.baseUrl}/index.html?smoke=${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise((r) => { chrome.once('exit', r); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);
  const session = await openCdpSession(cdpPort);
  await session.waitFor(`document.querySelectorAll('#specBody tr[data-pom-key]').length > 0`, 8000);

  const out = await session.eval(`(() => {
    const api = window.__braAutoModeDebug;
    if (!api || typeof api.getEffectivePomSpec !== 'function') return { ok: false };
    const rowVal = (k) => { const i = document.querySelector('tr[data-pom-key="'+k+'"] td.spec-td-size input'); return i ? i.value : null; };
    const hasBadge = (k, cls) => !!document.querySelector('tr[data-pom-key="'+k+'"] .spec-suggest-badge.'+cls);
    const spec5 = api.getEffectivePomSpec('5');
    const spec16 = api.getEffectivePomSpec('16');
    const over = api.setPomSpecOverride('5', 'sizeL', '9.9');
    const overVal = rowVal('5');
    const reset = api.setPomSpecOverride('5', 'sizeL', '');
    return {
      ok: true,
      spec5, spec16, over, reset,
      row5val: rowVal('5'), row16val: rowVal('16'), overVal,
      row5lib: hasBadge('5', 'library'), row16nodata: hasBadge('16', 'very_low'),
    };
  })()`);

  check(out && out.ok, 'C: debug hooks available');
  if (!out || !out.ok) { await session.close(); return; }

  const expect5 = fmt(data.poms['5'].median);
  const expectTol5 = fmt(fracToNum(data.poms['5'].tol));
  check(out.spec5.sizeL === expect5, `C: POM 5 pre-fills library median (${expect5})`, 'got: ' + out.spec5.sizeL);
  check(out.spec5.tol === expectTol5, `C: POM 5 pre-fills default TOL (${expectTol5})`, 'got: ' + out.spec5.tol);
  check(out.row5val === fracFmt(data.poms['5'].median), 'C: POM 5 Size L input shows the suggestion as a fraction', 'got: ' + out.row5val);
  check(out.row5lib, 'C: POM 5 shows a "library" badge');
  check(out.spec16.sizeL === '', 'C: POM 16 (no data) has an empty Size L', 'got: ' + out.spec16.sizeL);
  check(out.row16val === '', 'C: POM 16 Size L input is blank');
  check(out.row16nodata, 'C: POM 16 shows a "no data" badge');
  check(out.over.sizeL === '9.9' && out.overVal === '9.9', 'C: a TD override wins over the suggestion');
  check(out.reset.sizeL === expect5, 'C: clearing the override reverts to the suggestion', 'got: ' + out.reset.sizeL);

  await session.close();
}

function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures += 1; console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}

// ---- CDP plumbing (mirrors scripts/export-xlsx-tests.mjs) ----
async function openCdpSession(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const t = targets.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return connectToTarget(t.webSocketDebuggerUrl);
    } catch (_) {}
    await sleep(80);
  }
  throw new Error('no page target available on CDP port ' + port);
}
async function connectToTarget(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const cdp = (method, params) => new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, (m) => m.error ? reject(new Error(m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  const evalJs = async (expression) => {
    const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval failed');
    return res.result.value;
  };
  const waitFor = async (expression, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { if (await evalJs(expression)) return; } catch (_) {}
      await sleep(80);
    }
    throw new Error('waitFor timeout: ' + expression);
  };
  return { eval: evalJs, waitFor, close: () => ws.close() };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForCdp(port) {
  for (let i = 0; i < 80; i += 1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch (_) {}
    await sleep(80);
  }
  throw new Error('CDP did not come up');
}
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} ${res.status}`);
  return await res.json();
}

try {
  await main();
} catch (err) {
  if (process.exitCode == null) process.exitCode = 1;
  console.error('FAIL  suggestions-tests: ' + (err && err.message ? err.message : err));
} finally {
  for (const task of cleanupTasks.reverse()) {
    try { await task(); } catch (_) {}
  }
}
