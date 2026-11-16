'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./cfd.js');
function empty(nx = 32, ny = 16) { return S.createWindTunnel(nx, ny, 0.06, 0.03, { mask: new Uint8Array(nx * ny), wallMode: 'free-slip', perturbation: 0 }); }
function checkpoint() { const state = S.createWindTunnel(40, 24, 0.06, 0.03, { obstacle: 'cylinder' }); S.stepLBM(state, 20); return { state, snapshot: JSON.parse(S.exportSnapshotJSON(state, { includePopulations: true })) }; }
function moments(state, cell) { let rho = 0, mx = 0, my = 0; for (let q = 0; q < 9; q++) { const f = state.f[cell * 9 + q]; rho += f; mx += S.CX[q] * f; my += S.CY[q] * f; } return { rho, ux: mx / rho, uy: my / rho }; }

test('all NACA-prefixed aliases route to their actual section', () => {
  for (const code of ['0012', '2412', '4415']) assert.equal(S.generateObstacleMask('naca' + code, { nx: 80, ny: 40 }).code, code);
});
test('degenerate and camber-position-zero sections are rejected', () => {
  for (const code of ['0000', '2400', '2012']) assert.throws(() => S.parseNaca4(code), /thickness|camber/);
  assert.throws(() => S.generateNaca4Mask('0001', 4, 0, 80, 40), /no solid cells/);
});
test('coordinate sample requests and solver memory have explicit budgets', () => {
  assert.equal(S.naca4Coordinates('0012', 1000000).samples, 4096);
  assert.throws(() => S.createWindTunnel(4096, 4096, 0.08, 0.02), /memory budget/);
  assert.throws(() => S.generateObstacleMask('cylinder', { nx: 0, ny: 16 }), /between 8/);
});
test('custom masks reject wrong values, no-fluid domains and missing arrays', () => {
  for (const mask of [null, new Uint8Array(10), new Array(512).fill(2), new Uint8Array(512).fill(1)]) assert.throws(() => S.createWindTunnel(32, 16, 0.06, 0.03, { mask }), /mask|fluid/);
});
test('mask ownership prevents caller edits from silently changing solver geometry', () => {
  const mask = new Uint8Array(512); mask[200] = 1; const state = S.createWindTunnel(32, 16, 0.06, 0.03, { mask }); mask[200] = 0;
  assert.equal(state.mask[200], 1); assert.equal(state.mask.solidCount, 1);
});
test('airfoil force coefficients use chord while projected height remains a geometry measurement', () => {
  const mask = S.generateNaca4Mask('2412', 30, 8, 80, 40);
  const state = S.createWindTunnel(80, 40, 0.06, 0.03, { mask }); state.forceY = -0.02;
  assert.equal(state.referenceHeight, 30);
  assert.equal(mask.projectedHeight, Math.max(...mask.polygon.map(p => p.y)) - Math.min(...mask.polygon.map(p => p.y)));
  assert.ok(Math.abs(S.computeForceCoefficients(state).cl - 0.02 / (0.5 * 0.06 ** 2 * 30)) < 1e-12);
});
test('nonfinite and density repairs keep distributions and moments consistent', () => {
  const state = empty(); const cell = 8 * 32 + 16; state.f[cell * 9] = NaN;
  assert.equal(S.refreshMacroscopic(state, true), 1); assert.equal(state.unstable, true); assert.equal(state.sanitizedNodes, 1);
  let m = moments(state, cell); assert.ok(Math.abs(m.rho - state.rho[cell]) < 1e-12); assert.ok(Math.abs(m.ux - state.ux[cell]) < 1e-12);
  state.f.fill(0, cell * 9, cell * 9 + 9); S.refreshMacroscopic(state, true); m = moments(state, cell);
  assert.ok(Math.abs(m.rho - S.LIMITS.minDensity) < 1e-12); assert.ok(Math.abs(state.rho[cell] - m.rho) < 1e-12);
});
test('lattice speed repair changes populations to the bounded macroscopic velocity', () => {
  const state = empty(), cell = 100; state.f.fill(0, cell * 9, cell * 9 + 9); state.f[cell * 9 + 1] = 1;
  S.refreshMacroscopic(state, true); const m = moments(state, cell);
  assert.ok(Math.abs(Math.hypot(m.ux, m.uy) - S.LIMITS.maxLatticeSpeed) < 1e-12); assert.ok(Math.abs(m.ux - state.ux[cell]) < 1e-12);
});
test('uniform open flow with free-slip walls conserves mass and momentum', () => {
  const state = empty(); S.stepLBM(state, 100); const d = S.computeDiagnostics(state);
  assert.ok(Math.abs(d.fluidMass - 512) < 1e-10); assert.ok(Math.abs(d.inletFlux - d.outletFlux) < 1e-12);
  assert.ok(d.inletResidual < 1e-12); assert.equal(d.nonFiniteNodes, 0); assert.equal(d.sanitizedNodes, 0);
  for (let cell = 0; cell < 512; cell++) assert.ok(Math.abs(state.ux[cell] - 0.06) < 1e-12);
});
test('solid inlet sites are not overwritten by the velocity boundary', () => {
  const mask = new Uint8Array(512); mask[8 * 32] = 1;
  const state = S.createWindTunnel(32, 16, 0.06, 0.03, { mask }); S.stepLBM(state, 20);
  assert.equal(state.ux[8 * 32], 0); assert.equal(state.uy[8 * 32], 0); assert.ok(Math.abs(moments(state, 8 * 32).rho - 1) < 1e-12);
});
test('non-reset geometry changes immediately impose no-slip and clear stale force samples', () => {
  const state = empty(); S.stepLBM(state, 10); const mask = new Uint8Array(512); mask[100] = 1;
  S.setObstacle(state, mask, false); assert.equal(state.time, 10); assert.equal(state.ux[100], 0); assert.equal(state.forceHistory.length, 0);
});
test('one-sided vorticity and density stencils retain the analytic slope next to solids', () => {
  const state = empty(); state.mask[8 * 32 + 15] = 1;
  for (let j = 0; j < 16; j++) for (let i = 0; i < 32; i++) { const cell = j * 32 + i; state.ux[cell] = 0; state.uy[cell] = 0.005 * i; state.rho[cell] = 1 + 0.001 * i; }
  const f = S.computeFields(state), cell = 8 * 32 + 16;
  assert.ok(Math.abs(f.curl[cell] - 0.005) < 1e-12); assert.ok(Math.abs(f.vorticity[cell] + 0.005) < 1e-12); assert.ok(Math.abs(f.schlieren[cell] - 0.001) < 1e-12);
});
test('invalid step counts reject before changing time', () => {
  const state = empty(); for (const count of [NaN, Infinity, -1, 0.5, '3', 100001]) assert.throws(() => S.stepLBM(state, count), /steps/); assert.equal(state.time, 0);
});
test('stability limit preserves time, repair counters and evidence', () => {
  const state = empty(); S.stepLBM(state, 7); state.unstable = true; state.sanitizedNodes = state.cellCount * 4 + 1;
  assert.throws(() => S.stepLBM(state, 10), /stability limit/); assert.equal(state.time, 8); assert.equal(state.unstable, true); assert.equal(state.stabilityStopped, true);
  assert.throws(() => S.stepLBM(state), /Solver stopped/);
});
test('explicit disturbance amplitude changes the first-step field deterministically', () => {
  const mask = S.generateCylinderMask(3, 40, 24);
  const a = S.createWindTunnel(40, 24, 0.06, 0.03, { mask, perturbation: 0 });
  const b = S.createWindTunnel(40, 24, 0.06, 0.03, { mask, perturbation: 0.005 });
  S.stepLBM(a, 1); S.stepLBM(b, 1); assert.notDeepEqual(a.f, b.f);
});
test('closed NACA pressure contour integrates uniform pressure to zero force', () => {
  const state = S.createWindTunnel(80, 40, 0.06, 0.03, { mask: S.generateNaca4Mask('2412', 30, 8, 80, 40) });
  state.rho.fill(1.01); const profile = S.surfacePressureProfile(state);
  assert.ok(profile.rows.length > 100); assert.ok(Math.abs(profile.clPressure) < 1e-12); assert.ok(Math.abs(profile.cdPressure) < 1e-12);
});
test('surface pressure is explicitly unavailable for a Venturi wall model', () => {
  const state = S.createWindTunnel(40, 24, 0.05, 0.03, { obstacle: 'venturi' }); assert.equal(S.surfacePressureProfile(state).clPressure, null);
});
test('probe validates indices and returns actual physical vorticity', () => {
  const state = empty(); for (const [i,j] of [[-1,0],[32,1],[0,16],[1.5,2]]) assert.throws(() => S.sampleField(state, i, j), /indices/);
  assert.equal(S.sampleField(state, 3, 4).ux, 0.06);
});
test('field CSV is finite, row-major, schema-complete and includes every site', () => {
  const state = empty(); const rows = S.exportFieldCSV(state).trim().split('\n'); assert.equal(rows[0], 'i,j,rho,ux,uy,speed,cp,vorticity,solid'); assert.equal(rows.length, 513);
  for (let index = 1; index < rows.length; index++) { const values = rows[index].split(',').map(Number); assert.equal(values.length, 9); assert.ok(values.every(Number.isFinite)); assert.equal(values[0], (index - 1) % 32); assert.equal(values[1], Math.floor((index - 1) / 32)); }
});
test('all numerical exporters reject nonfinite data instead of serializing null or NaN', () => {
  const state = empty(); state.rho[100] = NaN;
  assert.throws(() => S.exportFieldCSV(state), /nonfinite/); assert.throws(() => S.exportSnapshotJSON(state), /nonfinite/);
  state.rho[100] = 1; state.ux[8 * 32 + 24] = NaN; assert.throws(() => S.exportWakeProfileCSV(state), /nonfinite/);
  state.forceHistory = [{ step: 1, fx: NaN, fy: 0, cd: 0, cl: 0, ld: 0 }]; assert.throws(() => S.exportForceHistoryCSV(state), /nonfinite/);
});
test('checkpoint round trip preserves every population, boundary mode and force sample', () => {
  const {state,snapshot} = checkpoint(); const restored = S.importSnapshotJSON(snapshot);
  assert.deepEqual(restored.f, state.f); assert.equal(restored.time, state.time); assert.equal(restored.wallMode, state.wallMode); assert.deepEqual(restored.forceHistory, state.forceHistory);
  assert.equal(S.verifySnapshotRoundTrip(state).maxPopulationError, 0);
});
test('resumed checkpoint produces the same next 20 steps as the original solver', () => {
  const {state,snapshot} = checkpoint(); const restored = S.importSnapshotJSON(snapshot); S.stepLBM(state,20); S.stepLBM(restored,20);
  assert.deepEqual(restored.f, state.f); assert.deepEqual(restored.forceHistory, state.forceHistory); assert.equal(restored.time, state.time);
});
test('checkpoint rejects truncated populations, illegal boundaries and inconsistent fields', () => {
  for (const mutate of [s => s.populations.pop(), s => {s.populations[0]=NaN;}, s => {s.simulation.wallMode='periodic';}, s => {s.simulation.referenceLength=0;}, s => {s.fields.rho[100]=9;}, s => s.fields.ux.pop(), s => {s.fields.solid[100]=2;}]) {
    const {snapshot}=checkpoint(); mutate(snapshot); assert.throws(() => S.importSnapshotJSON(snapshot), /checkpoint|mask/i);
  }
});
test('checkpoint rejects a non-resumable telemetry-only snapshot', () => {
  const state=empty(); assert.throws(() => S.importSnapshotJSON(S.exportSnapshotJSON(state)), /fields and populations/); assert.throws(() => S.importSnapshotJSON('{}'), /schema/);
});
test('scenario definitions are independent and solve without repairs at their showcase step counts', () => {
  const scenarios=S.listScenarios(); assert.equal(scenarios.length,4);
  for (const scenario of scenarios) {
    const state=S.createWindTunnel(110,46,scenario.u0,scenario.viscosity,{obstacle:scenario.obstacle,chordPx:scenario.chordPx/2,angleDeg:scenario.angleDeg,code:scenario.code});
    S.stepLBM(state,scenario.warmupSteps); const d=S.computeDiagnostics(state); assert.equal(d.nonFiniteNodes,0,scenario.id); assert.equal(d.unstable,false,scenario.id);
  }
  scenarios[0].u0=99; assert.notEqual(S.getScenario('symmetric').u0,99); for(const id of ['missing','__proto__','constructor','toString']) assert.throws(() => S.getScenario(id),/Unknown/);
});

test('bluff body width and height match its actual raster exactly', () => {
  const mask = S.generateBluffBodyMask(80, 40, 12, 20);
  assert.equal(mask.solidCount, 240); assert.equal(mask.bounds.xMax - mask.bounds.xMin + 1, 12); assert.equal(mask.projectedHeight, 20);
});
