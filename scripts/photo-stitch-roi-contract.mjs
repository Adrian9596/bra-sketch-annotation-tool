#!/usr/bin/env node
// US-109 P0A: validate the independent Oracle Semantic ROI lane.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSemanticRois } from './photo-stitch-roi-schema.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(appDir, 'scripts/groundtruth/photo-stitch');
let assertions = 0;
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  assertions += 1;
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mustReject(records, label, mutate) {
  const copy = clone(records);
  mutate(copy);
  let rejected = false;
  try { validateSemanticRois(copy, `negative:${label}`, check); } catch { rejected = true; }
  check(rejected, `negative control did not reject ${label}`);
}

async function main() {
  const names = (await readdir(corpusDir)).filter(name => name.endsWith('.json')).sort();
  check(names.length === 6, `expected six pilot fixtures, got ${names.length}`);
  let total = 0;
  let confirmed = 0;
  let drafts = 0;
  let unavailable = 0;
  let sample;

  for (const name of names) {
    const fixture = JSON.parse(await readFile(path.join(corpusDir, name), 'utf8'));
    validateSemanticRois(fixture.semanticRois, name, check);
    sample ||= fixture.semanticRois;
    total += fixture.semanticRois.length;
    confirmed += fixture.semanticRois.filter(roi => roi.source === 'td_confirmed').length;
    drafts += fixture.semanticRois.filter(roi => roi.source === 'draft_pending_td').length;
    unavailable += fixture.semanticRois.filter(roi => roi.availability === 'unavailable').length;
  }

  mustReject(sample, 'missing identity', records => records.pop());
  mustReject(sample, 'duplicate identity', records => { records[1] = clone(records[0]); });
  mustReject(sample, 'side encoded in zone', records => { records[0].zone = 'shoulder_strap_left'; });
  mustReject(sample, 'invalid center side', records => { records.at(-1).side = 'left'; });
  mustReject(sample, 'too few polygon points', records => { records[0].polygon = records[0].polygon.slice(0, 3); });
  mustReject(sample, 'out of range point', records => { records[0].polygon[0].x = 1.1; });
  mustReject(sample, 'unavailable still has polygon', records => {
    records[0].availability = 'unavailable';
    records[0].unavailableReason = 'not visible';
  });
  mustReject(sample, 'confirmed lacks reviewer', records => {
    records[0].source = 'td_confirmed';
    records[0].reviewer = null;
    records[0].reviewedAt = null;
  });

  console.log(`  corpus: ${names.length} fixtures, ${total} ROI identities, ${confirmed} td_confirmed, ${drafts} draft_pending_td, ${unavailable} unavailable`);
  if (confirmed < total) console.log('  BLOCKED  Oracle ROI accuracy authority waits for TD confirmation of every record');
  console.log(`PASS  photo-stitch-roi-contract   ${assertions} assertions ok`);
}

main().catch(error => {
  console.error(`FAIL  photo-stitch-roi-contract\n${error.stack || error}`);
  process.exitCode = 1;
});
