/*
 * SpectralFlow audit-test.js
 * Wave 3 self-adversarial audit coverage: SHA-256 checkpoint integrity,
 * conservation laws, fail-closed clamps, NACA invariants, obstacle symmetry,
 * Strouhal edge cases, export schemas, WCAG 2.1.4 shortcut toggle and
 * source hygiene. Zero dependencies: node:test + node:assert/strict + the
 * deterministic DOM adapter, like the rest of the suite.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./cfd.js');
const { boot } = require('./dom-harness.js');

const HERE = __dirname;
const NX = 220;
const NY = 92;

function tunnel(kind, options) {
  const o = Object.assign({ nx: NX, ny: NY }, options || {});
  const mask = S.generateObstacleMask(kind, o);
  return S.createWindTunnel(o.nx, o.ny, o.u0 || 0.08, o.viscosity || 0.02, { mask });
}
function checkpoint() {
  const state = S.createWindTunnel(40, 24, 0.06, 0.03, { obstacle: 'cylinder' });
  S.stepLBM(state, 20);
  return { state, snapshot: JSON.parse(S.exportSnapshotJSON(state, { includePopulations: true })) };
}
function moments(state, cell) {
  let rho = 0, mx = 0, my = 0;
  for (let q = 0; q < 9; q++) { const f = state.f[cell * 9 + q]; rho += f; mx += S.CX[q] * f; my += S.CY[q] * f; }
  return { rho, ux: mx / rho, uy: my / rho };
}

/* ---------------- SHA-256 primitive ---------------- */

test('sha256Hex matches the published vectors', () => {
  assert.equal(S.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(S.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(S.sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('sha256Hex agrees with the platform digest on long and non-ASCII input', () => {
  for (const s of ['a'.repeat(64), 'x'.repeat(1000), 'héllo wörld', JSON.stringify({ a: [1, 2, 3], b: null }), 'spectralflow-üñïçødé-①②③']) {
    assert.equal(S.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), `input ${s.slice(0, 24)}`);
  }
});

/* ---------------- Checkpoint integrity ---------------- */

test('checkpoint exports carry a well-formed full-snapshot SHA-256 digest', () => {
  const { snapshot } = checkpoint();
  assert.ok(snapshot.integrity, 'integrity block present');
  assert.equal(snapshot.integrity.algorithm, 'SHA-256');
  assert.equal(snapshot.integrity.scope, 'full-snapshot');
  assert.match(snapshot.integrity.digest, /^[0-9a-f]{64}$/);
});

test('telemetry-only exports are signed too', () => {
  const state = tunnel('cylinder');
  const snapshot = JSON.parse(S.exportSnapshotJSON(state, { includeFields: false }));
  assert.match(snapshot.integrity.digest, /^[0-9a-f]{64}$/);
});

test('checkpoint export is byte deterministic including its digest', () => {
  const state = tunnel('2412');
  S.stepLBM(state, 40);
  assert.equal(S.exportSnapshotJSON(state, { includePopulations: true }),
    S.exportSnapshotJSON(state, { includePopulations: true }));
});

test('a valid signed checkpoint imports and re-exports with a fresh valid digest', () => {
  const { snapshot } = checkpoint();
  const restored = S.importSnapshotJSON(snapshot);
  S.stepLBM(restored, 5);
  const again = JSON.parse(S.exportSnapshotJSON(restored, { includePopulations: true }));
  assert.notEqual(again.integrity.digest, '0'.repeat(64));
  assert.ok(S.importSnapshotJSON(again));
});

test('editing one population inside its legal range trips the digest', () => {
  const { snapshot } = checkpoint();
  snapshot.populations[100] = Math.min(8, Math.max(-0.5, snapshot.populations[100] + 0.01));
  assert.throws(() => S.importSnapshotJSON(snapshot), /integrity/);
});

test('an in-range simulation parameter edit is no longer accepted silently', () => {
  const { snapshot } = checkpoint();
  snapshot.simulation.u0 = 0.07; // legal range, forged payload
  assert.throws(() => S.importSnapshotJSON(snapshot), /integrity/);
});

test('editing trusted diagnostics, force history or wake samples trips the digest', () => {
  for (const mutate of [
    s => { s.diagnostics.fx += 0.001; },
    s => { s.forceHistory[0].cl += 0.01; },
    s => { s.wakeProfile.samples[3].ux = 0.123; },
    s => { s.centerlineProfile[2].cp = 0.5; }
  ]) {
    const { snapshot } = checkpoint();
    mutate(snapshot);
    assert.throws(() => S.importSnapshotJSON(snapshot), /integrity/);
  }
});

test('forged and malformed digest values are rejected', () => {
  const { snapshot } = checkpoint();
  snapshot.integrity.digest = '0'.repeat(64);
  assert.throws(() => S.importSnapshotJSON(snapshot), /integrity/);
  const { snapshot: upper } = checkpoint();
  upper.integrity.digest = upper.integrity.digest.toUpperCase();
  assert.throws(() => S.importSnapshotJSON(upper), /integrity/);
  const { snapshot: short } = checkpoint();
  short.integrity.digest = 'abcd';
  assert.throws(() => S.importSnapshotJSON(short), /integrity/);
  const { snapshot: scoped } = checkpoint();
  scoped.integrity.scope = 'populations';
  assert.throws(() => S.importSnapshotJSON(scoped), /integrity/);
});

test('a legacy checkpoint without an integrity block still validates and imports', () => {
  const { state, snapshot } = checkpoint();
  delete snapshot.integrity;
  const restored = S.importSnapshotJSON(snapshot);
  assert.equal(restored.time, state.time);
  assert.deepEqual(restored.f, state.f);
});

test('a non-array forceHistory field is rejected instead of silently dropped', () => {
  const { snapshot } = checkpoint();
  delete snapshot.integrity;
  snapshot.forceHistory = 'corrupt';
  assert.throws(() => S.importSnapshotJSON(snapshot), /force history/);
});

/* ---------------- Conservation laws ---------------- */

test('refreshMacroscopic recovers rho, ux and uy from injected equilibrium populations', () => {
  const state = tunnel('cylinder', { u0: 0.06 });
  const cell = 40 * NX + 100;
  const target = { rho: 1.12, ux: 0.05, uy: -0.023 };
  S.equilibriumArray(target.rho, target.ux, target.uy).forEach((v, q) => { state.f[cell * 9 + q] = v; });
  S.refreshMacroscopic(state, true);
  assert.ok(Math.abs(state.rho[cell] - target.rho) < 1e-12);
  assert.ok(Math.abs(state.ux[cell] - target.ux) < 1e-12);
  assert.ok(Math.abs(state.uy[cell] - target.uy) < 1e-12);
});

test('BGK collision conserves mass and both momentum components per cell', () => {
  const state = S.createWindTunnel(48, 32, 0.06, 0.03, { mask: new Uint8Array(48 * 32), perturbation: 0 });
  const cell = 17 * 48 + 23;
  S.equilibriumArray(1.08, 0.045, -0.018).forEach((v, q) => { state.f[cell * 9 + q] = v; });
  S.refreshMacroscopic(state, true);
  const before = moments(state, cell);
  S.collide(state);
  let rho = 0, mx = 0, my = 0;
  for (let q = 0; q < 9; q++) { const f = state.fStar[cell * 9 + q]; rho += f; mx += S.CX[q] * f; my += S.CY[q] * f; }
  assert.ok(Math.abs(rho - before.rho) < 1e-12, `mass ${before.rho} -> ${rho}`);
  assert.ok(Math.abs(mx - before.rho * before.ux) < 1e-12, `px`);
  assert.ok(Math.abs(my - before.rho * before.uy) < 1e-12, `py`);
});

test('pull streaming applies the exact stencil on every in-domain link', () => {
  const mask = S.generateNaca4Mask('2412', 60, 4, NX, NY);
  const state = S.createWindTunnel(NX, NY, 0.07, 0.024, { mask });
  S.stepLBM(state, 60);
  S.refreshMacroscopic(state, true);
  S.collide(state);
  const fs = state.fStar.slice();
  S.stream(state);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const cell = j * NX + i;
      if (state.mask[cell] === 1) continue;
      for (let q = 0; q < 9; q++) {
        const si = i - S.CX[q], sj = j - S.CY[q];
        if (si < 0 || si >= NX || sj < 0 || sj >= NY) continue; // patched links
        const src = sj * NX + si;
        if (state.mask[src] === 1) {
          assert.equal(state.f[cell * 9 + q], fs[cell * 9 + S.OPP[q]], `bounce ${i},${j} q${q}`);
        } else {
          assert.equal(state.f[cell * 9 + q], fs[src * 9 + q], `pull ${i},${j} q${q}`);
        }
      }
    }
  }
});

test('bounce-back top and bottom walls keep channel mass bounded over 400 steps', () => {
  const state = S.createWindTunnel(160, 60, 0.08, 0.02, { mask: new Uint8Array(160 * 60), perturbation: 0 });
  const m0 = state.initialFluidMass;
  S.stepLBM(state, 400);
  const d = S.computeDiagnostics(state);
  assert.ok(Math.abs(d.fluidMass - m0) / m0 < 0.02, `mass ${d.fluidMass} vs ${m0}`);
  assert.ok(Math.abs(d.fluxImbalanceFraction) < 0.05, `flux imbalance ${d.fluxImbalanceFraction}`);
  assert.equal(d.nonFiniteNodes, 0);
});

test('solid cells hold rest equilibrium populations and zero velocity after stepping', () => {
  const state = tunnel('cylinder');
  S.stepLBM(state, 80);
  for (let cell = 0; cell < state.cellCount; cell++) {
    if (state.mask[cell] !== 1) continue;
    for (let q = 0; q < 9; q++) assert.ok(Math.abs(state.f[cell * 9 + q] - S.W[q]) < 1e-12, `pop ${q} cell ${cell}`);
    assert.equal(state.ux[cell], 0);
    assert.equal(state.uy[cell], 0);
    assert.equal(state.rho[cell], 1);
  }
});

test('wake rake shows a monotone symmetric boundary layer under bounce-back', () => {
  const state = tunnel('cylinder', { u0: 0.08 });
  S.stepLBM(state, 200);
  const wake = S.wakeProfile(state, 0.75);
  const s = wake.samples;
  /* The no-slip plane sits at the wall: the wall-row speed is strongly
     retarded, rises monotonically into the channel and mirrors top to bottom. */
  assert.ok(s[0].ux < 0.25 * state.u0, `wall ux ${s[0].ux} vs u0 ${state.u0}`);
  assert.ok(s[0].ux < s[1].ux && s[1].ux < s[2].ux && s[2].ux < s[3].ux, 'top layer not monotone');
  for (let k = 0; k < 4; k++) {
    assert.ok(Math.abs(s[k].ux - s[NY - 1 - k].ux) < 1e-9, `asymmetry at ${k}`);
  }
});

test('force samples land on step one and every fifth step only', () => {
  const state = tunnel('cylinder');
  S.stepLBM(state, 64);
  for (const e of state.forceHistory) {
    assert.ok(e.step === 1 || e.step % 5 === 0, `sampled at step ${e.step}`);
  }
});

/* ---------------- Fail-closed clamps and stability ---------------- */

test('inflow speed clamps fail closed at both ends including zero and negative', () => {
  for (const [input, expected] of [[0, S.LIMITS.minSpeed], [-1, S.LIMITS.minSpeed], [99, S.LIMITS.maxSpeed]]) {
    const st = S.createWindTunnel(32, 16, input, 0.02, { mask: new Uint8Array(32 * 16) });
    assert.equal(st.u0, expected, `u0 ${input}`);
    assert.equal(st.parametersClamped, true);
  }
  const nan = S.createWindTunnel(32, 16, NaN, 0.02, { mask: new Uint8Array(32 * 16) });
  assert.equal(nan.u0, 0.08);
});

test('viscosity clamps keep tau strictly above one half and omega below two', () => {
  const low = S.createWindTunnel(32, 16, 0.06, 0, { mask: new Uint8Array(32 * 16) });
  assert.equal(low.viscosity, S.LIMITS.minViscosity);
  assert.ok(low.tau > 0.5, `tau ${low.tau}`);
  assert.ok(low.omega < 2 && low.omega > 0);
  const high = S.createWindTunnel(32, 16, 0.06, 99, { mask: new Uint8Array(32 * 16) });
  assert.equal(high.viscosity, S.LIMITS.maxViscosity);
  assert.ok(high.tau <= 3 * S.LIMITS.maxViscosity + 0.5 + 1e-12);
});

test('every reachable UI slider extreme stays inside the stable BGK envelope', () => {
  for (const u0 of [0.01, 0.08, 0.14]) {
    for (const nu of [0.006, 0.05, 0.09]) {
      const st = S.createWindTunnel(32, 16, u0, nu, { mask: new Uint8Array(32 * 16) });
      assert.ok(st.tau > 0.5 && st.omega < 2, `u=${u0} nu=${nu} tau=${st.tau} omega=${st.omega}`);
    }
  }
});

test('a stability-stopped solver refuses more steps until reset', () => {
  const state = S.createWindTunnel(32, 16, 0.06, 0.03, { mask: new Uint8Array(32 * 16), perturbation: 0 });
  S.stepLBM(state, 3);
  state.unstable = true;
  state.sanitizedNodes = state.cellCount * 4 + 1;
  assert.throws(() => S.stepLBM(state, 5), /stability limit/);
  assert.throws(() => S.stepLBM(state, 1), /Solver stopped/);
});

test('stabilityStopped survives the checkpoint round trip', () => {
  const state = S.createWindTunnel(40, 24, 0.06, 0.03, { obstacle: 'cylinder' });
  S.stepLBM(state, 10);
  state.stabilityStopped = true;
  const restored = S.importSnapshotJSON(JSON.parse(S.exportSnapshotJSON(state, { includePopulations: true })));
  assert.equal(restored.stabilityStopped, true);
  assert.throws(() => S.stepLBM(restored, 1), /Solver stopped/);
});

test('final-pass repairs from boundary patches flag the stability limit', () => {
  const state = S.createWindTunnel(32, 16, 0.06, 0.03, { mask: new Uint8Array(32 * 16), perturbation: 0 });
  const budget = Math.max(32, Math.round(state.cellCount * 0.005));
  state.lastSanitizedNodes = budget + 1; // as if the closing refreshMacroscopic repaired this many
  S.stepLBM(state, 1);
  // One in-step repair would not stop the run, but a flooded final pass must flag it.
  if (state.lastSanitizedNodes > budget) assert.equal(state.stabilityStopped, true);
  else assert.equal(state.stabilityStopped, false);
});

/* ---------------- NACA invariants ---------------- */

test('cambered sections keep the upper ordinate above the lower at every station', () => {
  const c = S.naca4Coordinates('2412', 160);
  for (let k = 0; k < c.upper.length; k++) {
    assert.ok(c.upper[k].y >= c.lower[k].y - 1e-12, `station ${k}`);
  }
  assert.ok(Math.abs(c.upper[0].y - c.lower[0].y) < 1e-12, 'leading edge closed');
  assert.ok(Math.abs(c.upper[c.upper.length - 1].y - c.lower[c.lower.length - 1].y) < 1e-12, 'trailing edge closed');
});

test('camber line x stations are strictly increasing across the chord', () => {
  const c = S.naca4Coordinates('4415', 200);
  for (let k = 1; k < c.camberLine.length; k++) {
    assert.ok(c.camberLine[k].x > c.camberLine[k - 1].x, `station ${k}`);
  }
  assert.ok(Math.abs(c.camberLine[0].x) < 1e-12);
  assert.ok(Math.abs(c.camberLine[c.camberLine.length - 1].x - 1) < 1e-12);
});

test('camber slope is continuous through the maximum camber station', () => {
  const m = 0.05, p = 0.3;
  const eps = 1e-7;
  const left = S.naca4CamberSlope(p - eps, m, p);
  const right = S.naca4CamberSlope(p + eps, m, p);
  assert.ok(Math.abs(left - right) < 1e-4, `slope jump ${left} vs ${right}`);
  assert.ok(Math.abs(S.naca4CamberSlope(p, m, p)) < 1e-9);
});

test('half thickness is nonnegative on the closed interval and zero at both ends', () => {
  for (const t of [0.06, 0.12, 0.18, 0.25]) {
    for (let k = 0; k <= 200; k++) {
      const x = k / 200;
      assert.ok(S.naca4Thickness(x, t) >= -1e-12, `t=${t} x=${x}`);
    }
    assert.ok(Math.abs(S.naca4Thickness(0, t)) < 1e-12);
    assert.ok(Math.abs(S.naca4Thickness(1, t)) < 1e-9);
  }
});

test('maximum thickness equals the section ratio near 30 percent chord for several codes', () => {
  for (const [code, t] of [['0006', 0.06], ['0012', 0.12], ['0021', 0.21]]) {
    const c = S.naca4Coordinates(code, 500);
    assert.ok(Math.abs(2 * c.maxThickness - t) < 0.002, `${code}: ${2 * c.maxThickness}`);
  }
});

test('coordinate sampling requests clamp into the documented budget', () => {
  assert.equal(S.naca4Coordinates('0012', 2).samples, 8);
  assert.equal(S.naca4Coordinates('0012', 50000).samples, 4096);
  assert.equal(S.naca4Coordinates('0012', NaN).samples, 120);
});

test('the raster polygon is closed, free of duplicate neighbors and anchored at the leading edge', () => {
  const c = S.naca4Coordinates('2412', 120);
  const poly = S.polygonFromCoordinates(c);
  for (let k = 1; k < poly.length; k++) {
    const a = poly[k - 1], b = poly[k];
    assert.ok(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1e-12, `duplicate at ${k}`);
  }
  assert.ok(Math.abs(poly[0].x) < 1e-9 && Math.abs(poly[0].y) < 1e-9);
});

test('the quarter-chord pivot region is inside the raster for positive incidence', () => {
  const nx = 200, ny = 90;
  const m = S.generateNaca4Mask('2412', 64, 8, nx, ny);
  const i = Math.floor(0.32 * nx), j = Math.floor(0.5 * ny);
  assert.equal(m[j * nx + i], 1, 'pivot cell should be solid');
  assert.ok(m.bounds.xMin <= i && m.bounds.xMax >= i);
});

test('airfoil metadata carries continuous coordinates and a rotated polygon', () => {
  const m = S.generateNaca4Mask('4415', 70, 6, 200, 90);
  assert.ok(m.coordinates.upper.length > 160);
  assert.ok(m.polygon.length > 160);
  assert.equal(m.forceReferenceLength, 70);
  assert.equal(m.coefficientConvention, 'chord times unit span');
});

/* ---------------- Obstacle symmetry and families ---------------- */

test('Venturi walls are mirror symmetric about the channel centerline', () => {
  for (const ny of [92, 24, 8]) {
    const m = S.generateVenturiMask(160, ny, 0.5, 0.18);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < 160; i++) {
        assert.equal(m[j * 160 + i], m[(ny - 1 - j) * 160 + i], `ny=${ny} cell ${i},${j}`);
      }
    }
  }
});

test('the Venturi throat column constricts more than the inlet reservoir column', () => {
  const m = S.generateVenturiMask(160, 60, 0.5, 0.18);
  const countAt = i => { let n = 0; for (let j = 0; j < 60; j++) n += m[j * 160 + i]; return n; };
  assert.ok(countAt(Math.round(160 * 0.46)) > countAt(6));
});

test('cylinder masks are mirror symmetric about the horizontal centerline', () => {
  for (const ny of [90, 91]) {
    const m = S.generateCylinderMask(8, 160, ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < 160; i++) {
      assert.equal(m[j * 160 + i], m[(ny - 1 - j) * 160 + i], `ny=${ny} ${i},${j}`);
    }
  }
});

test('bluff body raster stays vertically centered in the tunnel', () => {
  const m = S.generateBluffBodyMask(160, 80, 12, 20);
  assert.ok(Math.abs((m.bounds.yMin + m.bounds.yMax) - 79) <= 1);
});

test('grid and memory budgets fail closed at the documented edges', () => {
  assert.throws(() => S.createWindTunnel(7, 16, 0.06, 0.03), /between 8 and 4096/);
  assert.throws(() => S.createWindTunnel(4097, 16, 0.06, 0.03), /between 8 and 4096/);
  assert.ok(S.createWindTunnel(512, 512, 0.06, 0.03, { mask: new Uint8Array(512 * 512) }));
  assert.throws(() => S.createWindTunnel(513, 512, 0.06, 0.03), /memory budget/);
});

test('generateObstacleMask defaults to a 240 by 100 tunnel', () => {
  const m = S.generateObstacleMask('cylinder', {});
  assert.equal(m.length, 240 * 100);
  assert.equal(m.nx, 240);
  assert.equal(m.ny, 100);
});

/* ---------------- Strouhal estimator ---------------- */

test('Strouhal reports estimating below sixty history samples', () => {
  const state = tunnel('cylinder');
  S.stepLBM(state, 40); // 9 samples
  const st = S.computeStrouhal(state);
  assert.equal(st.available, false);
  assert.equal(st.reason, 'estimating');
});

test('flat and near-flat lift never produces a frequency', () => {
  const state = S.createWindTunnel(60, 30, 0.1, 0.02, { mask: new Uint8Array(60 * 30) });
  for (let k = 1; k <= 200; k++) state.forceHistory.push({ step: k * 5, fx: 0, fy: 0, cd: 0.4, cl: 0.3 + 0.001 * (k % 3), ld: 0 });
  const st = S.computeStrouhal(state);
  assert.equal(st.available, false);
  assert.equal(st.reason, 'no periodic shedding detected');
});

test('runaway amplitude reports a transient instead of a number', () => {
  const state = S.createWindTunnel(60, 30, 0.1, 0.02, { mask: new Uint8Array(60 * 30) });
  for (let k = 1; k <= 200; k++) state.forceHistory.push({ step: k * 5, fx: 0, fy: 0, cd: 0, cl: 6 * Math.sin(k), ld: 0 });
  const st = S.computeStrouhal(state);
  assert.equal(st.available, false);
  assert.match(st.reason, /transient/);
});

test('an irregular signal is refused rather than assigned a bogus period', () => {
  const state = S.createWindTunnel(60, 30, 0.1, 0.02, { mask: new Uint8Array(60 * 30) });
  let seed = 9;
  for (let k = 1; k <= 200; k++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    state.forceHistory.push({ step: k * 5, fx: 0, fy: 0, cd: 0, cl: (seed / 2147483648 - 0.5) * 0.6, ld: 0 });
  }
  const st = S.computeStrouhal(state);
  assert.equal(st.available, false);
  assert.ok(st.reason.length > 0);
});

test('a locked estimate reports cycles, frequency and a cylinder-referenced St', () => {
  const state = S.createWindTunnel(60, 30, 0.1, 0.02, { mask: S.generateCylinderMask(4, 60, 30) });
  /* Pick the period so the synthetic St lands mid range, St = f D / U = 0.25. */
  const period = Math.round(state.referenceHeight / (0.25 * state.u0) / 5) * 5;
  for (let step = 1; step <= 12 * period; step += 5) {
    state.forceHistory.push({ step, fx: 0, fy: 0, cd: 0, cl: 0.25 + 0.15 * Math.sin(2 * Math.PI * step / period), ld: 0 });
  }
  const st = S.computeStrouhal(state);
  assert.equal(st.available, true, st.reason);
  assert.ok(st.cycles >= 3);
  assert.ok(Math.abs(st.frequency - 1 / period) < 1e-3);
  assert.ok(Math.abs(st.strouhal - 0.25) < 0.02);
});

/* ---------------- Export schemas ---------------- */

test('wake CSV rows are all numeric and cover every transverse row', () => {
  const state = tunnel('venturi');
  S.stepLBM(state, 60);
  const rows = S.exportWakeProfileCSV(state).trim().split('\n');
  assert.equal(rows.length, NY + 1);
  for (let k = 1; k < rows.length; k++) {
    const cols = rows[k].split(',');
    assert.equal(cols.length, 8);
    for (const c of cols) assert.ok(Number.isFinite(Number(c)), `row ${k} value ${c}`);
  }
});

test('field CSV vorticity column is the negative of the screen-space curl', () => {
  const state = tunnel('cylinder');
  S.stepLBM(state, 30);
  const fields = S.computeFields(state);
  const rows = S.exportFieldCSV(state).trim().split('\n');
  const cols = rows[1].split(',').map(Number);
  assert.ok(Math.abs(cols[7] - (-fields.curl[0])) < 1e-12);
});

test('csvEscape handles carriage returns, unicode and empty values', () => {
  assert.equal(S.csvEscape(''), '');
  assert.equal(S.csvEscape('a\rb'), '"a\rb"');
  assert.equal(S.csvEscape('café'), 'café');
});

test('snapshot JSON carries every required top level section', () => {
  const state = tunnel('2412');
  S.stepLBM(state, 30);
  const snap = JSON.parse(S.exportSnapshotJSON(state, { includePopulations: true }));
  for (const key of ['format', 'version', 'schemaVersion', 'generatedBy', 'simulation',
    'diagnostics', 'wakeProfile', 'centerlineProfile', 'forceHistory', 'fields', 'populations', 'integrity']) {
    assert.ok(key in snap, `missing ${key}`);
  }
  assert.equal(snap.format, 'spectralflow-snapshot');
  assert.equal(snap.schemaVersion, 2);
});

test('checkpoint populations round-trip bit exactly through JSON text', () => {
  const { state, snapshot } = checkpoint();
  const restored = S.importSnapshotJSON(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.f, state.f);
  assert.equal(S.verifySnapshotRoundTrip(state).maxPopulationError, 0);
});

test('imported checkpoints keep inlet velocity pinned after resume', () => {
  const { snapshot } = checkpoint();
  const restored = S.importSnapshotJSON(snapshot);
  S.stepLBM(restored, 40);
  for (let j = 1; j < restored.ny - 1; j++) {
    assert.ok(Math.abs(restored.ux[j * restored.nx] - restored.u0) < 1e-6, `inlet row ${j}`);
  }
});

/* ---------------- Pass 2 adversarial regressions ---------------- */

test('an off-grid cylinder center fails closed instead of forging phantom geometry', () => {
  /* Wave 3 delegate defect: centerX outside the tunnel silently produced an
     empty mask that still claimed a 2r projected height and reference length. */
  assert.throws(() => S.generateCylinderMask(6, 160, 80, -100, 40), /no solid cells/);
  assert.throws(() => S.generateCylinderMask(6, 160, 80, 500, 40), /no solid cells/);
  /* Partly clipped cylinders still rasterize; fully inside remains fine. */
  assert.ok(S.generateCylinderMask(8, 160, 80, 4, 40).bounds.count > 0);
  assert.ok(S.generateCylinderMask(8, 160, 80).bounds.count > 0);
  /* The other generators cannot produce empty masks at all. */
  assert.ok(S.generateBluffBodyMask(160, 80).bounds.count > 0);
  assert.ok(S.generateVenturiMask(160, 80).bounds.count > 0);
});

test('checkpoint claiming NACA geometry over a foreign raster is refused', () => {
  /* Wave 3 delegate defect: the importer regenerated NACA metadata onto the
     solid field without checking the raster matched, so a forged checkpoint
     could fabricate surface pressure along a phantom contour. */
  const state = S.createWindTunnel(60, 32, 0.06, 0.03, { obstacle: 'cylinder' });
  S.stepLBM(state, 10);
  const snap = JSON.parse(S.exportSnapshotJSON(state, { includePopulations: true }));
  delete snap.integrity;
  snap.simulation.obstacle.kind = 'naca4';
  snap.simulation.obstacle.code = '2412';
  snap.simulation.obstacle.chordPx = 20;
  snap.simulation.obstacle.angleDeg = 0;
  snap.simulation.obstacle.shape = 'NACA 2412';
  assert.throws(() => S.importSnapshotJSON(snap), /obstacle|NACA/i);
  /* The matching honest checkpoint still imports. */
  const naca = S.createWindTunnel(60, 32, 0.06, 0.03, { mask: S.generateNaca4Mask('2412', 20, 0, 60, 32) });
  S.stepLBM(naca, 10);
  const good = JSON.parse(S.exportSnapshotJSON(naca, { includePopulations: true }));
  assert.ok(S.importSnapshotJSON(good).mask.length === 60 * 32);
});

test('denormal reference lengths cannot reach the coefficient denominator', () => {
  /* Wave 3 delegate defect: coefficientReference = 5e-324 underflowed
     q = 0.5*rho0*u0^2*D to zero, producing Infinity coefficients that hung the
     chart tick generator. Both the file and API paths now floor the value. */
  const state = S.createWindTunnel(60, 32, 0.06, 0.03, { obstacle: 'cylinder' });
  S.stepLBM(state, 10);
  const snap = JSON.parse(S.exportSnapshotJSON(state, { includePopulations: true }));
  delete snap.integrity;
  snap.simulation.coefficientReference = 5e-324;
  assert.throws(() => S.importSnapshotJSON(snap), /reference lengths/);
  snap.simulation.coefficientReference = 1e-300;
  assert.throws(() => S.importSnapshotJSON(snap), /reference lengths/);
  snap.simulation.coefficientReference = 0.2;
  snap.simulation.referenceLength = 0.2;
  assert.throws(() => S.importSnapshotJSON(snap), /reference lengths/);
  /* API path: a denormal custom force reference falls back to the default. */
  const mask = S.generateCylinderMask(8, 60, 32);
  mask.forceReferenceLength = 5e-324;
  const api = S.createWindTunnel(60, 32, 0.06, 0.03, { mask });
  assert.ok(api.referenceHeight >= 0.5, `referenceHeight ${api.referenceHeight}`);
  S.stepLBM(api, 20);
  for (const e of api.forceHistory) {
    assert.ok(Number.isFinite(e.cd) && Number.isFinite(e.cl) && Number.isFinite(e.ld));
  }
});

test('checkpoint stability bookkeeping requires honest types and bounds', () => {
  /* Wave 3 delegate defect: unstable:"yes" and sanitizedNodes:1e6 imported
     freely, then the very first resumed step latched stabilityStopped. */
  const state = S.createWindTunnel(40, 24, 0.06, 0.03, { obstacle: 'cylinder' });
  S.stepLBM(state, 10);
  const snap = JSON.parse(S.exportSnapshotJSON(state, { includePopulations: true }));
  delete snap.integrity;
  for (const [key, bad] of [['unstable', 'yes'], ['stabilityStopped', 'no']]) {
    const forged = JSON.parse(JSON.stringify(snap));
    forged.simulation[key] = bad;
    assert.throws(() => S.importSnapshotJSON(forged), /flag/, `${key}=${bad}`);
  }
  for (const bad of [-1, 1.5, state.cellCount * 9]) {
    const forged = JSON.parse(JSON.stringify(snap));
    forged.simulation.sanitizedNodes = bad;
    assert.throws(() => S.importSnapshotJSON(forged), /repair count/, `sanitizedNodes=${bad}`);
  }
  snap.simulation.unstable = true;
  snap.simulation.sanitizedNodes = 10;
  assert.equal(S.importSnapshotJSON(snap).unstable, true);
});

test('exporters refuse nonfinite force history instead of emitting JSON nulls', () => {
  /* Wave 3 delegate defect: telemetry sections were serialized unchecked, so
     a corrupt history produced an un-importable checkpoint full of nulls. */
  const state = S.createWindTunnel(40, 24, 0.06, 0.03, { obstacle: 'cylinder' });
  S.stepLBM(state, 10);
  state.forceHistory.push({ step: state.time, fx: 0, fy: 0, cd: Infinity, cl: 0, ld: 0 });
  assert.throws(() => S.exportSnapshotJSON(state, { includePopulations: true }), /nonfinite force history/);
});

test('sha256Hex encodes lone surrogates as U+FFFD like standard UTF-8', () => {
  /* Wave 3 delegate defect: the hand-rolled encoder emitted invalid 3-byte
     sequences for unpaired surrogates instead of the replacement character. */
  for (const s of ['a\ud800b', 'a\udc00b', '\udfff', 'x\ud800\udc00y']) {
    assert.equal(S.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s));
  }
});

/* ---------------- WCAG 2.1.4 shortcut toggle and focus guards ---------------- */

test('the probe keys toggle exists, defaults on and documents its shortcuts', () => {
  const h = boot(HERE);
  const btn = h.get('keysToggle');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.match(h.get('probeHelp').textContent, /Arrow keys move the probe/);
  assert.match(h.get('flowCanvas').getAttribute('aria-keyshortcuts'), /ArrowLeft/);
  h.dispose();
});

test('switching probe keys off stops canvas key navigation but not pointer probing', () => {
  const h = boot(HERE);
  const canvas = h.get('flowCanvas');
  h.get('keysToggle').click();
  assert.equal(h.get('keysToggle').getAttribute('aria-pressed'), 'false');
  assert.match(h.get('probeHelp').textContent, /keyboard navigation is off/);
  const before = h.get('probeReadout').textContent;
  h.key(canvas, 'ArrowRight');
  h.key(canvas, 'End');
  assert.equal(h.get('probeReadout').textContent, before, 'probe moved while keys disabled');
  h.event(canvas, 'pointermove', { clientX: 300, clientY: 120 });
  assert.match(h.get('probeReadout').textContent, /i=\d+, j=\d+/);
  h.dispose();
});

test('turning probe keys back on restores keyboard navigation', () => {
  const h = boot(HERE);
  const canvas = h.get('flowCanvas');
  h.get('keysToggle').click();
  h.get('keysToggle').click();
  assert.equal(h.get('keysToggle').getAttribute('aria-pressed'), 'true');
  h.key(canvas, 'Home');
  assert.match(h.get('probeReadout').textContent, /i=0/);
  h.dispose();
});

test('the Pin probe button still works while probe keys are off', () => {
  const h = boot(HERE);
  h.get('keysToggle').click();
  h.get('pinProbe').click();
  assert.equal(h.get('pinProbe').getAttribute('aria-pressed'), 'true');
  h.dispose();
});

test('a stored off preference starts the app with probe keys disabled', () => {
  const h = boot(HERE, {
    beforeBoot: ({ sandbox }) => {
      const get = sandbox.localStorage.getItem;
      sandbox.localStorage.getItem = key => (key === 'spectralflow-keys' ? 'off' : get(key));
    }
  });
  assert.equal(h.get('keysToggle').getAttribute('aria-pressed'), 'false');
  const canvas = h.get('flowCanvas');
  const before = h.get('probeReadout').textContent;
  h.key(canvas, 'ArrowRight');
  assert.equal(h.get('probeReadout').textContent, before);
  h.dispose();
});

test('probe keys off survives blocked storage without breaking startup', () => {
  const h = boot(HERE, { storageBlocked: true });
  assert.equal(h.get('keysToggle').getAttribute('aria-pressed'), 'true');
  h.get('keysToggle').click();
  assert.equal(h.get('keysToggle').getAttribute('aria-pressed'), 'false');
  h.dispose();
});

test('keydowns fired on unrelated elements cannot move the canvas probe', () => {
  const h = boot(HERE);
  const before = h.get('probeReadout').textContent;
  h.key(h.document.body, 'ArrowRight');
  assert.equal(h.get('probeReadout').textContent, before);
  h.dispose();
});

/* ---------------- Source hygiene and security fences ---------------- */

test('a strict CSP meta is present with hashed inline script and closed network', () => {
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  const meta = /Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(meta, 'CSP meta missing');
  const csp = meta[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  /* frame-ancestors only works as an HTTP header; in a meta it is ignored and
     logs a console error, so it must not be present. */
  assert.doesNotMatch(csp, /frame-ancestors/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
});

test('markup carries no inline event handler attributes', () => {
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('application sources contain no HTML or code injection sinks', () => {
  const js = ['app.js', 'cfd.js', 'spectral-lab.js', 'spectral-app.js']
    .map(f => fs.readFileSync(path.join(HERE, f), 'utf8')).join('');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/);
});

test('only local assets load: no external network references in shipped sources', () => {
  for (const file of ['index.html', 'app.js', 'cfd.js', 'spectral-lab.js', 'spectral-app.js', 'style.css']) {
    const text = fs.readFileSync(path.join(HERE, file), 'utf8');
    const refs = text.match(/https?:\/\/[^\s'"<>)]+/g) || [];
    const external = refs.filter(u => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(external, [], `${file} references ${external.join(', ')}`);
  }
});

test('no console logging or debugger statements remain in shipped scripts', () => {
  const js = ['app.js', 'cfd.js', 'spectral-lab.js', 'spectral-app.js']
    .map(f => fs.readFileSync(path.join(HERE, f), 'utf8')).join('');
  assert.doesNotMatch(js, /console\.(log|debug|info)|debugger/);
});

test('hygiene fence covers the stylesheet and harness too', () => {
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
  const harness = fs.readFileSync(path.join(HERE, 'dom-harness.js'), 'utf8');
  assert.doesNotMatch(css + harness, /[\u2014\u2013]/);
  assert.doesNotMatch(css, /scroll-behavior\s*:\s*smooth/);
});

/* ---------------- NaN canvas and recovery ---------------- */

test('a forced NaN population is repaired before it can reach the canvas field', () => {
  const state = tunnel('cylinder');
  state.f[100 * NX + 60] = NaN;
  S.stepLBM(state, 1);
  const d = S.computeDiagnostics(state);
  assert.equal(d.nonFiniteNodes, 0);
  assert.ok(state.sanitizedNodes >= 1);
  assert.ok(d.fields.speed.every(Number.isFinite));
  assert.ok(d.fields.cp.every(Number.isFinite));
});

test('field values used for color mapping stay finite across all five views', () => {
  const state = tunnel('bluff', { u0: 0.09 });
  S.stepLBM(state, 120);
  const d = S.computeDiagnostics(state);
  for (const key of ['speed', 'curl', 'vorticity', 'cp', 'schlieren']) {
    assert.ok(d.fields[key].every(Number.isFinite), `${key} nonfinite`);
  }
});

test('diagnostics stay finite when the solver state is freshly built', () => {
  const state = tunnel('2412');
  const d = S.computeDiagnostics(state);
  assert.ok(Number.isFinite(d.fluxImbalanceFraction));
  assert.ok(Number.isFinite(d.massChangeFraction));
  assert.ok(Number.isFinite(d.maxMach));
  assert.equal(d.nonFiniteNodes, 0);
});
