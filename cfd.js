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

  var VERSION = '1.0.0';

  /* Screen grid: i grows right, j grows down. Direction 2 is north (j - 1). */
  var CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
  var CY = [0, 0, -1, 0, 1, -1, -1, 1, 1];
  var W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
  var OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
  var OPP_Y = [0, 1, 4, 3, 2, 8, 7, 6, 5];
  var CS2 = 1 / 3;
  var Q9 = 9;
  var HISTORY_LIMIT = 720;

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
  function finite(v, fallback) { return Number.isFinite(v) ? v : fallback; }
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
    var n = Number.isFinite(samples) ? Math.max(8, Math.floor(samples)) : 120;
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
  }

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
    var chord = Number.isFinite(chordPx) ? clamp(chordPx, 4, Math.min(nx, ny) * 4) : nx * 0.32;
    var angle = Number.isFinite(angleDeg) ? clamp(angleDeg, -45, 45) * Math.PI / 180 : 0;
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
    /* Analytical projected frontal height is used as the reference area. */
    var ae = Math.atan(naca4CamberSlope(0, spec.maxCamber, spec.camberPosition));
    var projected = Math.abs(Math.sin(angle + ae)) * chord +
      coords.maxThickness * 2 * chord * Math.abs(Math.cos(angle + ae));
    return attachMaskMetadata(mask, {
      kind: 'naca4', code: spec.code, chordPx: chord, angleDeg: angle * 180 / Math.PI,
      nx: nx, ny: ny, solidCount: b.count, bounds: b,
      projectedHeight: Math.max(1, projected),
      referenceLength: chord,
      polygon: physical, coordinates: coords,
      maxCamber: spec.maxCamber, camberPosition: spec.camberPosition,
      thickness: spec.thickness, shape: 'NACA ' + spec.code
    });
  }

  function generateCylinderMask(radiusPx, nx, ny, centerX, centerY) {
    validateGrid(nx, ny);
    var r = Number.isFinite(radiusPx) ? clamp(radiusPx, 2, Math.min(nx, ny) / 3) : Math.max(3, ny * 0.055);
    var cx = Number.isFinite(centerX) ? centerX : nx * 0.28;
    var cy = Number.isFinite(centerY) ? centerY : ny * 0.5;
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
    var w = Number.isFinite(widthPx) ? widthPx : nx * 0.075;
    var h = Number.isFinite(heightPx) ? heightPx : ny * 0.22;
    var x0 = Math.floor(nx * 0.30);
    var y0 = Math.floor(ny * 0.5 - h / 2);
    var mask = new Uint8Array(nx * ny);
    for (var j = Math.max(1, y0); j <= Math.min(ny - 2, y0 + h); j++) {
      for (var i = Math.max(1, x0); i <= Math.min(nx - 2, x0 + w); i++) {
        mask[indexOf(nx, i, j)] = 1;
      }
    }
    var b = maskBounds(mask, nx, ny);
    return attachMaskMetadata(mask, {
      kind: 'bluff', code: 'BLUFF', nx: nx, ny: ny, widthPx: w, heightPx: h,
      solidCount: b.count, bounds: b,
      projectedHeight: h, referenceLength: h, shape: 'Bluff body'
    });
  }

  /*
   * Venturi channel. Two symmetric constriction walls plus a smooth throat
   * produce accelerating flow with a favorable pressure recovery downstream.
   */
  function generateVenturiMask(nx, ny, throatRatio, lipFraction) {
    validateGrid(nx, ny);
    var tr = Number.isFinite(throatRatio) ? clamp(throatRatio, 0.2, 0.85) : 0.5;
    var lip = Number.isFinite(lipFraction) ? clamp(lipFraction, 0.05, 0.45) : 0.18;
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
    var nx = o.nx || 240;
    var ny = o.ny || 100;
    var k = String(kind || '').toLowerCase();
    if (k === 'naca0012' || k === 'naca4' || k === 'airfoil' || /^[0-9]{4}$/.test(k)) {
      var code = /^[0-9]{4}$/.test(k) ? k : (o.code || '0012');
      return generateNaca4Mask(code, o.chordPx || nx * 0.32, o.angleDeg || 0, nx, ny);
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
    var u = clamp(Number.isFinite(u0) ? u0 : 0.08, MIN_SPEED, MAX_SPEED);
    var nu = clamp(Number.isFinite(viscosity) ? viscosity : 0.02, MIN_VISCOSITY, MAX_VISCOSITY);
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
  }

  function createWindTunnel(nx, ny, u0, viscosity, options) {
    validateGrid(nx, ny);
    var o = options || {};
    var p = effectiveParameters(u0, viscosity);
    var obstacle = o.mask || generateObstacleMask(o.obstacle || 'cylinder', {
      nx: nx, ny: ny, code: o.code, angleDeg: o.angleDeg,
      chordPx: o.chordPx, radiusPx: o.radiusPx, throatRatio: o.throatRatio
    });
    if (obstacle.length !== nx * ny) {
      throw new RangeError('Obstacle mask length must equal nx * ny');
    }
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
      seed: Number.isFinite(o.seed) ? o.seed : 1,
      perturbation: Number.isFinite(o.perturbation) ? o.perturbation : 0.004,
      time: 0, forceX: 0, forceY: 0, forceHistory: [],
      unstable: false, sanitizedNodes: 0,
      parametersClamped: p.clamped
    };
    initializeFlow(state);
    state.referenceLength = Number.isFinite(obstacle.referenceLength) ? obstacle.referenceLength : ny * 0.1;
    state.referenceHeight = Number.isFinite(obstacle.projectedHeight) ? obstacle.projectedHeight : ny * 0.1;
    state.reynolds = state.u0 * state.referenceLength / state.viscosity;
    return state;
  }

  function setObstacle(state, mask, reset) {
    if (mask.length !== state.cellCount) {
      throw new RangeError('Obstacle mask length must equal nx * ny');
    }
    state.mask = mask;
    state.obstacle = mask;
    state.referenceLength = Number.isFinite(mask.referenceLength) ? mask.referenceLength : state.ny * 0.1;
    state.referenceHeight = Number.isFinite(mask.projectedHeight) ? mask.projectedHeight : state.ny * 0.1;
    state.reynolds = state.u0 * state.referenceLength / state.viscosity;
    if (reset !== false) initializeFlow(state);
    return state;
  }

  function setFlowParameters(state, u0, viscosity) {
    var p = effectiveParameters(
      Number.isFinite(u0) ? u0 : state.u0,
      Number.isFinite(viscosity) ? viscosity : state.viscosity
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
    var n = state.cellCount;
    var f = state.f;
    var rhoArr = state.rho;
    var uxArr = state.ux;
    var uyArr = state.uy;
    var mask = state.mask;
    var sanitized = 0;
    for (var cell = 0; cell < n; cell++) {
      var b = baseOf(cell);
      var rho = 0;
      var mx = 0;
      var my = 0;
      var q;
      for (q = 0; q < Q9; q++) {
        var v = f[b + q];
        if (!Number.isFinite(v)) {
          v = W[q];
          f[b + q] = v;
          sanitized++;
        } else if (v < MIN_POPULATION || v > MAX_POPULATION) {
          v = clamp(v, MIN_POPULATION, MAX_POPULATION);
          f[b + q] = v;
          sanitized++;
        }
        rho += v;
        mx += CX[q] * v;
        my += CY[q] * v;
      }
      rho = clamp(rho, MIN_DENSITY, MAX_DENSITY);
      var ux = mx / rho;
      var uy = my / rho;
      var sp = Math.sqrt(ux * ux + uy * uy);
      if (!Number.isFinite(sp)) {
        ux = 0;
        uy = 0;
        sanitized++;
      } else if (sp > MAX_LATTICE_SPEED) {
        /*
         * Rescale the entire distribution toward equilibrium at a bounded
         * velocity. Clamping the macroscopic moment alone leaves the high
         * speed populations untouched, which re-triggers the instability on
         * the next collision step.
         */
        var scale = MAX_LATTICE_SPEED / sp;
        ux *= scale;
        uy *= scale;
        for (var r = 0; r < Q9; r++) {
          var feq = equilibrium(rho, ux, uy, r);
          f[b + r] = 0.5 * f[b + r] + 0.5 * feq;
        }
        sanitized++;
      }
      if (mask[cell] === 1) {
        rhoArr[cell] = 1;
        uxArr[cell] = 0;
        uyArr[cell] = 0;
      } else {
        rhoArr[cell] = rho;
        uxArr[cell] = ux;
        uyArr[cell] = uy;
      }
    }
    state.sanitizedNodes += sanitized;
    if (sanitize && sanitized > 0) state.unstable = true;
    return sanitized;
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
    if (state.perturbation <= 0 || state.time !== 0) return;
    var nx = state.nx;
    var ny = state.ny;
    var b = state.mask.bounds || maskBounds(state.mask, nx, ny);
    var cx = Math.min(nx - 3, b.xMax + 3);
    var cy = Math.floor(ny / 2);
    for (var j = Math.max(1, cy - 3); j <= Math.min(ny - 2, cy + 3); j++) {
      var cell = indexOf(nx, cx, j);
      if (state.mask[cell] === 1) continue;
      var d = 0.02 * state.u0 * Math.sin((j - cy) * 1.3 + state.seed);
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
      fx: round(state.forceX, 6),
      fy: round(state.forceY, 6),
      cd: round(cd, 5),
      cl: round(cl, 5),
      ld: round(Math.abs(cd) > 1e-9 ? cl / cd : 0, 5)
    };
    state.forceHistory.push(entry);
    if (state.forceHistory.length > HISTORY_LIMIT) state.forceHistory.shift();
    return entry;
  }

  /* Performs `steps` collision and streaming cycles. */
  function stepLBM(state, steps) {
    var count = Number.isFinite(steps) ? Math.max(0, Math.floor(steps)) : 1;
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
        initializeFlow(state);
        break;
      }
    }
    refreshMacroscopic(state, true);
    return state;
  }

  /* ---------------- Field diagnostics ---------------- */

  function derivative(arr, nx, ny, i, j, axis) {
    var ip = Math.min(nx - 1, i + 1);
    var im = Math.max(0, i - 1);
    var jp = Math.min(ny - 1, j + 1);
    var jm = Math.max(0, j - 1);
    if (axis === 0) {
      var dx = ip - im;
      return dx === 0 ? 0 : (arr[indexOf(nx, ip, j)] - arr[indexOf(nx, im, j)]) / dx;
    }
    var dy = jp - jm;
    return dy === 0 ? 0 : (arr[indexOf(nx, i, jp)] - arr[indexOf(nx, i, jm)]) / dy;
  }

  function computeFields(state) {
    var nx = state.nx;
    var ny = state.ny;
    var n = state.cellCount;
    var speed = new Float64Array(n);
    var curl = new Float64Array(n);
    var cp = new Float64Array(n);
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
        var vxL = i > 0 && mask[cell - 1] !== 1 ? ux[cell - 1] : vx;
        var vxR = i < nx - 1 && mask[cell + 1] !== 1 ? ux[cell + 1] : vx;
        var vxU = j > 0 && mask[cell - nx] !== 1 ? ux[cell - nx] : vx;
        var vxD = j < ny - 1 && mask[cell + nx] !== 1 ? ux[cell + nx] : vx;
        var vyL = i > 0 && mask[cell - 1] !== 1 ? uy[cell - 1] : vy;
        var vyR = i < nx - 1 && mask[cell + 1] !== 1 ? uy[cell + 1] : vy;
        var vyU = j > 0 && mask[cell - nx] !== 1 ? uy[cell - nx] : vy;
        var vyD = j < ny - 1 && mask[cell + nx] !== 1 ? uy[cell + nx] : vy;
        var dx = Math.max(1, (i < nx - 1 ? 1 : 0) + (i > 0 ? 1 : 0));
        var dy = Math.max(1, (j < ny - 1 ? 1 : 0) + (j > 0 ? 1 : 0));
        /* Screen-space curl d(uy)/dx - d(ux)/dy. Physical y-up vorticity is its negative. */
        curl[cell] = (vyR - vyL) / dx - (vxD - vxU) / dy;
        speed[cell] = Math.sqrt(vx * vx + vy * vy);
        cp[cell] = ((rho[cell] - state.rho0) * CS2) / dynamicPressure;
      }
    }
    return { speed: speed, curl: curl, cp: cp };
  }

  function centerlineProfile(state) {
    var nx = state.nx;
    var j = Math.floor(state.ny / 2);
    var out = [];
    var f = computeFields(state);
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

  function wakeProfile(state, xFraction) {
    var xf = Number.isFinite(xFraction) ? clamp(xFraction, 0, 1) : 0.75;
    var x = Math.min(state.nx - 2, Math.max(1, Math.round(state.nx * xf)));
    var f = computeFields(state);
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
    for (var cell = 0; cell < n; cell++) {
      if (state.mask[cell] === 1) continue;
      fluid++;
      var s = fields.speed[cell];
      var c = fields.curl[cell];
      var p = fields.cp[cell];
      if (s > maxSpeed) maxSpeed = s;
      if (Math.abs(c) > maxCurl) maxCurl = Math.abs(c);
      if (p < minCp) minCp = p;
      if (p > maxCp) maxCp = p;
      sumSpeed += s;
      sumVorticity += Math.abs(c);
    }
    if (fluid === 0) { minCp = 0; maxCp = 0; }
    var wake = wakeProfile(state, 0.75);
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
      fields: fields,
      centerline: centerlineProfile(state),
      wake: wake,
      forceHistory: state.forceHistory.slice()
    };
  }

  /* ---------------- Telemetry export ---------------- */

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
      rows.push([
        s.y, s.ux, s.uy, s.speed, s.rho, s.cp, s.curl, s.solid
      ].map(csvEscape).join(','));
    }
    return rows.join('\n') + '\n';
  }

  function exportForceHistoryCSV(state) {
    var rows = ['step,fx,fy,cd,cl,ld'];
    for (var k = 0; k < state.forceHistory.length; k++) {
      var e = state.forceHistory[k];
      rows.push([e.step, e.fx, e.fy, e.cd, e.cl, e.ld].map(csvEscape).join(','));
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
      generatedBy: 'SpectralFlow D2Q9 BGK solver',
      simulation: {
        nx: state.nx, ny: state.ny, time: state.time,
        u0: state.u0, viscosity: state.viscosity, tau: state.tau,
        omega: state.omega, reynolds: d.reynolds,
        obstacle: {
          kind: state.obstacle.kind || 'custom',
          code: state.obstacle.code || '',
          shape: state.obstacle.shape || 'custom',
          solidCount: state.obstacle.solidCount || 0,
          angleDeg: round(finite(state.obstacle.angleDeg, 0), 4),
          chordPx: round(finite(state.obstacle.chordPx, 0), 4)
        },
        unstable: state.unstable,
        sanitizedNodes: state.sanitizedNodes
      },
      diagnostics: {
        cd: round(d.cd, 6), cl: round(d.cl, 6), ld: round(d.ld, 6),
        meanCd: round(d.meanCd, 6), meanCl: round(d.meanCl, 6),
        meanLd: round(d.meanLd, 6),
        fx: round(d.fx, 6), fy: round(d.fy, 6),
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
    }
    return JSON.stringify(snapshot, null, 2);
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
    csvEscape: csvEscape
  };

  return api;
});
