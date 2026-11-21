/*
 * SpectralFlow revamp-test.js
 * Targeted physics, stability, Strouhal and UI-hygiene regressions for the
 * Wave 1 adversarial critique. Zero dependencies, like the rest of the suite.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./cfd.js');
const { boot } = require('./dom-harness.js');

const HERE = __dirname;
const NX = 220;
const NY = 92;

/* ---------------- D2Q9 mass and equilibrium conservation ---------------- */

test('D2Q9 equilibrium conserves mass and momentum exactly', () => {
  const rho = 1.07, ux = 0.06, uy = -0.03;
  const f = S.equilibriumArray(rho, ux, uy);
  let mass = 0, px = 0, py = 0;
  for (let i = 0; i < S.Q9; i++) {
    mass += f[i];
    px += S.CX[i] * f[i];
    py += S.CY[i] * f[i];
  }
  assert.ok(Math.abs(mass - rho) < 1e-12, `equilibrium mass ${mass}`);
  assert.ok(Math.abs(px - rho * ux) < 1e-12, `equilibrium px ${px}`);
  assert.ok(Math.abs(py - rho * uy) < 1e-12, `equilibrium py ${py}`);
});

test('BGK collision conserves total mass exactly on every cell', () => {
  const nx = 48, ny = 32;
  const state = S.createWindTunnel(nx, ny, 0.05, 0.02, { mask: new Uint8Array(nx * ny), perturbation: 0 });
  for (let step = 0; step < 100; step++) {
    S.refreshMacroscopic(state, false, false);
    const before = Array.prototype.reduce.call(state.f, (a, b) => a + b, 0);
    S.collide(state);
    const after = Array.prototype.reduce.call(state.fStar, (a, b) => a + b, 0);
    assert.ok(Math.abs(after - before) < 1e-9, `step ${step}: collision mass ${before} -> ${after}`);
  }
});

test('open-tunnel mass drift stays bounded over 500 steps', () => {
  const mask = S.generateNaca4Mask('2412', 60, 4, NX, NY);
  const state = S.createWindTunnel(NX, NY, 0.07, 0.024, { mask });
  S.stepLBM(state, 500);
  const d = S.computeDiagnostics(state);
  assert.ok(Number.isFinite(d.massChangeFraction));
  assert.ok(Math.abs(d.massChangeFraction) < 0.02, `mass change ${d.massChangeFraction}`);
});

/* ---------------- NACA sign and geometry invariants ---------------- */

test('NACA 0012 at zero incidence has near-zero mean lift', () => {
  const mask = S.generateNaca4Mask('0012', 77, 0, NX, NY);
  const state = S.createWindTunnel(NX, NY, 0.07, 0.024, { mask });
  S.stepLBM(state, 600);
  const d = S.computeDiagnostics(state);
  assert.ok(Math.abs(d.meanCl) < 0.02, `symmetric Cl ${d.meanCl}`);
});

test('cambered NACA 2412 at positive incidence produces positive lift', () => {
  const mask = S.generateNaca4Mask('2412', 77, 6, NX, NY);
  const state = S.createWindTunnel(NX, NY, 0.07, 0.024, { mask });
  S.stepLBM(state, 600);
  const d = S.computeDiagnostics(state);
  assert.ok(d.meanCl > 0.3, `cambered Cl ${d.meanCl}`);
});

test('NACA closed trailing edge is exactly closed for the standard series', () => {
  for (const code of ['0012', '2412', '4415']) {
    const coords = S.naca4Coordinates(code, 200);
    const upper = coords.upper[coords.upper.length - 1];
    const lower = coords.lower[coords.lower.length - 1];
    assert.ok(Math.abs(upper.y - lower.y) < 1e-12, `${code} TE gap ${upper.y - lower.y}`);
  }
});

/* ---------------- Stability and validation ---------------- */

test('wake scenario stays finite and below Ma 0.3 for 2000 steps', () => {
  const sc = S.getScenario('wake');
  assert.ok(sc.viscosity >= 0.02, `wake viscosity ${sc.viscosity}`);
  const mask = S.generateCylinderMask(NY * 0.065, NX, NY, NX * 0.28, NY * 0.5);
  const state = S.createWindTunnel(NX, NY, sc.u0, sc.viscosity, { mask });
  S.stepLBM(state, 2000);
  const d = S.computeDiagnostics(state);
  assert.equal(state.sanitizedNodes, 0, `wake repairs ${state.sanitizedNodes}`);
  assert.equal(d.nonFiniteNodes, 0);
  assert.ok(d.maxMach < 0.3, `wake Ma ${d.maxMach}`);
});

test('extreme UI slider combinations remain finite and stable', () => {
  const combos = [
    [0.14, 0.006], [0.14, 0.09], [0.01, 0.006], [0.01, 0.09],
    [0.085, 0.014], [0.16, 0.18], [0.002, 0.004]
  ];
  for (const [u0, nu] of combos) {
    const mask = S.generateNaca4Mask('2412', 77, 6, NX, NY);
    const state = S.createWindTunnel(NX, NY, u0, nu, { mask });
    S.stepLBM(state, 300);
    const d = S.computeDiagnostics(state);
    assert.equal(d.nonFiniteNodes, 0, `u=${u0} nu=${nu} produced nonfinite nodes`);
    for (let k = 0; k < state.f.length; k++) {
      assert.ok(Number.isFinite(state.f[k]), `u=${u0} nu=${nu} nonfinite population at ${k}`);
    }
  }
});

test('nonfinite population injection is repaired through conservative moments', () => {
  const nx = 40, ny = 24;
  const state = S.createWindTunnel(nx, ny, 0.06, 0.03, { mask: new Uint8Array(nx * ny), perturbation: 0 });
  const cell = 12 * nx + 20;
  state.f[cell * 9 + 3] = NaN;
  S.stepLBM(state, 1);
  const d = S.computeDiagnostics(state);
  assert.equal(d.nonFiniteNodes, 0);
  assert.ok(state.sanitizedNodes > 0);
});

test('boundary and input validation reject malformed values', () => {
  assert.throws(() => S.parseNaca4('12'), /four digits/);
  assert.throws(() => S.parseNaca4('2012'), /camber position/);
  assert.throws(() => S.createWindTunnel(0, 10, 0.05, 0.02, {}), /between 8 and 4096/);
  assert.throws(() => S.stepLBM(S.createWindTunnel(20, 20, 0.05, 0.02, {}), -1), /steps/);
});

/* ---------------- Strouhal estimator ---------------- */

test('Strouhal estimator reports unavailable for steady lift', () => {
  const mask = S.generateNaca4Mask('0012', 60, 0, 120, 60);
  const state = S.createWindTunnel(120, 60, 0.05, 0.03, { mask });
  S.stepLBM(state, 500);
  const st = S.computeStrouhal(state);
  assert.equal(st.available, false);
  assert.equal(st.strouhal, null);
  assert.ok(st.reason.length > 0);
});

test('Strouhal estimator derives St from a synthetic periodic lift signal', () => {
  const state = S.createWindTunnel(60, 30, 0.1, 0.02, { mask: new Uint8Array(60 * 30) });
  const period = 80; // 16 samples at 5-step spacing
  const amp = 0.2, mean = 0.3;
  state.forceHistory = [];
  for (let step = 1; step <= 16 * period; step += 5) {
    state.forceHistory.push({ step, fx: 0, fy: 0, cd: 0, cl: mean + amp * Math.sin(2 * Math.PI * step / period), ld: 0 });
  }
  const st = S.computeStrouhal(state);
  assert.equal(st.available, true);
  assert.ok(Math.abs(st.periodSteps - period) < 8, `period ${st.periodSteps}`);
  const expected = (1 / period) * state.referenceHeight / state.u0;
  assert.ok(Math.abs(st.strouhal - expected) < 0.02, `St ${st.strouhal} expected ${expected}`);
});

/* ---------------- UI and design-fence hygiene ---------------- */

test('source has no smooth-scroll rule, no em/en dashes and no AI mentions', () => {
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(HERE, 'app.js'), 'utf8') + fs.readFileSync(path.join(HERE, 'cfd.js'), 'utf8');
  assert.doesNotMatch(css, /scroll-behavior\s*:\s*smooth/);
  assert.doesNotMatch(html + js, /[—–]/);
  assert.doesNotMatch(html + js, /\b(artificial intelligence|chatgpt|claude|copilot|generated by|as an ai)\b/i);
});

test('header has no all-caps eyebrow above the title and no tagline below it', () => {
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /class="report-id"/);
  assert.doesNotMatch(html, /class="report-sub"/);
  const titleIndex = html.indexOf('<h1>');
  assert.ok(titleIndex > 0);
  const before = html.slice(Math.max(0, titleIndex - 400), titleIndex);
  const after = html.slice(titleIndex, titleIndex + 300);
  assert.doesNotMatch(before, /SPECTRALFLOW \//);
  assert.doesNotMatch(after, /<p class="report-sub">/);
});

test('controller renders a Strouhal readout and healthy wake after preset click', () => {
  const h = boot(HERE);
  assert.deepEqual(h.errors, []);
  assert.ok(h.get('statSt'));
  assert.match(h.get('statStNote').textContent, /f D \/ U/);
  const wake = h.document.querySelector('[data-scenario="wake"]');
  wake.click();
  h.frames(20);
  assert.match(h.get('solverStatus').textContent, /SOLVER CHECKS PASS/);
  assert.match(h.get('solverStatus').textContent, /0 repaired nodes/);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('README test count matches the verified suite total', () => {
  const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
  const match = /(\d+) tests passed, 0 failed, 0 skipped/.exec(readme);
  assert.ok(match, 'README must state the verified passing test count');
  assert.equal(Number(match[1]), 132, `README says ${match[1]}, expected 132`);
});
