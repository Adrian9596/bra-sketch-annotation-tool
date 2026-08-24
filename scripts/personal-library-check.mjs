#!/usr/bin/env node
// US-098 + US-099: layered Treatments, scale, Smart Hit/Align and Templates.
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
        functions:[d.addLineTreatment,d.applyLineTreatmentToIds,d.addTemplateFromAnnotationIds,d.placeTemplateInBox,d.getLineTreatmentMetrics,d.setSmartAlignEnabled,d.previewSmartAlignment].map(x=>typeof x),
        templateLabel:document.querySelector('#shapeStampSaveBtn').textContent,
        treatmentLabel:document.querySelector('#stitchesMenu .preset-divider:last-of-type')?.textContent||document.querySelector('#linePresetList')?.previousElementSibling?.textContent,
      };
    })()`);
    check(served.binding && served.binding.treatment.layers.length === 3,
      'Binding must ship as a three-layer Treatment');
    check(served.binding && served.binding.treatment.scale === 1,
      'legacy and built-in Treatments must normalize to 100% scale');
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

    const scaled = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      const before=d.getAnnotations().find(x=>x.id===9101);
      const geometry=JSON.stringify({start:before.start,end:before.end,control1:before.control1,control2:before.control2});
      const recipe={name:'Half binding',scale:0.5,layers:[{pattern:'solid',offset:-8,width:4,color:'black',spacing:20,amplitude:6},{pattern:'zigzag',offset:6,width:2,color:'blue',spacing:12,amplitude:5}]};
      d.applyLineTreatmentToIds([9101],recipe);
      const after=d.getAnnotations().find(x=>x.id===9101);
      return {scale:after.lineTreatment.scale,metrics:d.getLineTreatmentMetrics(9101),geometrySame:geometry===JSON.stringify({start:after.start,end:after.end,control1:after.control1,control2:after.control2})};
    })()`);
    check(scaled.scale === 0.5 && scaled.geometrySame,
      'Treatment Scale must be per instance and must not change host geometry');
    check(scaled.metrics.layers[0].offset === -4 && scaled.metrics.layers[0].width === 2
      && scaled.metrics.layers[0].spacing === 10 && scaled.metrics.layers[1].amplitude === 2.5,
      'Treatment Scale must multiply offsets, widths, spacing and amplitude');

    const scaleClamp = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      d.applyLineTreatmentToIds([9101],{name:'Too small',scale:0.01,layers:[{pattern:'solid',offset:2,width:2,color:'black',spacing:10,amplitude:4}]});
      const low=d.getAnnotations().find(x=>x.id===9101).lineTreatment.scale;
      d.applyLineTreatmentToIds([9101],{name:'Too large',scale:99,layers:[{pattern:'solid',offset:2,width:2,color:'black',spacing:10,amplitude:4}]});
      const high=d.getAnnotations().find(x=>x.id===9101).lineTreatment.scale;
      return {low,high};
    })()`);
    check(scaleClamp.low === 0.25 && scaleClamp.high === 4,
      'Treatment Scale must clamp to the approved 25–400% range');

    const smartHit = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug, canvas=document.getElementById('boardCanvas');
      d.applyLineTreatmentToIds([9101],{name:'Wide rails',scale:2,layers:[{pattern:'solid',offset:-9,width:2,color:'black',spacing:10,amplitude:4},{pattern:'solid',offset:9,width:2,color:'black',spacing:10,amplitude:4}]});
      d.clearSelection();
      const view=d.getView(), rect=canvas.getBoundingClientRect(), world={x:280,y:212};
      const x=world.x*view.zoom+view.panX+rect.left, y=world.y*view.zoom+view.panY+rect.top;
      canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y,bubbles:true,button:0}));
      await new Promise(r=>setTimeout(r,40));
      const hovered=d.getState().hoverAnnotationId;
      canvas.dispatchEvent(new MouseEvent('mousedown',{clientX:x,clientY:y,bubbles:true,button:0}));
      window.dispatchEvent(new MouseEvent('mouseup',{clientX:x,clientY:y,bubbles:true,button:0}));
      await new Promise(r=>setTimeout(r,80));
      return {hovered,selection:d.getState().selection};
    })()`);
    check(smartHit.hovered === 9101 && smartHit.selection.kind === 'annotation' && smartHit.selection.id === 9101,
      'Smart Hit must hover and select the host path from its outer Treatment rail');

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
      const send=(type,p,target=canvas)=>{const q=client(p);target.dispatchEvent(new MouseEvent(type,{clientX:q.x,clientY:q.y,bubbles:true,button:0,altKey:true}));};
      send('mousedown',world); send('mousemove',{x:world.x+36,y:world.y+24}); send('mouseup',{x:world.x+36,y:world.y+24},window);
      await new Promise(r=>setTimeout(r,180));
      const after=d.getAnnotations().filter(a=>ids.includes(a.id));
      return {ids,before,after};
    })()`);
    check(moved.after.every((ann,i) => Math.abs((ann.start.x-moved.before[i].start.x)-36)<0.01
      && Math.abs((ann.start.y-moved.before[i].start.y)-24)<0.01),
      `dragging a selected Template member did not move the whole group: ${JSON.stringify(moved)}`);

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

    const aligned = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug, canvas=document.getElementById('boardCanvas');
      const moving={id:9201,seq:null,purpose:'sketch-element',type:'straight',style:'solid',color:'black',arrowType:'none',lineWidth:2,start:{x:90,y:610},end:{x:190,y:610},control1:null,control2:null,points:[],label:{x:140,y:590},labelManual:false,text:null,value:null};
      const reference={id:9202,seq:null,purpose:'sketch-element',type:'straight',style:'solid',color:'black',arrowType:'none',lineWidth:2,start:{x:350,y:630},end:{x:450,y:630},control1:null,control2:null,points:[],label:{x:400,y:610},labelManual:false,text:null,value:null};
      d.styleEvidence.pushAnnotation(moving); d.styleEvidence.pushAnnotation(reference);
      d.setSmartAlignEnabled(true); d.selectAnnotation(9201);
      const view=d.getView(), rect=canvas.getBoundingClientRect();
      const client=p=>({x:p.x*view.zoom+view.panX+rect.left,y:p.y*view.zoom+view.panY+rect.top});
      const send=(type,p,target=canvas,altKey=false)=>{const q=client(p);target.dispatchEvent(new MouseEvent(type,{clientX:q.x,clientY:q.y,bubbles:true,button:0,altKey}));};
      const body={x:140,y:610};
      send('mousedown',body); send('mousemove',{x:294,y:626});
      await new Promise(r=>setTimeout(r,40));
      const live=d.getState(), during=d.getAnnotations().find(a=>a.id===9201);
      send('mouseup',{x:294,y:626},window);
      await new Promise(r=>setTimeout(r,60));
      return {during,guides:live.smartAlignGuides||[],enabled:live.smartAlignEnabled};
    })()`);
    check(aligned.enabled && Math.abs(aligned.during.end.x-350)<0.01 && Math.abs(aligned.during.end.y-630)<0.01,
      'Smart Align must snap a moving endpoint to a nearby endpoint');
    check(aligned.guides.some(g=>g.type==='point'), 'Smart Align must expose a visible endpoint guide during the drag');

    const alignBypass = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug, canvas=document.getElementById('boardCanvas');
      const ann=d.getAnnotations().find(a=>a.id===9201), view=d.getView(), rect=canvas.getBoundingClientRect();
      const body={x:(ann.start.x+ann.end.x)/2,y:(ann.start.y+ann.end.y)/2};
      const client=p=>({x:p.x*view.zoom+view.panX+rect.left,y:p.y*view.zoom+view.panY+rect.top});
      const send=(type,p,target=canvas)=>{const q=client(p);target.dispatchEvent(new MouseEvent(type,{clientX:q.x,clientY:q.y,bubbles:true,button:0,altKey:true}));};
      send('mousedown',body); send('mousemove',{x:body.x+16,y:body.y+7});
      await new Promise(r=>setTimeout(r,30));
      const live=d.getState(), during=d.getAnnotations().find(a=>a.id===9201);
      send('mouseup',{x:body.x+16,y:body.y+7},window);
      return {during,guides:live.smartAlignGuides||[]};
    })()`);
    check(Math.abs(alignBypass.during.end.x-366)<0.01 && Math.abs(alignBypass.during.end.y-637)<0.01
      && alignBypass.guides.length===0,
      'Alt/Option must bypass Smart Align for one drag');

    const alignModes = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      const a={id:9401,seq:null,purpose:'sketch-element',type:'straight',style:'solid',color:'black',arrowType:'none',lineWidth:2,start:{x:0,y:0},end:{x:100,y:100},control1:null,control2:null,points:[],label:{x:50,y:40},labelManual:false};
      const b={id:9402,seq:null,purpose:'sketch-element',type:'straight',style:'solid',color:'black',arrowType:'none',lineWidth:2,start:{x:200,y:208},end:{x:300,y:308},control1:null,control2:null,points:[],label:{x:250,y:248},labelManual:false};
      d.styleEvidence.pushAnnotation(a); d.styleEvidence.pushAnnotation(b);
      d.setSmartAlignEnabled(true);
      const axis=d.previewSmartAlignment([9201],0,-5,false);
      const collinear=d.previewSmartAlignment([9401],80,80,false);
      const toggle=document.getElementById('smartAlignToggleBtn');
      const before=toggle.getAttribute('aria-checked'); toggle.click();
      const off={state:d.getState().smartAlignEnabled,aria:toggle.getAttribute('aria-checked')}; toggle.click();
      return {axis,collinear,before,off,after:d.getState().smartAlignEnabled};
    })()`);
    check(alignModes.axis.guides.some(g=>g.type==='horizontal')
      && Math.abs(alignModes.axis.dx)<0.01 && Math.abs(alignModes.axis.dy+7)<0.01,
      'Smart Align must snap a moving path to a shared horizontal axis');
    check(alignModes.collinear.guides.some(g=>g.type==='line')
      && Math.abs(alignModes.collinear.dx-76)<0.01 && Math.abs(alignModes.collinear.dy-84)<0.01,
      'Smart Align must make an already-parallel straight path collinear without rotating it');
    check(alignModes.before === 'true' && alignModes.off.state === false && alignModes.off.aria === 'false' && alignModes.after === true,
      'the Tools menu Smart Align setting must accurately toggle the assistant');

    const scaleHistory = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug;
      d.applyLineTreatmentToIds([9101],{name:'Binding',scale:1.5,layers:[{kind:'solid',offset:-7,width:2},{kind:'dashed',offset:0,width:1.5,spacing:8},{kind:'solid',offset:7,width:2}]});
      const applied=d.getAnnotations().find(a=>a.id===9101).lineTreatment.scale;
      document.getElementById('undoBtn').click();
      await new Promise(r=>setTimeout(r,80));
      const undone=d.getAnnotations().find(a=>a.id===9101).lineTreatment.scale;
      document.getElementById('redoBtn').click();
      await new Promise(r=>setTimeout(r,80));
      const redone=d.getAnnotations().find(a=>a.id===9101).lineTreatment.scale;
      return {applied,undone,redone};
    })()`);
    check(scaleHistory.applied === 1.5 && scaleHistory.undone === 2 && scaleHistory.redone === 1.5,
      'Treatment Scale changes must participate in Undo and Redo');

    const scratch = await session.eval(`(() => {
      const d=window.__braAutoModeDebug;
      const a={id:9301,seq:null,purpose:'sketch-element',type:'straight',style:'solid',color:'black',arrowType:'none',lineWidth:2,start:{x:-420,y:-260},end:{x:-220,y:-260},control1:null,control2:null,points:[],label:{x:-320,y:-280},labelManual:false};
      const b={id:9302,seq:null,purpose:'sketch-element',type:'curved',style:'solid',color:'black',arrowType:'none',lineWidth:2,start:{x:-420,y:-220},end:{x:-220,y:-220},control1:{x:-360,y:-300},control2:{x:-280,y:-140},points:[],label:{x:-320,y:-240},labelManual:false};
      d.styleEvidence.pushAnnotation(a); d.styleEvidence.pushAnnotation(b);
      const asset=d.addTemplateFromAnnotationIds('Scratch wing',[9301,9302]);
      const source=d.getAnnotations().filter(x=>x.id===9301||x.id===9302);
      const coords=asset.members.flatMap(m=>[m.start,m.end,m.control1,m.control2].filter(Boolean));
      return {asset,source,normalized:coords.every(p=>p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1)};
    })()`);
    check(scratch.asset.members.length === 2 && scratch.normalized
      && scratch.source[0].start.x === -420 && scratch.source[1].start.x === -420,
      'Scratch Area geometry must save by selection, normalize locally and leave its source untouched');

    const projectScale = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug, project=d.exportProject();
      const before=project.state.annotations.find(a=>a.id===9101);
      await d.loadProject(project);
      const after=d.getAnnotations().find(a=>a.id===9101);
      d.selectAnnotation(9101);
      return {before:before.lineTreatment&&before.lineTreatment.scale,after:after.lineTreatment&&after.lineTreatment.scale};
    })()`);
    check(projectScale.before === 1.5 && projectScale.after === 1.5,
      'project save/open must preserve each applied Treatment Scale');

    const editor = await session.eval(`(async () => {
      const d=window.__braAutoModeDebug;
      document.getElementById('stitchesBtn').click();
      document.getElementById('lineTreatmentCustomizeBtn').click();
      await new Promise(r=>setTimeout(r,100));
      const range=document.querySelector('[data-treatment-scale-range]');
      const number=document.querySelector('[data-treatment-scale-number]');
      number.value='175'; number.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-treatment-scale-reset]')?.click();
      const result={open:!!document.querySelector('.treatment-editor'),layers:document.querySelectorAll('.treatment-layer').length,preview:!!document.querySelector('[data-treatment-preview]'),scaleRange:!!range,scaleNumber:!!number,resetRange:range?.value,resetNumber:number?.value};
      document.querySelector('.picker-overlay .picker-btn')?.click();
      return result;
    })()`);
    check(editor.open && editor.layers >= 1 && editor.preview && editor.scaleRange && editor.scaleNumber,
      'Customize selected must open the layered editor with visual scale controls and preview');
    check(editor.resetRange === '100' && editor.resetNumber === '100',
      'Reset 100% must restore both Treatment Scale controls');

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
