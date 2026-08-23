#!/usr/bin/env node
// US-095: focused browser contract for Board Graphic isolation and Cut Path.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CHROME=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let server,chrome,userDataDir,passed=0; const cleanup=[];
const check=(ok,msg)=>{if(!ok)throw new Error(msg);passed+=1;};

async function main(){
  const started=await startStaticServer(appDir);server=started.server;cleanup.push(()=>new Promise(r=>server.close(r)));
  const port=await getFreePort();userDataDir=await mkdtemp(path.join(tmpdir(),'board-shape-check-'));
  cleanup.push(()=>rm(userDataDir,{recursive:true,force:true}).catch(()=>{}));
  chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${port}`,`--user-data-dir=${userDataDir}`,'--window-size=1366,900',`${started.baseUrl}/index.html?shape=${Date.now()}`]);
  cleanup.push(()=>new Promise(r=>{chrome.once('exit',r);chrome.kill('SIGTERM');}));
  await waitForCdp(port);const s=await session(port);await s.waitFor('window.__braAutoModeDebug&&document.getElementById("modeManualBtn")',8000);
  await s.eval('document.getElementById("modeManualBtn").click()');

  const created=await s.eval(`(()=>{const d=__braAutoModeDebug,before=d.getAnnotations().length,canvas=document.getElementById('boardCanvas'),r=canvas.getBoundingClientRect(),v=d.getView();const screen=p=>({x:r.left+v.panX+p.x*v.zoom,y:r.top+v.panY+p.y*v.zoom});const ev=(type,p)=>{const q=screen(p);canvas.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:q.x,clientY:q.y,button:0,buttons:type==='mouseup'?0:1}));};document.getElementById('toolRectangle').click();ev('mousedown',{x:80,y:70});ev('mousemove',{x:200,y:140});ev('mousemove',{x:320,y:210});ev('mouseup',{x:320,y:210});const g=d.getGraphics()[0];return{g,annsBefore:before,annsAfter:d.getAnnotations().length,graphics:d.getGraphics().length,project:d.exportProject()};})()`);
  check(created.graphics===1,'rectangle was not added');
  check(created.annsBefore===0&&created.annsAfter===0,'Board Graphic contaminated annotations');
  check(created.project.state.graphics.length===1&&created.project.state.annotations.length===0,'project snapshot did not isolate graphics');
  check(created.g.mode==='live'&&created.g.shapeKind==='rectangle','new rectangle is not a Live Shape');

  const edit=await s.eval(`(()=>{document.getElementById('editPathBtn').click();const g=__braAutoModeDebug.getGraphics()[0];return{mode:g.mode,closed:g.subpaths[0].closed,nodes:g.subpaths[0].nodes.length,button:document.getElementById('editPathBtn').hidden};})()`);
  check(edit.mode==='path'&&edit.closed&&edit.nodes===4,'Edit Path did not convert rectangle to one closed four-node path');
  check(edit.button,'Edit Path button must withdraw while editing');

  const firstCut=await s.eval(`(()=>{const d=__braAutoModeDebug,g=d.getGraphics()[0];d.graphics.activateSegment(g.id,0,0,0.5);document.getElementById('segmentCurvedBtn').click();const curved=d.getGraphics()[0].subpaths[0].nodes[0].segmentType;d.graphics.activateSegment(g.id,0,0,0.5);document.getElementById('cutPathBtn').click();const out=d.getGraphics()[0];return{curved,subpaths:out.subpaths.length,closed:out.subpaths[0].closed,nodes:out.subpaths[0].nodes.length,endGap:Math.hypot(out.subpaths[0].nodes[0].point.x-out.subpaths[0].nodes.at(-1).point.x,out.subpaths[0].nodes[0].point.y-out.subpaths[0].nodes.at(-1).point.y),anns:d.getAnnotations().length};})()`);
  check(firstCut.curved==='curve','Make Curved did not convert the active segment');
  check(firstCut.subpaths===1&&!firstCut.closed&&firstCut.nodes===6,'first cut did not open the closed path at the inserted node');
  check(firstCut.endGap<1e-9,'first cut endpoints do not coincide');
  check(firstCut.anns===0,'Cut Path created a POM annotation');

  const secondCut=await s.eval(`(()=>{const d=__braAutoModeDebug,g=d.getGraphics()[0];d.graphics.activateNode(g.id,0,2);const ok=d.graphics.cut();const out=d.getGraphics()[0];return{ok,subpaths:out.subpaths.length,closed:out.subpaths.map(s=>s.closed),count:out.subpaths.reduce((n,s)=>n+s.nodes.length,0)};})()`);
  check(secondCut.ok&&secondCut.subpaths===2&&secondCut.closed.every(x=>!x),'cutting an open interior node did not create two open subpaths');

  const noOp=await s.eval(`(()=>{const d=__braAutoModeDebug,g=d.getGraphics()[0];d.graphics.activateNode(g.id,0,0);const before=JSON.stringify(d.getGraphics());const ok=d.graphics.cut();return{ok,same:before===JSON.stringify(d.getGraphics())};})()`);
  check(noOp.ok===false&&noOp.same,'cutting an open endpoint must be a no-op');

  const roundTrip=await s.eval(`(async()=>{const d=__braAutoModeDebug,snap=d.exportProject();await d.loadProject(snap);const saved=d.getGraphics();const old=structuredClone(snap);delete old.state.graphics;await d.loadProject(old);return{saved:saved.length,savedSubpaths:saved[0].subpaths.length,legacy:d.getGraphics().length,anns:d.getAnnotations().length};})()`);
  check(roundTrip.saved===1&&roundTrip.savedSubpaths===2,'Save/Open lost cut subpaths');
  check(roundTrip.legacy===0&&roundTrip.anns===0,'pre-US-095 project did not migrate to empty graphics');

  const shapes=await s.eval(`(()=>{const d=__braAutoModeDebug,c=d.graphics.addLive('circle',{x:20,y:20,width:90,height:90}),h=d.graphics.addLive('hexagon',{x:150,y:20,width:90,height:90});d.graphics.enterEdit(c.id);d.graphics.enterEdit(h.id);const all=d.getGraphics();return{circle:all.find(g=>g.id===c.id).subpaths[0],hex:all.find(g=>g.id===h.id).subpaths[0]};})()`);
  check(shapes.circle.nodes.length===4&&shapes.circle.nodes.every(n=>n.segmentType==='curve'),'Circle did not convert to four cubic segments');
  check(shapes.hex.nodes.length===6&&shapes.hex.nodes.every(n=>n.segmentType==='line'),'Hexagon did not convert to six straight segments');

  const ownership=await s.eval(`(async()=>{const d=__braAutoModeDebug,blank=d.exportProject();blank.state.graphics=[];blank.state.annotations=[];blank.state.images=[];await d.loadProject(blank);const fixture=document.createElement('canvas');fixture.width=800;fixture.height=500;const fctx=fixture.getContext('2d');fctx.fillStyle='#fff';fctx.fillRect(0,0,fixture.width,fixture.height);fctx.strokeStyle='#111';fctx.lineWidth=8;fctx.strokeRect(90,70,620,360);fctx.beginPath();fctx.moveTo(120,420);fctx.bezierCurveTo(260,100,540,100,680,420);fctx.stroke();await d.addBoardImages([fixture.toDataURL('image/png')]);document.getElementById('modeManualBtn').click();const im0=d.getImages()[0],g=d.graphics.addLive('rectangle',{x:im0.x+im0.width*.35,y:im0.y+im0.height*.35,width:60,height:40},im0.id);d.graphics.selectImage(im0.id);const canvas=document.getElementById('boardCanvas'),rect=canvas.getBoundingClientRect(),w2s=p=>{const v=d.getView();return{x:rect.left+v.panX+p.x*v.zoom,y:rect.top+v.panY+p.y*v.zoom}},ev=(t,p)=>{const q=w2s(p);canvas.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:q.x,clientY:q.y,button:0,buttons:t==='mouseup'?0:1}))},drag=(p,dx,dy)=>{ev('mousedown',p);for(let i=1;i<=4;i++)ev('mousemove',{x:p.x+dx*i/4,y:p.y+dy*i/4});ev('mouseup',{x:p.x+dx,y:p.y+dy})};const pick={x:im0.x+10,y:im0.y+10};const before=d.getGraphics().find(x=>x.id===g.id),imBefore=d.getImages()[0];drag(pick,45,30);const moved=d.getGraphics().find(x=>x.id===g.id),imMoved=d.getImages()[0];const corner={x:imMoved.x+imMoved.width,y:imMoved.y+imMoved.height};drag(corner,90,40);const scaled=d.getGraphics().find(x=>x.id===g.id),imScaled=d.getImages()[0];document.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));return{moveImage:[imMoved.x-imBefore.x,imMoved.y-imBefore.y],moveGraphic:[moved.live.center.x-before.live.center.x,moved.live.center.y-before.live.center.y],imageScale:imScaled.width/imMoved.width,graphicScale:scaled.live.width/moved.live.width,afterDelete:d.getGraphics().length,imagesAfter:d.getImages().length};})()`);
  console.log('board-shape-check: ownership',JSON.stringify(ownership));
  check(Math.hypot(ownership.moveImage[0]-ownership.moveGraphic[0],ownership.moveImage[1]-ownership.moveGraphic[1])<0.01,'owned graphic did not move exactly with its sketch');
  check(Math.abs(ownership.imageScale-ownership.graphicScale)<0.001,'owned graphic did not scale exactly with its sketch');
  check(ownership.afterDelete===0&&ownership.imagesAfter===0,'deleting a sketch did not delete its owned graphics in the same action');

  const errors=await s.eval('window.__shapeErrors||[]');check(errors.length===0,'browser console errors: '+errors.join(' | '));
  await s.close();console.log(`PASS  board-shape-check   ${passed}/${passed} assertions ok`);
}

async function session(port){const targets=await fetchJson(`http://127.0.0.1:${port}/json`);const t=targets.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});const cdp=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,m=>m.error?j(new Error(m.error.message)):r(m.result));ws.send(JSON.stringify({id:n,method,params}));});await cdp('Runtime.enable');await cdp('Runtime.evaluate',{expression:`window.__shapeErrors=[];addEventListener('error',e=>window.__shapeErrors.push(String(e.message||e.error)))`});const evalJs=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};return{eval:evalJs,waitFor:async(q,ms)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(await evalJs(q))return;}catch{}await sleep(80);}throw new Error('timeout '+q);},close:()=>ws.close()};}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitForCdp(port){for(let i=0;i<100;i++){try{await fetchJson(`http://127.0.0.1:${port}/json/version`);return;}catch{}await sleep(80);}throw new Error('CDP did not start');}
async function fetchJson(url){const r=await fetch(url);if(!r.ok)throw new Error(String(r.status));return r.json();}
try{await main();}catch(e){process.exitCode=1;console.error('FAIL',e.message);}finally{for(const task of cleanup.reverse())try{await task();}catch{}}
