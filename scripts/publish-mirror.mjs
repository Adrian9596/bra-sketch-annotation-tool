#!/usr/bin/env node
// Publish the app to the public mirror (US-133).
//
// The team's GitHub Pages site serves `main` of a SEPARATE public repo, the
// mirror. Until US-133 every publish was a hand-run copy out of the private
// repo, and on 2026-10-10 the mirror was found 11 days behind, with a finished
// sync staged in the clone but never committed. This script is that sync as
// one command, carrying the checks earlier landings had to learn one by one:
//
//   - The source is a private COMMIT (default: the private origin/main), never
//     the Drive working tree, which can hold other sessions' unfinished work.
//   - What ships is an ALLOW-LIST (PUBLISH_SCOPE). Brand sketches, ground
//     truth, the measurement library and internal docs never leave, and a
//     denylist (NEVER_PUBLISH) stops the run if one ever slips into scope.
//   - The sync happens in a TEMPORARY worktree of the mirror, so the clone is
//     never left half-staged, and the worktree is removed whatever happens.
//   - Before any commit exists: blob identity of every published file, the
//     denylist over the whole mirror tree, a leak scan of the added lines
//     (emails, home paths, keys), bundle freshness on the source commit, the
//     mirror's own demo-free suites, and smoke + golden on the exact source
//     commit when the private fixtures are on disk.
//   - Nothing leaves the machine without --push. After a push the script
//     waits for GitHub Pages and compares the live files byte for byte.
//
//   npm run publish-mirror                  dry run: sync + verify, then discard
//   npm run publish-mirror -- --push        ... then commit, push, check the live site
//   npm run publish-mirror-selftest         the same code against throwaway local repos
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_NAME = 'Auto-POMs';
const DEFAULT_MIRROR = process.env.PUBLISH_MIRROR_DIR || path.join(os.homedir(), 'bra-sketch-annotation-tool');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---------------------------------------------------------------------------
// What the mirror ships. Paths are relative to the repository root.
//   trees        mirrored exactly: a file deleted in the source commit is
//                deleted in the mirror.
//   scriptFiles  the top level of scripts/ (tools and suites), mirrored
//                exactly. Nothing below scripts/ except the trees above is
//                ever touched: scripts/golden/ and scripts/groundtruth/ are
//                private, scripts/bin/ is the clone's own local binary.
//   files        copied as-is. One missing from the source commit stops the
//                run instead of being deleted: the site cannot run without it.
//   renamed      source path -> mirror path. The mirror has its own README.
// Everything else in the mirror (.gitignore, .claude/, …) is the mirror's own
// and is never touched.
const PUBLISH_SCOPE = {
  trees: ['src', 'vendor', 'auto_mode_rules', 'scripts/lib', 'scripts/schema'],
  scriptFiles: /^scripts\/(?:[^/]+\.(?:mjs|json)|README\.md)$/,
  files: ['app.js', 'dxf-worker.js', 'index.html', 'package.json', 'package-lock.json'],
  renamed: { 'README.public.md': 'README.md' },
};

// Defence in depth. Whatever the scope says, none of these may exist anywhere
// in the published tree: brand artwork, ground truth, production data,
// internal docs, local state.
const NEVER_PUBLISH = [
  /^demo\//, /^docs\//, /^library\//, /^test\//, /^archive\//, /^pitch\//, /^measure-out\//,
  /^scripts\/(?:golden|groundtruth|bin)\//,
  /^(?:CLAUDE|AGENTS|ARCHITECTURE|POMS_CONTRACT|TESTING|PROJECT_CHARTER|PROJECT_STATUS)\.md$/,
  /^findings[^/]*\.md$/, /^README\.public\.md$/,
  /(?:^|\/)harness\.db/, /(?:^|\/)\.gitdir\//, /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/)\.DS_Store$/, /\.xlsx$/i, /(?:^|\/)Grading rules\.md$/,
];

// Scanned on every ADDED line of the published diff. The public repo is
// public: the Drive path alone carries the owner's email address. The
// patterns are written so that this file's own source never matches them
// (the [D] class, the split dashes): the script ships to the mirror too.
const LEAK_PATTERNS = [
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/ },
  { name: 'local home path', re: /\/Users\/[^/\s'"`]+\/|[A-Za-z]:\\Users\\|Google[D]rive-|\/My [D]rive\// },
  { name: 'private key', re: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/ },
  { name: 'access token', re: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/ },
  { name: 'credential assignment', re: /\b(?:api[_-]?key|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|passw(?:or)?d)\b\s*[:=]\s*['"][A-Za-z0-9_\-+/=.]{12,}['"]/i },
];
// `icon@2x.png` is a file name, not an email address.
const FILE_NAME_TLD = /\.(?:png|jpe?g|gif|svg|webp|ico|js|mjs|cjs|css|json|html?|txt|md|dxf)$/i;

// The mirror has no demo/, so only suites that pass there (or skip their
// fixture sections) run in it. All 25 were green in the mirror on 2026-10-10.
const MIRROR_SUITES = {
  full: [
    'check', 'group-deps-check', 'group-deps-selftest', 'boundary-characterization-check',
    'boundary-characterization-selftest', 'keyboard-shortcuts-check', 'board-shape-check',
    'autosave-check', 'mainpage-check', 'construction-check', 'bom-check', 'preview-check',
    'notes-check', 'library-manager-check', 'personal-library-check', 'shape-stamps-check',
    'line-presets-check', 'export-xlsx', 'export-hidden', 'pipeline-tests', 'junction-tests',
    'suggestions-tests', 'dxf-worker-check', 'dxf-measurement-check', 'dxf-import-check',
  ],
  quick: ['check', 'group-deps-check', 'keyboard-shortcuts-check'],
  none: [],
};
// Run on the extracted source commit with the private fixtures linked in, so
// they test the exact bytes being published.
const PRIVATE_SUITES = ['smoke', 'golden'];
const PRIVATE_FIXTURES = ['demo', 'scripts/golden'];

const SUITE_TIMEOUT_MS = 15 * 60 * 1000;
const LIVE_TIMEOUT_MS = 10 * 60 * 1000;

class PublishError extends Error {}

// ---------------------------------------------------------------------------
// Processes

// An exported GIT_DIR silently points `git -C other-repo` at the wrong repo
// (it happened on 2026-09-02), so every child process gets an env without it.
function cleanEnv() {
  // npm's update notifier would otherwise phone the registry on every suite.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', npm_config_update_notifier: 'false' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function run(cmd, args, { cwd, allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, env: cleanEnv(), encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error) {
    if (allowFail) return { status: -1, stdout: '', stderr: r.error.message };
    throw new PublishError(`${cmd} could not start: ${r.error.message}`);
  }
  if (r.status !== 0 && !allowFail) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-8).join('\n');
    throw new PublishError(`${cmd} ${args.join(' ')} exited ${r.status}${detail ? ':\n' + detail : ''}`);
  }
  return r;
}

// A repo handle is the argv prefix that points git at the repo.
const privateRepo = (gitDir, workTree) => ({ argv: ['--git-dir', gitDir, '--work-tree', workTree], workTree });
const dirRepo = dir => ({ argv: ['-C', dir], workTree: dir });
const git = (repo, args, opts) => run('git', [...repo.argv, ...args], opts).stdout.replace(/\n$/, '');
const gitStatus = (repo, args) => run('git', [...repo.argv, ...args], { allowFail: true }).status;
const short = sha => (sha || '').slice(0, 7);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let quiet = false;
function say(tag, message) {
  if (!quiet) console.log(`${tag.padEnd(5)} ${message}`);
}

// ---------------------------------------------------------------------------
// The publish set

function walkFiles(root, rel) {
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(root, relPath));
    else out.push(relPath);
  }
  return out;
}

const isOsNoise = p => /(?:^|\/)\.DS_Store$/.test(p);

function inScope(p) {
  return PUBLISH_SCOPE.trees.some(tree => p.startsWith(tree + '/'))
    || PUBLISH_SCOPE.scriptFiles.test(p)
    || PUBLISH_SCOPE.files.includes(p)
    || Object.values(PUBLISH_SCOPE.renamed).includes(p);
}

// [{ from, to }] for every file the mirror should hold, read from the
// extracted source commit.
function publishSet(sourceDir) {
  const set = [];
  for (const tree of PUBLISH_SCOPE.trees) {
    for (const f of walkFiles(sourceDir, tree)) if (!isOsNoise(f)) set.push({ from: f, to: f });
  }
  for (const f of walkFiles(sourceDir, 'scripts')) if (PUBLISH_SCOPE.scriptFiles.test(f)) set.push({ from: f, to: f });
  for (const f of PUBLISH_SCOPE.files) {
    if (!existsSync(path.join(sourceDir, f))) throw new PublishError(`the source commit has no ${f}; the site cannot run without it`);
    set.push({ from: f, to: f });
  }
  for (const [from, to] of Object.entries(PUBLISH_SCOPE.renamed)) {
    if (!existsSync(path.join(sourceDir, from))) throw new PublishError(`the source commit has no ${from} (it becomes the mirror's ${to})`);
    set.push({ from, to });
  }
  return set.sort((a, b) => a.to.localeCompare(b.to));
}

const isExecutable = mode => (mode & 0o111) !== 0;

// Make the worktree hold exactly the publish set inside the scope. Returns
// every path it wrote or deleted.
function syncInto(worktree, sourceDir, set, trackedInScope) {
  const wanted = new Set(set.map(entry => entry.to));
  const touched = [];
  for (const { from, to } of set) {
    const src = path.join(sourceDir, from);
    const srcStat = lstatSync(src);
    if (!srcStat.isFile()) throw new PublishError(`${from} is not a regular file in the source commit; the mirror only takes regular files`);
    const data = readFileSync(src);
    const dest = path.join(worktree, to);
    let same = false;
    if (existsSync(dest)) {
      const destStat = lstatSync(dest);
      same = destStat.isFile() && destStat.size === data.length && isExecutable(destStat.mode) === isExecutable(srcStat.mode)
        && readFileSync(dest).equals(data);
    }
    if (same) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    rmSync(dest, { force: true, recursive: true });
    writeFileSync(dest, data);
    chmodSync(dest, isExecutable(srcStat.mode) ? 0o755 : 0o644);
    touched.push(to);
  }
  for (const p of trackedInScope) {
    if (wanted.has(p)) continue;
    rmSync(path.join(worktree, p), { force: true });
    touched.push(p);
  }
  return touched;
}

function indexEntries(repo) {
  const entries = new Map();
  for (const record of git(repo, ['ls-files', '-s', '-z']).split('\0')) {
    if (!record) continue;
    const match = /^(\d+) ([0-9a-f]+) \d+\t([\s\S]*)$/.exec(record);
    if (match) entries.set(match[3], { mode: match[1], blob: match[2] });
  }
  return entries;
}

// Every published file in the index must be byte-identical to the source
// commit, with the same executable bit, and nothing else may sit in scope.
function verifyIdentity(worktreeRepo, sourceDir, set) {
  const index = indexEntries(worktreeRepo);
  const hashes = git(worktreeRepo, ['hash-object', '--stdin-paths'], {
    input: set.map(entry => path.join(sourceDir, entry.from)).join('\n') + '\n',
  }).split('\n');
  const problems = [];
  set.forEach((entry, i) => {
    const staged = index.get(entry.to);
    if (!staged) { problems.push(`${entry.to}: not in the mirror index (is it gitignored there?)`); return; }
    if (staged.blob !== hashes[i]) problems.push(`${entry.to}: content differs from ${entry.from}`);
    const wantMode = isExecutable(lstatSync(path.join(sourceDir, entry.from)).mode) ? '100755' : '100644';
    if (staged.mode !== wantMode) problems.push(`${entry.to}: mode ${staged.mode}, source is ${wantMode}`);
  });
  const wanted = new Set(set.map(entry => entry.to));
  for (const p of index.keys()) if (inScope(p) && !wanted.has(p)) problems.push(`${p}: in scope but not in the source commit`);
  if (problems.length) throw new PublishError(`identity check failed:\n  ${problems.slice(0, 20).join('\n  ')}`);
  return set.length;
}

function neverPublishHits(paths) {
  return paths.filter(p => NEVER_PUBLISH.some(re => re.test(p)));
}

function leakScan(worktreeRepo) {
  const diff = git(worktreeRepo, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-renames']);
  const hits = [];
  let file = null;
  let lineNo = 0;
  let added = 0;
  let afterMinusHeader = false;
  for (const line of diff.split('\n')) {
    // `+++ b/path` is a header only right after `--- a/path`; inside a hunk
    // an added line may itself begin with "++".
    if (afterMinusHeader && line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (?:b\/)?/, ''); afterMinusHeader = false; continue; }
    afterMinusHeader = line.startsWith('--- ');
    if (line.startsWith('@@')) { lineNo = Number((/\+(\d+)/.exec(line) || [])[1] || 0); continue; }
    if (!line.startsWith('+')) continue;
    added += 1;
    const text = line.slice(1);
    for (const { name, re } of LEAK_PATTERNS) {
      const match = re.exec(text);
      if (!match) continue;
      if (name === 'email address' && FILE_NAME_TLD.test(match[0])) continue;
      hits.push({ file, line: lineNo, name, text: match[0] });
    }
    lineNo += 1;
  }
  return { added, hits };
}

// ---------------------------------------------------------------------------
// Suites

function suiteSummary(log) {
  const lines = log.split('\n').map(l => l.trim()).filter(Boolean);
  const last = [...lines].reverse().find(l => /^(?:PASS|FAIL|SKIP)\b|: PASS|: FAIL|passed$|GOLDEN: PASS/.test(l)) || '';
  const count = /(\d+\/\d+) assertions ok/.exec(last) || /PASS \((\d+) checks\)/.exec(last);
  // A suite that only SKIPs (its fixtures are absent) exits 0 but proved
  // nothing; it is reported apart from the green ones, never as verification.
  const skipped = /^SKIP\b/.test(last) && !lines.some(l => /^PASS\b|: PASS|passed$|GOLDEN: PASS|check passed/.test(l));
  return { line: last, count: count ? count[1] : '', skipped };
}

const describeSuites = results => results.filter(r => !r.skipped).map(r => (r.count ? `${r.suite} ${r.count}` : r.suite)).join(', ');
const skippedSuites = results => results.filter(r => r.skipped).map(r => r.suite);

function runOneSuite(cwd, suite, logDir) {
  return new Promise(resolve => {
    const logPath = path.join(logDir, `${suite}.log`);
    const fd = openSync(logPath, 'w');
    const started = Date.now();
    const child = spawn(NPM, ['run', suite], { cwd, env: cleanEnv(), stdio: ['ignore', fd, fd], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, SUITE_TIMEOUT_MS);
    const finish = (code, error) => {
      clearTimeout(timer);
      closeSync(fd);
      const log = readFileSync(logPath, 'utf8');
      resolve({
        suite, code, timedOut, error, logPath, ms: Date.now() - started,
        // npm echoes "> <script>" before running it. Without that line nothing
        // ran, however clean the exit code looks.
        ran: log.includes(`> ${suite}`),
        ...suiteSummary(log),
      });
    };
    child.on('error', error => finish(-1, error.message));
    child.on('close', code => finish(code, null));
  });
}

async function runSuites(cwd, suites, logDir, parallel = 4) {
  mkdirSync(logDir, { recursive: true });
  const queue = [...suites];
  const results = [];
  const worker = async () => {
    while (queue.length) results.push(await runOneSuite(cwd, queue.shift(), logDir));
  };
  await Promise.all(Array.from({ length: Math.min(parallel, suites.length) }, worker));
  return results.sort((a, b) => suites.indexOf(a.suite) - suites.indexOf(b.suite));
}

function resolveSuites(spec, packageScripts) {
  const requested = MIRROR_SUITES[spec] || String(spec).split(',').map(s => s.trim()).filter(Boolean);
  const present = requested.filter(s => packageScripts[s]);
  const missing = requested.filter(s => !packageScripts[s]);
  return { requested, present, missing };
}

function assertSuitesGreen(results, label) {
  const bad = results.filter(r => r.code !== 0 || r.timedOut || !r.ran);
  if (!bad.length) return;
  const why = r => (r.timedOut ? 'timed out' : !r.ran ? 'never ran' : `exit ${r.code}`);
  throw new PublishError(`${label} failed: ${bad.map(r => `${r.suite} (${why(r)}, log: ${r.logPath})`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// History

// The last private commit this mirror was synced from: the `Synced-From:`
// trailer this script writes, or the "Synced from Auto-POMs a..b" line the
// hand-written syncs used.
function previousSync(mirrorRepo, baseRev, sourceRepo) {
  const out = git(mirrorRepo, ['log', '-n', '300', '--format=%H%x1f%B%x1e', baseRev]);
  for (const record of out.split('\x1e')) {
    const [sha, body = ''] = record.replace(/^\n/, '').split('\x1f');
    if (!sha) continue;
    const match = new RegExp(`^Synced-From: ${SOURCE_NAME}@([0-9a-f]{7,40})\\s*$`, 'm').exec(body)
      || new RegExp(`Synced from ${SOURCE_NAME}\\s+[0-9a-f]{7,40}\\.\\.([0-9a-f]{7,40})\\b`).exec(body);
    if (!match) continue;
    const resolved = run('git', [...sourceRepo.argv, 'rev-parse', '--verify', '--quiet', `${match[1]}^{commit}`], { allowFail: true });
    return { mirrorCommit: sha, ref: match[1], sha: resolved.status === 0 ? resolved.stdout.trim() : null };
  }
  return null;
}

function wrap(text, width = 76) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function commitMessage({ title, sourceSha, prev, commits, shortstat, suites, privateSuites, trailers }) {
  const range = prev && prev.sha ? `${short(prev.sha)}..${short(sourceSha)}` : short(sourceSha);
  const listed = commits.slice(-30).map(c => `- ${c.subject} (${c.sha})`);
  if (commits.length > 30) listed.unshift(`- … ${commits.length - 30} earlier commits`);
  const suiteText = (describeSuites(suites) || 'none run')
    + (skippedSuites(suites).length ? `. Skipped without fixtures, not counted: ${skippedSuites(suites).join(', ')}` : '');
  const parts = [
    title,
    '',
    `Synced from ${SOURCE_NAME} ${range}:`,
    '',
    ...listed,
    '',
    wrap(`${shortstat.trim()}.`),
    '',
    wrap(`Mirror verification (demo-free suites): ${suiteText}.`),
  ];
  if (privateSuites.length) parts.push('', wrap(`Same commit with the private fixtures: ${privateSuites.map(s => s.suite).join(', ')} green.`));
  parts.push('', `Synced-From: ${SOURCE_NAME}@${sourceSha}`, ...trailers);
  return parts.join('\n') + '\n';
}

function defaultTitle(commits, prev, sourceSha) {
  if (commits.length === 1) {
    const subject = commits[0].subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '');
    return subject.charAt(0).toUpperCase() + subject.slice(1);
  }
  const range = prev && prev.sha ? `${short(prev.sha)}..${short(sourceSha)}` : short(sourceSha);
  return `Sync from ${SOURCE_NAME} ${range} (${commits.length} commits)`;
}

// ---------------------------------------------------------------------------
// Live site

function parseGithubRemote(url) {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url || '');
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function fetchBytes(url) {
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function compareLive(site, dir, extraPaths) {
  const stamp = Date.now();
  const local = p => readFileSync(path.join(dir, p));
  const appUrl = (/src="(app\.js\?v=[^"]+)"/.exec(local('index.html').toString('utf8')) || [])[1] || `app.js?publish-check=${stamp}`;
  const workerUrl = (/(dxf-worker\.js\?v=[0-9a-f]+)/.exec(local('app.js').toString('utf8')) || [])[1] || `dxf-worker.js?publish-check=${stamp}`;
  const targets = [
    { path: 'index.html', url: `index.html?publish-check=${stamp}` },
    { path: 'app.js', url: appUrl },
    { path: 'dxf-worker.js', url: workerUrl },
    ...extraPaths.map(p => ({ path: p, url: `${encodeURI(p)}?publish-check=${stamp}` })),
  ];
  const results = [];
  for (const target of targets) {
    try {
      results.push({ path: target.path, same: (await fetchBytes(site + target.url)).equals(local(target.path)) });
    } catch (error) {
      results.push({ path: target.path, same: false, error: error.message });
    }
  }
  return results;
}

async function verifyLive({ mirrorRepo, worktreeDir, pushedSha, changes, siteUrl }) {
  const remote = parseGithubRemote(git(mirrorRepo, ['remote', 'get-url', 'origin']));
  const hasGh = remote && run('gh', ['--version'], { allowFail: true }).status === 0;
  let site = siteUrl;
  if (!site && hasGh) {
    const r = run('gh', ['api', `repos/${remote.owner}/${remote.repo}/pages`, '--jq', '.html_url'], { allowFail: true });
    if (r.status === 0) site = r.stdout.trim();
  }
  if (!site && remote) site = `https://${remote.owner.toLowerCase()}.github.io/${remote.repo}/`;
  if (!site) throw new PublishError('cannot work out the Pages URL; pass --site-url');
  if (!site.endsWith('/')) site += '/';
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  if (hasGh) {
    say('INFO', `waiting for the GitHub Pages build of ${short(pushedSha)}`);
    for (;;) {
      const r = run('gh', ['api', `repos/${remote.owner}/${remote.repo}/pages/builds/latest`, '--jq', '.status + " " + .commit'], { allowFail: true });
      const [state, commit] = (r.stdout || '').trim().split(' ');
      if (commit === pushedSha && state === 'built') break;
      if (commit === pushedSha && state === 'errored') throw new PublishError(`the GitHub Pages build of ${short(pushedSha)} errored`);
      if (Date.now() > deadline) throw new PublishError(`timed out waiting for the Pages build of ${short(pushedSha)}`);
      await sleep(15000);
    }
  }
  const vendorChanges = changes.filter(c => c.status !== 'D' && c.path.startsWith('vendor/')).map(c => c.path);
  for (;;) {
    const results = await compareLive(site, worktreeDir, vendorChanges);
    if (results.every(r => r.same)) return { site, results };
    if (Date.now() > deadline) {
      throw new PublishError(`the live site still differs after ${LIVE_TIMEOUT_MS / 60000} min: ${results.filter(r => !r.same).map(r => r.path + (r.error ? ` (${r.error})` : '')).join(', ')}`);
    }
    await sleep(15000);
  }
}

function fastForwardClone(mirrorRepo) {
  const branch = run('git', [...mirrorRepo.argv, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }).stdout.trim();
  if (branch !== 'main') return `left alone: the clone is on ${branch || 'a detached HEAD'}`;
  if (git(mirrorRepo, ['status', '--porcelain', '--untracked-files=no'])) return 'left alone: the clone has uncommitted changes to tracked files';
  git(mirrorRepo, ['merge', '--ff-only', '--quiet', 'origin/main']);
  return 'fast-forwarded to origin/main';
}

// ---------------------------------------------------------------------------
// The run

let activeCleanup = null;

async function publish(opts) {
  const o = {
    from: 'origin/main', mirrorBase: 'origin/main', suites: 'full', privateSuites: true,
    push: false, liveCheck: true, fetch: true, trailers: [], ...opts,
  };
  const source = privateRepo(o.privateGitDir, o.privateWorkTree);
  const mirror = dirRepo(o.mirrorDir);
  if (!existsSync(o.privateGitDir)) throw new PublishError(`no private git dir at ${o.privateGitDir}`);
  if (gitStatus(mirror, ['rev-parse', '--git-dir']) !== 0) throw new PublishError(`no git repo at ${o.mirrorDir}`);

  if (o.fetch) {
    git(source, ['fetch', '--quiet', 'origin']);
    git(mirror, ['fetch', '--quiet', 'origin']);
  }
  const sourceSha = git(source, ['rev-parse', '--verify', `${o.from}^{commit}`]);
  const baseSha = git(mirror, ['rev-parse', '--verify', `${o.mirrorBase}^{commit}`]);
  say('INFO', `source ${SOURCE_NAME} ${short(sourceSha)} (${o.from}) -> mirror base ${short(baseSha)} (${o.mirrorBase})`);

  if (!o.allowUnpushed && gitStatus(source, ['merge-base', '--is-ancestor', sourceSha, 'origin/main']) !== 0) {
    throw new PublishError(`${short(sourceSha)} is not on the private origin/main; push it there first (or pass --allow-unpushed)`);
  }
  const ahead = run('git', [...source.argv, 'rev-list', '--count', 'origin/main..HEAD'], { allowFail: true }).stdout.trim();
  if (ahead && ahead !== '0') say('WARN', `${ahead} private commit(s) on HEAD are not on origin/main and are not published`);
  const scopeSpecs = [...PUBLISH_SCOPE.trees, 'scripts', ...PUBLISH_SCOPE.files, ...Object.keys(PUBLISH_SCOPE.renamed)];
  const dirtyScope = run('git', [...source.argv, 'status', '--porcelain', '--', ...scopeSpecs], { allowFail: true }).stdout
    .split('\n').map(l => l.slice(3)).filter(p => p && (inScope(p) || PUBLISH_SCOPE.renamed[p]));
  if (dirtyScope.length) {
    say('WARN', `${dirtyScope.length} uncommitted change(s) in the private tree are NOT published (commit and push them first): ${dirtyScope.slice(0, 5).join(', ')}${dirtyScope.length > 5 ? ', …' : ''}`);
  }

  const prev = previousSync(mirror, baseSha, source);
  if (prev) {
    say('INFO', `last publish: ${SOURCE_NAME} ${prev.ref} (mirror ${short(prev.mirrorCommit)})`);
    if (!prev.sha) say('WARN', `${prev.ref} is not in the private repo; cannot tell whether this publish moves forward`);
    else if (!o.allowBackwards && gitStatus(source, ['merge-base', '--is-ancestor', prev.sha, sourceSha]) !== 0) {
      throw new PublishError(`${short(sourceSha)} does not contain ${short(prev.sha)}, which the mirror already publishes: this would go backwards (pass --allow-backwards if that is the point)`);
    }
  } else {
    say('WARN', 'no earlier sync found in the mirror history; the commit list starts at the source commit');
  }

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'publish-mirror-'));
  const sourceDir = path.join(tmpRoot, 'source');
  const worktreeDir = path.join(tmpRoot, 'mirror');
  let worktreeAdded = false;
  const cleanup = () => {
    if (worktreeAdded) run('git', [...mirror.argv, 'worktree', 'remove', '--force', worktreeDir], { allowFail: true });
    worktreeAdded = false;
    if (!o.keepTemp) rmSync(tmpRoot, { recursive: true, force: true });
  };
  activeCleanup = cleanup;
  try {
    // 1. The source commit, exactly as committed.
    mkdirSync(sourceDir);
    const tarPath = path.join(tmpRoot, 'source.tar');
    git(source, ['archive', '--format=tar', '-o', tarPath, sourceSha]);
    run('tar', ['-xf', tarPath, '-C', sourceDir]);
    rmSync(tarPath);
    if (!existsSync(path.join(sourceDir, 'scripts', 'build-app.mjs'))) throw new PublishError('the source commit has no scripts/build-app.mjs');
    const fresh = run(process.execPath, ['scripts/build-app.mjs', '--verify'], { cwd: sourceDir, allowFail: true });
    if (fresh.status !== 0) {
      throw new PublishError(`bundle freshness failed on ${short(sourceSha)}: app.js/dxf-worker.js do not match src/ in that commit. Rebuild, commit and push in the private repo first.\n${(fresh.stderr || fresh.stdout).trim().split('\n').slice(-4).join('\n')}`);
    }
    say('PASS', `bundle fresh     build-app --verify on ${short(sourceSha)}`);

    // 2. A throwaway worktree of the mirror at its base.
    run('git', [...mirror.argv, 'worktree', 'prune'], { allowFail: true });
    git(mirror, ['worktree', 'add', '--quiet', '--detach', worktreeDir, baseSha]);
    worktreeAdded = true;
    const wt = dirRepo(worktreeDir);

    // 3. Sync and stage.
    const set = publishSet(sourceDir);
    const trackedInScope = [...indexEntries(wt).keys()].filter(inScope);
    const touched = syncInto(worktreeDir, sourceDir, set, trackedInScope);
    if (touched.length) {
      const specFile = path.join(tmpRoot, 'pathspec');
      writeFileSync(specFile, touched.join('\0') + '\0');
      run('git', ['--literal-pathspecs', ...wt.argv, 'add', '-A', `--pathspec-from-file=${specFile}`, '--pathspec-file-nul']);
    }
    const changes = [];
    const nameStatus = git(wt, ['diff', '--cached', '--name-status', '--no-renames', '-z']).split('\0').filter(Boolean);
    for (let i = 0; i + 1 < nameStatus.length; i += 2) changes.push({ status: nameStatus[i], path: nameStatus[i + 1] });
    const tree = git(wt, ['write-tree']);
    if (!changes.length) {
      say('PASS', `nothing to publish: mirror ${short(baseSha)} already matches ${short(sourceSha)} (${set.length} files)`);
      return { nothingToPublish: true, sourceSha, baseSha, prev, tree, changes };
    }
    const count = s => changes.filter(c => c.status === s).length;
    say('INFO', `${changes.length} file(s): ${count('M')} modified, ${count('A')} added, ${count('D')} deleted`);
    for (const c of changes.slice(0, 40)) say('', `  ${c.status} ${c.path}`);
    if (changes.length > 40) say('', `  … ${changes.length - 40} more`);

    // 4. Verify before anything is committed.
    say('PASS', `identity         ${verifyIdentity(wt, sourceDir, set)} published files match ${short(sourceSha)} byte for byte`);
    const tracked = [...indexEntries(wt).keys()];
    const denied = neverPublishHits(tracked);
    if (denied.length) throw new PublishError(`never-publish paths in the mirror tree: ${denied.slice(0, 10).join(', ')}`);
    say('PASS', `never-publish    0 of ${tracked.length} tracked files`);
    const leaks = leakScan(wt);
    if (leaks.hits.length && !o.skipLeakScan) {
      const listed = leaks.hits.slice(0, 10).map(h => `${h.file}:${h.line} ${h.name}: ${h.text}`).join('\n  ');
      throw new PublishError(`leak scan: ${leaks.hits.length} hit(s) in added lines. The mirror is PUBLIC; remove them in the private repo, or review and pass --skip-leak-scan:\n  ${listed}`);
    }
    say(leaks.hits.length ? 'WARN' : 'PASS', `leak scan        ${leaks.hits.length} hit(s) in ${leaks.added} added lines${leaks.hits.length ? ' (skipped by --skip-leak-scan)' : ''}`);

    const packageScripts = JSON.parse(readFileSync(path.join(worktreeDir, 'package.json'), 'utf8')).scripts || {};
    const suites = resolveSuites(o.suites, packageScripts);
    if (suites.missing.length) say('WARN', `not in package.json, skipped: ${suites.missing.join(', ')}`);
    let suiteResults = [];
    if (suites.requested.length) {
      if (!suites.present.length) throw new PublishError(`no mirror suite ran: none of ${suites.requested.join(', ')} is in package.json`);
      say('INFO', `running ${suites.present.length} mirror suite(s) in the worktree`);
      suiteResults = await runSuites(worktreeDir, suites.present, path.join(tmpRoot, 'logs', 'mirror'));
      assertSuitesGreen(suiteResults, 'mirror suites');
      const greenCount = suiteResults.filter(r => !r.skipped).length;
      if (!greenCount) throw new PublishError('every mirror suite skipped (no fixtures?); nothing was verified');
      say('PASS', `mirror suites    ${greenCount} green: ${describeSuites(suiteResults)}`);
      if (skippedSuites(suiteResults).length) say('INFO', `skipped for lack of fixtures (not counted): ${skippedSuites(suiteResults).join(', ')}`);
    } else {
      say('WARN', 'mirror suites skipped (--suites none)');
    }

    let privateResults = [];
    const fixturesHere = PRIVATE_FIXTURES.every(f => existsSync(path.join(o.privateWorkTree, f)));
    if (o.privateSuites && fixturesHere) {
      for (const f of PRIVATE_FIXTURES) {
        const link = path.join(sourceDir, f);
        rmSync(link, { recursive: true, force: true });
        mkdirSync(path.dirname(link), { recursive: true });
        symlinkSync(path.join(o.privateWorkTree, f), link);
      }
      say('INFO', `running ${PRIVATE_SUITES.join(' + ')} on ${short(sourceSha)} with the private fixtures`);
      privateResults = await runSuites(sourceDir, PRIVATE_SUITES, path.join(tmpRoot, 'logs', 'private'), 2);
      assertSuitesGreen(privateResults, 'private-fixture suites');
      if (privateResults.some(r => r.skipped)) throw new PublishError(`private-fixture suites skipped with the fixtures linked in: ${skippedSuites(privateResults).join(', ')}`);
      say('PASS', `private suites   ${privateResults.map(r => r.suite).join(', ')} green on ${short(sourceSha)}`);
    } else if (o.privateSuites) {
      say('INFO', `private-fixture suites skipped: ${PRIVATE_FIXTURES.join(' / ')} not found under ${o.privateWorkTree}`);
    }

    if (!o.push) {
      say('INFO', `DRY RUN: nothing committed or pushed. Staged tree ${tree}. Re-run with --push to publish.`);
      return { nothingToPublish: false, sourceSha, baseSha, prev, tree, changes, suites: suiteResults, privateSuites: privateResults };
    }

    // 5. Commit, then push only if the mirror has not moved meanwhile.
    const commitRange = prev && prev.sha ? `${prev.sha}..${sourceSha}` : `${sourceSha}^!`;
    const commits = git(source, ['log', '--reverse', '--format=%h%x1f%s', commitRange]).split('\n').filter(Boolean)
      .map(line => { const [sha, subject] = line.split('\x1f'); return { sha, subject }; });
    const message = commitMessage({
      title: o.title || defaultTitle(commits, prev, sourceSha),
      sourceSha, prev, commits,
      shortstat: git(wt, ['diff', '--cached', '--shortstat']),
      suites: suiteResults, privateSuites: privateResults, trailers: o.trailers,
    });
    const messageFile = path.join(tmpRoot, 'commit-message.txt');
    writeFileSync(messageFile, message);
    git(wt, ['commit', '--quiet', '-F', messageFile]);
    const commitSha = git(wt, ['rev-parse', 'HEAD']);
    if (o._beforePush) await o._beforePush();
    if (o.fetch) git(mirror, ['fetch', '--quiet', 'origin']);
    const remoteNow = git(mirror, ['rev-parse', '--verify', 'origin/main^{commit}']);
    if (remoteNow !== baseSha) {
      throw new PublishError(`the mirror's origin/main moved to ${short(remoteNow)} during the run (base was ${short(baseSha)}); nothing was pushed. Run again.`);
    }
    git(wt, ['push', '--quiet', 'origin', `${commitSha}:refs/heads/main`]);
    say('PASS', `pushed           mirror main ${short(baseSha)}..${short(commitSha)}`);
    say('INFO', `clone ${o.mirrorDir}: ${fastForwardClone(mirror)}`);

    let live = null;
    if (o.liveCheck) {
      live = await verifyLive({ mirrorRepo: mirror, worktreeDir, pushedSha: commitSha, changes, siteUrl: o.siteUrl });
      say('PASS', `live site        ${live.results.map(r => r.path).join(', ')} identical at ${live.site}`);
    }
    return { nothingToPublish: false, sourceSha, baseSha, prev, tree, changes, pushedSha: commitSha, live, suites: suiteResults, privateSuites: privateResults };
  } finally {
    if (o.keepTemp) say('INFO', `kept ${tmpRoot}`);
    cleanup();
    activeCleanup = null;
  }
}

// ---------------------------------------------------------------------------
// Self-test: the same publish() against throwaway local repos. No network,
// no GitHub, and the real repos are never opened.

async function selftest() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'publish-mirror-selftest-'));
  const savedEnv = { ...process.env };
  // Fixture strings that must trip the leak scan are assembled at run time,
  // so this file's own source never does.
  const AT = '@';
  const SELFTEST_EMAIL = `selftest${AT}example.invalid`;
  // Isolate git from the user's global config (signing, hooks, identity).
  Object.assign(process.env, {
    HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_AUTHOR_NAME: 'selftest', GIT_AUTHOR_EMAIL: SELFTEST_EMAIL,
    GIT_COMMITTER_NAME: 'selftest', GIT_COMMITTER_EMAIL: SELFTEST_EMAIL,
  });
  writeFileSync(path.join(tmp, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
  quiet = true;
  let passed = 0;
  let failed = 0;
  const check = (ok, label) => {
    if (ok) passed += 1;
    else { failed += 1; console.log(`FAIL  ${label}`); }
  };
  const refused = async (fn, pattern, label) => {
    try {
      await fn();
      check(false, `${label}: expected a refusal`);
    } catch (error) {
      check(error instanceof PublishError && pattern.test(error.message), `${label}: refused for the wrong reason: ${error.message.split('\n')[0]}`);
    }
  };
  const sh = (cwd, args) => run('git', args, { cwd }).stdout.trim();
  const write = (dir, files) => {
    for (const [p, content] of Object.entries(files)) {
      const f = path.join(dir, p);
      if (content === null) { rmSync(f, { force: true }); continue; }
      mkdirSync(path.dirname(f), { recursive: true });
      if (typeof content === 'object') { writeFileSync(f, content.data); chmodSync(f, content.mode); } else writeFileSync(f, content);
    }
  };
  const commit = (dir, files, message) => {
    write(dir, files);
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', message]);
    return sh(dir, ['rev-parse', 'HEAD']);
  };

  try {
    const BUILD_OK = 'process.exit(0);\n';
    const BUILD_STALE = "console.error('app.js is stale'); process.exit(1);\n";
    const pkg = `${JSON.stringify({
      name: 'fixture', private: true,
      scripts: {
        'fake-pass': `node -e "console.log('PASS  fake-pass   1/1 assertions ok')"`,
        'fake-skip': `node -e "console.log('SKIP  fake-skip   fixtures absent')"`,
        'fake-fail': 'node -e "process.exit(3)"',
      },
    }, null, 2)}\n`;
    const SHARED = {
      'src/a.js': 'a1\n', 'src/old.js': 'old\n', 'scripts/x.mjs': 'x1\n', 'scripts/old.mjs': 'old\n',
      'scripts/lib/l.mjs': 'l1\n', 'scripts/build-app.mjs': BUILD_OK, 'app.js': 'app1\n',
      'dxf-worker.js': 'worker1\n', 'index.html': '<script src="app.js?v=aaa"></script>\n',
      'package.json': pkg, 'package-lock.json': '{}\n', 'vendor/v.js': 'v1\n', 'auto_mode_rules/r.json': '{}\n',
    };
    const PRIVATE_ONLY = {
      'README.md': 'private readme\n', 'README.public.md': 'public readme v1\n', 'CLAUDE.md': 'internal\n',
      'docs/plan.md': 'plan\n', 'demo/sketch.txt': 'brand art\n', 'scripts/groundtruth/gt.json': '{}\n',
      'scripts/golden/g.json': '{}\n', 'library/styles.json': '{}\n',
    };
    const MIRROR_ONLY = { '.gitignore': 'node_modules/\nscripts/bin/\n', '.claude/launch.json': '{}\n', 'README.md': 'public readme v1\n' };

    const privOrigin = path.join(tmp, 'private-origin.git');
    const privWork = path.join(tmp, 'private');
    sh(tmp, ['init', '-q', '--bare', privOrigin]);
    sh(tmp, ['init', '-q', privWork]);
    sh(privWork, ['remote', 'add', 'origin', privOrigin]);
    const P1 = commit(privWork, { ...SHARED, ...PRIVATE_ONLY }, 'feat: first private state');
    sh(privWork, ['push', '-q', 'origin', 'main']);

    const mirOrigin = path.join(tmp, 'mirror-origin.git');
    const seed = path.join(tmp, 'mirror-seed');
    sh(tmp, ['init', '-q', '--bare', mirOrigin]);
    sh(tmp, ['init', '-q', seed]);
    sh(seed, ['remote', 'add', 'origin', mirOrigin]);
    commit(seed, { ...SHARED, ...MIRROR_ONLY }, `Seed\n\nSynced-From: ${SOURCE_NAME}@${P1}`);
    sh(seed, ['push', '-q', 'origin', 'main']);
    const clone = path.join(tmp, 'mirror');
    sh(tmp, ['clone', '-q', mirOrigin, clone]);

    const P2 = commit(privWork, {
      'src/a.js': 'a2\n', 'src/new.js': 'new\n', 'src/old.js': null, 'scripts/new.mjs': 'n\n',
      'scripts/old.mjs': null, 'scripts/schema/s.sql': 'create table t(x);\n',
      'scripts/tool.mjs': { data: '#!/usr/bin/env node\n', mode: 0o755 },
      'README.public.md': 'public readme v2\n', 'README.md': 'private readme v2\n',
      'docs/more.md': 'more\n', 'scripts/groundtruth/gt2.json': '{}\n',
    }, 'fix(US-1): second private state');
    sh(privWork, ['push', '-q', 'origin', 'main']);

    const base = {
      privateGitDir: path.join(privWork, '.git'), privateWorkTree: privWork, mirrorDir: clone,
      suites: 'fake-pass', privateSuites: false, liveCheck: false,
    };
    const tipOf = () => sh(mirOrigin, ['rev-parse', 'main']);
    const show = p => run('git', ['-C', mirOrigin, 'show', `main:${p}`], { allowFail: true });
    const worktreeCount = () => sh(clone, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).length;

    // A. Dry run.
    const tip0 = tipOf();
    const dry = await publish({ ...base });
    const changed = Object.fromEntries(dry.changes.map(c => [c.path, c.status]));
    check(changed['src/a.js'] === 'M' && changed['src/new.js'] === 'A' && changed['src/old.js'] === 'D', 'dry run: src/ mirrored exactly (M/A/D)');
    check(changed['scripts/new.mjs'] === 'A' && changed['scripts/old.mjs'] === 'D' && changed['scripts/schema/s.sql'] === 'A', 'dry run: scripts/ top level and schema/ mirrored');
    check(changed['README.md'] === 'M', 'dry run: README.public.md becomes README.md');
    check(Object.keys(changed).every(p => inScope(p) && !neverPublishHits([p]).length), 'dry run: only in-scope paths change');
    check(tipOf() === tip0, 'dry run: nothing pushed');
    check(sh(clone, ['status', '--porcelain']) === '' && worktreeCount() === 1, 'dry run: clone untouched, temp worktree removed');

    // B. Push.
    const pushed = await publish({ ...base, push: true, suites: 'fake-pass,fake-skip', trailers: [`Co-Authored-By: Selftest <${SELFTEST_EMAIL}>`] });
    const tip1 = tipOf();
    check(pushed.pushedSha === tip1 && tip1 !== tip0, 'push: mirror main advanced to the new commit');
    check(show('src/a.js').stdout === 'a2\n' && show('src/new.js').status === 0 && show('src/old.js').status !== 0, 'push: the published tree matches the source commit');
    check(show('README.md').stdout === 'public readme v2\n', 'push: the mirror README comes from README.public.md');
    check(['CLAUDE.md', 'docs/plan.md', 'docs/more.md', 'demo/sketch.txt', 'scripts/groundtruth/gt.json', 'scripts/groundtruth/gt2.json', 'scripts/golden/g.json', 'library/styles.json', 'README.public.md']
      .every(p => show(p).status !== 0), 'push: private-only files never reach the mirror');
    check(show('.claude/launch.json').status === 0 && show('.gitignore').stdout === MIRROR_ONLY['.gitignore'], 'push: mirror-only files are kept');
    check(sh(mirOrigin, ['ls-tree', 'main', 'scripts/tool.mjs']).startsWith('100755'), 'push: executable bit preserved');
    const message = sh(mirOrigin, ['log', '-1', '--format=%B', 'main']);
    check(message.includes(`Synced-From: ${SOURCE_NAME}@${P2}`) && message.includes('second private state') && message.includes('Co-Authored-By: Selftest'),
      'push: the message names the source commit, its subject and the trailers');
    check(/fake-pass 1\/1/.test(message) && /not counted: fake-skip/.test(message.replace(/\s+/g, ' ')),
      'push: a suite that only skipped is listed apart, not as verification');
    check(sh(clone, ['rev-parse', 'HEAD']) === tip1 && worktreeCount() === 1, 'push: the clean clone fast-forwarded, worktree removed');

    // C. Idempotent.
    const again = await publish({ ...base, push: true });
    check(again.nothingToPublish === true && tipOf() === tip1, 'second run: nothing to publish, no commit');

    // D. Refusals; each must leave the mirror untouched.
    await refused(() => publish({ ...base, from: P1, push: true }), /backwards/, 'an older source commit');
    let tip = tipOf();
    const homePath = ['', 'Users', 'someone', 'Library', 'CloudStorage', 'Google' + 'Drive-x', 'My ' + 'Drive', 'app'].join('/');
    commit(privWork, { 'src/leak.js': `const p = '${homePath}';\n` }, 'chore: add a path');
    sh(privWork, ['push', '-q', 'origin', 'main']);
    await refused(() => publish({ ...base, push: true }), /leak scan/, 'a home path in an added line');
    commit(privWork, { 'src/leak.js': `const contact = '${['someone', 'example.com'].join(AT)}';\n` }, 'chore: add a contact');
    sh(privWork, ['push', '-q', 'origin', 'main']);
    await refused(() => publish({ ...base, push: true }), /email address/, 'an email address in an added line');
    commit(privWork, { 'src/leak.js': null, 'src/harness.db': 'x\n' }, 'chore: stray db');
    sh(privWork, ['push', '-q', 'origin', 'main']);
    await refused(() => publish({ ...base, push: true }), /never-publish/, 'a never-publish path inside the scope');
    commit(privWork, { 'src/harness.db': null, 'scripts/build-app.mjs': BUILD_STALE }, 'chore: stale bundle');
    sh(privWork, ['push', '-q', 'origin', 'main']);
    await refused(() => publish({ ...base, push: true }), /bundle freshness/, 'a stale bundle');
    commit(privWork, { 'scripts/build-app.mjs': BUILD_OK, 'src/b.js': 'b\n' }, 'feat: b');
    sh(privWork, ['push', '-q', 'origin', 'main']);
    await refused(() => publish({ ...base, push: true, suites: 'fake-fail' }), /mirror suites failed/, 'a failing mirror suite');
    await refused(() => publish({ ...base, push: true, suites: 'does-not-exist' }), /no mirror suite ran/, 'a suite list that runs nothing');
    await refused(() => publish({ ...base, push: true, suites: 'fake-skip' }), /every mirror suite skipped/, 'suites that all skip');
    commit(privWork, { 'src/c.js': 'c\n' }, 'feat: c');
    await refused(() => publish({ ...base, from: 'HEAD', push: true }), /not on the private origin\/main/, 'an unpushed source commit');
    sh(privWork, ['push', '-q', 'origin', 'main']);
    check(tipOf() === tip && worktreeCount() === 1, 'refusals: mirror main unchanged, no worktree left behind');

    // E. The mirror moves during the run: no push, the other commit survives.
    const other = path.join(tmp, 'mirror-other');
    sh(tmp, ['clone', '-q', mirOrigin, other]);
    await refused(() => publish({
      ...base, push: true,
      _beforePush: () => { commit(other, { 'notes.txt': 'manual edit\n' }, 'manual'); sh(other, ['push', '-q', 'origin', 'main']); },
    }), /moved/, 'the mirror moving during the run');
    check(sh(mirOrigin, ['log', '-1', '--format=%s', 'main']) === 'manual', 'race: the other push survives, ours was not forced');

    // F. A dirty clone is never touched, and the next publish lands on top.
    write(clone, { 'README.md': 'local edit\n' });
    const cloneHead = sh(clone, ['rev-parse', 'HEAD']);
    const ok = await publish({ ...base, push: true });
    tip = tipOf();
    check(ok.pushedSha === tip && show('notes.txt').status === 0 && show('src/c.js').stdout === 'c\n' && show('src/b.js').status === 0,
      'after the race: publish lands on top of the manual mirror commit');
    check(readFileSync(path.join(clone, 'README.md'), 'utf8') === 'local edit\n' && sh(clone, ['rev-parse', 'HEAD']) === cloneHead,
      'a dirty clone is left alone');
    check(show('src/harness.db').status !== 0 && show('src/leak.js').status !== 0, 'files removed upstream stay removed');

    // G. This script ships to the mirror too, so its own source must scan clean.
    const ownHits = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(line => LEAK_PATTERNS.some(({ name, re }) => {
      const match = re.exec(line);
      return match && !(name === 'email address' && FILE_NAME_TLD.test(match[0]));
    }));
    check(ownHits.length === 0, `this script's own source passes the leak scan (hits: ${ownHits.slice(0, 3).join(' | ')})`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  selftest crashed: ${error.stack || error.message}`);
  } finally {
    quiet = false;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${failed ? 'FAIL' : 'PASS'}  publish-mirror-selftest   ${passed}/${passed + failed} assertions ok`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// CLI

const HELP = `Usage: node scripts/publish-mirror.mjs [options]

Publishes a commit of the private repo to the public mirror (GitHub Pages).
Without --push it is a dry run: the sync is built and verified in a
temporary worktree of the mirror, then discarded.

  --push               commit, push to the mirror's main, then check the live site
  --from <rev>         private commit to publish (default: origin/main)
  --mirror <dir>       mirror clone (default: ~/bra-sketch-annotation-tool or $PUBLISH_MIRROR_DIR)
  --mirror-base <rev>  mirror commit to sync onto (default: origin/main)
  --suites <set>       full (default) | quick | none | comma-separated npm scripts
  --no-private-suites  skip smoke + golden on the source commit
  --no-live-check      do not wait for GitHub Pages after --push
  --site-url <url>     Pages URL for the live check (default: asked from gh)
  --title <text>       commit title (default: from the source commits)
  --trailer <text>     extra commit trailer; repeatable
  --allow-unpushed     publish a commit that is not on the private origin/main
  --allow-backwards    publish a commit older than the one the mirror holds
  --skip-leak-scan     publish despite leak-scan hits (review them first)
  --no-fetch           do not fetch either remote first
  --keep-temp          keep the temporary worktree and logs
  --selftest           run the self-test on throwaway local repos
`;

function parseArgs(argv) {
  const opts = { trailers: [] };
  const takes = { '--from': 'from', '--mirror': 'mirrorDir', '--mirror-base': 'mirrorBase', '--suites': 'suites', '--site-url': 'siteUrl', '--title': 'title' };
  const flags = {
    '--push': ['push', true], '--no-private-suites': ['privateSuites', false], '--no-live-check': ['liveCheck', false],
    '--allow-unpushed': ['allowUnpushed', true], '--allow-backwards': ['allowBackwards', true],
    '--skip-leak-scan': ['skipLeakScan', true], '--no-fetch': ['fetch', false], '--keep-temp': ['keepTemp', true],
    '--selftest': ['selftest', true], '--help': ['help', true], '-h': ['help', true],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (flags[arg]) { opts[flags[arg][0]] = flags[arg][1]; continue; }
    if (takes[arg] || arg === '--trailer') {
      const value = argv[i + 1];
      if (value == null || value.startsWith('--')) throw new PublishError(`${arg} needs a value`);
      i += 1;
      if (arg === '--trailer') opts.trailers.push(value); else opts[takes[arg]] = value;
      continue;
    }
    throw new PublishError(`unknown option ${arg} (see --help)`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL  ${error.message}`);
    return 2;
  }
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.selftest) return (await selftest()) ? 0 : 1;
  const onSignal = () => { if (activeCleanup) activeCleanup(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await publish({
      privateGitDir: path.join(appDir, '.gitdir'),
      privateWorkTree: appDir,
      mirrorDir: opts.mirrorDir || DEFAULT_MIRROR,
      ...Object.fromEntries(Object.entries(opts).filter(([key]) => key !== 'mirrorDir')),
    });
    return 0;
  } catch (error) {
    if (!(error instanceof PublishError)) throw error;
    console.error(`FAIL  ${error.message}`);
    return 1;
  }
}

process.exitCode = await main();
