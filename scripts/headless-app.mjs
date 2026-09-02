// Shared headless-Chrome harness for the browser-driven suites: static
// server + Chrome + one CDP session, with a single `close()` that tears the
// three down in reverse order. Every browser suite used to carry its own copy
// of openCdpSession/waitForCdp/fetchJson and the launch sequence; the Auto
// Seam suites (auto-seam-technical-flat-check, photo-stitch-technical-flat-
// pilot, photo-stitch-browser, photo-stitch-roi-pilot, auto-seam-probe) read
// it from here. Other suites can adopt it one at a time.
//
//   const app = await launchHeadlessApp({ appDir, query: 'my-suite' });
//   try { const result = await analyzeSeamFixture(app.session, { relativePath: 'demo/…' }); }
//   finally { await app.close(); }

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getFreePort, startStaticServer } from './static-server.mjs';

export const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

export async function waitForCdp(port) {
  for (let index = 0; index < 100; index += 1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch { /* retry */ }
    await sleep(80);
  }
  throw new Error('CDP did not start');
}

// Opens a CDP session on the first page target. Returns
//   cdp(method, params)      raw protocol call
//   eval(expression)         Runtime.evaluate with awaitPromise, returnByValue
//   waitFor(expression, ms)  poll eval() until truthy
//   close()
export async function openCdpSession(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('no Chrome page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  await cdp('Runtime.enable');
  const evalJs = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (await evalJs(expression)) return; } catch { /* not ready yet */ }
      await sleep(80);
    }
    throw new Error(`timeout: ${expression}`);
  };
  let closed = false;
  return { cdp, eval: evalJs, waitFor, close: () => { if (!closed) { closed = true; ws.close(); } } };
}

// Serve `appDir`, launch headless Chrome on index.html?<query>=<now>, wait for
// `readyExpression`, and return { session, baseUrl, port, close }.
export async function launchHeadlessApp({
  appDir,
  query = 'headless',
  windowSize = '1200,900',
  profilePrefix = 'headless-app-',
  readyExpression = 'window.__braAutoModeDebug',
  readyTimeout = 8000,
} = {}) {
  if (!appDir) throw new Error('launchHeadlessApp needs appDir');
  const cleanup = [];
  const close = async () => {
    for (const task of cleanup.reverse()) { try { await task(); } catch { /* best effort */ } }
    cleanup.length = 0;
  };
  try {
    const started = await startStaticServer(appDir);
    cleanup.push(() => new Promise(resolve => started.server.close(resolve)));
    const port = await getFreePort();
    const profileDir = await mkdtemp(path.join(tmpdir(), profilePrefix));
    cleanup.push(() => rm(profileDir, { recursive: true, force: true }).catch(() => {}));
    const browser = spawn(chromePath, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, `--window-size=${windowSize}`,
      `${started.baseUrl}/index.html?${query}=${Date.now()}`,
    ]);
    cleanup.push(() => new Promise(resolve => { browser.once('exit', resolve); browser.kill('SIGTERM'); }));
    await waitForCdp(port);
    const session = await openCdpSession(port);
    cleanup.push(() => session.close());
    await session.waitFor(readyExpression, readyTimeout);
    return { session, baseUrl: started.baseUrl, port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function screenshotTo(session, filePath) {
  const screenshot = await session.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(filePath, Buffer.from(screenshot.data, 'base64'));
}

export function mimeForFixture(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.svg') return 'image/svg+xml';
  return 'image/png';
}

export async function readFixtureDataUrl(filePath) {
  const bytes = await readFile(filePath);
  return `data:${mimeForFixture(filePath)};base64,${bytes.toString('base64')}`;
}

// Put one image on the board and run Auto Seam analysis on it. Either
// `dataUrl` (sent inline) or `relativePath` (fetched by the page from the
// static server, e.g. 'demo/photos for seam detection/7.png'). With
// `resetBoard` the page first loads a blank project so fixtures can be run in
// sequence on one page; the single-fixture check keeps the fresh page as is.
export async function analyzeSeamFixture(session, { dataUrl, relativePath, resetBoard = true }) {
  if (!dataUrl && !relativePath) throw new Error('analyzeSeamFixture needs dataUrl or relativePath');
  return session.eval(`(async () => {
    const d = window.__braAutoModeDebug;
    ${resetBoard ? 'const blank = d.exportProject(); blank.state.annotations = []; blank.state.images = []; blank.state.idCounter = 1; blank.state.nextSequence = 1; await d.loadProject(blank);' : ''}
    ${dataUrl
      ? `const dataURL = ${JSON.stringify(dataUrl)};`
      : `const response = await fetch(${JSON.stringify(relativePath)}); const blob = await response.blob();
    const dataURL = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });`}
    await d.addBoardImages([dataURL]);
    const image = d.getImages()[0];
    return d.autoSeam.analyzeImage(image.id);
  })()`);
}
