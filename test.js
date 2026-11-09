/*
 * SpectralFlow test.js
 * Run with: node --test test.js
 * Zero dependencies. Uses node:test and node:assert/strict only.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./cfd.js');

const NX = 160;
const NY = 80;

function tunnel(kind, options) {
  const o = Object.assign({ nx: NX, ny: NY }, options || {});
  const mask = S.generateObstacleMask(kind, o);
  return S.createWindTunnel(o.nx, o.ny, o.u0 || 0.08, o.viscosity || 0.02, { mask });
}

/* ---------------- D2Q9 lattice constants ---------------- */

test('D2Q9 exports nine discrete velocity vectors', () => {
  assert.equal(S.Q9, 9);
  assert.equal(S.CX.length, 9);
  assert.equal(S.CY.length, 9);
  assert.equal(S.W.length, 9);
  assert.equal(S.OPP.length, 9);
  assert.equal(S.CS2, 1 / 3);
});

test('sum of D2Q9 lattice weights equals exactly 1', () => {
  const sum = S.W.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `sum was ${sum}`);
});

test('rest, axis, and diagonal weights match the exact tensor weights', () => {
  assert.equal(S.W[0], 4 / 9);
  for (let i = 1; i <= 4; i++) assert.equal(S.W[i], 1 / 9);
  for (let i = 5; i <= 8; i++) assert.equal(S.W[i], 1 / 36);
});

test('each direction has a unique lattice velocity', () => {
  const seen = new Set();
  for (let i = 0; i < 9; i++) {
    const key = `${S.CX[i]},${S.CY[i]}`;
    assert.ok(!seen.has(key), `duplicate direction ${key}`);
    seen.add(key);
  }
  assert.equal(seen.size, 9);
});

test('opposite directions map involution and negate the velocity vector', () => {
  for (let i = 0; i < 9; i++) {
    const o = S.OPP[i];
    assert.equal(S.OPP[o], i);
    assert.ok(S.CX[o] === -S.CX[i] && Object.is(S.CX[o] + S.CX[i], 0));
    assert.ok(S.CY[o] === -S.CY[i] && Object.is(S.CY[o] + S.CY[i], 0));
    assert.equal(S.W[o], S.W[i]);
  }
});

test('lattice isotropy: second moment tensor is cs2 times identity', () => {
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < 9; i++) {
    xx += S.W[i] * S.CX[i] * S.CX[i];
    yy += S.W[i] * S.CY[i] * S.CY[i];
    xy += S.W[i] * S.CX[i] * S.CY[i];
  }
  assert.ok(Math.abs(xx - 1 / 3) < 1e-12);
  assert.ok(Math.abs(yy - 1 / 3) < 1e-12);
  assert.ok(Math.abs(xy) < 1e-12);
});

/* ---------------- Equilibrium ---------------- */

test('equilibrium conserves mass for arbitrary density and velocity', () => {
  for (const [rho, ux, uy] of [[1, 0, 0], [1.3, 0.07, -0.02], [0.7, -0.11, 0.05]]) {
    const eq = S.equilibriumArray(rho, ux, uy);
    const sum = eq.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - rho) < 1e-12, `rho ${rho} gave ${sum}`);
  }
});

test('equilibrium conserves x and y momentum', () => {
  const rho = 1.25;
  const ux = 0.06;
  const uy = -0.03;
  const eq = S.equilibriumArray(rho, ux, uy);
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 9; i++) {
    mx += S.CX[i] * eq[i];
    my += S.CY[i] * eq[i];
  }
  assert.ok(Math.abs(mx - rho * ux) < 1e-12);
  assert.ok(Math.abs(my - rho * uy) < 1e-12);
});

test('equilibrium at rest reduces to w_i times rho', () => {
  const eq = S.equilibriumArray(2, 0, 0);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(eq[i] - 2 * S.W[i]) < 1e-12);
});

test('equilibrium populations are nonnegative at moderate Mach number', () => {
  const eq = S.equilibriumArray(1, 0.12, 0.06);
  for (let i = 0; i < 9; i++) assert.ok(eq[i] > 0, `direction ${i}`);
});

test('equilibriumArray length and finiteness', () => {
  const eq = S.equilibriumArray(1, 0.1, 0.1);
  assert.equal(eq.length, 9);
  for (const v of eq) assert.ok(Number.isFinite(v));
});

/* ---------------- NACA 4 digit polynomials ---------------- */

test('parseNaca4 decodes 0012, 2412, and 4415', () => {
  assert.deepEqual(S.parseNaca4('0012'), {
    code: '0012', maxCamber: 0, camberPosition: 0, thickness: 0.12,
    digits: [0, 0, 1, 2]
  });
  const a = S.parseNaca4('2412');
  assert.equal(a.maxCamber, 0.02);
  assert.equal(a.camberPosition, 0.4);
  assert.equal(a.thickness, 0.12);
  const b = S.parseNaca4('4415');
  assert.equal(b.maxCamber, 0.04);
  assert.equal(b.camberPosition, 0.4);
  assert.equal(Math.abs(b.thickness - 0.15) < 1e-12, true);
});

test('parseNaca4 rejects malformed codes', () => {
  assert.throws(() => S.parseNaca4('241'), RangeError);
  assert.throws(() => S.parseNaca4('24120'), RangeError);
  assert.throws(() => S.parseNaca4('ab12'), RangeError);
  assert.throws(() => S.parseNaca4('24-2'), RangeError);
});

test('thickness polynomial vanishes at the leading and trailing edge', () => {
  assert.ok(Math.abs(S.naca4Thickness(0, 0.12)) < 1e-12);
  assert.ok(Math.abs(S.naca4Thickness(1, 0.12)) < 1e-9);
  assert.ok(S.naca4Thickness(0.3, 0.12) > 0);
  assert.ok(S.naca4Thickness(0.3, 0.15) > S.naca4Thickness(0.3, 0.12));
});

test('thickness polynomial peaks near 30 percent chord', () => {
  let best = 0;
  let bestX = 0;
  for (let k = 1; k < 1000; k++) {
    const x = k / 1000;
    const y = S.naca4Thickness(x, 0.12);
    if (y > best) { best = y; bestX = x; }
  }
  assert.ok(bestX > 0.25 && bestX < 0.35, `peak at ${bestX}`);
  assert.ok(Math.abs(2 * best - 0.12) < 0.001, `max thickness ${2 * best}`);
});

test('camber polynomial is continuous and peaks at the camber position', () => {
  const m = 0.04;
  const p = 0.4;
  assert.ok(Math.abs(S.naca4Camber(0, m, p)) < 1e-12);
  assert.ok(Math.abs(S.naca4Camber(1, m, p)) < 1e-12);
  assert.ok(Math.abs(S.naca4Camber(p, m, p) - m) < 1e-12);
  const left = S.naca4Camber(p - 1e-6, m, p);
  const right = S.naca4Camber(p + 1e-6, m, p);
  assert.ok(Math.abs(left - right) < 1e-6);
});

test('camber slope changes sign across the maximum camber point', () => {
  const m = 0.04;
  const p = 0.4;
  assert.ok(S.naca4CamberSlope(0.2, m, p) > 0);
  assert.ok(S.naca4CamberSlope(0.7, m, p) < 0);
  assert.ok(Math.abs(S.naca4CamberSlope(p, m, p)) < 1e-9);
});

test('zero camber sections have an identically zero camber line', () => {
  const c = S.naca4Coordinates('0012', 100);
  assert.equal(c.maxCamber, 0);
  for (const p of c.camberLine) {
    assert.equal(p.y, 0);
    assert.equal(p.slope, 0);
  }
  for (let k = 0; k < c.upper.length; k++) {
    assert.ok(Math.abs(c.upper[k].y + c.lower[k].y) < 1e-12);
    assert.ok(Math.abs(c.upper[k].x - c.lower[k].x) < 1e-12);
  }
});

test('naca4Coordinates returns cosine clustered upper, lower, and camber arrays', () => {
  const c = S.naca4Coordinates('2412', 120);
  assert.equal(c.upper.length, 121);
  assert.equal(c.lower.length, 121);
  assert.equal(c.camberLine.length, 121);
  assert.equal(c.code, '2412');
  assert.ok(Math.abs(c.thickness - 0.12) < 1e-12);
  assert.ok(c.maxThickness > 0.05 && c.maxThickness < 0.07);
  const x1 = c.upper[1].x - c.upper[0].x;
  const xMid = c.upper[60].x - c.upper[59].x;
  assert.ok(x1 < xMid, 'cosine clustering must resolve the leading edge');
});

test('NACA 0012 solid mask is exactly symmetric about the horizontal centerline at 0 deg', () => {
  const nx = 200;
  const ny = 90;
  const m = S.generateNaca4Mask('0012', 64, 0, nx, ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      assert.equal(m[j * nx + i], m[(ny - 1 - j) * nx + i], `mismatch at ${i},${j}`);
    }
  }
  assert.equal(m.angleDeg, 0);
  assert.equal(m.code, '0012');
});

test('NACA 0012 mask is asymmetric at a positive angle of attack', () => {
  const nx = 200;
  const ny = 90;
  const m = S.generateNaca4Mask('0012', 64, 8, nx, ny);
  const flat = S.generateNaca4Mask('0012', 64, 0, nx, ny);
  let diff = 0;
  for (let c = 0; c < nx * ny; c++) if (m[c] !== flat[c]) diff++;
  assert.ok(diff > 0);
  assert.ok(m.projectedHeight > flat.projectedHeight);
});

test('NACA mask metadata reports chord, code, bounds, and solid count', () => {
  const m = S.generateNaca4Mask('4415', 70, 6, 200, 90);
  assert.equal(m.kind, 'naca4');
  assert.equal(m.code, '4415');
  assert.equal(m.chordPx, 70);
  assert.equal(m.angleDeg, 6);
  assert.ok(m.solidCount > 100);
  assert.ok(m.bounds.xMin > 0 && m.bounds.xMax < 199);
  assert.ok(m.projectedHeight > 0);
  assert.equal(m.length, 200 * 90);
});

test('generateNaca4Mask rejects invalid codes and grids', () => {
  assert.throws(() => S.generateNaca4Mask('12x4', 40, 0, 100, 60), RangeError);
  assert.throws(() => S.generateNaca4Mask('0012', 40, 0, 4, 60), RangeError);
  assert.throws(() => S.generateNaca4Mask('0012', 40, 0, 100.5, 60), RangeError);
});

/* ---------------- Other obstacle families ---------------- */

test('cylinder mask is circular and has 2r projected height', () => {
  const m = S.generateCylinderMask(8, 160, 80, 50, 40);
  assert.equal(m.kind, 'cylinder');
  assert.ok(Math.abs(m.projectedHeight - 16) < 1e-9);
  assert.equal(m[40 * 160 + 50], 1);
  assert.equal(m[40 * 160 + 90], 0);
  assert.ok(m.solidCount > 150 && m.solidCount < 230);
});

test('bluff body mask is a filled rectangle with a positive solid count', () => {
  const m = S.generateBluffBodyMask(160, 80, 12, 20);
  assert.equal(m.kind, 'bluff');
  assert.ok(m.solidCount > 200);
  assert.equal(m.projectedHeight, 20);
  assert.equal(m[0], 0);
});

test('Venturi mask constricts at the throat and opens at the inlet', () => {
  const m = S.generateVenturiMask(160, 80, 0.5, 0.18);
  assert.equal(m.kind, 'venturi');
  assert.equal(m[0], 0);
  assert.equal(m[159], 0);
  assert.ok(m.throatHeight > 0);
  assert.ok(m.clearance[80] < m.clearance[20]);
  assert.ok(m.clearance[80] < m.clearance[140]);
  let solidMid = 0;
  for (let j = 0; j < 80; j++) if (m[j * 160 + 80]) solidMid++;
  assert.ok(solidMid > 0);
});

test('generateObstacleMask routes all presets and rejects unknown kinds', () => {
  for (const k of ['0012', '2412', '4415', 'cylinder', 'karman', 'bluff', 'plate', 'venturi', 'nozzle', 'airfoil']) {
    const m = S.generateObstacleMask(k, { nx: 120, ny: 60 });
    assert.equal(m.length, 120 * 60);
    assert.ok(m.solidCount > 0);
  }
  assert.throws(() => S.generateObstacleMask('rocket', { nx: 120, ny: 60 }), RangeError);
});

test('maskBounds agrees with the counted solid cells', () => {
  const m = S.generateObstacleMask('2412', { nx: 160, ny: 80, angleDeg: 5 });
  let count = 0;
  let minX = 160;
  let maxX = -1;
  for (let j = 0; j < 80; j++) {
    for (let i = 0; i < 160; i++) {
      if (m[j * 160 + i]) {
        count++;
        minX = Math.min(minX, i);
        maxX = Math.max(maxX, i);
      }
    }
  }
  const b = S.maskBounds(m, 160, 80);
  assert.equal(b.count, count);
  assert.equal(b.xMin, minX);
  assert.equal(b.xMax, maxX);
});

test('pointInPolygon handles a square and a triangle', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(S.pointInPolygon(5, 5, square), true);
  assert.equal(S.pointInPolygon(15, 5, square), false);
  const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }];
  assert.equal(S.pointInPolygon(5, 3, tri), true);
  assert.equal(S.pointInPolygon(9, 8, tri), false);
});

/* ---------------- Wind tunnel construction ---------------- */

test('createWindTunnel initializes a uniform equilibrium inflow', () => {
  const st = tunnel('cylinder', { u0: 0.07 });
  assert.equal(st.nx, NX);
  assert.equal(st.ny, NY);
  assert.equal(st.cellCount, NX * NY);
  assert.equal(st.time, 0);
  assert.equal(st.f.length, NX * NY * 9);
  assert.ok(Math.abs(st.ux[40 * NX + 5] - 0.07) < 1e-12);
  assert.equal(st.uy[40 * NX + 5], 0);
  assert.ok(Math.abs(st.rho[40 * NX + 5] - 1) < 1e-12);
  assert.ok(Math.abs(st.tau - (3 * 0.02 + 0.5)) < 1e-12);
  assert.ok(Math.abs(st.omega - 1 / 0.56) < 1e-12);
});

test('Reynolds number scales as u0 L / nu', () => {
  const st = tunnel('cylinder', { u0: 0.08, viscosity: 0.02 });
  assert.ok(Math.abs(st.reynolds - 0.08 * st.referenceLength / 0.02) < 1e-9);
  const fast = S.createWindTunnel(NX, NY, 0.16, 0.01, { mask: st.mask });
  assert.ok(fast.reynolds > st.reynolds * 3);
});

test('stability clamps viscosity, speed, and lattice velocity', () => {
  const st = S.createWindTunnel(NX, NY, 99, -5, { mask: S.generateCylinderMask(8, NX, NY) });
  assert.equal(st.u0, S.LIMITS.maxSpeed);
  assert.equal(st.viscosity, S.LIMITS.minViscosity);
  assert.equal(st.parametersClamped, true);
  assert.ok(st.tau > 0.5);
  assert.ok(st.omega > 0 && st.omega < 2);
});

test('setFlowParameters resets the flow and updates tau', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 30);
  S.setFlowParameters(st, 0.1, 0.04);
  assert.equal(st.time, 0);
  assert.equal(st.u0, 0.1);
  assert.ok(Math.abs(st.tau - 0.62) < 1e-12);
  assert.equal(st.forceHistory.length, 0);
});

test('setObstacle swaps the geometry and resets the reference length', () => {
  const st = tunnel('cylinder');
  const before = st.referenceLength;
  const airfoil = S.generateNaca4Mask('2412', 50, 4, NX, NY);
  S.setObstacle(st, airfoil);
  assert.equal(st.mask.code, '2412');
  assert.notEqual(st.referenceLength, before);
  assert.equal(st.time, 0);
  assert.throws(() => S.setObstacle(st, new Uint8Array(10)), RangeError);
});

test('createWindTunnel rejects a mask with the wrong dimensions', () => {
  assert.throws(() => S.createWindTunnel(NX, NY, 0.08, 0.02, {
    mask: S.generateCylinderMask(6, 40, 40)
  }), RangeError);
});

/* ---------------- Solver behavior ---------------- */

test('stepLBM advances time by exactly the requested number of steps', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 25);
  assert.equal(st.time, 25);
  S.stepLBM(st, 5);
  assert.equal(st.time, 30);
  S.stepLBM(st, 0);
  assert.equal(st.time, 30);
});

test('stepLBM keeps density and velocity finite over a long run', () => {
  const st = tunnel('bluff', { u0: 0.1, viscosity: 0.01 });
  S.stepLBM(st, 250);
  for (let c = 0; c < st.cellCount; c += 7) {
    assert.ok(Number.isFinite(st.rho[c]));
    assert.ok(Number.isFinite(st.ux[c]));
    assert.ok(Number.isFinite(st.uy[c]));
    assert.ok(st.rho[c] >= S.LIMITS.minDensity - 1e-9);
    assert.ok(st.rho[c] <= S.LIMITS.maxDensity + 1e-9);
  }
  assert.ok(st.sanitizedNodes < st.cellCount);
});

test('bounce-back enforces a strict no-slip condition on every solid node', () => {
  const st = tunnel('2412', { u0: 0.09 });
  S.stepLBM(st, 120);
  let solids = 0;
  for (let c = 0; c < st.cellCount; c++) {
    if (st.mask[c] !== 1) continue;
    solids++;
    assert.equal(st.ux[c], 0, `ux at solid cell ${c}`);
    assert.equal(st.uy[c], 0, `uy at solid cell ${c}`);
    assert.equal(st.rho[c], 1);
  }
  assert.ok(solids > 100);
});

test('Zou-He inflow maintains the prescribed inlet velocity', () => {
  const st = tunnel('cylinder', { u0: 0.075 });
  S.stepLBM(st, 100);
  for (let j = 1; j < NY - 1; j++) {
    const cell = j * NX;
    assert.ok(Math.abs(st.ux[cell] - 0.075) < 1e-6, `inlet ux row ${j}`);
    assert.ok(Math.abs(st.uy[cell]) < 1e-6);
  }
});

test('equilibrium inflow mode also maintains the prescribed inlet velocity', () => {
  const mask = S.generateCylinderMask(6, NX, NY);
  const st = S.createWindTunnel(NX, NY, 0.07, 0.02, { mask, inflowMode: 'equilibrium' });
  S.stepLBM(st, 60);
  assert.ok(Math.abs(st.ux[40 * NX] - 0.07) < 1e-9);
});

test('free-slip top and bottom walls remain stable', () => {
  const mask = S.generateCylinderMask(6, NX, NY);
  const st = S.createWindTunnel(NX, NY, 0.08, 0.02, { mask, wallMode: 'free-slip' });
  S.stepLBM(st, 100);
  assert.equal(st.wallMode, 'free-slip');
  assert.ok(Number.isFinite(st.ux[40 * NX + 80]));
});

test('solver produces a wake velocity deficit behind an obstacle', () => {
  const st = tunnel('cylinder', { u0: 0.08 });
  S.stepLBM(st, 160);
  const d = S.computeDiagnostics(st);
  const b = st.mask.bounds;
  const near = b.xMax + 6;
  let wake = 0;
  let far = 0;
  for (let j = b.yMin; j <= b.yMax; j++) {
    wake += st.ux[j * NX + near];
    far += st.ux[j * NX + 2];
  }
  assert.ok(wake < far, `wake ux ${wake} should be below inlet ux ${far}`);
  assert.ok(d.wakeDeficit >= 0);
});

test('Venturi throat accelerates the centerline flow above the inlet speed', () => {
  const mask = S.generateVenturiMask(NX, NY, 0.5, 0.18);
  const st = S.createWindTunnel(NX, NY, 0.06, 0.02, { mask });
  S.stepLBM(st, 200);
  const j = Math.floor(NY / 2);
  const inlet = st.ux[j * NX + 3];
  const throat = st.ux[j * NX + Math.round(NX * 0.46)];
  assert.ok(throat > inlet * 1.5, `inlet ${inlet}, throat ${throat}`);
});

test('positive angle of attack increases lift over the symmetric 0012 section', () => {
  function meanCl(a) {
    const m = S.generateNaca4Mask('0012', 50, a, NX, NY);
    const st = S.createWindTunnel(NX, NY, 0.08, 0.02, { mask: m });
    S.stepLBM(st, 300);
    return S.computeDiagnostics(st).meanCl;
  }
  const cl0 = meanCl(0);
  const cl5 = meanCl(5);
  const cl10 = meanCl(10);
  assert.ok(Math.abs(cl0) < 0.05, `zero angle lift ${cl0}`);
  assert.ok(cl5 > cl0 + 0.5, `5 deg lift ${cl5}`);
  assert.ok(cl10 > cl5, `10 deg lift ${cl10} should exceed 5 deg lift ${cl5}`);
});

test('negative angle of attack produces negative lift with antisymmetric magnitude', () => {
  function meanCl(a) {
    const m = S.generateNaca4Mask('0012', 50, a, NX, NY);
    const st = S.createWindTunnel(NX, NY, 0.08, 0.02, { mask: m });
    S.stepLBM(st, 300);
    return S.computeDiagnostics(st).meanCl;
  }
  const plus = meanCl(6);
  const minus = meanCl(-6);
  assert.ok(plus > 0);
  assert.ok(minus < 0);
  assert.ok(Math.abs(plus + minus) < 0.05, `antisymmetry: ${plus} and ${minus}`);
});

test('cambered 2412 produces positive lift at zero geometric angle of attack', () => {
  const m = S.generateNaca4Mask('2412', 50, 0, NX, NY);
  const st = S.createWindTunnel(NX, NY, 0.08, 0.02, { mask: m });
  S.stepLBM(st, 300);
  assert.ok(S.computeDiagnostics(st).meanCl > 0.1);
});

test('force history records step, fx, fy, cd, cl, and ld', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 51);
  assert.ok(st.forceHistory.length >= 10);
  for (const e of st.forceHistory) {
    assert.ok(Number.isInteger(e.step) && e.step > 0);
    for (const key of ['fx', 'fy', 'cd', 'cl', 'ld']) assert.ok(Number.isFinite(e[key]), key);
  }
});

test('force history is capped to avoid unbounded memory growth', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 4000);
  assert.ok(st.forceHistory.length <= 720);
});

test('drag coefficient is positive for a cylinder in crossflow', () => {
  const st = tunnel('cylinder', { u0: 0.08 });
  S.stepLBM(st, 250);
  const d = S.computeDiagnostics(st);
  assert.ok(d.meanCd > 0);
  assert.ok(Math.abs(d.meanCl) < 0.1);
  assert.ok(Math.abs(d.meanLd) < 0.2);
});

/* ---------------- Diagnostics ---------------- */

test('computeFields returns arrays of length nx times ny', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 40);
  const f = S.computeFields(st);
  for (const key of ['speed', 'curl', 'cp']) {
    assert.equal(f[key].length, st.cellCount);
    for (let c = 0; c < st.cellCount; c++) assert.ok(Number.isFinite(f[key][c]));
  }
});

test('solid nodes have zero speed, zero curl, and zero pressure coefficient', () => {
  const st = tunnel('2412');
  S.stepLBM(st, 30);
  const f = S.computeFields(st);
  for (let c = 0; c < st.cellCount; c++) {
    if (st.mask[c] !== 1) continue;
    assert.equal(f.speed[c], 0);
    assert.equal(f.curl[c], 0);
    assert.equal(f.cp[c], 0);
  }
});

test('curl of a solid body rotation field matches the analytic value', () => {
  const nx = 30;
  const ny = 30;
  const mask = new Uint8Array(nx * ny);
  const st = S.createWindTunnel(nx, ny, 0.05, 0.02, { mask });
  const omega = 0.01;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      st.ux[c] = omega * (j - ny / 2);
      st.uy[c] = -omega * (i - nx / 2);
    }
  }
  const curl = S.computeFields(st).curl;
  /* screen-space curl d(uy)/dx - d(ux)/dy = -omega - omega = -2 omega */
  assert.ok(Math.abs(curl[15 * nx + 15] + 2 * omega) < 1e-12);
});

test('pressure coefficient uses p = rho cs2 with the dynamic pressure scale', () => {
  const nx = 30;
  const ny = 20;
  const mask = new Uint8Array(nx * ny);
  const st = S.createWindTunnel(nx, ny, 0.1, 0.02, { mask });
  st.rho[10 * nx + 15] = 1.03;
  const cp = S.computeFields(st).cp[10 * nx + 15];
  const expected = (0.03 * S.CS2) / (0.5 * 1 * 0.1 * 0.1);
  assert.ok(Math.abs(cp - expected) < 1e-9);
});

test('computeDiagnostics reports Reynolds number, maxima, and coefficient triples', () => {
  const st = tunnel('2412', { u0: 0.08, viscosity: 0.02 });
  S.stepLBM(st, 100);
  const d = S.computeDiagnostics(st);
  for (const key of ['reynolds', 'maxSpeed', 'meanSpeed', 'maxAbsCurl', 'meanAbsCurl',
    'minCp', 'maxCp', 'cd', 'cl', 'ld', 'meanCd', 'meanCl', 'meanLd',
    'wakeDeficit', 'fx', 'fy', 'time']) {
    assert.ok(Number.isFinite(d[key]), `${key} must be finite`);
  }
  assert.ok(Math.abs(d.reynolds - 0.08 * st.referenceLength / 0.02) < 1e-9);
  assert.ok(d.maxSpeed >= d.meanSpeed);
  assert.ok(d.minCp <= d.maxCp);
  assert.equal(d.time, 100);
  assert.ok(d.fields.speed.length === st.cellCount);
  assert.equal(typeof d.unstable, 'boolean');
});

test('centerline profile skips solid cells and has bounded coordinates', () => {
  const st = tunnel('0012');
  S.stepLBM(st, 50);
  const p = S.centerlineProfile(st);
  assert.ok(p.length > 0 && p.length <= NX);
  for (const s of p) {
    assert.ok(s.x >= 0 && s.x < NX);
    assert.equal(s.y, Math.floor(NY / 2));
    assert.ok(Number.isFinite(s.ux) && Number.isFinite(s.speed) && Number.isFinite(s.cp));
    assert.equal(st.mask[s.y * NX + s.x], 0);
  }
});

test('wake profile returns exactly ny samples with a solid flag', () => {
  const st = tunnel('venturi');
  S.stepLBM(st, 40);
  const w = S.wakeProfile(st, 0.7);
  assert.equal(w.samples.length, NY);
  assert.equal(w.x, Math.round(NX * 0.7));
  assert.ok(w.samples.some((s) => s.solid === 1), 'Venturi walls should appear as solid');
  for (const s of w.samples) {
    assert.equal(s.x, w.x);
    assert.ok(s.solid === 0 || s.solid === 1);
  }
});

test('wakeProfile clamps the requested x fraction into the domain', () => {
  const st = tunnel('cylinder');
  assert.equal(S.wakeProfile(st, 5).x, NX - 2);
  assert.equal(S.wakeProfile(st, -5).x, 1);
});

/* ---------------- Export ---------------- */

test('exportWakeProfileCSV has a header and one row per transverse site', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 40);
  const csv = S.exportWakeProfileCSV(st, 0.75);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'y,ux,uy,speed,rho,cp,curl,solid');
  assert.equal(lines.length - 1, NY);
  const cols = lines[1].split(',');
  assert.equal(cols.length, 8);
  for (const c of cols) assert.ok(Number.isFinite(Number(c)), `bad CSV value ${c}`);
});

test('exportWakeProfileCSV is deterministic for the same state', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 20);
  assert.equal(S.exportWakeProfileCSV(st), S.exportWakeProfileCSV(st));
});

test('csvEscape quotes commas, quotes, and newlines', () => {
  assert.equal(S.csvEscape('plain'), 'plain');
  assert.equal(S.csvEscape('a,b'), '"a,b"');
  assert.equal(S.csvEscape('a"b'), '"a""b"');
  assert.equal(S.csvEscape('a\nb'), '"a\nb"');
});

test('exportForceHistoryCSV has a header plus one row per sample', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 60);
  const lines = S.exportForceHistoryCSV(st).trim().split('\n');
  assert.equal(lines[0], 'step,fx,fy,cd,cl,ld');
  assert.equal(lines.length - 1, st.forceHistory.length);
  assert.equal(lines[1].split(',').length, 6);
});

test('exportSnapshotJSON parses and carries the full simulation metadata', () => {
  const st = tunnel('2412', { u0: 0.09, viscosity: 0.015 });
  S.stepLBM(st, 80);
  const snap = JSON.parse(S.exportSnapshotJSON(st));
  assert.equal(snap.format, 'spectralflow-snapshot');
  assert.equal(snap.version, S.VERSION);
  assert.equal(snap.simulation.nx, NX);
  assert.equal(snap.simulation.ny, NY);
  assert.equal(snap.simulation.time, 80);
  assert.equal(snap.simulation.obstacle.code, '2412');
  assert.ok(Math.abs(snap.simulation.omega - st.omega) < 1e-9);
  assert.ok(Math.abs(snap.diagnostics.meanCl - S.computeDiagnostics(st).meanCl) < 1e-5);
  assert.ok(snap.wakeProfile.samples.length === NY);
  assert.ok(snap.centerlineProfile.length > 0);
  assert.equal(snap.forceHistory.length, st.forceHistory.length);
});

test('exportSnapshotJSON fields are row major and match the grid size', () => {
  const st = tunnel('cylinder');
  S.stepLBM(st, 20);
  const snap = JSON.parse(S.exportSnapshotJSON(st));
  assert.equal(snap.fields.layout, 'row-major, j from 0 to ny-1, i from 0 to nx-1');
  for (const key of snap.fields.keys) {
    assert.equal(snap.fields[key].length, NX * NY, `${key} length`);
    for (const v of snap.fields[key]) assert.ok(Number.isFinite(v));
  }
  let solid = 0;
  for (const v of snap.fields.solid) solid += v;
  assert.equal(solid, st.mask.solidCount);
});

test('exportSnapshotJSON can omit the heavy field arrays', () => {
  const st = tunnel('cylinder');
  const snap = JSON.parse(S.exportSnapshotJSON(st, { includeFields: false }));
  assert.equal(snap.fields, undefined);
  assert.ok(snap.diagnostics);
  assert.ok(snap.wakeProfile);
});

/* ---------------- UMD portability ---------------- */

test('UMD module exposes the complete public API in CommonJS', () => {
  for (const key of ['generateNaca4Mask', 'generateCylinderMask', 'generateBluffBodyMask',
    'generateVenturiMask', 'generateObstacleMask', 'createWindTunnel', 'stepLBM',
    'computeDiagnostics', 'exportWakeProfileCSV', 'exportSnapshotJSON',
    'naca4Coordinates', 'equilibriumArray', 'parseNaca4']) {
    assert.equal(typeof S[key], 'function', key);
  }
});

test('UMD wrapper attaches a browser global under a fake window', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'cfd.js'), 'utf8');
  const sandbox = { globalThis: {}, define: undefined, module: undefined };
  sandbox.globalThis.SpectralFlow = undefined;
  vm.runInNewContext(source, sandbox, { filename: 'cfd.js' });
  assert.equal(typeof sandbox.globalThis.SpectralFlow, 'object');
  assert.equal(typeof sandbox.globalThis.SpectralFlow.createWindTunnel, 'function');
  assert.ok(Math.abs(sandbox.globalThis.SpectralFlow.W.reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('all obstacle presets stay numerically stable after a long run', () => {
  for (const kind of ['0012', '2412', '4415', 'cylinder', 'bluff', 'venturi']) {
    const st = tunnel(kind, { u0: 0.09, viscosity: 0.012 });
    S.stepLBM(st, 200);
    const d = S.computeDiagnostics(st);
    assert.ok(Number.isFinite(d.cd) && Number.isFinite(d.cl), kind);
    assert.ok(d.maxSpeed < 0.5, `${kind} max speed ${d.maxSpeed}`);
    assert.equal(d.unstable, false, `${kind} flagged unstable`);
  }
});
