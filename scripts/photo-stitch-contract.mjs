// US-109: Photo Zigzag Detection — ground-truth schema validator.
//
// This is Section 1/2 of docs/stories/epics/E07-measurement-detection/
// US-109-photo-zigzag-detection/CLAUDE_IMPLEMENTATION_CHECKLIST.md: the
// versioned ground-truth schema plus a structural check that it can reject
// invalid data, not just accept the current drafts. The real-photo fixtures
// may contain Codex-seeded review geometry, but this script never promotes it
// to TD authority or invents an accuracy threshold: every file stays
// "draft_pending_td" (schema-checked, never gated) until a TD confirms it,
// exactly like the existing measurements/ and dxf-measurements/ corpora.
//
// Usage: node scripts/photo-stitch-contract.mjs
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const corpusDir = path.join(appDir, 'scripts/groundtruth/photo-stitch');
const photosDir = path.join(appDir, 'demo/photos for seam detection');

let checked = 0;
const fail = (msg) => { throw new Error(msg); };
const ok = (cond, msg) => { if (!cond) fail(msg); checked += 1; };

const VIEW_ROLES = new Set(['front_outer', 'front_inner', 'back', 'unknown']);
const AXIS_STATUSES = new Set(['trusted', 'untrusted', 'unavailable']);
const STITCH_TYPES = new Set(['zigzag', 'other_stitch', 'ambiguous']);
const VISIBILITIES = new Set(['clear', 'blurred', 'occluded', 'clipped', 'ambiguous']);
const SIDES = new Set(['left', 'right', 'center']);
const NEGATIVE_KINDS = new Set([
  'boundary', 'fold', 'embroidery', 'logo', 'decoration', 'hardware', 'closure', 'background',
]);
const SOURCES = new Set(['draft_pending_td', 'td_confirmed']);

// A finite [0,1] normalized point — the one property every geometry field
// in this schema shares, checked in exactly one place.
function isUnitPoint(p) {
  return !!p && Number.isFinite(p.x) && p.x >= 0 && p.x <= 1 && Number.isFinite(p.y) && p.y >= 0 && p.y <= 1;
}

function validatePolygon(polygon, label) {
  ok(Array.isArray(polygon) && polygon.length >= 3, label + ' polygon needs at least 3 points, got ' + JSON.stringify(polygon));
  polygon.forEach((p, i) => ok(isUnitPoint(p), label + ' polygon point ' + i + ' must be a finite [0,1] point, got ' + JSON.stringify(p)));
}

// Throws (via fail/ok) on the first violation, with a message naming the
// exact field — this is the whole point: a TD or a future implementer can
// point a broken file at this function and get back which field is wrong,
// not just "invalid".
function validateGroundTruth(gt, filename) {
  ok(gt.schemaVersion === 'photo-stitch-groundtruth/1', filename + ': unknown schemaVersion ' + JSON.stringify(gt.schemaVersion));
  ok(typeof gt.image === 'string' && gt.image.length > 0, filename + ': image must be a non-empty string');
  ok(SOURCES.has(gt.source), filename + ': source must be one of ' + [...SOURCES].join('|') + ', got ' + JSON.stringify(gt.source));
  ok(Number.isInteger(gt.width) && gt.width > 0, filename + ': width must be a positive integer, got ' + JSON.stringify(gt.width));
  ok(Number.isInteger(gt.height) && gt.height > 0, filename + ': height must be a positive integer, got ' + JSON.stringify(gt.height));
  ok(typeof gt.sourceSha256 === 'string' && /^[0-9a-f]{64}$/.test(gt.sourceSha256), filename + ': sourceSha256 must be a 64-char lowercase hex string');
  ok(typeof gt.corpusVersion === 'string' && gt.corpusVersion.length > 0, filename + ': corpusVersion must be a non-empty string');
  ok(gt.labeledAt === null || (typeof gt.labeledAt === 'string' && Number.isFinite(Date.parse(gt.labeledAt))),
    filename + ': labeledAt must be null or a parseable timestamp');
  ok(gt.labeledBy === null || (typeof gt.labeledBy === 'string' && gt.labeledBy.trim().length > 0),
    filename + ': labeledBy must be null or a non-empty string');

  ok(typeof gt.unjudgeable === 'boolean', filename + ': unjudgeable must be a boolean');
  if (gt.unjudgeable) {
    ok(typeof gt.unjudgeableReason === 'string' && gt.unjudgeableReason.trim().length > 0,
      filename + ': unjudgeable=true requires a non-empty unjudgeableReason');
  }

  ok(!!gt.view && typeof gt.view === 'object', filename + ': view must be an object');
  ok(gt.view.role === null || VIEW_ROLES.has(gt.view.role), filename + ': view.role must be null or one of ' + [...VIEW_ROLES].join('|'));
  ok(gt.view.roleTrusted === null || typeof gt.view.roleTrusted === 'boolean', filename + ': view.roleTrusted must be null or boolean');
  ok(!!gt.view.centerAxis && typeof gt.view.centerAxis === 'object', filename + ': view.centerAxis must be an object');
  ok(gt.view.centerAxis.status === null || AXIS_STATUSES.has(gt.view.centerAxis.status),
    filename + ': view.centerAxis.status must be null or one of ' + [...AXIS_STATUSES].join('|'));
  for (const key of ['xTop', 'xBottom']) {
    const v = gt.view.centerAxis[key];
    ok(v === null || (Number.isFinite(v) && v >= 0 && v <= 1), filename + ': view.centerAxis.' + key + ' must be null or a finite [0,1] value');
  }

  ok(!!gt.garment && Array.isArray(gt.garment.zones), filename + ': garment.zones must be an array');
  gt.garment.zones.forEach((z, i) => ok(typeof z === 'string' && z.length > 0, filename + ': garment.zones[' + i + '] must be a non-empty string'));

  ok(Array.isArray(gt.paths), filename + ': paths must be an array');
  const seenIds = new Set();
  gt.paths.forEach((p, i) => {
    const label = filename + ': paths[' + i + ']';
    ok(typeof p.id === 'string' && p.id.length > 0, label + '.id must be a non-empty string');
    ok(!seenIds.has(p.id), label + '.id duplicates an earlier path id ' + JSON.stringify(p.id));
    seenIds.add(p.id);
    ok(STITCH_TYPES.has(p.stitchType), label + '.stitchType must be one of ' + [...STITCH_TYPES].join('|') + ', got ' + JSON.stringify(p.stitchType));
    ok(p.technicalLabel === undefined || (typeof p.technicalLabel === 'string' && p.technicalLabel.trim().length > 0),
      label + '.technicalLabel must be absent or a non-empty string');
    ok(typeof p.zone === 'string' && p.zone.length > 0, label + '.zone must be a non-empty string');
    ok(p.side === null || SIDES.has(p.side), label + '.side must be null or one of ' + [...SIDES].join('|'));
    ok(p.symmetryPairId === null || (typeof p.symmetryPairId === 'string' && p.symmetryPairId.length > 0),
      label + '.symmetryPairId must be null or a non-empty string');
    ok(VISIBILITIES.has(p.visibility), label + '.visibility must be one of ' + [...VISIBILITIES].join('|') + ', got ' + JSON.stringify(p.visibility));
    ok(!!p.endpoints && isUnitPoint(p.endpoints.a), label + '.endpoints.a must be a finite [0,1] point');
    ok(!!p.endpoints && isUnitPoint(p.endpoints.b), label + '.endpoints.b must be a finite [0,1] point');
    ok(Array.isArray(p.referencePolyline) && p.referencePolyline.length >= 2,
      label + '.referencePolyline must have at least 2 points, got ' + JSON.stringify(p.referencePolyline));
    p.referencePolyline.forEach((pt, j) => ok(isUnitPoint(pt), label + '.referencePolyline[' + j + '] must be a finite [0,1] point'));
  });
  // A symmetryPairId must reference an id that actually exists in this same
  // file — a typo'd pair id would otherwise silently read as "no pair".
  gt.paths.forEach((p, i) => {
    if (p.symmetryPairId != null) {
      ok(seenIds.has(p.symmetryPairId), filename + ': paths[' + i + '].symmetryPairId ' + JSON.stringify(p.symmetryPairId) + ' does not match any path id in this file');
    }
  });

  ok(Array.isArray(gt.negativeRegions), filename + ': negativeRegions must be an array');
  gt.negativeRegions.forEach((r, i) => {
    const label = filename + ': negativeRegions[' + i + ']';
    ok(NEGATIVE_KINDS.has(r.kind), label + '.kind must be one of ' + [...NEGATIVE_KINDS].join('|') + ', got ' + JSON.stringify(r.kind));
    validatePolygon(r.polygon, label);
  });

  ok(Array.isArray(gt.ignoreRegions), filename + ': ignoreRegions must be an array');
  gt.ignoreRegions.forEach((r, i) => {
    const label = filename + ': ignoreRegions[' + i + ']';
    validatePolygon(r.polygon, label);
    ok(typeof r.reason === 'string' && r.reason.trim().length > 0, label + '.reason must be a non-empty string');
  });

  ok(typeof gt.notes === 'string', filename + ': notes must be a string (may be empty)');

  if (gt.source === 'td_confirmed') {
    ok(typeof gt.labeledAt === 'string' && Number.isFinite(Date.parse(gt.labeledAt)),
      filename + ': td_confirmed requires a parseable labeledAt timestamp');
    ok(typeof gt.labeledBy === 'string' && gt.labeledBy.trim().length > 0,
      filename + ': td_confirmed requires a non-empty labeledBy reviewer');
    ok(gt.unjudgeable || gt.paths.length > 0 || gt.negativeRegions.length > 0 || gt.ignoreRegions.length > 0,
      filename + ': td_confirmed requires reviewed paths/regions or unjudgeable=true');
  }
}

async function loadCorpus() {
  const names = (await readdir(corpusDir)).filter(f => f.endsWith('.json')).sort();
  const files = [];
  for (const name of names) {
    const gt = JSON.parse(await readFile(path.join(corpusDir, name), 'utf8'));
    files.push({ name, gt });
  }
  return files;
}

async function main() {
  const files = await loadCorpus();
  ok(files.length === 6, 'expected the 6 pilot fixtures (scripts/groundtruth/photo-stitch/), got ' + files.length);

  for (const { name, gt } of files) validateGroundTruth(gt, name);

  // Cross-check sourceSha256/width/height against the real photo bytes when
  // present (private repo only — the public mirror ships no demo/, and this
  // corpus's own photos are never synced there per README.md's exclusion
  // list, same as every other demo/-derived fixture in this repo).
  let photosPresent = true;
  try {
    await readdir(photosDir);
  } catch {
    photosPresent = false;
  }
  if (photosPresent) {
    for (const { name, gt } of files) {
      const bytes = await readFile(path.join(photosDir, gt.image));
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      ok(actualHash === gt.sourceSha256, name + ': sourceSha256 does not match the actual file bytes of ' + gt.image
        + ' (expected ' + actualHash + ') — corpus is stale or the photo changed');
    }
    console.log('  cross-checked sourceSha256 against demo/photos for seam detection/*');
  } else {
    console.log('  SKIP  demo/photos for seam detection/ not present (public mirror) — hash cross-check skipped');
  }

  const bySource = { draft_pending_td: 0, td_confirmed: 0 };
  let unjudgeable = 0, labelledPaths = 0;
  for (const { gt } of files) {
    bySource[gt.source] += 1;
    if (gt.unjudgeable) unjudgeable += 1;
    labelledPaths += gt.paths.length;
  }
  console.log('  corpus: ' + files.length + ' fixtures, '
    + bySource.td_confirmed + ' td_confirmed, ' + bySource.draft_pending_td + ' draft_pending_td, '
    + unjudgeable + ' unjudgeable, ' + labelledPaths + ' total labelled paths');
  if (bySource.td_confirmed === 0) {
    console.log('  NOTE: no TD-confirmed ground truth yet — accuracy proof (US-109 checklist step 1) cannot start until at least one fixture flips to td_confirmed with real paths.');
  }

  // ---- Positive control: prove a FULLY populated fixture is accepted ----
  // Keep one synthetic, clearly-not-real fixture that exercises every field
  // at least once: two symmetric paths, one of each negative-region kind, an
  // ignore region, and a populated view/garment block. It must validate cleanly.
  const fullyPopulated = {
    schemaVersion: 'photo-stitch-groundtruth/1',
    image: 'synthetic-positive-control.jpg',
    source: 'td_confirmed',
    labeledAt: '2026-08-31T00:00:00.000Z',
    labeledBy: 'positive-control-fixture',
    corpusVersion: 'us109-pilot-1',
    sourceSha256: '0'.repeat(64),
    width: 600, height: 800,
    unjudgeable: false, unjudgeableReason: null,
    view: { role: 'front_outer', roleTrusted: true, centerAxis: { status: 'trusted', xTop: 0.5, xBottom: 0.51 } },
    garment: { zones: ['underbust_band_left', 'underbust_band_right'] },
    paths: [
      { id: 'path-L', stitchType: 'zigzag', technicalLabel: 'zigzag', zone: 'underbust_band_left', side: 'left', symmetryPairId: 'path-R',
        visibility: 'clear', endpoints: { a: { x: 0.12, y: 0.81 }, b: { x: 0.34, y: 0.79 } },
        referencePolyline: [{ x: 0.12, y: 0.81 }, { x: 0.23, y: 0.80 }, { x: 0.34, y: 0.79 }] },
      { id: 'path-R', stitchType: 'zigzag', zone: 'underbust_band_right', side: 'right', symmetryPairId: 'path-L',
        visibility: 'blurred', endpoints: { a: { x: 0.66, y: 0.79 }, b: { x: 0.88, y: 0.81 } },
        referencePolyline: [{ x: 0.66, y: 0.79 }, { x: 0.77, y: 0.80 }, { x: 0.88, y: 0.81 }] },
      { id: 'path-ambiguous', stitchType: 'ambiguous', zone: 'center_front_placket', side: 'center', symmetryPairId: null,
        visibility: 'occluded', endpoints: { a: { x: 0.48, y: 0.3 }, b: { x: 0.52, y: 0.5 } },
        referencePolyline: [{ x: 0.48, y: 0.3 }, { x: 0.52, y: 0.5 }] },
    ],
    negativeRegions: [...NEGATIVE_KINDS].map((kind, i) => ({
      kind, polygon: [{ x: 0.01 * i, y: 0 }, { x: 0.01 * i + 0.02, y: 0 }, { x: 0.01 * i + 0.01, y: 0.02 }],
    })),
    ignoreRegions: [
      { polygon: [{ x: 0.9, y: 0.9 }, { x: 0.99, y: 0.9 }, { x: 0.95, y: 0.99 }], reason: 'motion blur, path not judgeable' },
    ],
    notes: 'synthetic positive-control fixture, not a real photo',
  };
  validateGroundTruth(fullyPopulated, 'positive-control');
  console.log('  positive control: a fully-populated td_confirmed-shaped fixture (2 symmetric paths + ambiguous + all '
    + NEGATIVE_KINDS.size + ' negative-region kinds + an ignore region) validated cleanly');

  // ---- Negative controls: prove every rule above can actually fail ----
  const base = files[0].gt;
  const clone = (obj) => JSON.parse(JSON.stringify(obj));
  const mustReject = (label, mutator) => {
    const copy = clone(base);
    mutator(copy);
    let threw = false;
    try { validateGroundTruth(copy, 'mutation:' + label); } catch { threw = true; }
    if (!threw) fail('negative control failed to reject: ' + label);
    checked += 1;
  };
  mustReject('bad schemaVersion', (c) => { c.schemaVersion = 'photo-stitch-groundtruth/999'; });
  mustReject('bad source enum', (c) => { c.source = 'td_says_so'; });
  mustReject('out-of-range coordinate', (c) => {
    c.paths.push({ id: 'x', stitchType: 'zigzag', zone: 'z', side: null, symmetryPairId: null, visibility: 'clear',
      endpoints: { a: { x: 1.5, y: 0.5 }, b: { x: 0.2, y: 0.2 } }, referencePolyline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
  mustReject('non-finite coordinate', (c) => {
    c.paths.push({ id: 'x', stitchType: 'zigzag', zone: 'z', side: null, symmetryPairId: null, visibility: 'clear',
      endpoints: { a: { x: NaN, y: 0.5 }, b: { x: 0.2, y: 0.2 } }, referencePolyline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
  mustReject('unknown stitchType', (c) => {
    c.paths.push({ id: 'x', stitchType: 'chainstitch', zone: 'z', side: null, symmetryPairId: null, visibility: 'clear',
      endpoints: { a: { x: 0.1, y: 0.1 }, b: { x: 0.2, y: 0.2 } }, referencePolyline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
  mustReject('empty technicalLabel', (c) => {
    c.paths.push({ id: 'x', stitchType: 'other_stitch', technicalLabel: '', zone: 'z', side: null, symmetryPairId: null, visibility: 'clear',
      endpoints: { a: { x: 0.1, y: 0.1 }, b: { x: 0.2, y: 0.2 } }, referencePolyline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
  mustReject('unknown visibility', (c) => {
    c.paths.push({ id: 'x', stitchType: 'zigzag', zone: 'z', side: null, symmetryPairId: null, visibility: 'invisible',
      endpoints: { a: { x: 0.1, y: 0.1 }, b: { x: 0.2, y: 0.2 } }, referencePolyline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
  mustReject('dangling symmetryPairId', (c) => {
    c.paths.push({ id: 'x', stitchType: 'zigzag', zone: 'z', side: 'left', symmetryPairId: 'does-not-exist', visibility: 'clear',
      endpoints: { a: { x: 0.1, y: 0.1 }, b: { x: 0.2, y: 0.2 } }, referencePolyline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
  mustReject('duplicate path id', (c) => {
    const p1 = { id: 'dup', stitchType: 'zigzag', zone: 'z', side: null, symmetryPairId: null, visibility: 'clear',
      endpoints: { a: { x: 0.1, y: 0.1 }, b: { x: 0.2, y: 0.2 } }, referencePolyline: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    c.paths.push(p1, { ...p1 });
  });
  mustReject('negative region with unknown kind', (c) => {
    c.negativeRegions.push({ kind: 'graffiti', polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
  });
  mustReject('ignore region missing reason', (c) => {
    c.ignoreRegions.push({ polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], reason: '' });
  });
  mustReject('unjudgeable without a reason', (c) => { c.unjudgeable = true; c.unjudgeableReason = null; });
  mustReject('sha256 wrong shape', (c) => { c.sourceSha256 = 'not-a-hash'; });
  mustReject('td_confirmed without reviewer', (c) => {
    c.source = 'td_confirmed'; c.labeledAt = null; c.labeledBy = null;
  });
  mustReject('td_confirmed without reviewed evidence', (c) => {
    c.source = 'td_confirmed'; c.paths = []; c.negativeRegions = []; c.ignoreRegions = [];
  });
  console.log('  15 negative controls all correctly rejected their mutated fixture');

  console.log('PASS  photo-stitch-contract   ' + checked + ' assertions ok');
}

main().catch((err) => {
  console.error('FAIL  photo-stitch-contract  ', err.message);
  process.exit(1);
});
