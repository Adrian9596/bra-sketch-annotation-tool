#!/usr/bin/env node
// Focused end-to-end proof for Construction working sheets (US-078/ADR 0045).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
let server, chrome, userDataDir;
const cleanupTasks = [];
let passed = 0;

async function main() {
  const started = await startStaticServer(appDir);
  server = started.server;
  cleanupTasks.push(() => new Promise(resolve => server.close(resolve)));
  const cdpPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(tmpdir(), 'construction-check-'));
  cleanupTasks.push(() => rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`,
    `${started.baseUrl}/index.html?construction-check=${Date.now()}`,
  ]);
  cleanupTasks.push(() => new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); }));
  await waitForCdp(cdpPort);
  const s = await openCdpSession(cdpPort);
  await s.waitFor(`document.querySelectorAll('#specBody tr').length > 0`, 8000);

  await s.eval(`document.querySelector('#pageTabBar [data-page="construction"]').click()`);
  await s.waitFor(`document.body.classList.contains('construction-open')`, 4000);

  // 1. Continuous sheet layout and seed contract.
  const initial = await s.eval(`(() => {
    const cc = window.__braAutoModeDebug.exportProject().state.construction;
    return {
      schema: cc.schemaVersion,
      seedId: cc.seedId,
      rows: cc.rows.length,
      callouts: cc.callouts.length,
      blankDetails: cc.rows.filter(r => r.detail === '').length,
      solidOuter: cc.rows.filter(r => r.sheet === 'solid' && r.view === 'outer').map(r => r.area),
      solidInner: cc.rows.filter(r => r.sheet === 'solid' && r.view === 'inner').map(r => r.area),
      laceOuter: cc.rows.filter(r => r.sheet === 'lace' && r.view === 'outer').length,
      laceInner: cc.rows.filter(r => r.sheet === 'lace' && r.view === 'inner').length,
      visibleRows: document.querySelectorAll('#ccTableBody tr[data-cc-row]').length,
      viewBands: Array.from(document.querySelectorAll('#ccTableBody .cc-view-band')).map(x => x.textContent.trim()),
      hasToggle: !!document.getElementById('ccTableToggleBtn'),
      hasSide: !!document.getElementById('ccSidePanel'),
      tools: ['ccSelectToolBtn','ccAddCalloutBtn','ccAddLeaderBtn'].every(id => !!document.getElementById(id)),
      selectActive: document.getElementById('ccSelectToolBtn').classList.contains('cc-tool-active'),
      leaderDisabled: document.getElementById('ccAddLeaderBtn').disabled,
    };
  })()`);
  check(initial.schema === 2, `expected Construction schema 2, got ${initial.schema}`);
  check(initial.seedId === 'construction-working-sheets-v1', `unexpected seed id ${initial.seedId}`);
  check(initial.rows === 24, `fresh Construction should seed 24 rows, got ${initial.rows}`);
  check(initial.callouts === 0, 'fresh draft rows must not invent callouts');
  check(initial.blankDetails === 24, 'all seeded Construction Detail values must be truly blank');
  check(initial.solidOuter.join(',') === 'CUP,SLING,CRADLE,SIDE_SEAM,BACK_CLOSURE,FRONT_CLOSURE', `wrong OUTER seed ${initial.solidOuter}`);
  check(initial.solidInner.join(',') === initial.solidOuter.join(','), 'INNER seed must match OUTER structural draft');
  check(initial.laceOuter === 6 && initial.laceInner === 6, 'Lace must seed six Outer and six Inner rows');
  check(initial.visibleRows === 12, `active Solid table should show 12 rows, got ${initial.visibleRows}`);
  check(initial.viewBands.join(',') === 'OUTER,INNER', `expected OUTER/INNER bands, got ${initial.viewBands}`);
  check(initial.hasToggle === false && initial.hasSide === false, 'old collapsible table and side-note editor must be removed');
  check(initial.tools, 'Select/Add Callouts/Add Leaders tools are missing');
  check(initial.selectActive && initial.leaderDisabled, 'Select should be default and Add Leaders disabled without a callout');

  // 2. Drop images into independent Solid Outer and Inner panels.
  await dropTinyPng(s, 'outer', 'solid-outer.png');
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.construction.images.solid.outer.length === 1`, 4000);
  await dropTinyPng(s, 'inner', 'solid-inner.png');
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.construction.images.solid.inner.length === 1`, 4000);
  const imageOwnership = await s.eval(`(() => {
    const cc = window.__braAutoModeDebug.exportProject().state.construction;
    return {
      so: cc.images.solid.outer.length, si: cc.images.solid.inner.length,
      lo: cc.images.lace.outer.length, li: cc.images.lace.inner.length,
      ids: [cc.images.solid.outer[0].id, cc.images.solid.inner[0].id],
      bytes: !!cc.images.solid.outer[0].dataURL && !!cc.images.solid.inner[0].dataURL,
    };
  })()`);
  check(imageOwnership.so === 1 && imageOwnership.si === 1, 'Solid Outer/Inner images were not stored independently');
  check(imageOwnership.lo === 0 && imageOwnership.li === 0, 'Solid drops must not leak into Lace');
  check(imageOwnership.ids[0] !== imageOwnership.ids[1], 'Outer and Inner must own different image records');
  check(imageOwnership.bytes, 'Construction image bytes must be serialized for save/autosave');

  // 3. Add Callouts batches rows and obeys row view ownership.
  await s.eval(`document.getElementById('ccAddCalloutBtn').click()`);
  const armed = await s.eval(`({
    active: document.getElementById('ccAddCalloutBtn').classList.contains('cc-tool-active'),
    hint: document.getElementById('ccToolHint').textContent,
    selected: document.querySelector('#ccTableBody tr.cc-row-selected')?.dataset.ccRow || null,
  })`);
  check(armed.active, 'Add Callouts should become active');
  check(/row 1.*OUTER/i.test(armed.hint), `first batch hint should target row 1 OUTER, got ${armed.hint}`);
  check(!!armed.selected, 'the next uncovered row should be highlighted');
  await canvasClick(s, 'outer', 0, 0);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.construction.callouts.length === 1`, 4000);
  const firstCallout = await s.eval(`(() => {
    const cc = window.__braAutoModeDebug.exportProject().state.construction;
    const c = cc.callouts[0], r = cc.rows.find(x => x.id === c.rowId);
    return {
      toolActive: document.getElementById('ccAddCalloutBtn').classList.contains('cc-tool-active'),
      rowArea: r.area, rowView: r.view, calloutView: c.view, targets: c.targets.length,
      storesText: Object.prototype.hasOwnProperty.call(c, 'detail') || Object.prototype.hasOwnProperty.call(c, 'note'),
      nextHint: document.getElementById('ccToolHint').textContent,
      rowId: r.id, calloutId: c.id,
    };
  })()`);
  check(firstCallout.toolActive, 'Add Callouts must stay active after the first placement');
  check(firstCallout.rowArea === 'CUP' && firstCallout.rowView === 'outer', 'first callout should belong to seeded Outer CUP row');
  check(firstCallout.calloutView === 'outer' && firstCallout.targets === 1, 'callout view/target shape is wrong');
  check(firstCallout.storesText === false, 'callout must derive text from its row instead of storing a copy');
  check(/row 2.*OUTER/i.test(firstCallout.nextHint), `batch should advance to row 2, got ${firstCallout.nextHint}`);
  await canvasClick(s, 'outer', 25, 18);
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.construction.callouts.length === 2`, 4000);

  // Row ⊕ on an occupied row selects it and never duplicates it.
  const occupiedSelect = await s.eval(`(() => {
    const cc = window.__braAutoModeDebug.exportProject().state.construction;
    const rowId = cc.callouts[0].rowId;
    document.querySelector('[data-cc-row-callout="' + rowId + '"]').click();
    const after = window.__braAutoModeDebug.exportProject().state.construction;
    return {
      count: after.callouts.length,
      selectActive: document.getElementById('ccSelectToolBtn').classList.contains('cc-tool-active'),
      leaderDisabled: document.getElementById('ccAddLeaderBtn').disabled,
      rowId,
    };
  })()`);
  check(occupiedSelect.count === 2, 'row callout action must not duplicate an occupied row');
  check(occupiedSelect.selectActive && occupiedSelect.leaderDisabled === false, 'occupied row should select its callout and enable Add Leaders');

  // 4. Persistent Add Leaders, Escape, target drag, and undo.
  await s.eval(`document.getElementById('ccAddLeaderBtn').click()`);
  await canvasClick(s, 'outer', -35, -25);
  await canvasClick(s, 'outer', 40, -30);
  const leaders = await s.eval(`(() => {
    const cc = window.__braAutoModeDebug.exportProject().state.construction;
    const c = cc.callouts.find(x => x.rowId === ${occupiedSelect.rowId});
    return { targets: c.targets.length, active: document.getElementById('ccAddLeaderBtn').classList.contains('cc-tool-active') };
  })()`);
  check(leaders.targets === 3, `two persistent leader clicks should make 3 targets, got ${leaders.targets}`);
  check(leaders.active, 'Add Leaders should remain active for repeated targets');
  await s.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`);
  check(await s.eval(`document.getElementById('ccSelectToolBtn').classList.contains('cc-tool-active')`), 'Escape should return to Select');

  const beforeDrag = await s.eval(`window.__braAutoModeDebug.exportProject().state.construction.callouts.find(c => c.rowId === ${occupiedSelect.rowId}).targets[0]`);
  await dragPrimaryTarget(s, 'outer', 35, 20);
  const afterDrag = await s.eval(`window.__braAutoModeDebug.exportProject().state.construction.callouts.find(c => c.rowId === ${occupiedSelect.rowId}).targets[0]`);
  check(afterDrag.nx !== beforeDrag.nx || afterDrag.ny !== beforeDrag.ny, 'dragging one target should move only its normalized position');
  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`(() => { const t=window.__braAutoModeDebug.exportProject().state.construction.callouts.find(c=>c.rowId===${occupiedSelect.rowId}).targets[0]; return t.nx===${beforeDrag.nx} && t.ny===${beforeDrag.ny}; })()`, 4000);
  passed += 1;

  // 5. Table edits are the source for callout content; no TBC is injected.
  const edited = await s.eval(`(() => {
    const area = document.querySelector('[data-cc-row-area="${occupiedSelect.rowId}"]');
    area.value = 'SLING'; area.dispatchEvent(new Event('change', { bubbles:true }));
    const detail = document.querySelector('[data-cc-row-detail="${occupiedSelect.rowId}"]');
    detail.value = 'Attach sling cleanly'; detail.dispatchEvent(new Event('input', { bubbles:true }));
    detail.dispatchEvent(new Event('focusout', { bubbles:true }));
    const cc = window.__braAutoModeDebug.exportProject().state.construction;
    const row = cc.rows.find(r => r.id === ${occupiedSelect.rowId});
    const callout = cc.callouts.find(c => c.rowId === row.id);
    return { area: row.area, detail: row.detail, storedCopy: callout.detail || callout.note || null, containsTbc: cc.rows.some(r => /TBC/i.test(r.detail)) };
  })()`);
  check(edited.area === 'SLING', `Area dropdown did not write SLING, got ${edited.area}`);
  check(edited.detail === 'Attach sling cleanly', 'Construction Detail did not write through to the row');
  check(edited.storedCopy === null, 'callout should not cache row detail');
  check(edited.containsTbc === false, 'the Construction draft must never inject TBC text');

  // 6. Moving a row between views deletes its old callout atomically; undo restores both.
  const moved = await s.eval(`(() => {
    const select = document.querySelector('[data-cc-row-view="${occupiedSelect.rowId}"]');
    select.value = 'inner'; select.dispatchEvent(new Event('change', { bubbles:true }));
    const cc = window.__braAutoModeDebug.exportProject().state.construction;
    return { view: cc.rows.find(r=>r.id===${occupiedSelect.rowId}).view, callout: !!cc.callouts.find(c=>c.rowId===${occupiedSelect.rowId}) };
  })()`);
  check(moved.view === 'inner' && moved.callout === false, 'moving Outer→Inner must remove the old-view callout');
  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`(() => { const cc=window.__braAutoModeDebug.exportProject().state.construction; return cc.rows.find(r=>r.id===${occupiedSelect.rowId}).view==='outer' && !!cc.callouts.find(c=>c.rowId===${occupiedSelect.rowId}); })()`, 4000);
  passed += 1;

  // 7. Deleting a row deletes the owned callout; undo restores both.
  const deleted = await s.eval(`(() => {
    document.querySelector('[data-cc-row-del="${occupiedSelect.rowId}"]').click();
    const cc=window.__braAutoModeDebug.exportProject().state.construction;
    return { row: !!cc.rows.find(r=>r.id===${occupiedSelect.rowId}), callout: !!cc.callouts.find(c=>c.rowId===${occupiedSelect.rowId}) };
  })()`);
  check(!deleted.row && !deleted.callout, 'row delete must remove row and owned callout together');
  await s.eval(`document.getElementById('undoBtn').click()`);
  await s.waitFor(`(() => { const cc=window.__braAutoModeDebug.exportProject().state.construction; return !!cc.rows.find(r=>r.id===${occupiedSelect.rowId}) && !!cc.callouts.find(c=>c.rowId===${occupiedSelect.rowId}); })()`, 4000);
  passed += 1;

  // 8. Lace owns independent rows/images and retains the same two-view sheet layout.
  await s.eval(`document.querySelector('[data-cc-sheet="lace"]').click()`);
  const laceBefore = await s.eval(`({ rows:document.querySelectorAll('#ccTableBody tr[data-cc-row]').length, title:document.getElementById('ccSheetTitle').textContent, calls:window.__braAutoModeDebug.exportProject().state.construction.callouts.filter(c=>c.sheet==='lace').length })`);
  check(laceBefore.rows === 12, `Lace should show its own 12 draft rows, got ${laceBefore.rows}`);
  check(laceBefore.title === 'CONSTRUCTION · LACE', `wrong Lace sheet title ${laceBefore.title}`);
  check(laceBefore.calls === 0, 'Solid callouts must not leak into Lace');
  await dropTinyPng(s, 'outer', 'lace-outer.png');
  await s.waitFor(`window.__braAutoModeDebug.exportProject().state.construction.images.lace.outer.length === 1`, 4000);
  const independent = await s.eval(`(() => { const cc=window.__braAutoModeDebug.exportProject().state.construction; return { so:cc.images.solid.outer.length, lo:cc.images.lace.outer.length, same:cc.images.solid.outer[0].id===cc.images.lace.outer[0].id }; })()`);
  check(independent.so === 1 && independent.lo === 1 && !independent.same, 'Lace and Solid must own independent image records');

  // 9. Legacy note migration preserves facts and uses explicit front_inner when present.
  const migrated = await s.eval(`(async () => {
    await window.__braAutoModeDebug.loadProject({
      format:'bra-sketch-project', version:2, savedAt:new Date().toISOString(),
      state:{
        annotations:[],
        images:[{id:7,dataURL:'${TINY_PNG}',x:0,y:0,width:400,height:300,locked:false,viewRole:'front_inner'}],
        eraseStrokes:[],brushSize:24,showLabels:true,calibration:{unitsPerPx:null,unit:'cm'},
        nextSequence:1,idCounter:20,drawStyle:'solid',drawColor:'red',arrowType:'double',lineWidth:2.5,
        zoom:1,panX:0,panY:0,styleId:'',pomSpecs:{},
        construction:{notes:[{id:9,seq:1,imageId:7,zone:'BACK',variant:'lace',targets:[{nx:.2,ny:.3},{nx:.4,ny:.5}],textPos:{nx:.6,ny:.2},note:'Legacy closure instruction',color:'#123456'}]},
      },
    });
    const cc=window.__braAutoModeDebug.exportProject().state.construction;
    return { schema:cc.schemaVersion,seed:cc.seedId,rows:cc.rows.length,calls:cc.callouts.length,
      row:cc.rows[0],call:cc.callouts[0],images:cc.images.lace.inner.length,bytes:!!cc.images.lace.inner[0].dataURL };
  })()`);
  check(migrated.schema === 2 && migrated.seed === 'legacy-migrated', 'legacy Construction did not migrate to schema 2');
  check(migrated.rows === 1 && migrated.calls === 1, 'legacy content should not receive 24 seed rows');
  check(migrated.row.sheet === 'lace' && migrated.row.view === 'inner', 'legacy front_inner note should migrate to Lace Inner');
  check(migrated.row.area === 'BACK' && migrated.row.detail === 'Legacy closure instruction', 'legacy area/detail were not preserved');
  check(migrated.call.targets.length === 2 && migrated.call.textPos.nx === .6, 'legacy targets/text position were not preserved');
  check(migrated.images === 1 && migrated.bytes, 'legacy Board image was not copied into Lace Inner with bytes');

  // 10. New-model save/open round trip preserves rows, callouts, and owned images.
  const roundTrip = await s.eval(`(async () => {
    const api=window.__braAutoModeDebug;
    const before=api.exportProject();
    await api.loadProject(before);
    const cc=api.exportProject().state.construction;
    return { rows:cc.rows.length,calls:cc.callouts.length,detail:cc.rows[0].detail,targets:cc.callouts[0].targets.length,images:cc.images.lace.inner.length,bytes:!!cc.images.lace.inner[0].dataURL };
  })()`);
  check(roundTrip.rows === 1 && roundTrip.calls === 1, 'new Construction model did not round-trip');
  check(roundTrip.detail === 'Legacy closure instruction' && roundTrip.targets === 2, 'round trip lost row/callout content');
  check(roundTrip.images === 1 && roundTrip.bytes, 'round trip lost Construction image ownership/bytes');

  // 11. A pre-Construction project receives only the structural seed; detection remains untouched.
  const legacyEmpty = await s.eval(`(async () => {
    await window.__braAutoModeDebug.loadProject({format:'bra-sketch-project',version:1,savedAt:new Date().toISOString(),state:{
      annotations:[],images:[],eraseStrokes:[],brushSize:24,showLabels:true,calibration:{unitsPerPx:null,unit:'cm'},
      nextSequence:1,idCounter:1,drawStyle:'solid',drawColor:'red',arrowType:'double',lineWidth:2.5,
      zoom:1,panX:0,panY:0,styleId:'',pomSpecs:{},
    }});
    const cc=window.__braAutoModeDebug.exportProject().state.construction;
    const st=window.__braAutoModeDebug.getState();
    return {rows:cc.rows.length,blank:cc.rows.filter(r=>r.detail==='').length,calls:cc.callouts.length,anchors:st.anchorCount,drafts:st.draftCount};
  })()`);
  check(legacyEmpty.rows === 24 && legacyEmpty.blank === 24 && legacyEmpty.calls === 0, 'pre-Construction load should receive blank structural seed only');
  check(legacyEmpty.anchors === 0 && legacyEmpty.drafts === 0, 'Construction must not create POM anchors or drafts');

  await s.close();
  console.log(`PASS  construction-check   ${passed}/${passed} assertions ok`);
}

async function dropTinyPng(s, view, name) {
  await s.eval(`(() => {
    const canvas=document.getElementById('constructionCanvas');
    const rect=canvas.getBoundingClientRect();
    const binary=atob('${TINY_PNG.split(',')[1]}');
    const bytes=new Uint8Array(binary.length); for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    const file=new File([bytes], '${name}', {type:'image/png'});
    const dt=new DataTransfer(); dt.items.add(file);
    const x='${view}'==='outer' ? rect.left+rect.width*.25 : rect.left+rect.width*.75;
    canvas.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:x,clientY:rect.top+rect.height*.5,dataTransfer:dt}));
  })()`);
}

async function canvasClick(s, view, dx, dy) {
  await s.eval(`(() => {
    const canvas=document.getElementById('constructionCanvas'); const r=canvas.getBoundingClientRect();
    const x='${view}'==='outer' ? r.left+r.width*.25+${dx} : r.left+r.width*.75+${dx};
    canvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:x,clientY:r.top+r.height*.54+${dy}}));
  })()`);
}

async function dragPrimaryTarget(s, view, dx, dy) {
  await s.eval(`(() => {
    const canvas=document.getElementById('constructionCanvas'); const r=canvas.getBoundingClientRect();
    const x='${view}'==='outer' ? r.left+r.width*.25 : r.left+r.width*.75; const y=r.top+r.height*.54;
    canvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:x,clientY:y}));
    window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x+${dx},clientY:y+${dy}}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:x+${dx},clientY:y+${dy}}));
  })()`);
}

function check(cond, msg) {
  if (!cond) {
    console.error('FAIL  ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  passed += 1;
}

async function openCdpSession(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return connectToTarget(target.webSocketDebuggerUrl);
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
  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const cdp = (method, params) => new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
  const evalJs = async expression => {
    const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      const ex = res.exceptionDetails.exception;
      throw new Error((ex && (ex.description || ex.value)) || JSON.stringify(res.exceptionDetails));
    }
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
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
  if (err && err.message) console.error('FAIL', err.message);
} finally {
  for (const task of cleanupTasks.reverse()) {
    try { await task(); } catch (_) {}
  }
}
