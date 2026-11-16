'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./dom-harness.js');
const S = require('./cfd.js');
function bench(options) { const h = boot(__dirname, options); assert.deepEqual(h.errors, []); return h; }
function change(h,id,value) { h.get(id).value = value; h.event(h.get(id),'change'); }

test('all real index scripts compile and every startup DOM binding is valid', () => {
  const h=bench(); assert.match(h.get('solverStatus').textContent,/SOLVER CHECKS PASS/); assert.match(h.get('solverStatus').textContent,/20,240 finite cells/); assert.equal(h.animation.size,1); h.dispose();
});
test('unavailable local storage does not stop startup or theme switching', () => {
  const h=bench({storageBlocked:true}); assert.equal(h.document.documentElement.getAttribute('data-theme'),'dark'); h.get('themeToggle').click(); assert.equal(h.document.documentElement.getAttribute('data-theme'),'light'); h.dispose();
});
test('all four one-click experiments reach their showcase steps without a repair', () => {
  const h=bench();
  for(const button of h.document.querySelectorAll('[data-scenario]')) { button.click(); h.frames(20); assert.match(h.get('scenarioStatus').textContent,/live experiment/); assert.match(h.get('solverStatus').textContent,/0 repaired nodes/); assert.equal(h.get('errorStatus').hidden,true); }
  assert.deepEqual(h.errors,[]); h.dispose();
});
test('fast pause and resume cycles keep exactly one animation loop', () => {
  const h=bench(); for(let i=0;i<6;i++){h.get('runToggle').click();assert.equal(h.animation.size,0);h.get('runToggle').click();assert.equal(h.animation.size,1);}
  h.frames(1); assert.equal(h.animation.size,1); h.dispose();
});
test('background visibility cancels work and foreground visibility schedules one frame', () => {
  const h=bench(); h.document.hidden=true; h.event(h.document,'visibilitychange'); assert.equal(h.animation.size,0); h.document.hidden=false; h.event(h.document,'visibilitychange'); assert.equal(h.animation.size,1); h.dispose();
});
test('step button pauses and advances exactly 20 lattice steps', () => {
  const h=bench(); h.get('stepBtn').click(); assert.equal(h.animation.size,0); assert.equal(h.get('runToggle').getAttribute('aria-pressed'),'false'); assert.match(h.get('statTime').textContent,/step 60/); h.dispose();
});
test('canvas follows CSS width and device pixel ratio when resized', () => {
  const h=bench({dpr:2}); const canvas=h.get('flowCanvas'); canvas.rect={left:0,top:0,width:600,height:600*92/220}; h.resize(); assert.equal(canvas.width,1200); assert.equal(canvas.height,Math.round(1200*92/220));
  canvas.rect={left:0,top:0,width:340,height:340*92/220}; h.resize(); assert.equal(canvas.width,680); h.dispose();
});
test('keyboard field probe moves, clamps and exposes actual numerical values', () => {
  const h=bench(); const canvas=h.get('flowCanvas'); h.key(canvas,'Home'); assert.match(h.get('probeReadout').textContent,/i=0/); h.key(canvas,'ArrowLeft'); assert.match(h.get('probeReadout').textContent,/i=0/);
  h.key(canvas,'ArrowRight',{shiftKey:true}); assert.match(h.get('probeReadout').textContent,/i=10/); h.key(canvas,'End'); assert.match(h.get('probeReadout').textContent,/i=219/); h.dispose();
});
test('pinned probe resists pointer movement and Escape releases it', () => {
  const h=bench(); const canvas=h.get('flowCanvas'); h.event(canvas,'pointermove',{clientX:400,clientY:160}); h.key(canvas,'Enter'); const before=h.get('probeReadout').textContent;
  assert.equal(h.get('pinProbe').getAttribute('aria-pressed'),'true'); h.event(canvas,'pointermove',{clientX:700,clientY:200}); assert.equal(h.get('probeReadout').textContent,before);
  h.key(canvas,'Escape'); assert.equal(h.get('pinProbe').getAttribute('aria-pressed'),'false'); h.dispose();
});
test('SVG redraws preserve titles and descriptions without accumulating stale nodes', () => {
  const h=bench(); const chart=h.get('forceChart'); const initial=chart.querySelector('title').textContent;
  h.frames(12); assert.equal(chart.querySelectorAll('title').length,1); assert.equal(chart.querySelectorAll('desc').length,1); assert.equal(chart.querySelector('title').textContent,initial);
  for(const node of h.document.querySelectorAll('svg path')) assert.doesNotMatch(node.getAttribute('d')||'',/NaN|Infinity/); h.dispose();
});
test('section trajectory updates from measured force samples as time advances', () => {
  const h=bench(); const before=h.get('sectionChart').textContent; h.get('stepBtn').click(); assert.notEqual(h.get('sectionChart').textContent,before); assert.match(h.get('sectionChart').textContent,/measured pairs/); assert.doesNotMatch(h.get('sectionChart').textContent,/parabola|estimate/); h.dispose();
});
test('invalid NACA designation is visible and blocks stale exports', () => {
  const h=bench(); change(h,'obstacleKind','custom'); change(h,'customCode','2012'); assert.equal(h.get('errorStatus').hidden,false); assert.match(h.get('errorStatus').textContent,/camber position/); assert.equal(h.get('jsonBtn').disabled,true); assert.equal(h.animation.size,0);
  change(h,'customCode','2309'); assert.equal(h.get('errorStatus').hidden,true); assert.equal(h.get('jsonBtn').disabled,false); h.dispose();
});
test('non-airfoil controls are disabled and no fake surface coefficient is displayed', () => {
  const h=bench(); change(h,'obstacleKind','venturi'); assert.equal(h.get('angleRange').disabled,true); assert.equal(h.get('chordRange').disabled,true); assert.match(h.get('cpIntegralLabel').textContent,/n\/a/); h.dispose();
});
test('field radios maintain a single tab stop and support arrow navigation', () => {
  const h=bench(); const radios=h.document.querySelectorAll('.seg'); radios[0].focus(); h.key(radios[0],'ArrowRight'); assert.equal(radios[1].getAttribute('aria-checked'),'true'); assert.equal(radios.filter(r=>r.getAttribute('tabindex')==='0').length,1); h.dispose();
});
test('full field, wake and force CSV downloads contain finite rows', async () => {
  const h=bench(); h.get('csvBtn').click(); h.get('forceCsvBtn').click(); h.get('fieldCsvBtn').click();
  assert.equal(h.document.downloads.length,3);
  for(const file of h.document.downloads){ const text=await h.blobs.get(file.href).text(); assert.doesNotMatch(text,/NaN|Infinity/); assert.ok(text.endsWith('\n')); }
  const field=await h.blobs.get(h.document.downloads[2].href).text(); assert.equal(field.trim().split('\n').length,20241); h.flushTimers();assert.equal(h.blobs.size,0);h.dispose();
});
test('checkpoint download runs its round trip and emits all 182160 populations', async () => {
  const h=bench(); h.get('jsonBtn').click(); assert.match(h.get('scenarioStatus').textContent,/round trip PASS/); const item=h.document.downloads[0]; const json=JSON.parse(await h.blobs.get(item.href).text()); assert.equal(json.populations.length,182160); assert.equal(json.schemaVersion,2); assert.equal(S.importSnapshotJSON(json).time,40);h.dispose();
});
test('checkpoint import restores a real solver and leaves it paused for review', async () => {
  const h=bench(); h.get('jsonBtn').click(); const item=h.document.downloads[0]; const text=await h.blobs.get(item.href).text(); h.get('stepBtn').click();
  h.get('snapshotInput').files=[{size:text.length,text:async()=>text}]; h.event(h.get('snapshotInput'),'change'); await new Promise(resolve=>setImmediate(resolve)); assert.equal(h.get('errorStatus').hidden,true); assert.match(h.get('scenarioStatus').textContent,/restored at step 40/); assert.equal(h.animation.size,0); h.dispose();
});
test('invalid checkpoint import reports the error without throwing a console exception', async () => {
  const h=bench(); h.get('snapshotInput').files=[{size:2,text:async()=>'{}'}];h.event(h.get('snapshotInput'),'change');await new Promise(resolve=>setImmediate(resolve));assert.match(h.get('errorStatus').textContent,/Import failed/);assert.deepEqual(h.errors,[]);h.dispose();
});
test('hatching updates its accessibility state and print remains available', () => {
  const h=bench();h.get('textureToggle').click();assert.equal(h.get('textureToggle').getAttribute('aria-pressed'),'true');h.get('printBtn').click();h.flushTimers();assert.deepEqual(h.errors,[]);h.dispose();
});
