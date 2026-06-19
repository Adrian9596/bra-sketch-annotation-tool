#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');

const jsFiles = [
  'auto_mode_rules.js',
  'opencv_free_api.js',
  'opencv_real_api.js',
  'potrace.js',
  'scripts/build-app.mjs',
  'scripts/auto-mode-smoke.mjs',
  'scripts/learning-tests.mjs',
  'scripts/meaning-tests.mjs',
  'scripts/serve.mjs',
  'scripts/static-server.mjs',
  'scripts/check.mjs',
];

const failures = [];

const build = spawnSync(process.execPath, ['scripts/build-app.mjs'], {
  cwd: appDir,
  encoding: 'utf8',
});
if (build.status !== 0) {
  failures.push(`Build failed:\n${build.stderr || build.stdout}`);
}

for (const file of jsFiles) {
  const absolute = path.join(appDir, file);
  if (!existsSync(absolute)) {
    failures.push(`Missing JS file: ${file}`);
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', absolute], {
    cwd: appDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures.push(`Syntax failed: ${file}\n${result.stderr || result.stdout}`);
  }
}

for (const file of [
  'src/state.js',
  'src/manual-tools.js',
  'src/auto-detection.js',
  'src/auto-drafts.js',
  'src/rendering.js',
]) {
  const absolute = path.join(appDir, file);
  if (!existsSync(absolute)) {
    failures.push(`Missing source part: ${file}`);
    continue;
  }
  try {
    // Parse the source part inside a function wrapper; source parts share
    // app-level scope after bundling, so they are not standalone modules.
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(absolute, 'utf8'));
  } catch (error) {
    failures.push(`Source part failed parse: ${file}\n${error && error.stack ? error.stack : error}`);
  }
}

const appCheck = spawnSync(process.execPath, ['--check', path.join(appDir, 'app.js')], {
  cwd: appDir,
  encoding: 'utf8',
});
if (appCheck.status !== 0) {
  failures.push(`Generated app.js syntax failed:\n${appCheck.stderr || appCheck.stdout}`);
}

const htmlPath = path.join(appDir, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const requiredScripts = [
  'opencv_free_api.js',
  'opencv_real_api.js',
  'potrace.js',
  'auto_mode_rules.js',
  'app.js',
];

for (const script of requiredScripts) {
  if (!html.includes(script)) failures.push(`index.html does not include ${script}`);
}

if (/<script>\s*\(\(\)\s*=>/.test(html)) {
  failures.push('index.html still contains the large inline app script.');
}

if (!/window\.BraMeasurementRules/.test(readFileSync(path.join(appDir, 'auto_mode_rules.js'), 'utf8'))) {
  failures.push('auto_mode_rules.js does not expose window.BraMeasurementRules.');
}

if (!/window\.__braAutoModeDebug/.test(readFileSync(path.join(appDir, 'app.js'), 'utf8'))) {
  failures.push('app.js does not expose window.__braAutoModeDebug for smoke tests.');
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log('check passed');
