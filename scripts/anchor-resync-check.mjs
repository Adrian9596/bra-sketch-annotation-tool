#!/usr/bin/env node
// The rules resyncDraftsFromAnchors (src/auto/drafts/anchor-drag-sync.js) has to
// obey while it rewrites every draft's geometry from the anchors on each move.
//
// board-interaction-check owns the headline behaviour — all 18 POMs follow their
// anchors, POM 1 stays level, Reset Anchors re-syncs. This file owns the three
// rules that make that safe, none of which that section touches:
//
//   1. a draft the TD has HAND-EDITED (tdEdited) keeps their geometry — without
//      this the fix would be worse than the bug it replaces;
//   2. a draft that was NOT hand-edited does follow its anchors;
//   3. Undo restores a corrected anchor (and the drafts derived from it), and a
//      band nudge carries the hem-seeded bottoms with it instead of flattening
//      them onto the band chord;
//   4. tdApproved is dropped only for a draft whose geometry actually moved, and
//      that verdict is taken AFTER the style-evidence blend. Judged before it, a
//      style with stored evidence would un-approve every blended draft on every
//      anchor move, because the pre-blend rebuild always differs from the
//      post-blend geometry the TD is looking at even when the two passes land it
//      right back where it was. Guard 4 pins that round trip.
//
// Uses its own Chrome and its own board, so nothing here perturbs another suite.
// Learning is OFF: every gesture below is a real TD correction as far as the app
// is concerned and would otherwise pour synthetic samples into the calibration
// store.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, passes = 0;
const check = (ok, msg) => { if (ok) { passes += 1; console.log('  ok   ' + msg); } else { fails += 1; console.log('  FAIL ' + msg); } };

const started = await startStaticServer(APP_DIR);
const cdpPort = await getFreePort();
const userDataDir = await mkdtemp(path.join(tmpdir(), 'resync-guards-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, '--window-size=1440,900',
  `${started.baseUrl}/index.html?contract=resyncguards${Date.now()}`], { stdio: ['ignore', 'ignore', 'pipe'] });

let s;
try {
  await waitForCdp(cdpPort);
  s = await openCdpSession(cdpPort);
  await s.waitFor('!!window.__braAutoModeDebug', 30000);
  await s.waitForSoft(`/ready/i.test(document.querySelector('#visionEngineChip')?.textContent||'')`, 120000);
  await s.eval(`window.__braAutoModeDebug.learning.setEnabled(false); 'off'`);
  await s.eval(`(async () => { const d = window.__braAutoModeDebug;
    const b = await (await fetch('demo/demo1.jpg?p=' + Date.now(), {cache:'no-store'})).blob();
    const u = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
    window.__G='run'; await d.runAutoOnDataUrl(u); window.__G='done'; return 'go'; })()`);
  await s.waitFor(`window.__G === 'done'`, 300000);

  const out = await s.eval(`(() => {
    const d = window.__braAutoModeDebug;
    const canvas = document.getElementById('boardCanvas');
    const view = () => d.getView ? d.getView() : d.getViewport();
    const w2s = p => { const v = view(); const r = canvas.getBoundingClientRect();
      return { x: p.x*v.zoom + v.panX + r.left, y: p.y*v.zoom + v.panY + r.top }; };
    const ev = (t,x,y,o) => canvas.dispatchEvent(new MouseEvent(t, Object.assign({
      bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons: t==='mouseup'?0:1 }, o||{})));
    const drafts = () => d.getDrafts();
    const byPom = (p) => drafts().find(x => String(x.seq) === String(p));
    const geom = (x) => x && x.start ? { sx:x.start.x, sy:x.start.y, ex:x.end.x, ey:x.end.y } : null;
    const moved = (a,b) => !a || !b ? null
      : Math.max(Math.hypot(a.sx-b.sx, a.sy-b.sy), Math.hypot(a.ex-b.ex, a.ey-b.ey));

    // --- hand-edit POM 11 by dragging its whole line ---
    const p11 = byPom(11);
    const mid = { x: (p11.start.x + p11.end.x)/2, y: (p11.start.y + p11.end.y)/2 };
    const c = w2s(mid);
    const sx = Math.round(c.x), sy = Math.round(c.y);
    ev('mousedown', sx, sy); ev('mouseup', sx, sy);            // select the draft
    ev('mousedown', sx, sy);
    const opened = (d.getInteraction() || {}).type;
    for (let i=1;i<=6;i+=1) ev('mousemove', sx + 18*i/6, sy + 14*i/6);
    ev('mouseup', sx + 18, sy + 14);
    const edited11 = byPom(11);
    const editedGeom = geom(edited11);

    // Approve everything drawable, so the approval rule below has something to test.
    const approvedCount = d.approveDrawableDrafts();
    const approvedBefore = drafts().filter(x => x.tdApproved).map(x => String(x.seq));

    const before = {};
    for (const x of drafts()) before[String(x.seq)] = geom(x);

    // --- move side-top: POM 11 reads it, and so does nothing else ---
    const a = d.getAnchors().find(x => x.kind === 'side-top');
    const I = d.getImages().find(i => i.id === a.sourceImageId) || d.getImages()[0];
    const ap = w2s({ x: I.x + a.x*I.width, y: I.y + a.y*I.height });
    const ax = Math.round(ap.x), ay = Math.round(ap.y);
    ev('mousedown', ax, ay);
    for (let i=1;i<=6;i+=1) ev('mousemove', ax, ay - 26*i/6);
    ev('mouseup', ax, ay - 26, { altKey: true });

    const after = {};
    for (const x of drafts()) after[String(x.seq)] = geom(x);
    const post11 = byPom(11);

    // --- now move an anchor that DOES feed a non-edited draft, to prove the
    //     approval rule drops only what moved ---
    const before2 = {}; for (const x of drafts()) before2[String(x.seq)] = geom(x);
    const approvedBefore2 = drafts().filter(x => x.tdApproved).map(x => String(x.seq));
    const a2 = d.getAnchors().find(x => x.kind === 'strap-top');
    const ap2 = w2s({ x: I.x + a2.x*I.width, y: I.y + a2.y*I.height });
    const bx = Math.round(ap2.x), by = Math.round(ap2.y);
    ev('mousedown', bx, by);
    for (let i=1;i<=6;i+=1) ev('mousemove', bx, by - 26*i/6);
    ev('mouseup', bx, by - 26, { altKey: true });
    const after2 = {}; for (const x of drafts()) after2[String(x.seq)] = geom(x);
    const approvedAfter2 = drafts().filter(x => x.tdApproved).map(x => String(x.seq));
    const geomMoved2 = Object.keys(before2).filter(p => (moved(before2[p], after2[p]) || 0) > 1e-9);

    // --- guard 4: with style evidence stored, a settled blended draft must not
    //     lose its approval every time some unrelated anchor moves. The resync
    //     rewrites it to RAW fixture geometry and then re-blends, so a naive
    //     "did the rewrite change anything" test says yes on every single move
    //     even though the line the TD is looking at never budges.
    const I2 = d.getImages()[0];
    const nrm = (p) => ({ x: (p.x - I2.x)/I2.width, y: (p.y - I2.y)/I2.height });
    const p1 = byPom(1);
    d.styleEvidence.add(null, {
      id: 'guard-ev-1', sourceImageId: I2.id, savedAt: new Date().toISOString(),
      source: 'td-edited-auto-line', tdStatus: 'confirmed', pom: '1', viewRole: 'front_outer',
      line: { type: 'straight', start: { x: nrm(p1.start).x + 0.02, y: nrm(p1.start).y + 0.01 },
                                end:   { x: nrm(p1.end).x   + 0.02, y: nrm(p1.end).y   + 0.01 } },
      quality: { sourceConfidence: 'high', editedFromAuto: true, drawability: 'DRAWABLE' },
    });
    const dragKind = (kind, dy) => {
      const an = d.getAnchors().find(x => x.kind === kind);
      const IM = d.getImages().find(i => i.id === an.sourceImageId) || d.getImages()[0];
      const q = w2s({ x: IM.x + an.x*IM.width, y: IM.y + an.y*IM.height });
      const qx = Math.round(q.x), qy = Math.round(q.y);
      ev('mousedown', qx, qy);
      for (let i=1;i<=6;i+=1) ev('mousemove', qx, qy + dy*i/6);
      ev('mouseup', qx, qy + dy, { altKey: true });
    };
    // First move lets the blend land on POM 1 (its geometry legitimately shifts).
    dragKind('back-top', -20);
    const pom1Blended = !!byPom(1).styleEvidenceStatus;
    // Re-approve everything, then move the SAME unrelated anchor again.
    d.approveDrawableDrafts();
    const approvedBefore3 = drafts().filter(x => x.tdApproved).map(x => String(x.seq));
    const before3 = {}; for (const x of drafts()) before3[String(x.seq)] = geom(x);
    dragKind('back-top', -14);
    const after3 = {}; for (const x of drafts()) after3[String(x.seq)] = geom(x);
    const approvedAfter3 = drafts().filter(x => x.tdApproved).map(x => String(x.seq));
    const geomMoved3 = Object.keys(before3).filter(p => (moved(before3[p], after3[p]) || 0) > 1e-9);

    // Re-usable by the sections after this eval.
    window.__ARC = { w2s, ev, dragKind, geom, byPom, drafts, moved, d };

    return {
      opened,
      pom1Blended,
      approvedBefore3, approvedAfter3, geomMoved3,
      tdEdited11: !!post11.tdEdited,
      editedGeom, post11Geom: geom(post11),
      edit11Survived: moved(editedGeom, geom(post11)),
      approvedCount, approvedBefore,
      movedByAnchorDrag: Object.keys(before).filter(p => (moved(before[p], after[p]) || 0) > 1e-9),
      approvedBefore2, approvedAfter2, geomMoved2,
      pom14MovedOnStrapDrag: (moved(before2['14'], after2['14']) || 0),
    };
  })()`);

  console.log('=== guard 1: a hand-edited draft is not clobbered ===');
  // Any of the draft-edit gestures counts: pressing the midpoint can land on an
  // endpoint handle when the line is short, and drag-handle is just as much a
  // TD edit as drag-annotation(s). What must NOT happen is the press opening an
  // anchor or image drag, which would mean POM 11 was never hand-edited at all.
  check(/^drag-(handle|annotation|annotations)$/.test(String(out.opened)),
    `the press grabbed the draft, not something else (interaction was "${out.opened}")`);
  check(out.tdEdited11 === true, 'POM 11 is flagged tdEdited after the hand drag');
  check(out.edit11Survived === 0,
    `POM 11 kept the TD's geometry through the side-top anchor drag (moved ${out.edit11Survived})`);
  check(!out.movedByAnchorDrag.includes('11'),
    `POM 11 was not re-derived (drafts that moved: ${JSON.stringify(out.movedByAnchorDrag)})`);

  console.log('\n=== guard 2: non-edited drafts DO follow their anchors ===');
  check(out.pom14MovedOnStrapDrag > 1e-9,
    `POM 14 followed the strap-top drag (moved ${out.pom14MovedOnStrapDrag.toFixed(3)} world px) — the fix is live`);

  console.log('\n=== guard 3: approval is dropped only where the geometry moved ===');
  const lost = out.approvedBefore2.filter(p => !out.approvedAfter2.includes(p));
  const kept = out.approvedAfter2;
  console.log(`   approved before: ${out.approvedBefore2.length} | after: ${kept.length}`);
  console.log(`   geometry moved:  ${JSON.stringify(out.geomMoved2)}`);
  console.log(`   lost approval:   ${JSON.stringify(lost)}`);
  check(out.approvedBefore2.length > 0, 'there were approved drafts to test against');
  check(lost.length > 0, 'the drafts whose geometry moved lost their approval');
  check(lost.every(p => out.geomMoved2.includes(p)),
    'no draft lost its approval without its geometry moving');
  check(out.geomMoved2.every(p => !out.approvedBefore2.includes(p) || lost.includes(p)),
    'every approved draft that moved lost its approval');

  console.log('\n=== guard 4: a settled blended draft keeps its approval when an unrelated anchor moves ===');
  check(out.pom1Blended, 'POM 1 actually picked up the stored style evidence (else guard 4 tests nothing)');
  const lost3 = out.approvedBefore3.filter(p => !out.approvedAfter3.includes(p));
  console.log(`   geometry moved: ${JSON.stringify(out.geomMoved3)} | lost approval: ${JSON.stringify(lost3)}`);
  check(!out.geomMoved3.includes('1'),
    'POM 1 did not move when back-top did — the raw-rewrite-then-reblend round trip is a no-op');
  check(!lost3.includes('1'),
    'POM 1 kept its approval through an unrelated anchor move despite being re-blended each time');
  check(lost3.every(p => out.geomMoved3.includes(p)),
    `only drafts that really moved lost approval (lost ${JSON.stringify(lost3)}, moved ${JSON.stringify(out.geomMoved3)})`);
  check(out.geomMoved3.length > 0, 'the second back-top drag did move something (non-vacuous)');

  // ---- guard 5: Undo restores a corrected anchor -------------------------
  // Anchors used to sit outside history entirely: makeSnapshot carried no
  // autoMode key, so the fingerprint never changed, pushHistoryIfChanged
  // short-circuited and Cmd+Z did nothing at all — while the Undo button stayed
  // enabled, so there was no signal either. The only way back was Reset Anchors,
  // which discards EVERY correction rather than the last one. Drives the real
  // #undoBtn (async) rather than an internal, so the button's own disabled state
  // is part of the assertion.
  const undoPrep = await s.eval(`(() => {
    const A = window.__ARC;
    const kind = 'side-bottom';
    const before = (() => { const a = A.d.getAnchors().find(x => x.kind === kind); return { x:a.x, y:a.y }; })();
    const draftBefore = A.geom(A.byPom(11));
    A.dragKind(kind, -22);
    const after = (() => { const a = A.d.getAnchors().find(x => x.kind === kind); return { x:a.x, y:a.y }; })();
    const btn = document.getElementById('undoBtn');
    return { kind, before, after, draftBefore,
      dragMoved: Math.hypot(after.x - before.x, after.y - before.y),
      undoEnabled: !!btn && !btn.disabled };
  })()`);
  // This file's check() echoes its message on success too, so every message is
  // phrased as the assertion, not as the failure.
  check(undoPrep.dragMoved > 0.001,
    `the ${undoPrep.kind} drag moved the anchor by ${undoPrep.dragMoved.toFixed(5)} (needs > 0.001 to be worth undoing)`);
  check(undoPrep.undoEnabled, 'the Undo button is enabled after an anchor correction');
  await s.eval(`(() => { window.__UNDO_SETTLED = false;
    document.getElementById('undoBtn').click();
    setTimeout(() => { window.__UNDO_SETTLED = true; }, 400); return 'clicked'; })()`);
  await s.waitFor('window.__UNDO_SETTLED === true', 20000);
  const undoOut = await s.eval(`(() => {
    const A = window.__ARC;
    const a = A.d.getAnchors().find(x => x.kind === ${JSON.stringify('side-bottom')});
    return { present: !!a, pos: a ? { x:a.x, y:a.y } : null, draftCount: A.drafts().length };
  })()`);
  check(undoOut.present, 'the anchor set survived the undo');
  const undoGap = undoOut.pos
    ? Math.hypot(undoOut.pos.x - undoPrep.before.x, undoOut.pos.y - undoPrep.before.y) : Infinity;
  check(undoGap < 1e-9,
    `Undo put the ${undoPrep.kind} anchor back (off by ${undoGap}) — it used to do nothing at all`);
  check(undoOut.draftCount >= 15,
    `the drafts survived the undo (got ${undoOut.draftCount}) — they ride the same snapshot`);

  // ---- guard 6: a band nudge carries the hem-seeded bottoms ---------------
  // cf-bottom and cradle-cup-bottom are seeded from hem ink at their own column
  // (US-061). Their drop_to_line derivation used to project them flat onto the
  // band chord, so the first band nudge silently discarded that. The gap is 0 on
  // most demo sketches, which is exactly why this asserts the RELATIONSHIP holds
  // rather than a magic number — and skips loudly if the fixture has no gap to
  // preserve, instead of passing for the wrong reason.
  const hem = await s.eval(`(() => {
    const A = window.__ARC;
    const at = (k) => A.d.getAnchors().find(x => x.kind === k) || null;
    const chordY = (p) => { const bl = at('band-left'), br = at('band-right');
      if (!bl || !br || !p) return null;
      const t = (br.x - bl.x) === 0 ? 0 : (p.x - bl.x) / (br.x - bl.x);
      return bl.y + t * (br.y - bl.y); };
    const gapOf = (k) => { const p = at(k); const c = chordY(p); return (p && c != null) ? p.y - c : null; };
    const before = { cf: gapOf('cf-bottom'), cc: gapOf('cradle-cup-bottom') };
    A.dragKind('band-right', -24);
    const after = { cf: gapOf('cf-bottom'), cc: gapOf('cradle-cup-bottom') };
    const moved = (() => { const bl = at('band-left'), br = at('band-right');
      return Math.abs(br.y - bl.y); })();
    return { before, after, bandSkew: moved,
      offsets: { cf: (at('cf-bottom') || {}).derivedOffset, cc: (at('cradle-cup-bottom') || {}).derivedOffset } };
  })()`);
  check(hem.bandSkew > 0.001,
    `the band pair is un-level after the drag (skew ${hem.bandSkew.toFixed(5)}), so the projection is exercised`);
  check(hem.before.cf != null && hem.after.cf != null, 'cf-bottom was present on both sides of the drag');
  check(Math.abs(hem.after.cf - hem.before.cf) < 1e-9,
    `cf-bottom kept its gap to the band chord (${Number(hem.before.cf).toFixed(7)} -> ${Number(hem.after.cf).toFixed(7)}), `
    + `so the hem seeding survived the nudge`);
  check(Math.abs(hem.after.cc - hem.before.cc) < 1e-9,
    `cradle-cup-bottom kept its gap to the band chord `
    + `(${Number(hem.before.cc).toFixed(7)} -> ${Number(hem.after.cc).toFixed(7)})`);
  check(hem.offsets.cf != null && hem.offsets.cc != null,
    `both dependents carry a derivedOffset recorded at seed time — without one, a sketch whose hem `
    + `happens to sit on the chord would pass this section for the wrong reason`);
  console.log(`  info  hem gap held at cf=${Number(hem.after.cf).toFixed(6)}, `
    + `cc=${Number(hem.after.cc).toFixed(6)} across a ${hem.bandSkew.toFixed(4)} band skew`);

  if (fails) {
    console.log(`\nanchor-resync-check: FAIL (${fails} of ${passes + fails} checks)`);
    process.exitCode = 1;
  } else {
    console.log(`\nanchor-resync-check: PASS (${passes} checks)`);
  }
} finally {
  try { if (s) s.close(); } catch (_) {}
  try { chrome.kill('SIGTERM'); } catch (_) {}
  await new Promise(r => started.server.close(r));
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

async function openCdpSession(port){const targets=await fetchJson(`http://127.0.0.1:${port}/json`);const target=targets.find(i=>i.type==='page'&&i.webSocketDebuggerUrl);const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})});let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}});const cdp=(method,params={})=>new Promise((res,rej)=>{const rid=++id;pending.set(rid,m=>m.error?rej(new Error(m.error.message)):res(m.result));ws.send(JSON.stringify({id:rid,method,params}))});await cdp('Runtime.enable');await cdp('Page.enable');const evalJs=async expr=>{const r=await cdp('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text||'eval failed');return r.result.value};const waitFor=async(expr,ms)=>{const dl=Date.now()+ms;while(Date.now()<dl){try{if(await evalJs(expr))return true}catch(_){}await sleep(100)}throw new Error('waitFor timeout: '+expr)};const waitForSoft=async(expr,ms)=>{try{return await waitFor(expr,ms)}catch(_){return false}};return{eval:evalJs,waitFor,waitForSoft,cdp,close:()=>ws.close()}}
async function waitForCdp(port){for(let i=0;i<120;i+=1){try{await fetchJson(`http://127.0.0.1:${port}/json/version`);return}catch(_){}await sleep(100)}throw new Error('CDP did not come up')}
async function fetchJson(url){const r=await fetch(url);if(!r.ok)throw new Error('fetch '+url+' '+r.status);return r.json()}
