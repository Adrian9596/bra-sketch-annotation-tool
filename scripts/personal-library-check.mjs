#!/usr/bin/env node
// US-098: focused proof for layered Line Treatments and grouped Templates.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

async function main() {
  const started = await startStaticServer(appDir);
  const cdpPort = await getFreePort();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'personal-library-check-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900', `${started.baseUrl}/index.html?contract=personallibrary${Date.now()}`,
  ]);
  let session = null;
  try {
    await waitForCdp(cdpPort);
    session = await openCdpSession(cdpPort);
    await session.waitFor(`!!window.__braAutoModeDebug`, 20000);
    await session.eval(`window.__plErrors=[];window.addEventListener('error',e=>window.__plErrors.push(String(e.message||e.type)));window.addEventListener('unhandledrejection',e=>window.__plErrors.push(String(e.reason&&e.reason.message||e.reason)));true`);

    const served = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      return {
        binding:d.getLinePresets().find(x=>x.id==='builtin-binding'),
        functions:[d.addLineTreatment,d.applyLineTreatmentToIds,d.addTemplateFromAnnotationIds,d.placeTemplateInBox].map(x=>typeof x),
        templateLabel:document.querySelector('#shapeStampSaveBtn').textContent,
        treatmentLabel:document.querySelector('#stitchesMenu .preset-divider:last-of-type')?.textContent||document.querySelector('#linePresetList')?.previousElementSibling?.textContent,
      };
    })()`);
    check(served.binding && served.binding.treatment.layers.length === 3,
      'Binding must ship as a three-layer Treatment');
    check(served.functions.every(x => x === 'function'), 'the served bundle is missing Personal Library hooks');
    check(/Template/i.test(served.templateLabel), 'Tools must present reusable geometry as Templates');

    const treatment = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      d.meaning.setAppMode('manual');
      d.resetLinePresets(); d.resetShapeStamps();
      const straight={id:9101,seq:1,type:'straight',style:'solid',color:'red',arrowType:'double',lineWidth:2.5,start:{x:160,y:230},end:{x:410,y:230},control1:null,control2:null,points:[],label:{x:285,y:210},labelManual:false,text:null,value:null};
      const curve={id:9102,seq:2,type:'curved',style:'solid',color:'red',arrowType:'double',lineWidth:2.5,start:{x:170,y:330},end:{x:410,y:330},control1:{x:230,y:260},control2:{x:350,y:400},points:[],label:{x:290,y:300},labelManual:false,text:null,value:null};
      d.styleEvidence.pushAnnotation(straight); d.styleEvidence.pushAnnotation(curve);
      const before=d.getAnnotations().map(a=>({id:a.id,start:a.start,end:a.end,control1:a.control1,control2:a.control2}));
      const binding=d.getLinePresets().find(x=>x.id==='builtin-binding');
      const count=d.applyLineTreatmentToIds([9101,9102],binding.treatment);
      const after=d.getAnnotations().filter(a=>a.id===9101||a.id===9102);
      const measured=d.getMeasurementAnnIds();
      return {count,before,after,measured,binding};
    })()`);
    check(treatment.count === 2, 'Binding must apply to the whole selected path set');
    for (const ann of treatment.after) {
      const before = treatment.before.find(x => x.id === ann.id);
      check(JSON.stringify({ start:ann.start,end:ann.end,control1:ann.control1,control2:ann.control2 })
        === JSON.stringify({ start:before.start,end:before.end,control1:before.control1,control2:before.control2 }),
      `Treatment changed geometry for annotation ${ann.id}`);
      check(ann.lineTreatment && ann.lineTreatment.layers.length === 3,
        `annotation ${ann.id} did not receive an independent Binding recipe`);
      check(!treatment.measured.includes(ann.id), `treated annotation ${ann.id} leaked into Measurement Spec`);
    }

    const independent = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      const custom={name:'Wide binding',layers:[{pattern:'solid',offset:-8,width:3,color:'black',spacing:10,amplitude:4},{pattern:'solid',offset:8,width:3,color:'black',spacing:10,amplitude:4}]};
      d.applyLineTreatmentToIds([9101],custom);
      const a=d.getAnnotations().find(x=>x.id===9101);
      const b=d.getAnnotations().find(x=>x.id===9102);
      const library=d.getLinePresets().find(x=>x.id==='builtin-binding');
      const saved=d.addLineTreatment('Wide binding',custom);
      return {aLayers:a.lineTreatment.layers.length,bLayers:b.lineTreatment.layers.length,libraryLayers:library.treatment.layers.length,saved};
    })()`);
    check(independent.aLayers === 2 && independent.bLayers === 3 && independent.libraryLayers === 3,
      'customizing one applied Treatment must not mutate another line or its Library source');
    check(independent.saved && independent.saved.kind === 'treatment', 'Save as new treatment did not persist a reusable recipe');

    const template = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      const asset=d.addTemplateFromAnnotationIds('Back wing',[9101,9102]);
      const beforeCount=d.getAnnotations().length;
      const placed=d.placeTemplateInBox(asset.id,{x:520,y:180,width:300,height:220});
      const state=d.getState();
      return {asset,beforeCount,placed,state,measured:d.getMeasurementAnnIds()};
    })()`);
    check(template.asset && template.asset.members.length === 2, 'a two-path back wing did not save as one Template');
    check(template.placed.length === 2 && new Set(template.placed.map(x => x.templateGroupId)).size === 1,
      'Template placement must create two members with one group id');
    check(template.placed.every(x => x.purpose === 'sketch-element' && !template.measured.includes(x.id)),
      'Template members must stay out of the measurement contract');
    check(template.state.selectedAnnotationIds.length === 2,
      'placing a Template must select it as one group');

    const moved = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug, canvas=document.getElementById('boardCanvas');
      const ids=d.getState().selectedAnnotationIds;
      const before=d.getAnnotations().filter(a=>ids.includes(a.id));
      const first=before[0], world={x:(first.start.x+first.end.x)/2,y:(first.start.y+first.end.y)/2};
      const view=d.getView(), rect=canvas.getBoundingClientRect();
      const client=p=>({x:p.x*view.zoom+view.panX+rect.left,y:p.y*view.zoom+view.panY+rect.top});
      const send=(type,p,target=canvas)=>{const q=client(p);target.dispatchEvent(new MouseEvent(type,{clientX:q.x,clientY:q.y,bubbles:true,button:0}));};
      send('mousedown',world); send('mousemove',{x:world.x+36,y:world.y+24}); send('mouseup',{x:world.x+36,y:world.y+24},window);
      await new Promise(r=>setTimeout(r,180));
      const after=d.getAnnotations().filter(a=>ids.includes(a.id));
      return {ids,before,after};
    })()`);
    check(moved.after.every((ann,i) => Math.abs((ann.start.x-moved.before[i].start.x)-36)<0.01
      && Math.abs((ann.start.y-moved.before[i].start.y)-24)<0.01),
      'dragging a selected Template member did not move the whole group');

    const entered = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug, canvas=document.getElementById('boardCanvas');
      const ids=d.getState().selectedAnnotationIds, first=d.getAnnotations().find(a=>a.id===ids[0]);
      const world={x:(first.start.x+first.end.x)/2,y:(first.start.y+first.end.y)/2};
      const view=d.getView(), rect=canvas.getBoundingClientRect();
      const x=world.x*view.zoom+view.panX+rect.left, y=world.y*view.zoom+view.panY+rect.top;
      canvas.dispatchEvent(new MouseEvent('dblclick',{clientX:x,clientY:y,bubbles:true,button:0}));
      await new Promise(r=>setTimeout(r,120));
      return d.getState();
    })()`);
    check(entered.templateGroupEditId && entered.selectedAnnotationIds.length === 1,
      'double-click must enter a Template group and expose one member path');

    const editor = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug;
      document.getElementById('stitchesBtn').click();
      document.getElementById('lineTreatmentCustomizeBtn').click();
      await new Promise(r=>setTimeout(r,100));
      const result={open:!!document.querySelector('.treatment-editor'),layers:document.querySelectorAll('.treatment-layer').length,preview:!!document.querySelector('[data-treatment-preview]')};
      document.querySelector('.picker-overlay .picker-btn')?.click();
      return result;
    })()`);
    check(editor.open && editor.layers >= 1 && editor.preview,
      'Customize selected must open the layered editor with a visual preview');

    const persistedBefore = await session.eval(`(() => ({treatments:localStorage.getItem('bra-line-presets-v1'),templates:localStorage.getItem('bra-shape-stamps-v1')}))()`);
    check(persistedBefore.treatments?.includes('Wide binding') && persistedBefore.templates?.includes('Back wing'),
      'Personal Library entries were not written to browser storage');
    await session.eval(`window.location.reload()`);
    await session.waitFor(`!!window.__braAutoModeDebug`, 20000);
    const persistedAfter = await session.eval(`(() => {const d=window.__braAutoModeDebug;return {treatments:d.getLinePresets().map(x=>x.name),templates:d.getShapeStamps().map(x=>x.name),external:performance.getEntriesByType('resource').map(x=>x.name).filter(x=>/^https?:/.test(x)&&new URL(x).origin!==location.origin)};})()`);
    check(persistedAfter.treatments.includes('Wide binding') && persistedAfter.templates.includes('Back wing'),
      'Personal Library did not survive a reload on the static site origin');
    check(persistedAfter.external.length === 0,
      `Personal Library caused external runtime requests: ${JSON.stringify(persistedAfter.external)}`);

    const errors = await session.eval(`window.__plErrors||[]`);
    check(errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
    console.log(`personal-library-check: PASS (${passed} checks)`);
  } finally {
    if (session) session.close();
    await new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); });
    await new Promise(resolve => started.server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

async function waitForCdp(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch (_) {}
    await sleep(100);
  }
  throw new Error('Chrome CDP did not start');
}

async function openCdpSession(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('No Chrome page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Runtime.enable');
  const evalJs = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'eval failed');
    return result.result.value;
  };
  const waitFor = async (expression, timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await evalJs(expression)) return; } catch (_) {}
      await sleep(100);
    }
    throw new Error(`waitFor timeout: ${expression}`);
  };
  return { eval: evalJs, waitFor, close: () => ws.close() };
}

main().catch(error => {
  console.error('personal-library-check: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
