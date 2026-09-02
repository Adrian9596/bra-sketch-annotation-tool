#!/usr/bin/env node
// Render private TD-review PNGs for Oracle Semantic ROI fixtures. The photos
// and outputs live under demo/, which the public mirror and Git exclude.

import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateSemanticRois } from './photo-stitch-roi-schema.mjs';
import { getFreePort } from './static-server.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(appDir, 'scripts/groundtruth/photo-stitch');
const photoDir = path.join(appDir, 'demo/photos for seam detection');
const outputDir = path.join(appDir, 'demo/photo-stitch-roi-review');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const COLORS = Object.freeze({
  shoulder_strap: '#e63946',
  neckline: '#ff8c00',
  armhole: '#ffd60a',
  cup_edge: '#2dc653',
  cup_seam: '#00b4d8',
  underbust_band: '#4361ee',
  side_seam: '#8338ec',
  center_front: '#ff4dbe',
});

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function centroid(points) {
  return points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
}

function buildSvg(fixture, photoMime, photoBase64) {
  const width = fixture.width;
  const height = fixture.height;
  const fontSize = Math.max(10, Math.round(Math.min(width, height) * 0.018));
  const strokeWidth = Math.max(2, Math.round(Math.min(width, height) * 0.004));
  const roiMarkup = fixture.semanticRois.map(roi => {
    if (roi.availability !== 'available') return '';
    const points = roi.polygon.map(point => `${(point.x * width).toFixed(2)},${(point.y * height).toFixed(2)}`).join(' ');
    const center = centroid(roi.polygon);
    const cx = center.x / roi.polygon.length * width;
    const cy = center.y / roi.polygon.length * height;
    const color = COLORS[roi.zone];
    const dash = roi.side === 'right' ? ` stroke-dasharray="${strokeWidth * 3} ${strokeWidth * 2}"` : '';
    const label = `${roi.zone} / ${roi.side}`;
    return `<polygon points="${points}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="${strokeWidth}"${dash}/>`
      + `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" stroke="#111827" stroke-width="${Math.max(2, strokeWidth * 0.65)}" paint-order="stroke">${escapeXml(label)}</text>`;
  }).join('\n');
  const status = fixture.semanticRois.every(roi => roi.source === 'td_confirmed')
    ? 'TD CONFIRMED' : 'DRAFT — TD REVIEW REQUIRED';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <image href="data:${photoMime};base64,${photoBase64}" width="${width}" height="${height}" preserveAspectRatio="none"/>
  ${roiMarkup}
  <rect x="0" y="0" width="${width}" height="${Math.max(30, fontSize * 2)}" fill="#111827" fill-opacity="0.84"/>
  <text x="${width / 2}" y="${Math.max(21, fontSize * 1.35)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(fixture.image)} · ${escapeXml(status)}</text>
</svg>`;
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(tmpdir(), 'us109-roi-overlay-'));
  const port = await getFreePort();
  const profilePath = path.join(tempDir, 'chrome-profile');
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profilePath}`, '--window-size=800,800', 'about:blank',
  ]);
  try {
    await waitForCdp(port);
    const session = await openCdpSession(port);
    const names = (await readdir(corpusDir)).filter(name => name.endsWith('.json')).sort();
    for (const name of names) {
      const fixture = JSON.parse(await readFile(path.join(corpusDir, name), 'utf8'));
      validateSemanticRois(fixture.semanticRois, name);
      const photoPath = path.join(photoDir, fixture.image);
      const photoBytes = await readFile(photoPath);
      const mime = fixture.image.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const svg = buildSvg(fixture, mime, photoBytes.toString('base64'));
      const svgPath = path.join(tempDir, `${fixture.image}.roi.svg`);
      const pngPath = path.join(outputDir, `${fixture.image}.semantic-roi.png`);
      await writeFile(svgPath, svg);
      await session.cdp('Emulation.setDeviceMetricsOverride', {
        width: fixture.width, height: fixture.height, deviceScaleFactor: 1, mobile: false,
      });
      await session.cdp('Page.navigate', { url: pathToFileURL(svgPath).href });
      await session.waitFor(`document.readyState === 'complete'`, 5000);
      const shot = await session.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await writeFile(pngPath, Buffer.from(shot.data, 'base64'));
      console.log(`WROTE ${path.relative(appDir, pngPath)} (${fixture.width}x${fixture.height})`);
    }
    session.close();
  } finally {
    if (browser.exitCode == null) {
      browser.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        browser.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function openCdpSession(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('no Chrome page target available');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, message => message.error
      ? reject(new Error(message.error.message))
      : resolve(message.result));
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Chrome evaluation failed');
    return result.result.value;
  };
  return {
    cdp,
    close: () => ws.close(),
    waitFor: async (expression, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { if (await evaluate(expression)) return; } catch { /* retry while navigating */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Chrome timeout: ${expression}`);
    },
  };
}

async function waitForCdp(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fetchJson(`http://127.0.0.1:${port}/json/version`); return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
  return response.json();
}

main().catch(error => {
  console.error(`FAIL  photo-stitch-roi-overlay\n${error.stack || error}`);
  process.exitCode = 1;
});
