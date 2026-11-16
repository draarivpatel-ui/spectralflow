/*
 * SpectralFlow cfd.js
 * D2Q9 BGK lattice Boltzmann wind tunnel, NACA 4 digit geometry, telemetry.
 * Zero dependencies. CommonJS, AMD, and browser global are supported.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.SpectralFlow = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '2.0.0';
  var isFiniteNumber = Number.isFinite;
  var vectorLength = Math.hypot;

  /* Screen grid: i grows right, j grows down. Direction 2 is north (j - 1). */
  var CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
  var CY = [0, 0, -1, 0, 1, -1, -1, 1, 1];
  var W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
  var OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
  var OPP_Y = [0, 1, 4, 3, 2, 8, 7, 6, 5];
  var CS2 = 1 / 3;
  var Q9 = 9;
  var HISTORY_LIMIT = 720;
  var MAX_CELLS = 262144;

  var MIN_VISCOSITY = 0.004;
  var MAX_VISCOSITY = 0.18;
  var MIN_SPEED = 0.002;
  var MAX_SPEED = 0.16;
  var MAX_LATTICE_SPEED = 0.38;
  var MIN_DENSITY = 0.25;
  var MAX_DENSITY = 4.0;
  var MIN_POPULATION = -0.5;
  var MAX_POPULATION = 8.0;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function finite(v, fallback) { return isFiniteNumber(v) ? v : fallback; }
  function round(v, places) {
    var p = Math.pow(10, places);
    return Math.round(v * p) / p;
  }
  function indexOf(nx, i, j) { return j * nx + i; }
  function baseOf(cell) { return cell * Q9; }

  /* f_i^eq = w_i rho [1 + 3 c_i.u + 9/2 (c_i.u)^2 - 3/2 u.u] */
  function equilibrium(rho, ux, uy, i) {
    var cu = CX[i] * ux + CY[i] * uy;
    var u2 = ux * ux + uy * uy;
    return W[i] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u2);
  }

  function equilibriumArray(rho, ux, uy) {
    var out = new Array(Q9);
    for (var i = 0; i < Q9; i++) out[i] = equilibrium(rho, ux, uy, i);
    return out;
  }

  function writeEquilibrium(arr, base, rho, ux, uy) {
    for (var i = 0; i < Q9; i++) arr[base + i] = equilibrium(rho, ux, uy, i);
  }

  /* ---------------- NACA 4 digit section ---------------- */

  function parseNaca4(code) {
    var s = String(code).trim();
    if (!/^[0-9]{4}$/.test(s)) {
      throw new RangeError('NACA code must be exactly four digits, received: ' + s);
    }
    var d0 = Number(s.charAt(0));
    var d1 = Number(s.charAt(1));
    var d2 = Number(s.charAt(2));
    var d3 = Number(s.charAt(3));
    if ((d2 * 10 + d3) === 0) throw new RangeError('NACA thickness must be greater than zero');
    if (d0 > 0 && d1 === 0) throw new RangeError('A cambered NACA section needs a nonzero camber position');
    return {
      code: s,
      maxCamber: d0 / 100,
      camberPosition: d1 / 10,
      thickness: (d2 * 10 + d3) / 100,
      digits: [d0, d1, d2, d3]
    };
  }

  /* Closed trailing edge form, coefficient -0.1036 makes y_t(1) = 0. */
  function naca4Thickness(x, thicknessRatio) {
    var xn = clamp(x, 0, 1);
    var t = thicknessRatio;
    return 5 * t * (
      0.2969 * Math.sqrt(xn) - 0.1260 * xn - 0.3516 * xn * xn +
      0.2843 * xn * xn * xn - 0.1036 * xn * xn * xn * xn
    );
  }

  function naca4Camber(x, maxCamber, camberPosition) {
    var xn = clamp(x, 0, 1);
    var m = maxCamber;
    var p = camberPosition;
    if (m === 0 || p <= 0) return 0;
    if (p >= 1) return 0;
    if (xn < p) return (m / (p * p)) * (2 * p * xn - xn * xn);
    var q = 1 - p;
    return (m / (q * q)) * ((1 - 2 * p) + 2 * p * xn - xn * xn);
  }

  function naca4CamberSlope(x, maxCamber, camberPosition) {
    var xn = clamp(x, 0, 1);
    var m = maxCamber;
    var p = camberPosition;
    if (m === 0 || p <= 0 || p >= 1) return 0;
    if (xn < p) return (2 * m / (p * p)) * (p - xn);
    var q = 1 - p;
    return (2 * m / (q * q)) * (p - xn);
  }

  /*
   * Exact NACA 4 digit coordinates with perpendicular thickness offset.
   * Cosine clustering resolves the leading edge and the closed trailing edge.
   * Coordinates are dimensionless fractions of the chord, y positive upward.
   */
  function naca4Coordinates(code, samples) {
    var spec = parseNaca4(code);
    var n = isFiniteNumber(samples) ? clamp(Math.floor(samples), 8, 4096) : 120;
    var m = spec.maxCamber;
    var p = spec.camberPosition;
    var t = spec.thickness;
    var upper = [];
    var lower = [];
    var camber = [];
    for (var k = 0; k <= n; k++) {
      var x = 0.5 * (1 - Math.cos(Math.PI * k / n));
      var yt = naca4Thickness(x, t);
      var yc = naca4Camber(x, m, p);
      var slope = naca4CamberSlope(x, m, p);
      var theta = Math.atan(slope);
      var st = Math.sin(theta);
      var ct = Math.cos(theta);
      upper.push({ x: x - yt * st, y: yc + yt * ct });
      lower.push({ x: x + yt * st, y: yc - yt * ct });
      camber.push({ x: x, y: yc, slope: slope, thickness: yt });
    }
    return {
      code: spec.code,
      maxCamber: m,
      camberPosition: p,
      thickness: t,
      samples: n,
      upper: upper,
      lower: lower,
      camberLine: camber,
      maxThickness: Math.max.apply(null, camber.map(function (c) { return c.thickness; }))
    };
  }

  function polygonFromCoordinates(coords) {
    var poly = [];
    var k;
    for (k = 0; k < coords.upper.length; k++) poly.push(coords.upper[k]);
    for (k = coords.lower.length - 2; k >= 1; k--) poly.push(coords.lower[k]);
    return poly;
  }

  function pointInPolygon(px, py, poly) {
    var inside = false;
    var n = poly.length;
    var j = n - 1;
    for (var a = 0; a < n; j = a++) {
      var ya = poly[a].y;
      var yb = poly[j].y;
      if ((ya > py) !== (yb > py)) {
        var xCross = (poly[j].x - poly[a].x) * (py - ya) / (yb - ya) + poly[a].x;
        if (px < xCross) inside = !inside;
      }
    }
    return inside;
  }

  function attachMaskMetadata(mask, meta) {
    var keys = Object.keys(meta);
    for (var k = 0; k < keys.length; k++) mask[keys[k]] = meta[keys[k]];
    return mask;
  }

  function maskBounds(mask, nx, ny) {
    var xMin = nx;
    var xMax = -1;
    var yMin = ny;
    var yMax = -1;
    var count = 0;
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        if (mask[j * nx + i]) {
          count++;
          if (i < xMin) xMin = i;
          if (i > xMax) xMax = i;
          if (j < yMin) yMin = j;
          if (j > yMax) yMax = j;
        }
      }
    }
    if (count === 0) return { xMin: 0, xMax: 0, yMin: 0, yMax: 0, count: 0 };
    return { xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax, count: count };
  }

  function validateGrid(nx, ny) {
    if (!Number.isInteger(nx) || !Number.isInteger(ny)) {
      throw new RangeError('nx and ny must be integers');
    }
    if (nx < 8 || ny < 8 || nx > 4096 || ny > 4096) {
      throw new RangeError('nx and ny must lie between 8 and 4096');
    }
    if (nx * ny > MAX_CELLS) throw new RangeError('Grid exceeds the ' + MAX_CELLS + ' cell memory budget');
  }

  function validateMask(mask, nx, ny) {
    if (!mask || typeof mask.length !== 'number' || mask.length !== nx * ny) throw new RangeError('Obstacle mask length must equal nx * ny');
    var fluid = 0;
    for (var cell = 0; cell < mask.length; cell++) {
      if (mask[cell] !== 0 && mask[cell] !== 1) throw new RangeError('Obstacle mask must contain only 0 and 1');
      if (mask[cell] === 0) fluid++;
    }
    if (!fluid) throw new RangeError('Obstacle mask must leave fluid cells in the tunnel');
    var copy = new Uint8Array(mask);
    ['kind', 'code', 'shape', 'nx', 'ny', 'chordPx', 'angleDeg', 'radiusPx', 'centerX', 'centerY', 'widthPx', 'heightPx', 'projectedHeight', 'referenceLength', 'forceReferenceLength', 'coefficientConvention', 'clipped', 'polygon', 'coordinates', 'maxCamber', 'camberPosition', 'thickness', 'throatRatio', 'lipFraction', 'throatHeight', 'clearance'].forEach(function (key) { if (mask[key] != null) copy[key] = mask[key]; });
    copy.bounds = maskBounds(copy, nx, ny);
    copy.solidCount = copy.bounds.count;
    return copy;
  }

  function positiveReference(value, fallback) { return isFiniteNumber(value) && value > 0 ? value : fallback; }

  /* ---------------- Obstacle generators ---------------- */

  /*
   * NACA 4 digit airfoil raster. The quarter chord point sits at 0.32 nx,
   * the section rotates about that quarter chord, and angles use the
   * mathematical convention with y positive upward (positive angle of
   * attack raises the leading edge in screen terms).
   */
  function generateNaca4Mask(code, chordPx, angleDeg, nx, ny) {
    validateGrid(nx, ny);
    var spec = parseNaca4(code);
    var chord = isFiniteNumber(chordPx) ? clamp(chordPx, 4, Math.min(nx, ny) * 4) : nx * 0.32;
    var angle = isFiniteNumber(angleDeg) ? clamp(angleDeg, -45, 45) * Math.PI / 180 : 0;
    var coords = naca4Coordinates(code, Math.max(160, Math.round(chord * 3)));
    var poly = polygonFromCoordinates(coords);
    var qx = 0.32 * nx;
    var qy = 0.5 * ny;
    var mask = new Uint8Array(nx * ny);
    var ca = Math.cos(angle);
    var sa = Math.sin(angle);
    var physical = [];
    var k;
    for (k = 0; k < poly.length; k++) {
      var lx = (poly[k].x - 0.25) * chord;
      var ly = -(poly[k].y) * chord;
      physical.push({ x: qx + lx * ca - ly * sa, y: qy + lx * sa + ly * ca });
    }
    var minX = Math.max(1, Math.floor(Math.min.apply(null, physical.map(function (p) { return p.x; })) - 1));
    var maxX = Math.min(nx - 2, Math.ceil(Math.max.apply(null, physical.map(function (p) { return p.x; })) + 1));
    var minY = Math.max(1, Math.floor(Math.min.apply(null, physical.map(function (p) { return p.y; })) - 1));
    var maxY = Math.min(ny - 2, Math.ceil(Math.max.apply(null, physical.map(function (p) { return p.y; })) + 1));
    for (var j = minY; j <= maxY; j++) {
      for (var i = minX; i <= maxX; i++) {
        if (pointInPolygon(i + 0.5, j + 0.5, physical)) mask[indexOf(nx, i, j)] = 1;
      }
    }
    var b = maskBounds(mask, nx, ny);
    if (!b.count) throw new RangeError('Airfoil resolves no solid cells. Increase chord or section thickness.');
    /* Analytical projected frontal height is used as the reference area. */
    var projected = Math.max.apply(null, physical.map(function (point) { return point.y; })) - Math.min.apply(null, physical.map(function (point) { return point.y; }));
    return attachMaskMetadata(mask, {
      kind: 'naca4', code: spec.code, chordPx: chord, angleDeg: angle * 180 / Math.PI,
      nx: nx, ny: ny, solidCount: b.count, bounds: b,
      projectedHeight: Math.max(1, projected),
      forceReferenceLength: chord,
      coefficientConvention: 'chord times unit span',
      clipped: physical.some(function (point) { return point.x < 1 || point.x > nx - 1 || point.y < 1 || point.y > ny - 1; }),
      referenceLength: chord,
      polygon: physical, coordinates: coords,
      maxCamber: spec.maxCamber, camberPosition: spec.camberPosition,
      thickness: spec.thickness, shape: 'NACA ' + spec.code
    });
  }

  function generateCylinderMask(radiusPx, nx, ny, centerX, centerY) {
    validateGrid(nx, ny);
    var r = isFiniteNumber(radiusPx) ? clamp(radiusPx, 2, Math.min(nx, ny) / 3) : Math.max(3, ny * 0.055);
    var cx = isFiniteNumber(centerX) ? centerX : nx * 0.28;
    var cy = isFiniteNumber(centerY) ? centerY : ny * 0.5;
    var mask = new Uint8Array(nx * ny);
    var r2 = r * r;
    var minX = Math.max(1, Math.floor(cx - r - 1));
    var maxX = Math.min(nx - 2, Math.ceil(cx + r + 1));
    var minY = Math.max(1, Math.floor(cy - r - 1));
    var maxY = Math.min(ny - 2, Math.ceil(cy + r + 1));
    for (var j = minY; j <= maxY; j++) {
      for (var i = minX; i <= maxX; i++) {
        var dx = i + 0.5 - cx;
        var dy = j + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) mask[indexOf(nx, i, j)] = 1;
      }
    }
    var b = maskBounds(mask, nx, ny);
    return attachMaskMetadata(mask, {
      kind: 'cylinder', code: 'CYL', nx: nx, ny: ny, radiusPx: r,
      centerX: cx, centerY: cy, solidCount: b.count, bounds: b,
      projectedHeight: 2 * r, referenceLength: 2 * r,
      shape: 'Cylinder'
    });
  }

  function generateBluffBodyMask(nx, ny, widthPx, heightPx) {
    validateGrid(nx, ny);
    var w = Math.round(isFiniteNumber(widthPx) ? clamp(widthPx, 1, nx - 2) : nx * 0.075);
    var h = Math.round(isFiniteNumber(heightPx) ? clamp(heightPx, 1, ny - 2) : ny * 0.22);
    var x0 = Math.floor(nx * 0.30);
    var y0 = Math.floor(ny * 0.5 - h / 2);
    var mask = new Uint8Array(nx * ny);
    for (var j = Math.max(1, y0); j < Math.min(ny - 1, y0 + h); j++) {
      for (var i = Math.max(1, x0); i < Math.min(nx - 1, x0 + w); i++) {
        mask[indexOf(nx, i, j)] = 1;
      }
    }
    var b = maskBounds(mask, nx, ny);
    return attachMaskMetadata(mask, {
      kind: 'bluff', code: 'BLUFF', nx: nx, ny: ny, widthPx: w, heightPx: h,
      solidCount: b.count, bounds: b,
      projectedHeight: b.yMax - b.yMin + 1, referenceLength: b.yMax - b.yMin + 1, clipped: b.xMax - b.xMin + 1 < w, shape: 'Bluff body'
    });
  }

  /*
   * Venturi channel. Two symmetric constriction walls plus a smooth throat
   * produce accelerating flow with a favorable pressure recovery downstream.
   */
  function generateVenturiMask(nx, ny, throatRatio, lipFraction) {
    validateGrid(nx, ny);
    var tr = isFiniteNumber(throatRatio) ? clamp(throatRatio, 0.2, 0.85) : 0.5;
    var lip = isFiniteNumber(lipFraction) ? clamp(lipFraction, 0.05, 0.45) : 0.18;
    var mask = new Uint8Array(nx * ny);
    var half = ny / 2;
    var throatHalf = half * tr;
    var xPeak = nx * (0.28 + lip);
    var top = [];
    var lipStart = nx * 0.10;
    var lipEnd = nx * 0.90;
    var i;
    for (i = 0; i < nx; i++) {
      if (i <= lipStart) top.push(half * 0.94);
      else if (i <= xPeak) {
        var a = (i - lipStart) / (xPeak - lipStart);
        top.push(half * 0.94 - (half * 0.94 - throatHalf) * (0.5 - 0.5 * Math.cos(Math.PI * a)));
      } else if (i < lipEnd) {
        var b = (i - xPeak) / (lipEnd - xPeak);
        top.push(throatHalf + (half * 0.94 - throatHalf) * (0.5 - 0.5 * Math.cos(Math.PI * b)));
      } else {
        top.push(half * 0.94);
      }
    }
    for (i = 0; i < nx; i++) {
      var clearance = top[i];
      for (var j = 0; j < ny; j++) {
        if (j < half - clearance || j > half + clearance) mask[indexOf(nx, i, j)] = 1;
      }
    }
    /* Keep short inlet and outlet reservoirs fully open for the boundary rules. */
    var reservoir = Math.max(3, Math.round(nx * 0.04));
    for (i = 0; i < nx; i++) {
      if (i < reservoir || i >= nx - reservoir) {
        for (var jj = 0; jj < ny; jj++) mask[indexOf(nx, i, jj)] = 0;
      }
    }
    var bounds = maskBounds(mask, nx, ny);
    return attachMaskMetadata(mask, {
      kind: 'venturi', code: 'VENTURI', nx: nx, ny: ny,
      throatRatio: tr, lipFraction: lip, clearance: top,
      throatHeight: 2 * throatHalf, solidCount: bounds.count, bounds: bounds,
      projectedHeight: ny * (1 - tr), referenceLength: 2 * throatHalf,
      shape: 'Venturi channel'
    });
  }

  function generateObstacleMask(kind, options) {
    var o = options || {};
    var nx = o.nx == null ? 240 : o.nx;
    var ny = o.ny == null ? 100 : o.ny;
    var k = String(kind || '').toLowerCase();
    if (/^naca[0-9]{4}$/.test(k) || k === 'naca4' || k === 'airfoil' || /^[0-9]{4}$/.test(k)) {
      var code = /^naca[0-9]{4}$/.test(k) ? k.slice(4) : /^[0-9]{4}$/.test(k) ? k : (o.code || '0012');
      return generateNaca4Mask(code, o.chordPx == null ? nx * 0.32 : o.chordPx, o.angleDeg == null ? 0 : o.angleDeg, nx, ny);
    }
    if (k === 'cylinder' || k === 'karman') {
      return generateCylinderMask(o.radiusPx || ny * 0.055, nx, ny, o.centerX, o.centerY);
    }
    if (k === 'bluff' || k === 'plate') {
      return generateBluffBodyMask(nx, ny, o.widthPx, o.heightPx);
    }
    if (k === 'venturi' || k === 'nozzle') {
      return generateVenturiMask(nx, ny, o.throatRatio, o.lipFraction);
    }
    throw new RangeError('Unknown obstacle kind: ' + kind);
  }

  /* ---------------- D2Q9 BGK solver ---------------- */

  function effectiveParameters(u0, viscosity) {
    var u = clamp(isFiniteNumber(u0) ? u0 : 0.08, MIN_SPEED, MAX_SPEED);
    var nu = clamp(isFiniteNumber(viscosity) ? viscosity : 0.02, MIN_VISCOSITY, MAX_VISCOSITY);
    var tau = 3 * nu + 0.5;
    return {
      u0: u, viscosity: nu, tau: tau, omega: 1 / tau,
      clamped: (u !== u0) || (nu !== viscosity)
    };
  }

  function allocateFields(nx, ny) {
    var n = nx * ny;
    return {
      f: new Float64Array(n * Q9),
      fStar: new Float64Array(n * Q9),
      rho: new Float64Array(n),
      ux: new Float64Array(n),
      uy: new Float64Array(n)
    };
  }

  function initializeFlow(state) {
    var nx = state.nx;
    var ny = state.ny;
    var n = nx * ny;
    var eq = equilibriumArray(1, state.u0, 0);
    var eqRest = equilibriumArray(1, 0, 0);
    var i;
    var cell;
    var b;
    for (cell = 0; cell < n; cell++) {
      b = baseOf(cell);
      var solid = state.mask[cell] === 1;
      for (i = 0; i < Q9; i++) {
        state.f[b + i] = solid ? eqRest[i] : eq[i];
        state.fStar[b + i] = state.f[b + i];
      }
      state.rho[cell] = 1;
      state.ux[cell] = solid ? 0 : state.u0;
      state.uy[cell] = 0;
    }
    state.time = 0;
    state.forceX = 0;
    state.forceY = 0;
    state.forceHistory = [];
    state.unstable = false;
    state.sanitizedNodes = 0;
    state.lastSanitizedNodes = 0;
    state.stabilityStopped = false;
    state.initialFluidMass = state.cellCount - maskBounds(state.mask, nx, ny).count;
  }

  function createWindTunnel(nx, ny, u0, viscosity, options) {
    validateGrid(nx, ny);
    var o = options || {};
    var p = effectiveParameters(u0, viscosity);
    var obstacle = Object.prototype.hasOwnProperty.call(o, 'mask') ? o.mask : generateObstacleMask(o.obstacle || 'cylinder', {
      nx: nx, ny: ny, code: o.code, angleDeg: o.angleDeg,
      chordPx: o.chordPx, radiusPx: o.radiusPx, throatRatio: o.throatRatio
    });
    obstacle = validateMask(obstacle, nx, ny);
    var fields = allocateFields(nx, ny);
    var state = {
      version: VERSION,
      nx: nx, ny: ny, cellCount: nx * ny,
      u0: p.u0, viscosity: p.viscosity, tau: p.tau, omega: p.omega,
      cs2: CS2, rho0: 1,
      mask: obstacle, obstacle: obstacle,
      f: fields.f, fStar: fields.fStar,
      rho: fields.rho, ux: fields.ux, uy: fields.uy,
      inflowMode: o.inflowMode === 'equilibrium' ? 'equilibrium' : 'zou-he',
      outflowMode: o.outflowMode === 'equilibrium' ? 'equilibrium' : 'convective',
      wallMode: o.wallMode === 'free-slip' ? 'free-slip' : 'bounce-back',
      seed: isFiniteNumber(o.seed) ? o.seed : 1,
      perturbation: isFiniteNumber(o.perturbation) ? clamp(o.perturbation, 0, 0.02) : 0.0008,
      time: 0, forceX: 0, forceY: 0, forceHistory: [],
      unstable: false, sanitizedNodes: 0,
      parametersClamped: p.clamped
    };
    initializeFlow(state);
    state.referenceLength = positiveReference(obstacle.referenceLength, ny * 0.1);
    state.referenceHeight = positiveReference(obstacle.forceReferenceLength, positiveReference(obstacle.projectedHeight, ny * 0.1));
    state.reynolds = state.u0 * state.referenceLength / state.viscosity;
    return state;
  }

  function setObstacle(state, mask, reset) {
    mask = validateMask(mask, state.nx, state.ny);
    state.mask = mask;
    state.obstacle = mask;
    state.referenceLength = positiveReference(mask.referenceLength, state.ny * 0.1);
    state.referenceHeight = positiveReference(mask.forceReferenceLength, positiveReference(mask.projectedHeight, state.ny * 0.1));
    state.reynolds = state.u0 * state.referenceLength / state.viscosity;
    if (reset !== false) initializeFlow(state);
    else {
      for (var cell = 0; cell < state.cellCount; cell++) {
        if (mask[cell] === 1) {
          writeEquilibrium(state.f, baseOf(cell), 1, 0, 0);
          writeEquilibrium(state.fStar, baseOf(cell), 1, 0, 0);
          state.rho[cell] = 1; state.ux[cell] = 0; state.uy[cell] = 0;
        }
      }
      refreshMacroscopic(state, true);
      state.forceHistory = []; state.forceX = 0; state.forceY = 0;
      state.initialFluidMass = state.rho.reduce(function (sum, value, index) { return state.mask[index] === 1 ? sum : sum + value; }, 0);
    }
    return state;
  }

  function setFlowParameters(state, u0, viscosity) {
    var p = effectiveParameters(
      isFiniteNumber(u0) ? u0 : state.u0,
      isFiniteNumber(viscosity) ? viscosity : state.viscosity
    );
    state.u0 = p.u0;
    state.viscosity = p.viscosity;
    state.tau = p.tau;
    state.omega = p.omega;
    state.reynolds = state.u0 * state.referenceLength / state.viscosity;
    state.parametersClamped = p.clamped;
    initializeFlow(state);
    return state;
  }

  /* Macroscopic moments: rho = sum f_i, rho u = sum c_i f_i. */
  function refreshMacroscopic(state, sanitize) {
    var f = state.f, rhoArr = state.rho, uxArr = state.ux, uyArr = state.uy;
    var corrected = 0;
    for (var cell = 0; cell < state.cellCount; cell++) {
      var base = baseOf(cell);
      if (state.mask[cell] === 1) {
        writeEquilibrium(f, base, 1, 0, 0);
        rhoArr[cell] = 1; uxArr[cell] = 0; uyArr[cell] = 0;
        continue;
      }
      var rho = 0, mx = 0, my = 0, repair = false;
      for (var q = 0; q < Q9; q++) {
        var value = f[base + q];
        if (!isFiniteNumber(value) || value < MIN_POPULATION || value > MAX_POPULATION) {
          repair = true;
          value = W[q];
        }
        rho += value; mx += CX[q] * value; my += CY[q] * value;
      }
      if (rho < MIN_DENSITY || rho > MAX_DENSITY) repair = true;
      rho = clamp(rho, MIN_DENSITY, MAX_DENSITY);
      var ux = mx / rho, uy = my / rho;
      var speed = vectorLength(ux, uy);
      if (!isFiniteNumber(speed)) { ux = 0; uy = 0; repair = true; }
      else if (speed > MAX_LATTICE_SPEED) { ux *= MAX_LATTICE_SPEED / speed; uy *= MAX_LATTICE_SPEED / speed; repair = true; }
      /* A repair changes the populations and the moments together. */
      if (repair) { writeEquilibrium(f, base, rho, ux, uy); corrected++; }
      rhoArr[cell] = rho; uxArr[cell] = ux; uyArr[cell] = uy;
    }
    state.sanitizedNodes += corrected;
    state.lastSanitizedNodes = corrected;
    if (sanitize && corrected) state.unstable = true;
    return corrected;
  }

  function collide(state) {
    var f = state.f;
    var fs = state.fStar;
    var rhoArr = state.rho;
    var uxArr = state.ux;
    var uyArr = state.uy;
    var omega = state.omega;
    var n = state.cellCount;
    for (var cell = 0; cell < n; cell++) {
      var b = baseOf(cell);
      if (state.mask[cell] === 1) {
        for (var z = 0; z < Q9; z++) fs[b + z] = W[z];
        continue;
      }
      var rho = rhoArr[cell];
      var ux = uxArr[cell];
      var uy = uyArr[cell];
      for (var q = 0; q < Q9; q++) {
        var feq = equilibrium(rho, ux, uy, q);
        var value = f[b + q] + omega * (feq - f[b + q]);
        fs[b + q] = clamp(value, MIN_POPULATION, MAX_POPULATION);
      }
    }
  }

  /* Zou-He velocity inlet applied after streaming on the west column. */
  function applyInflow(state) {
    var nx = state.nx;
    var ny = state.ny;
    var f = state.f;
    var u0 = state.u0;
    var uy = 0;
    for (var j = 0; j < ny; j++) {
      var cell = indexOf(nx, 0, j);
      var b = baseOf(cell);
      if (state.mask[cell] === 1) { writeEquilibrium(f, b, 1, 0, 0); continue; }
      var f0 = f[b + 0];
      var f2 = f[b + 2];
      var f3 = f[b + 3];
      var f4 = f[b + 4];
      var f6 = f[b + 6];
      var f7 = f[b + 7];
      if (state.inflowMode === 'equilibrium') {
        writeEquilibrium(f, b, 1, u0, uy);
        continue;
      }
      var rho = (f0 + f2 + f4 + 2 * (f3 + f6 + f7)) / (1 - u0);
      rho = clamp(rho, MIN_DENSITY, MAX_DENSITY);
      f[b + 1] = f3 + (2 / 3) * rho * u0;
      f[b + 5] = f7 + (1 / 6) * rho * u0 - 0.5 * rho * uy + 0.5 * (f4 - f2);
      f[b + 8] = f6 + (1 / 6) * rho * u0 + 0.5 * rho * uy + 0.5 * (f2 - f4);
      if (f[b + 1] < MIN_POPULATION || f[b + 5] < MIN_POPULATION || f[b + 8] < MIN_POPULATION ||
          f[b + 1] > MAX_POPULATION || f[b + 5] > MAX_POPULATION || f[b + 8] > MAX_POPULATION) {
        writeEquilibrium(f, b, rho, u0, uy);
        state.unstable = true;
      }
      for (var q = 0; q < Q9; q++) f[b + q] = clamp(f[b + q], MIN_POPULATION, MAX_POPULATION);
    }
  }

  function applyOutflow(state) {
    var nx = state.nx;
    var ny = state.ny;
    var f = state.f;
    var fx = state.fStar;
    for (var j = 0; j < ny; j++) {
      var last = indexOf(nx, nx - 1, j);
      var prev = indexOf(nx, nx - 2, j);
      var bl = baseOf(last);
      var bp = baseOf(prev);
      if (state.mask[last] === 1) {
        for (var z = 0; z < Q9; z++) f[bl + z] = W[z];
        continue;
      }
      for (var q = 0; q < Q9; q++) {
        if (CX[q] < 0) {
          if (state.outflowMode === 'equilibrium') {
            var rho = state.rho[prev];
            var ux = state.ux[prev];
            var uy = state.uy[prev];
            f[bl + q] = equilibrium(clamp(rho, 0.9, 1.1), clamp(ux, -MAX_SPEED, MAX_SPEED), uy, q);
          } else {
            f[bl + q] = fx[bp + q];
          }
        }
      }
      for (var k = 0; k < Q9; k++) f[bl + k] = clamp(f[bl + k], MIN_POPULATION, MAX_POPULATION);
    }
  }

  /*
   * Pull streaming. When the source site is solid, the post-collision
   * population in the opposite direction is reflected (halfway bounce-back),
   * which imposes the no-slip condition on the obstacle surface. The same
   * reflected population supplies the momentum-exchange force on the body.
   */
  function stream(state) {
    var nx = state.nx;
    var ny = state.ny;
    var f = state.f;
    var fs = state.fStar;
    var mask = state.mask;
    var fx = 0;
    var fy = 0;
    var freeSlip = state.wallMode === 'free-slip';
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var cell = indexOf(nx, i, j);
        var b = baseOf(cell);
        var solid = mask[cell] === 1;
        for (var q = 0; q < Q9; q++) {
          var srcI = i - CX[q];
          var srcJ = j - CY[q];
          if (solid) {
            f[b + q] = W[q];
            continue;
          }
          if (srcI < 0 || srcI >= nx) {
            /* Inflow and outflow columns are patched after streaming. */
            f[b + q] = fs[b + q];
            continue;
          }
          if (srcJ < 0 || srcJ >= ny) {
            if (freeSlip) {
              var sq = OPP_Y[q];
              var mirrorI = i - CX[sq];
              if (mirrorI >= 0 && mirrorI < nx && mask[indexOf(nx, mirrorI, j)] !== 1) {
                f[b + q] = fs[baseOf(indexOf(nx, mirrorI, j)) + sq];
              } else {
                f[b + q] = fs[b + OPP[q]];
              }
            } else {
              f[b + q] = fs[b + OPP[q]];
            }
            continue;
          }
          var srcCell = indexOf(nx, srcI, srcJ);
          if (mask[srcCell] === 1) {
            var d = OPP[q];
            var reflect = fs[b + d];
            f[b + q] = reflect;
            fx += 2 * CX[d] * reflect;
            fy += 2 * CY[d] * reflect;
          } else {
            f[b + q] = fs[baseOf(srcCell) + q];
          }
        }
      }
    }
    state.forceX = fx;
    state.forceY = fy;
  }

  function applyPerturbation(state) {
    /* Tiny deterministic transverse kick seeds the Karman vortex street. */
    if (state.perturbation <= 0 || state.time !== 0 || !state.mask.bounds.count) return;
    var nx = state.nx;
    var ny = state.ny;
    var b = state.mask.bounds || maskBounds(state.mask, nx, ny);
    var cx = Math.min(nx - 3, b.xMax + 3);
    var cy = Math.floor(ny / 2);
    for (var j = Math.max(1, cy - 3); j <= Math.min(ny - 2, cy + 3); j++) {
      var cell = indexOf(nx, cx, j);
      if (state.mask[cell] === 1) continue;
      var d = state.perturbation * Math.sin((j - cy) * 1.3 + state.seed);
      state.uy[cell] += d;
      writeEquilibrium(state.f, baseOf(cell), state.rho[cell], state.ux[cell], state.uy[cell]);
    }
  }

  function recordForce(state) {
    var q = 0.5 * state.rho0 * state.u0 * state.u0 * state.referenceHeight;
    var cd = state.forceX / q;
    var cl = -state.forceY / q;
    var entry = {
      step: state.time,
      fx: state.forceX,
      fy: state.forceY,
      cd: cd,
      cl: cl,
      ld: Math.abs(cd) > 1e-9 ? cl / cd : 0
    };
    state.forceHistory.push(entry);
    if (state.forceHistory.length > HISTORY_LIMIT) state.forceHistory.shift();
    return entry;
  }

  /* Performs `steps` collision and streaming cycles. */
  function stepLBM(state, steps) {
    var count = steps == null ? 1 : steps;
    if (!Number.isInteger(count) || count < 0 || count > 100000) throw new RangeError('steps must be an integer between 0 and 100000');
    if (state.stabilityStopped) throw new RangeError('Solver stopped at its stability limit. Reset with lower speed or higher viscosity.');
    if (count === 0) return state;
    var s;
    for (s = 0; s < count; s++) {
      applyPerturbation(state);
      refreshMacroscopic(state, true);
      collide(state);
      stream(state);
      applyInflow(state);
      applyOutflow(state);
      state.time += 1;
      if (state.time % 5 === 0 || state.time === 1) recordForce(state);
      if (state.unstable && state.sanitizedNodes > state.cellCount * 4) {
        state.stabilityStopped = true;
        refreshMacroscopic(state, true);
        throw new RangeError('Numerical stability limit reached at step ' + state.time + '. Increase viscosity or lower inflow speed.');
      }
    }
    refreshMacroscopic(state, true);
    return state;
  }

  /* ---------------- Field diagnostics ---------------- */

  function derivative(arr, nx, ny, i, j, axis, mask) {
    var cell = indexOf(nx, i, j);
    var lo = axis === 0 ? i - 1 : j - 1;
    var hi = axis === 0 ? i + 1 : j + 1;
    var limit = axis === 0 ? nx : ny;
    var left = axis === 0 ? cell - 1 : cell - nx;
    var right = axis === 0 ? cell + 1 : cell + nx;
    var hasLeft = lo >= 0 && mask[left] !== 1;
    var hasRight = hi < limit && mask[right] !== 1;
    var span = Number(hasLeft) + Number(hasRight);
    if (!span) return 0;
    return ((hasRight ? arr[right] : arr[cell]) - (hasLeft ? arr[left] : arr[cell])) / span;
  }

  function computeFields(state) {
    var nx = state.nx;
    var ny = state.ny;
    var n = state.cellCount;
    var speed = new Float64Array(n);
    var curl = new Float64Array(n);
    var vorticity = new Float64Array(n);
    var cp = new Float64Array(n);
    var schlieren = new Float64Array(n);
    var mask = state.mask;
    var ux = state.ux;
    var uy = state.uy;
    var rho = state.rho;
    var dynamicPressure = 0.5 * state.rho0 * state.u0 * state.u0;
    var i;
    var j;
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        var cell = indexOf(nx, i, j);
        if (mask[cell] === 1) continue;
        var vx = ux[cell];
        var vy = uy[cell];
        /* One-sided differences use the actual fluid stencil at solids and edges. */
        curl[cell] = derivative(uy, nx, ny, i, j, 0, mask) - derivative(ux, nx, ny, i, j, 1, mask);
        vorticity[cell] = -curl[cell];
        var drx = derivative(rho, nx, ny, i, j, 0, mask);
        var dry = derivative(rho, nx, ny, i, j, 1, mask);
        schlieren[cell] = vectorLength(drx, dry);
        speed[cell] = Math.sqrt(vx * vx + vy * vy);
        cp[cell] = ((rho[cell] - state.rho0) * CS2) / dynamicPressure;
      }
    }
    return { speed: speed, curl: curl, vorticity: vorticity, cp: cp, schlieren: schlieren };
  }

  function centerlineProfile(state, fields) {
    var nx = state.nx;
    var j = Math.floor(state.ny / 2);
    var out = [];
    var f = fields || computeFields(state);
    for (var i = 0; i < nx; i++) {
      var cell = indexOf(nx, i, j);
      if (state.mask[cell] === 1) continue;
      out.push({
        x: i, y: j,
        ux: round(state.ux[cell], 6), uy: round(state.uy[cell], 6),
        speed: round(f.speed[cell], 6),
        cp: round(f.cp[cell], 6),
        curl: round(f.curl[cell], 6),
        rho: round(state.rho[cell], 6)
      });
    }
    return out;
  }

  function wakeProfile(state, xFraction, fields) {
    var xf = isFiniteNumber(xFraction) ? clamp(xFraction, 0, 1) : 0.75;
    var x = Math.min(state.nx - 2, Math.max(1, Math.round(state.nx * xf)));
    var f = fields || computeFields(state);
    var out = [];
    for (var j = 0; j < state.ny; j++) {
      var cell = indexOf(state.nx, x, j);
      out.push({
        x: x, y: j,
        ux: round(state.ux[cell], 6), uy: round(state.uy[cell], 6),
        speed: round(f.speed[cell], 6),
        cp: round(f.cp[cell], 6),
        curl: round(f.curl[cell], 6),
        rho: round(state.rho[cell], 6),
        solid: state.mask[cell] === 1 ? 1 : 0
      });
    }
    return { x: x, xFraction: xf, samples: out };
  }

  /*
   * Momentum-exchange force with a running time average. Vortex shedding makes
   * the instantaneous lift oscillate; the windowed mean is the stable estimate
   * of the section coefficient, while the instantaneous value drives charts.
   */
  function computeForceCoefficients(state) {
    var q = 0.5 * state.rho0 * state.u0 * state.u0 * state.referenceHeight;
    var cd = state.forceX / q;
    var cl = -state.forceY / q;
    var window = state.forceHistory.slice(-160);
    var meanFx = 0;
    var meanFy = 0;
    if (window.length === 0) {
      meanFx = state.forceX;
      meanFy = state.forceY;
    } else {
      for (var k = 0; k < window.length; k++) {
        meanFx += window[k].fx;
        meanFy += window[k].fy;
      }
      meanFx /= window.length;
      meanFy /= window.length;
    }
    var meanCd = meanFx / q;
    var meanCl = -meanFy / q;
    return {
      fx: state.forceX,
      fy: state.forceY,
      cd: cd,
      cl: cl,
      ld: Math.abs(cd) > 1e-9 ? cl / cd : 0,
      meanFx: meanFx,
      meanFy: meanFy,
      meanCd: meanCd,
      meanCl: meanCl,
      meanLd: Math.abs(meanCd) > 1e-9 ? meanCl / meanCd : 0,
      samples: window.length,
      dynamicPressure: q,
      referenceHeight: state.referenceHeight
    };
  }

  function computeDiagnostics(state) {
    var n = state.cellCount;
    var fields = computeFields(state);
    var forces = computeForceCoefficients(state);
    var maxSpeed = 0;
    var maxCurl = 0;
    var minCp = Infinity;
    var maxCp = -Infinity;
    var sumSpeed = 0;
    var sumVorticity = 0;
    var fluid = 0;
    var fluidMass = 0, kineticEnergy = 0, minDensity = Infinity, maxDensity = -Infinity;
    var inletFlux = 0, outletFlux = 0, inletResidual = 0, nonFiniteNodes = 0;
    for (var cell = 0; cell < n; cell++) {
      if (state.mask[cell] === 1) continue;
      fluid++;
      var density = state.rho[cell];
      fluidMass += density;
      minDensity = Math.min(minDensity, density); maxDensity = Math.max(maxDensity, density);
      var s = fields.speed[cell];
      var c = fields.curl[cell];
      var p = fields.cp[cell];
      if (!isFiniteNumber(s) || !isFiniteNumber(c) || !isFiniteNumber(p) || !isFiniteNumber(density)) nonFiniteNodes++;
      kineticEnergy += 0.5 * density * s * s;
      if (cell % state.nx === 0) {
        inletFlux += density * state.ux[cell];
        inletResidual = Math.max(inletResidual, Math.abs(state.ux[cell] - state.u0), Math.abs(state.uy[cell]));
      }
      if (cell % state.nx === state.nx - 1) outletFlux += density * state.ux[cell];
      if (s > maxSpeed) maxSpeed = s;
      if (Math.abs(c) > maxCurl) maxCurl = Math.abs(c);
      if (p < minCp) minCp = p;
      if (p > maxCp) maxCp = p;
      sumSpeed += s;
      sumVorticity += Math.abs(c);
    }
    if (fluid === 0) { minCp = 0; maxCp = 0; }
    var wake = wakeProfile(state, 0.75, fields);
    var wakeDeficit = 0;
    var wakeSamples = 0;
    for (var k = 0; k < wake.samples.length; k++) {
      if (wake.samples[k].solid) continue;
      wakeDeficit += Math.max(0, state.u0 - wake.samples[k].ux);
      wakeSamples++;
    }
    return {
      nx: state.nx, ny: state.ny, time: state.time,
      u0: state.u0, viscosity: state.viscosity, tau: state.tau, omega: state.omega,
      reynolds: state.u0 * state.referenceLength / state.viscosity,
      referenceLength: state.referenceLength,
      maxSpeed: maxSpeed,
      meanSpeed: fluid > 0 ? sumSpeed / fluid : 0,
      maxAbsCurl: maxCurl,
      meanAbsCurl: fluid > 0 ? sumVorticity / fluid : 0,
      minCp: minCp, maxCp: maxCp,
      cd: forces.cd, cl: forces.cl, ld: forces.ld,
      meanCd: forces.meanCd, meanCl: forces.meanCl, meanLd: forces.meanLd,
      fx: forces.fx, fy: forces.fy,
      wakeDeficit: wakeSamples > 0 ? wakeDeficit / wakeSamples : 0,
      unstable: state.unstable,
      sanitizedNodes: state.sanitizedNodes,
      lastSanitizedNodes: state.lastSanitizedNodes,
      stabilityStopped: state.stabilityStopped,
      fluidCount: fluid, fluidMass: fluidMass, kineticEnergy: kineticEnergy,
      minDensity: minDensity, maxDensity: maxDensity,
      maxMach: maxSpeed / Math.sqrt(CS2),
      massChangeFraction: (fluidMass - state.initialFluidMass) / state.initialFluidMass,
      inletFlux: inletFlux, outletFlux: outletFlux,
      fluxImbalanceFraction: Math.abs(inletFlux) > 1e-12 ? (inletFlux - outletFlux) / inletFlux : 0,
      inletResidual: inletResidual, nonFiniteNodes: nonFiniteNodes,
      coefficientReference: state.referenceHeight,
      fields: fields,
      centerline: centerlineProfile(state, fields),
      wake: wake,
      forceHistory: state.forceHistory.slice()
    };
  }

  /* ---------------- Telemetry export ---------------- */

  function surfacePressureProfile(state, fields) {
    var mask = state.mask;
    if (mask.kind !== 'naca4' || !mask.coordinates) return { rows: [], clPressure: null, cdPressure: null, convention: 'NACA surface only' };
    var coords = mask.coordinates, chord = mask.chordPx;
    var angle = mask.angleDeg * Math.PI / 180, ca = Math.cos(angle), sa = Math.sin(angle);
    var cp = (fields || computeFields(state)).cp;
    var upper = [], lower = [], rows = [];
    function surfacePoint(point) {
      var x = (point.x - 0.25) * chord, y = -point.y * chord;
      return { x: 0.32 * state.nx + x * ca - y * sa, y: 0.5 * state.ny + x * sa + y * ca };
    }
    function sample(point, normalX, normalY) {
      for (var distance = 1.5; distance <= 6; distance += 0.5) {
        var x = point.x + normalX * distance - 0.5, y = point.y + normalY * distance - 0.5;
        var i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
        var value = 0, weight = 0;
        for (var di = 0; di <= 1; di++) for (var dj = 0; dj <= 1; dj++) {
          var ii = i + di, jj = j + dj;
          if (ii < 0 || ii >= state.nx || jj < 0 || jj >= state.ny) continue;
          var cell = indexOf(state.nx, ii, jj);
          if (mask[cell] === 1) continue;
          var w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy);
          value += w * cp[cell]; weight += w;
        }
        if (weight > 0.95) return value / weight;
      }
      return null;
    }
    for (var k = 0; k < coords.upper.length; k++) {
      var theta = Math.atan(coords.camberLine[k].slope);
      var nx = -Math.sin(theta), ny = -Math.cos(theta);
      var rx = nx * ca - ny * sa, ry = nx * sa + ny * ca;
      var u = surfacePoint(coords.upper[k]), l = surfacePoint(coords.lower[k]);
      var cpu = sample(u, rx, ry), cpl = sample(l, -rx, -ry);
      if (cpu == null || cpl == null) continue;
      rows.push({ xc: coords.camberLine[k].x, cpUpper: cpu, cpLower: cpl });
      upper.push({ x: u.x, y: u.y, cp: cpu }); lower.push({ x: l.x, y: l.y, cp: cpl });
    }
    var contour = upper.concat(lower.reverse()), cl = 0, cd = 0;
    for (var index = 0; index < contour.length; index++) {
      var a = contour[index], b = contour[(index + 1) % contour.length], pressure = 0.5 * (a.cp + b.cp);
      cd -= pressure * (b.y - a.y) / chord;
      cl -= pressure * (b.x - a.x) / chord;
    }
    return { rows: rows, clPressure: rows.length > 1 ? cl : null, cdPressure: rows.length > 1 ? cd : null, convention: 'Closed-contour pressure force / (dynamic pressure * chord), sampled 1.5 to 6 cells along surface normals; excludes shear' };
  }

  var SCENARIOS = {
    symmetric: { id: 'symmetric', label: 'Symmetry baseline', obstacle: 'naca0012', code: '0012', angleDeg: 0, u0: 0.06, viscosity: 0.026, chordPx: 72, field: 'cp', warmupSteps: 240, description: 'A symmetric section at zero incidence. Compare upper and lower pressure and near-zero lift.' },
    lift: { id: 'lift', label: 'Make lift visible', obstacle: 'naca2412', code: '2412', angleDeg: 8, u0: 0.07, viscosity: 0.024, chordPx: 77, field: 'cp', warmupSteps: 240, description: 'Camber and incidence build a measurable pressure difference. Inspect pressure and link forces.' },
    wake: { id: 'wake', label: 'Follow a vortex wake', obstacle: 'cylinder', angleDeg: 0, u0: 0.085, viscosity: 0.01, chordPx: 77, field: 'curl', warmupSteps: 400, description: 'A cylinder creates separated shear layers. Probe velocity deficit and opposite vorticity signs.' },
    venturi: { id: 'venturi', label: 'Accelerate through a throat', obstacle: 'venturi', angleDeg: 0, u0: 0.045, viscosity: 0.03, chordPx: 77, field: 'speed', warmupSteps: 240, description: 'A narrowing channel accelerates flow. Move the probe from inlet to throat and compare speeds.' }
  };
  function getScenario(id) { if (!Object.prototype.hasOwnProperty.call(SCENARIOS, id)) throw new RangeError('Unknown scenario: ' + id); return JSON.parse(JSON.stringify(SCENARIOS[id])); }
  function listScenarios() { return Object.keys(SCENARIOS).map(getScenario); }

  function csvEscape(value) {
    var s = String(value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportWakeProfileCSV(state, xFraction) {
    var wake = wakeProfile(state, xFraction);
    var rows = ['y,ux,uy,speed,rho,cp,curl,solid'];
    for (var k = 0; k < wake.samples.length; k++) {
      var s = wake.samples[k];
      var values = [s.y, s.ux, s.uy, s.speed, s.rho, s.cp, s.curl, s.solid];
      if (values.some(function (value) { return !isFiniteNumber(value); })) throw new RangeError('Cannot export nonfinite wake CSV');
      rows.push(values.map(csvEscape).join(','));
    }
    return rows.join('\n') + '\n';
  }

  function exportForceHistoryCSV(state) {
    var rows = ['step,fx,fy,cd,cl,ld'];
    for (var k = 0; k < state.forceHistory.length; k++) {
      var e = state.forceHistory[k];
      var values = [e.step, e.fx, e.fy, e.cd, e.cl, e.ld];
      if (values.some(function (value) { return !isFiniteNumber(value); })) throw new RangeError('Cannot export nonfinite force CSV');
      rows.push(values.map(csvEscape).join(','));
    }
    return rows.join('\n') + '\n';
  }

  function exportSnapshotJSON(state, options) {
    var o = options || {};
    var d = computeDiagnostics(state);
    var includeFields = o.includeFields !== false;
    var n = state.cellCount;
    var snapshot = {
      format: 'spectralflow-snapshot',
      version: VERSION,
      schemaVersion: 2,
      generatedBy: 'SpectralFlow D2Q9 BGK solver',
      simulation: {
        nx: state.nx, ny: state.ny, time: state.time,
        u0: state.u0, viscosity: state.viscosity, tau: state.tau,
        omega: state.omega, reynolds: d.reynolds,
        inflowMode: state.inflowMode, outflowMode: state.outflowMode, wallMode: state.wallMode,
        seed: state.seed, perturbation: state.perturbation,
        referenceLength: state.referenceLength, coefficientReference: state.referenceHeight,
        initialFluidMass: state.initialFluidMass,
        obstacle: {
          kind: state.obstacle.kind || 'custom',
          code: state.obstacle.code || '',
          shape: state.obstacle.shape || 'custom',
          solidCount: state.obstacle.solidCount || 0,
          angleDeg: finite(state.obstacle.angleDeg, 0),
          chordPx: finite(state.obstacle.chordPx, 0)
        },
        unstable: state.unstable,
        sanitizedNodes: state.sanitizedNodes
      },
      diagnostics: {
        cd: round(d.cd, 6), cl: round(d.cl, 6), ld: round(d.ld, 6),
        meanCd: round(d.meanCd, 6), meanCl: round(d.meanCl, 6),
        meanLd: round(d.meanLd, 6),
        fx: d.fx, fy: d.fy,
        reynolds: round(d.reynolds, 4),
        maxSpeed: round(d.maxSpeed, 6), meanSpeed: round(d.meanSpeed, 6),
        maxAbsCurl: round(d.maxAbsCurl, 6), meanAbsCurl: round(d.meanAbsCurl, 6),
        minCp: round(d.minCp, 6), maxCp: round(d.maxCp, 6),
        wakeDeficit: round(d.wakeDeficit, 6)
      },
      wakeProfile: { x: d.wake.x, xFraction: d.wake.xFraction, samples: d.wake.samples },
      centerlineProfile: d.centerline,
      forceHistory: d.forceHistory
    };
    snapshot.simulation.stabilityStopped = state.stabilityStopped;
    snapshot.simulation.obstacle.coefficientConvention = state.obstacle.coefficientConvention || 'projected height times unit span';
    snapshot.simulation.obstacle.projectedHeight = positiveReference(state.obstacle.projectedHeight, state.referenceHeight);
    snapshot.simulation.obstacle.clipped = !!state.obstacle.clipped;
    snapshot.diagnostics.fluidMass = d.fluidMass;
    snapshot.diagnostics.inletResidual = d.inletResidual;
    snapshot.diagnostics.maxMach = d.maxMach;
    if (d.nonFiniteNodes) throw new RangeError('Cannot export nonfinite fluid fields');
    if (includeFields) {
      snapshot.fields = {
        layout: 'row-major, j from 0 to ny-1, i from 0 to nx-1',
        keys: ['rho', 'ux', 'uy', 'speed', 'cp', 'curl', 'solid'],
        rho: Array.prototype.map.call(state.rho, function (v) { return round(v, 5); }),
        ux: Array.prototype.map.call(state.ux, function (v) { return round(v, 5); }),
        uy: Array.prototype.map.call(state.uy, function (v) { return round(v, 5); }),
        speed: Array.prototype.map.call(d.fields.speed, function (v) { return round(v, 5); }),
        cp: Array.prototype.map.call(d.fields.cp, function (v) { return round(v, 5); }),
        curl: Array.prototype.map.call(d.fields.curl, function (v) { return round(v, 5); }),
        solid: Array.prototype.slice.call(state.mask).map(function (v) { return v ? 1 : 0; })
      };
      if (snapshot.fields.rho.length !== n) throw new Error('Field export length mismatch');
      snapshot.fields.keys.forEach(function (key) { if (snapshot.fields[key].some(function (value) { return !isFiniteNumber(value); })) throw new RangeError('Cannot export nonfinite ' + key + ' fields'); });
    }
    if (o.includePopulations) {
      snapshot.populations = Array.prototype.slice.call(state.f);
      if (snapshot.populations.some(function (value) { return !isFiniteNumber(value); })) throw new RangeError('Cannot export nonfinite populations');
    }
    return JSON.stringify(snapshot, null, 2);
  }

  function importSnapshotJSON(source) {
    var snapshot = typeof source === 'string' ? JSON.parse(source) : source;
    if (!snapshot || snapshot.format !== 'spectralflow-snapshot' || snapshot.schemaVersion !== 2) throw new RangeError('Unsupported SpectralFlow checkpoint schema');
    var s = snapshot.simulation;
    if (!s || !snapshot.fields || !Array.isArray(snapshot.fields.solid) || !Array.isArray(snapshot.populations)) throw new RangeError('A resumable checkpoint needs fields and populations');
    validateGrid(s.nx, s.ny);
    if (!Number.isSafeInteger(s.time) || s.time < 0 || !isFiniteNumber(s.u0) || s.u0 < MIN_SPEED || s.u0 > MAX_SPEED || !isFiniteNumber(s.viscosity) || s.viscosity < MIN_VISCOSITY || s.viscosity > MAX_VISCOSITY) throw new RangeError('Invalid checkpoint operating conditions');
    if (!isFiniteNumber(s.seed) || !isFiniteNumber(s.perturbation) || s.perturbation < 0 || s.perturbation > 0.02) throw new RangeError('Invalid checkpoint disturbance parameters');
    ['rho', 'ux', 'uy', 'speed', 'cp', 'curl', 'solid'].forEach(function (key) {
      var array = snapshot.fields[key];
      if (!Array.isArray(array) || array.length !== s.nx * s.ny || array.some(function (value) { return !isFiniteNumber(value); })) throw new RangeError('Invalid checkpoint field array: ' + key);
    });
    if (['zou-he', 'equilibrium'].indexOf(s.inflowMode) < 0 || ['convective', 'equilibrium'].indexOf(s.outflowMode) < 0 || ['bounce-back', 'free-slip'].indexOf(s.wallMode) < 0) throw new RangeError('Invalid checkpoint boundary conditions');
    if (snapshot.populations.length !== s.nx * s.ny * Q9 || snapshot.populations.some(function (value) { return !isFiniteNumber(value) || value < MIN_POPULATION || value > MAX_POPULATION; })) throw new RangeError('Invalid checkpoint population array');
    var mask = validateMask(snapshot.fields.solid, s.nx, s.ny);
    var metadata = s.obstacle || {};
    if (metadata.kind === 'naca4') {
      var geometry = generateNaca4Mask(metadata.code, metadata.chordPx, metadata.angleDeg, s.nx, s.ny);
      ['coordinates', 'polygon', 'maxCamber', 'camberPosition', 'thickness', 'projectedHeight'].forEach(function (key) { mask[key] = geometry[key]; });
    }
    ['kind', 'code', 'shape', 'angleDeg', 'chordPx', 'coefficientConvention', 'clipped'].forEach(function (key) { if (metadata[key] != null) mask[key] = metadata[key]; });
    var maximumReference = Math.max(s.nx, s.ny) * 4;
    if (!isFiniteNumber(s.referenceLength) || s.referenceLength <= 0 || s.referenceLength > maximumReference || !isFiniteNumber(s.coefficientReference) || s.coefficientReference <= 0 || s.coefficientReference > maximumReference) throw new RangeError('Invalid checkpoint reference lengths');
    mask.referenceLength = s.referenceLength; mask.forceReferenceLength = s.coefficientReference;
    if (!mask.projectedHeight) mask.projectedHeight = s.coefficientReference;
    var state = createWindTunnel(s.nx, s.ny, s.u0, s.viscosity, { mask: mask, inflowMode: s.inflowMode, outflowMode: s.outflowMode, wallMode: s.wallMode, seed: s.seed, perturbation: s.perturbation });
    state.f.set(snapshot.populations); state.fStar.set(snapshot.populations);
    if (refreshMacroscopic(state, true)) throw new RangeError('Checkpoint populations require numerical repair');
    var derived = computeFields(state);
    ['rho', 'ux', 'uy', 'speed', 'cp', 'curl'].forEach(function (key) {
      var array = state[key] || derived[key];
      if (snapshot.fields[key].some(function (value, index) { return Math.abs(value - array[index]) > 0.000005001; })) throw new RangeError('Checkpoint fields disagree with populations: ' + key);
    });
    state.time = s.time;
    state.forceHistory = Array.isArray(snapshot.forceHistory) ? snapshot.forceHistory.slice(-HISTORY_LIMIT).map(function (entry) {
      if (!entry || !Number.isInteger(entry.step) || entry.step < 0 || entry.step > s.time || ['fx', 'fy', 'cd', 'cl', 'ld'].some(function (key) { return !isFiniteNumber(entry[key]); })) throw new RangeError('Invalid checkpoint force history');
      return { step: entry.step, fx: entry.fx, fy: entry.fy, cd: entry.cd, cl: entry.cl, ld: entry.ld };
    }) : [];
    if (!snapshot.diagnostics || !isFiniteNumber(snapshot.diagnostics.fx) || !isFiniteNumber(snapshot.diagnostics.fy)) throw new RangeError('Invalid checkpoint force balance');
    state.forceX = snapshot.diagnostics.fx; state.forceY = snapshot.diagnostics.fy;
    state.unstable = !!s.unstable; state.stabilityStopped = !!s.stabilityStopped;
    state.sanitizedNodes = Number.isInteger(s.sanitizedNodes) && s.sanitizedNodes >= 0 ? s.sanitizedNodes : 0;
    if (!isFiniteNumber(s.initialFluidMass) || s.initialFluidMass <= 0 || s.initialFluidMass > state.cellCount * MAX_DENSITY) throw new RangeError('Invalid checkpoint initial mass');
    state.initialFluidMass = s.initialFluidMass;
    return state;
  }

  function verifySnapshotRoundTrip(state) {
    var restored = importSnapshotJSON(exportSnapshotJSON(state, { includePopulations: true }));
    var error = 0;
    for (var i = 0; i < state.f.length; i++) error = Math.max(error, Math.abs(state.f[i] - restored.f[i]));
    return { passes: error === 0 && restored.time === state.time, maxPopulationError: error, populations: state.f.length, cells: state.cellCount, time: state.time };
  }

  function sampleField(state, i, j, fields) {
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || i >= state.nx || j < 0 || j >= state.ny) throw new RangeError('Probe coordinates must be lattice indices inside the grid');
    var cell = indexOf(state.nx, i, j), f = fields || computeFields(state);
    return { i: i, j: j, solid: state.mask[cell] === 1, rho: state.rho[cell], ux: state.ux[cell], uy: state.uy[cell], speed: f.speed[cell], cp: f.cp[cell], vorticity: -f.curl[cell], schlieren: f.schlieren[cell] };
  }

  function exportFieldCSV(state) {
    var fields = computeFields(state);
    var rows = ['i,j,rho,ux,uy,speed,cp,vorticity,solid'];
    for (var j = 0; j < state.ny; j++) for (var i = 0; i < state.nx; i++) {
      var cell = j * state.nx + i;
      var row = [i, j, state.rho[cell], state.ux[cell], state.uy[cell], fields.speed[cell], fields.cp[cell], -fields.curl[cell], state.mask[cell]];
      if (row.some(function (value) { return !isFiniteNumber(value); })) throw new RangeError('Cannot export nonfinite field CSV');
      rows.push(row.map(csvEscape).join(','));
    }
    return rows.join('\n') + '\n';
  }

  /* ---------------- Public API ---------------- */

  var api = {
    VERSION: VERSION,
    CX: CX.slice(), CY: CY.slice(), W: W.slice(), OPP: OPP.slice(),
    Q9: Q9, CS2: CS2,
    LIMITS: {
      minViscosity: MIN_VISCOSITY, maxViscosity: MAX_VISCOSITY,
      minSpeed: MIN_SPEED, maxSpeed: MAX_SPEED,
      maxLatticeSpeed: MAX_LATTICE_SPEED,
      maxCells: MAX_CELLS,
      minDensity: MIN_DENSITY, maxDensity: MAX_DENSITY
    },
    equilibrium: equilibrium,
    equilibriumArray: equilibriumArray,
    parseNaca4: parseNaca4,
    naca4Thickness: naca4Thickness,
    naca4Camber: naca4Camber,
    naca4CamberSlope: naca4CamberSlope,
    naca4Coordinates: naca4Coordinates,
    polygonFromCoordinates: polygonFromCoordinates,
    pointInPolygon: pointInPolygon,
    generateNaca4Mask: generateNaca4Mask,
    generateCylinderMask: generateCylinderMask,
    generateBluffBodyMask: generateBluffBodyMask,
    generateVenturiMask: generateVenturiMask,
    generateObstacleMask: generateObstacleMask,
    maskBounds: maskBounds,
    createWindTunnel: createWindTunnel,
    setObstacle: setObstacle,
    setFlowParameters: setFlowParameters,
    initializeFlow: initializeFlow,
    refreshMacroscopic: refreshMacroscopic,
    stepLBM: stepLBM,
    computeFields: computeFields,
    computeForceCoefficients: computeForceCoefficients,
    computeDiagnostics: computeDiagnostics,
    centerlineProfile: centerlineProfile,
    wakeProfile: wakeProfile,
    exportWakeProfileCSV: exportWakeProfileCSV,
    exportForceHistoryCSV: exportForceHistoryCSV,
    exportSnapshotJSON: exportSnapshotJSON,
    importSnapshotJSON: importSnapshotJSON,
    verifySnapshotRoundTrip: verifySnapshotRoundTrip,
    exportFieldCSV: exportFieldCSV,
    sampleField: sampleField,
    surfacePressureProfile: surfacePressureProfile,
    getScenario: getScenario,
    listScenarios: listScenarios,
    csvEscape: csvEscape
  };

  return api;
});
