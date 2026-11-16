/*
 * SpectralFlow app.js
 * Browser controller: D2Q9 wind tunnel loop, Schlieren & field viewport,
 * chordwise Cp(x/c) plot, wake rake, force balance, section ordinates & polar.
 * Zero dependencies. No network requests.
 */
(function () {
  'use strict';

  var SF = globalThis.SpectralFlow;
  if (!SF) {
    document.getElementById('liveStatus').textContent = 'The solver module did not load.';
    return;
  }

  var NX = 220;
  var NY = 92;
  var STEPS_PER_FRAME = 2;
  var CHART_EVERY = 6;
  var TABLE_EVERY = 24;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var CHART_W = 540;
  var CHART_H = 260;
  var PLOT = { left: 56, right: 516, top: 18, bottom: 210 };

  var $ = function (id) { return document.getElementById(id); };

  var ui = {
    themeToggle: $('themeToggle'), themeLabel: $('themeLabel'), printBtn: $('printBtn'),
    obstacleKind: $('obstacleKind'), customCodeField: $('customCodeField'),
    customCode: $('customCode'), angleRange: $('angleRange'), angleValue: $('angleValue'),
    speedRange: $('speedRange'), speedValue: $('speedValue'),
    viscosityRange: $('viscosityRange'), viscosityValue: $('viscosityValue'),
    chordRange: $('chordRange'), chordValue: $('chordValue'),
    runToggle: $('runToggle'), stepBtn: $('stepBtn'), resetBtn: $('resetBtn'),
    textureToggle: $('textureToggle'),
    statRe: $('statRe'), statReNote: $('statReNote'), statCd: $('statCd'),
    statCl: $('statCl'), statClNote: $('statClNote'), statLd: $('statLd'),
    statTime: $('statTime'), statTau: $('statTau'), statMach: $('statMach'),
    canvas: $('flowCanvas'), fieldTooltip: $('fieldTooltip'),
    fieldDescription: $('fieldDescription'), fieldScaleLabel: $('fieldScaleLabel'),
    legendBar: $('legendBar'),
    cpChart: $('cpChart'), cpIntegralLabel: $('cpIntegralLabel'),
    wakeChart: $('wakeChart'), wakeTooltip: $('wakeTooltip'), wakeXLabel: $('wakeXLabel'),
    wakeTable: $('wakeTable'),
    forceChart: $('forceChart'), forceTooltip: $('forceTooltip'),
    forceSamplesLabel: $('forceSamplesLabel'), forceTable: $('forceTable'),
    sectionChart: $('sectionChart'), sectionSub: $('sectionSub'),
    sectionTable: $('sectionTable'), specList: $('specList'),
    csvBtn: $('csvBtn'), forceCsvBtn: $('forceCsvBtn'), jsonBtn: $('jsonBtn'),
    liveStatus: $('liveStatus'), solverStatus: $('solverStatus'), scenarioStatus: $('scenarioStatus'),
    errorStatus: $('errorStatus'), probeReadout: $('probeReadout'), pinProbe: $('pinProbe'),
    importBtn: $('importBtn'), snapshotInput: $('snapshotInput'), fieldCsvBtn: $('fieldCsvBtn')
  };

  var app = {
    field: 'curl',
    running: true,
    texture: false,
    frame: 0,
    state: null,
    diag: null,
    schlieren: new Float64Array(NX * NY),
    colors: {},
    lut: null,
    lutKey: '',
    off: null,
    offCtx: null,
    offData: null,
    tracers: [],
    wakePoints: [],
    forcePoints: [],
    polarPoints: []
  };
  app.raf = null;
  app.warmRemaining = 0;
  app.scenario = '';
  app.probe = { i: Math.round(NX * 0.6), j: Math.floor(NY / 2) };
  app.probePinned = false;

  /* ---------------- Color helpers ---------------- */

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hexToRgb(hex) {
    var s = String(hex).replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var v = parseInt(s, 16);
    if (!Number.isFinite(v)) return [0, 0, 0];
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function rgbToCss(c) {
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }

  function lerpColor(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function sampleRamp(stops, t) {
    var x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(x));
    return lerpColor(stops[i], stops[i + 1], x - i);
  }

  function refreshColors() {
    var keys = ['--surface-1', '--surface-2', '--surface-3', '--text-primary',
      '--text-secondary', '--text-muted', '--grid', '--axis', '--solid-ink',
      '--series-1', '--series-2', '--series-3', '--seq-100', '--seq-250',
      '--seq-400', '--seq-550', '--seq-700', '--div-neg', '--div-mid',
      '--div-pos', '--accent'];
    for (var k = 0; k < keys.length; k++) {
      app.colors[keys[k]] = hexToRgb(cssVar(keys[k]));
    }
    app.lutKey = '';
  }

  function buildLut(field) {
    var c = app.colors;
    var out = new Uint8Array(256 * 3);
    var stops;
    var i;
    var t;
    var rgb;
    if (field === 'schlieren') {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      stops = dark
        ? [[14, 16, 19], [48, 56, 66], [128, 138, 148], [218, 220, 214], [252, 249, 240]]
        : [[248, 245, 236], [206, 200, 186], [134, 128, 116], [62, 58, 52], [18, 17, 15]];
      for (i = 0; i < 256; i++) {
        rgb = sampleRamp(stops, Math.pow(i / 255, 0.72));
        out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
      }
    } else if (field === 'speed') {
      stops = [c['--surface-1'], c['--seq-100'], c['--seq-250'], c['--seq-400'],
        c['--seq-550'], c['--seq-700']];
      for (i = 0; i < 256; i++) {
        rgb = sampleRamp(stops, i / 255);
        out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
      }
    } else {
      var neg = field === 'curl' ? c['--div-neg'] : c['--div-pos'];
      var pos = field === 'curl' ? c['--div-pos'] : c['--div-neg'];
      var mid = c['--div-mid'];
      for (i = 0; i < 256; i++) {
        t = i / 255;
        rgb = t < 0.5 ? lerpColor(neg, mid, t * 2) : lerpColor(mid, pos, (t - 0.5) * 2);
        out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
      }
    }
    return out;
  }

  function scaleLimit(arr, mask, floor) {
    var vals = [];
    for (var cell = 0; cell < arr.length; cell++) {
      if (mask[cell] === 1) continue;
      vals.push(Math.abs(arr[cell]));
    }
    if (vals.length === 0) return floor;
    vals.sort(function (a, b) { return a - b; });
    var p = vals[Math.floor(vals.length * 0.985)];
    return Math.max(floor, Math.min(p, floor * 400));
  }

  function computeSchlierenField() {
    app.schlieren = app.diag.fields.schlieren;
    return app.schlieren;
  }

  /* ---------------- Simulation setup ---------------- */

  function currentCode() {
    var kind = ui.obstacleKind.value;
    if (kind === 'custom') {
      var code = ui.customCode.value.trim();
      SF.parseNaca4(code);
      return code;
    }
    if (kind.indexOf('naca') === 0) return kind.slice(4);
    return '2412';
  }

  function currentAngle() { return Number(ui.angleRange.value); }
  function currentSpeed() { return Number(ui.speedRange.value); }
  function currentViscosity() { return Number(ui.viscosityRange.value); }
  function currentChord() { return Number(ui.chordRange.value); }

  function buildMask() {
    var kind = ui.obstacleKind.value;
    if (kind === 'cylinder') return SF.generateCylinderMask(NY * 0.065, NX, NY, NX * 0.28, NY * 0.5);
    if (kind === 'bluff') return SF.generateBluffBodyMask(NX, NY, NX * 0.07, NY * 0.24);
    if (kind === 'venturi') return SF.generateVenturiMask(NX, NY, 0.52, 0.20);
    return SF.generateNaca4Mask(currentCode(), currentChord(), currentAngle(), NX, NY);
  }

  function rebuild(resetParticles) {
    var mask;
    try { mask = buildMask(); } catch (error) { setRunning(false); [ui.csvBtn, ui.forceCsvBtn, ui.fieldCsvBtn, ui.jsonBtn].forEach(function (node) { node.disabled = true; }); reportError(error.message); return false; }
    ui.errorStatus.hidden = true;
    [ui.csvBtn, ui.forceCsvBtn, ui.fieldCsvBtn, ui.jsonBtn].forEach(function (node) { node.disabled = false; });
    if (!app.state) {
      app.state = SF.createWindTunnel(NX, NY, currentSpeed(), currentViscosity(), { mask: mask });
      app.off = document.createElement('canvas');
      app.off.width = NX;
      app.off.height = NY;
      app.offCtx = app.off.getContext('2d');
      app.offData = app.offCtx.createImageData(NX, NY);
    } else {
      SF.setFlowParameters(app.state, currentSpeed(), currentViscosity());
      SF.setObstacle(app.state, mask);
    }
    if (resetParticles !== false) seedTracers();
    SF.stepLBM(app.state, 40);
    app.diag = SF.computeDiagnostics(app.state);
    computeSchlierenField();
    app.frame = 0;
    app.warmRemaining = 0;
    app.probePinned = false;
    ui.pinProbe.setAttribute('aria-pressed', 'false');
    updateControlLabels();
    renderAll(true);
    announce('Simulation reset for ' + mask.shape + '.');
    return true;
  }

  function reportError(message) { ui.errorStatus.textContent = message; ui.errorStatus.hidden = false; announce(message); }

  function loadScenario(id) {
    var scenario = SF.getScenario(id);
    ui.obstacleKind.value = scenario.obstacle;
    ui.angleRange.value = scenario.angleDeg;
    ui.speedRange.value = scenario.u0;
    ui.viscosityRange.value = scenario.viscosity;
    ui.chordRange.value = scenario.chordPx;
    app.scenario = id;
    if (!rebuild(true)) return;
    app.warmRemaining = Math.max(0, scenario.warmupSteps - app.state.time);
    ui.scenarioStatus.textContent = scenario.label + ': preparing live flow';
    setField(scenario.field);
    setRunning(true);
  }

  function updateControlLabels() {
    ui.angleValue.textContent = currentAngle() + '\u00b0';
    ui.speedValue.textContent = currentSpeed().toFixed(3);
    ui.viscosityValue.textContent = currentViscosity().toFixed(3);
    ui.chordValue.textContent = currentChord() + ' px';
    var kind = ui.obstacleKind.value;
    var isAirfoil = kind.indexOf('naca') === 0 || kind === 'custom';
    ui.customCodeField.hidden = kind !== 'custom';
    ui.angleRange.disabled = !isAirfoil;
    ui.chordRange.disabled = !isAirfoil;
    ui.angleRange.closest('.control-field').style.opacity = isAirfoil ? '1' : '0.5';
    ui.chordRange.closest('.control-field').style.opacity = isAirfoil ? '1' : '0.5';
  }

  function announce(text) { ui.liveStatus.textContent = text; }

  /* ---------------- Tracer particles ---------------- */

  function seedTracers() {
    app.tracers = [];
    var count = 340;
    for (var k = 0; k < count; k++) {
      app.tracers.push({
        x: Math.random() * NX,
        y: 1 + Math.random() * (NY - 2),
        px: 0, py: 0, age: Math.random() * 90, life: 60 + Math.random() * 120
      });
    }
    for (var t = 0; t < app.tracers.length; t++) {
      app.tracers[t].px = app.tracers[t].x;
      app.tracers[t].py = app.tracers[t].y;
    }
  }

  function sampleVelocity(x, y, ux, uy, mask) {
    var i = Math.floor(x);
    var j = Math.floor(y);
    var fx = x - i;
    var fy = y - j;
    var c00 = mask[Math.max(0, Math.min(NY - 1, j)) * NX + Math.max(0, Math.min(NX - 1, i))] === 1;
    if (c00) return null;
    function at(di, dj, arr) {
      var ii = Math.max(0, Math.min(NX - 1, i + di));
      var jj = Math.max(0, Math.min(NY - 1, j + dj));
      return arr[jj * NX + ii];
    }
    var vx = (1 - fx) * (1 - fy) * at(0, 0, ux) + fx * (1 - fy) * at(1, 0, ux) +
      (1 - fx) * fy * at(0, 1, ux) + fx * fy * at(1, 1, ux);
    var vy = (1 - fx) * (1 - fy) * at(0, 0, uy) + fx * (1 - fy) * at(1, 0, uy) +
      (1 - fx) * fy * at(0, 1, uy) + fx * fy * at(1, 1, uy);
    return [vx, vy];
  }

  function advanceTracers() {
    var st = app.state;
    for (var k = 0; k < app.tracers.length; k++) {
      var p = app.tracers[k];
      p.px = p.x;
      p.py = p.y;
      var v = sampleVelocity(p.x, p.y, st.ux, st.uy, st.mask);
      if (!v) {
        p.x = 1;
        p.y = 1 + Math.random() * (NY - 2);
        p.px = p.x; p.py = p.y; p.age = 0;
        continue;
      }
      var boost = 3.2;
      p.x += Math.max(0.02, v[0]) * boost;
      p.y += v[1] * boost;
      p.age += 1;
      if (p.x >= NX - 1 || p.y < 1 || p.y > NY - 2 || p.age > p.life) {
        p.x = 1 + Math.random() * 3;
        p.y = 1 + Math.random() * (NY - 2);
        p.px = p.x; p.py = p.y; p.age = 0;
      }
    }
  }

  /* ---------------- Canvas field render ---------------- */

  function canvasSize() {
    var dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    var rect = ui.canvas.getBoundingClientRect();
    var w = Math.max(320, Math.round(rect.width * dpr));
    var h = Math.round(w * NY / NX);
    if (ui.canvas.width !== w || ui.canvas.height !== h) {
      ui.canvas.width = w;
      ui.canvas.height = h;
    }
    return [w, h];
  }

  function fieldDescriptions() {
    return {
      curl: 'Physical vorticity with y upward. Blue and orange mark opposite rotation in the shear layers and wake.',
      schlieren: 'Numerical Schlieren knife-edge density gradient |grad rho|, highlighting shear layers, stagnation compression, and vortex cores.',
      speed: 'Velocity magnitude |u| on a sequential scale from stagnation (0) to peak accelerated flow over the suction surface.',
      cp: 'Pressure coefficient Cp = (rho - rho0) / (3 q). Suction (negative Cp) and stagnation compression share one diverging scale.',
      tracers: 'Massless smoke-wire filaments advected through bilinear lattice velocities. Trails expose boundary-layer separation and wake roll-up.'
    };
  }

  function currentFieldLimit() {
    var d = app.diag;
    var f = app.field;
    if (f === 'curl') return scaleLimit(d.fields.vorticity, app.state.mask, 0.004);
    if (f === 'schlieren') return scaleLimit(app.schlieren, app.state.mask, 0.0015);
    if (f === 'cp') return scaleLimit(d.fields.cp, app.state.mask, 0.06);
    return Math.max(app.state.u0 * 1.35, d.maxSpeed);
  }

  function renderField() {
    var st = app.state;
    var d = app.diag;
    var f = app.field;
    var key = f + '|' + document.documentElement.getAttribute('data-theme') + '|' + app.texture;
    if (app.lutKey !== key) {
      app.lut = buildLut(f === 'tracers' ? 'speed' : f);
      app.lutKey = key;
    }
    var data = app.offData.data;
    var solid = app.colors['--solid-ink'];
    var bg = app.colors['--surface-1'];
    var arr;
    var limit = currentFieldLimit();
    if (f === 'curl') {
      arr = d.fields.vorticity;
    } else if (f === 'schlieren') {
      arr = app.schlieren;
    } else if (f === 'speed' || f === 'tracers') {
      arr = d.fields.speed;
    } else {
      arr = d.fields.cp;
    }
    var lut = app.lut;
    var cell;
    var idx;
    for (cell = 0; cell < st.cellCount; cell++) {
      idx = cell * 4;
      if (st.mask[cell] === 1) {
        data[idx] = solid[0]; data[idx + 1] = solid[1]; data[idx + 2] = solid[2];
        data[idx + 3] = 255;
        continue;
      }
      var v = arr[cell];
      var t;
      if (f === 'speed' || f === 'tracers' || f === 'schlieren') {
        t = Math.max(0, Math.min(1, v / limit));
      } else {
        t = 0.5 + 0.5 * Math.max(-1, Math.min(1, v / limit));
      }
      if (f === 'tracers') {
        var bgc = lerpColor(bg, lutRgb(lut, 90), 0.25 * t);
        data[idx] = bgc[0]; data[idx + 1] = bgc[1]; data[idx + 2] = bgc[2];
      } else {
        var b = Math.round(t * 255) * 3;
        data[idx] = lut[b]; data[idx + 1] = lut[b + 1]; data[idx + 2] = lut[b + 2];
      }
      data[idx + 3] = 255;
    }
    app.offCtx.putImageData(app.offData, 0, 0);
    var size = canvasSize();
    var ctx = ui.canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, size[0], size[1]);
    ctx.drawImage(app.off, 0, 0, size[0], size[1]);
    drawFieldOverlay(ctx, size, arr, limit);
  }

  function lutRgb(lut, i) { return [lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]]; }

  function drawFieldOverlay(ctx, size, arr, limit) {
    var sx = size[0] / NX;
    var sy = size[1] / NY;
    var st = app.state;
    var f = app.field;
    ctx.save();
    if (f === 'tracers') {
      ctx.lineWidth = Math.max(1.1, sx * 0.85);
      ctx.lineCap = 'round';
      var accent = rgbToCss(app.colors['--series-1']);
      for (var k = 0; k < app.tracers.length; k++) {
        var p = app.tracers[k];
        var alpha = 0.18 + 0.58 * (1 - p.age / p.life);
        ctx.globalAlpha = Math.max(0.08, alpha);
        ctx.strokeStyle = accent;
        ctx.beginPath();
        ctx.moveTo(p.px * sx, p.py * sy);
        ctx.lineTo(p.x * sx, p.y * sy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (app.texture && f !== 'tracers') {
      ctx.strokeStyle = rgbToCss(app.colors['--text-primary']);
      ctx.globalAlpha = 0.24;
      ctx.lineWidth = 1;
      var step = Math.max(5, Math.round(sx * 3));
      var pole = (f === 'speed' || f === 'schlieren') ? 1 : 0.5;
      for (var j = 2; j < NY - 2; j += 2) {
        for (var i = 2; i < NX - 2; i += 2) {
          var v = arr[j * NX + i];
          var norm = (f === 'speed' || f === 'tracers' || f === 'schlieren') ? v / limit : 0.5 + 0.5 * v / limit;
          if (st.mask[j * NX + i] === 1) continue;
          if (Math.abs(norm - pole) < 0.22) continue;
          var positive = norm > pole;
          var x = i * sx;
          var y = j * sy;
          ctx.beginPath();
          if (positive) { ctx.moveTo(x - step, y + step); ctx.lineTo(x + step, y - step); }
          else { ctx.moveTo(x - step, y - step); ctx.lineTo(x + step, y + step); }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    /* Draw wake rake traverse station line at x = 0.75 NX */
    var wakeX = Math.round(NX * 0.75) * sx;
    ctx.strokeStyle = rgbToCss(app.colors['--axis']);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(wakeX, 0);
    ctx.lineTo(wakeX, size[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    var probeX = (app.probe.i + 0.5) * sx, probeY = (app.probe.j + 0.5) * sy;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = rgbToCss(app.colors['--text-primary']);
    ctx.lineWidth = Math.max(1, sx * 0.3);
    ctx.beginPath(); ctx.moveTo(probeX - 8, probeY); ctx.lineTo(probeX + 8, probeY);
    ctx.moveTo(probeX, probeY - 8); ctx.lineTo(probeX, probeY + 8); ctx.stroke();
    ctx.restore();
  }

  function renderLegend(limit) {
    var f = app.field;
    ui.legendBar.textContent = '';
    if (f === 'tracers') {
      var note = document.createElement('span');
      note.textContent = 'Smoke-wire tracer filaments advected by bilinear velocity; dashed vertical line marks wake rake at x = 0.75 Lx.';
      ui.legendBar.appendChild(note);
      ui.fieldScaleLabel.textContent = 'tracer advection';
      return;
    }
    var stops;
    if (f === 'schlieren') {
      stops = [cssVar('--surface-1'), cssVar('--text-muted'), cssVar('--text-primary')];
    } else if (f === 'speed') {
      stops = [cssVar('--surface-1'), cssVar('--seq-100'), cssVar('--seq-250'), cssVar('--seq-400'), cssVar('--seq-550'), cssVar('--seq-700')];
    } else if (f === 'curl') {
      stops = [cssVar('--div-neg'), cssVar('--div-mid'), cssVar('--div-pos')];
    } else {
      stops = [cssVar('--div-pos'), cssVar('--div-mid'), cssVar('--div-neg')];
    }
    var gradient = document.createElement('span');
    gradient.className = 'legend-gradient';
    var cssStops = stops.map(function (s, k) {
      return s + ' ' + Math.round(k / (stops.length - 1) * 100) + '%';
    });
    gradient.style.background = 'linear-gradient(90deg, ' + cssStops.join(', ') + ')';
    ui.legendBar.appendChild(gradient);
    var ticks = document.createElement('span');
    ticks.className = 'legend-ticks';
    var lo = document.createElement('span');
    var mid = document.createElement('span');
    var hi = document.createElement('span');
    if (f === 'speed' || f === 'schlieren') {
      lo.textContent = '0';
      mid.textContent = (limit / 2).toFixed(4);
      hi.textContent = limit.toFixed(4) + (f === 'speed' ? ' |u|' : ' |grad rho|');
    } else {
      lo.textContent = '-' + limit.toFixed(3);
      mid.textContent = '0';
      hi.textContent = '+' + limit.toFixed(3);
    }
    ticks.appendChild(lo); ticks.appendChild(mid); ticks.appendChild(hi);
    ui.legendBar.appendChild(ticks);
    ui.fieldScaleLabel.textContent = f === 'speed' ? 'velocity scale' : (f === 'curl' ? 'vorticity range' : (f === 'schlieren' ? 'Schlieren knife-edge' : 'Cp range'));
  }

  /* ---------------- SVG chart primitives ---------------- */

  function svgEl(tag, attrs, text) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    }
    if (text !== undefined) el.textContent = String(text);
    return el;
  }

  function clearSvg(svg) {
    Array.from(svg.childNodes).forEach(function (node) {
      if (node.nodeType !== 1 || (node.localName !== 'title' && node.localName !== 'desc')) svg.removeChild(node);
    });
  }

  function chartFrame(svg, xTicks, yTicks, xTitle, yTitle) {
    var g = svgEl('g');
    var k;
    for (k = 0; k < yTicks.length; k++) {
      var t = yTicks[k];
      g.appendChild(svgEl('line', {
        x1: PLOT.left, x2: PLOT.right, y1: t.y, y2: t.y, class: 'gridline'
      }));
      g.appendChild(svgEl('text', {
        x: PLOT.left - 8, y: t.y + 3.5, 'text-anchor': 'end', class: 'tick-text'
      }, t.label));
    }
    g.appendChild(svgEl('line', {
      x1: PLOT.left, x2: PLOT.right, y1: PLOT.bottom, y2: PLOT.bottom, class: 'axis-line'
    }));
    g.appendChild(svgEl('line', {
      x1: PLOT.left, x2: PLOT.left, y1: PLOT.top, y2: PLOT.bottom, class: 'axis-line'
    }));
    for (k = 0; k < xTicks.length; k++) {
      var xt = xTicks[k];
      g.appendChild(svgEl('text', {
        x: xt.x, y: PLOT.bottom + 17, 'text-anchor': 'middle', class: 'tick-text'
      }, xt.label));
    }
    g.appendChild(svgEl('text', {
      x: (PLOT.left + PLOT.right) / 2, y: CHART_H - 14,
      'text-anchor': 'middle', class: 'axis-title'
    }, xTitle));
    g.appendChild(svgEl('text', {
      x: 14, y: (PLOT.top + PLOT.bottom) / 2,
      'text-anchor': 'middle', class: 'axis-title',
      transform: 'rotate(-90 14 ' + ((PLOT.top + PLOT.bottom) / 2) + ')'
    }, yTitle));
    svg.appendChild(g);
  }

  function niceTicks(min, max, count) {
    var span = max - min;
    if (span <= 0 || !Number.isFinite(span)) span = 1;
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step * 0.5; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return { lo: lo, hi: hi, ticks: ticks };
  }

  function fmtTick(v, step) {
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(0) + 'K';
    if (Math.abs(v) >= 10) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(1);
    if (Math.abs(v) === 0) return '0';
    var digits = step < 0.01 ? 3 : 2;
    return v.toFixed(digits);
  }

  function pathFrom(points) {
    var d = '';
    for (var k = 0; k < points.length; k++) {
      d += (k === 0 ? 'M' : 'L') + points[k][0].toFixed(2) + ' ' + points[k][1].toFixed(2);
    }
    return d;
  }

  function crosshairFor(svg) {
    return svg.querySelector('.crosshair');
  }

  /* ---------------- Chordwise Surface Cp(x/c) Chart ---------------- */

  function computeSurfaceCp() {
    return SF.surfacePressureProfile(app.state, app.diag.fields);
  }

  function renderCpChart() {
    var svg = ui.cpChart;
    var surf = computeSurfaceCp();
    var rows = surf.rows;
    clearSvg(svg);
    if (rows.length < 2) {
      chartFrame(svg, [{ x: PLOT.left, label: '0.0' }, { x: PLOT.right, label: '1.0' }],
        [{ y: PLOT.bottom, label: '+1.0' }, { y: PLOT.top, label: '-1.0' }],
        'Normalized chord station x / c', 'Surface pressure -Cp');
      ui.cpIntegralLabel.textContent = 'Cl,p = n/a';
      return;
    }
    var vals = [];
    rows.forEach(function (r) { vals.push(-r.cpUpper, -r.cpLower); });
    var minV = Math.min.apply(null, vals.concat([-0.6]));
    var maxV = Math.max.apply(null, vals.concat([0.8]));
    var scale = niceTicks(minV - 0.15, maxV + 0.15, 5);
    var stepY = scale.ticks.length > 1 ? scale.ticks[1] - scale.ticks[0] : 0.5;
    var xOf = function (xc) { return PLOT.left + xc * (PLOT.right - PLOT.left); };
    var yOf = function (negCp) {
      return PLOT.bottom - (negCp - scale.lo) / (scale.hi - scale.lo) * (PLOT.bottom - PLOT.top);
    };
    var xTicks = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map(function (xc) {
      return { x: xOf(xc), label: xc.toFixed(1) };
    });
    chartFrame(svg, xTicks,
      scale.ticks.map(function (v) { return { y: yOf(v), label: fmtTick(v, stepY) }; }),
      'Normalized chord station x / c', 'Suction -Cp (upward)');

    if (scale.lo < 0 && scale.hi > 0) {
      svg.appendChild(svgEl('line', {
        x1: PLOT.left, x2: PLOT.right, y1: yOf(0), y2: yOf(0), class: 'ref-line'
      }));
    }
    var upPts = rows.map(function (r) { return [xOf(r.xc), yOf(-r.cpUpper)]; });
    var loPts = rows.map(function (r) { return [xOf(r.xc), yOf(-r.cpLower)]; });
    var loopArea = pathFrom(upPts) + ' ' + pathFrom(loPts.slice().reverse()).replace(/^M/, 'L') + ' Z';
    svg.appendChild(svgEl('path', { d: loopArea, fill: cssVar('--series-1'), opacity: '0.10' }));
    svg.appendChild(svgEl('path', { d: pathFrom(upPts), class: 'series-line', stroke: cssVar('--series-1') }));
    svg.appendChild(svgEl('path', { d: pathFrom(loPts), class: 'series-line', stroke: cssVar('--series-2') }));
    ui.cpIntegralLabel.textContent = 'Cl,p = ' + surf.clPressure.toFixed(3);
  }

  /* ---------------- Wake chart ---------------- */

  function renderWakeChart() {
    var svg = ui.wakeChart;
    var samples = app.diag.wake.samples;
    var st = app.state;
    var u0 = st.u0;
    var vals = samples.map(function (s) { return s.ux; });
    var minV = Math.min.apply(null, vals);
    var maxV = Math.max.apply(null, vals.concat([u0]));
    var pad = Math.max(0.008, (maxV - minV) * 0.12);
    var scale = niceTicks(Math.min(0, minV - pad), maxV + pad, 5);
    var stepY = scale.ticks.length > 1 ? scale.ticks[1] - scale.ticks[0] : 1;
    var xOf = function (v) { return PLOT.left + (v - scale.lo) / (scale.hi - scale.lo) * (PLOT.right - PLOT.left); };
    var yOf = function (i) { return PLOT.top + i / (samples.length - 1) * (PLOT.bottom - PLOT.top); };
    clearSvg(svg);
    chartFrame(svg,
      scale.ticks.map(function (v) { return { x: xOf(v), label: fmtTick(v, stepY) }; }),
      [{ y: yOf(0), label: '0' }, { y: yOf((samples.length - 1) / 2), label: String(Math.floor(NY / 2)) },
        { y: yOf(samples.length - 1), label: String(NY - 1) }],
      'Streamwise velocity u_x (lattice units)', 'Tunnel row j');

    var refX = xOf(u0);
    if (refX >= PLOT.left && refX <= PLOT.right) {
      svg.appendChild(svgEl('line', {
        x1: refX, x2: refX, y1: PLOT.top, y2: PLOT.bottom, class: 'ref-line'
      }));
      svg.appendChild(svgEl('text', {
        x: Math.min(PLOT.right - 4, refX + 5), y: PLOT.top + 11, class: 'tick-text',
        'text-anchor': refX > PLOT.right - 70 ? 'end' : 'start'
      }, 'u0 = ' + u0.toFixed(3)));
    }
    var pts = [];
    for (var i = 0; i < samples.length; i++) pts.push([xOf(Math.max(scale.lo, Math.min(scale.hi, vals[i]))), yOf(i)]);
    app.wakePoints = pts;
    var area = pathFrom(pts) + ' L' + xOf(scale.lo).toFixed(2) + ' ' + PLOT.bottom +
      ' L' + xOf(scale.lo).toFixed(2) + ' ' + PLOT.top + ' Z';
    svg.appendChild(svgEl('path', { d: area, fill: cssVar('--series-1'), opacity: '0.10' }));
    svg.appendChild(svgEl('path', { d: pathFrom(pts), class: 'series-line', stroke: cssVar('--series-1') }));
    var deficitIndex = 0;
    for (var m = 1; m < vals.length; m++) if (vals[m] < vals[deficitIndex]) deficitIndex = m;
    var ep = pts[deficitIndex];
    svg.appendChild(svgEl('circle', {
      cx: ep[0], cy: ep[1], r: 4,
      fill: cssVar('--series-1'), class: 'end-dot'
    }));
    svg.appendChild(svgEl('text', {
      x: Math.min(PLOT.right - 2, ep[0] + 8), y: ep[1] + 4, class: 'end-label'
    }, 'min ' + vals[deficitIndex].toFixed(3)));
    svg.appendChild(svgEl('line', {
      x1: 0, x2: 0, y1: PLOT.top, y2: PLOT.bottom, class: 'crosshair', visibility: 'hidden'
    }));
    ui.wakeXLabel.textContent = app.diag.wake.x + ' / ' + NX;
  }

  function showWakeTooltip(clientX, clientY) {
    var rect = ui.wakeChart.getBoundingClientRect();
    var sx = CHART_W / rect.width;
    var sy = CHART_H / rect.height;
    var px = (clientX - rect.left) * sx;
    var py = (clientY - rect.top) * sy;
    if (px < PLOT.left - 10 || px > PLOT.right + 10 || py < PLOT.top - 10 || py > PLOT.bottom + 10) {
      hideTooltip(ui.wakeTooltip, ui.wakeChart);
      return;
    }
    var best = 0;
    var bestDist = Infinity;
    for (var k = 0; k < app.wakePoints.length; k++) {
      var d = Math.abs(app.wakePoints[k][1] - py);
      if (d < bestDist) { bestDist = d; best = k; }
    }
    var s = app.diag.wake.samples[best];
    var ch = crosshairFor(ui.wakeChart);
    if (ch) {
      ch.setAttribute('x1', app.wakePoints[best][0]);
      ch.setAttribute('x2', app.wakePoints[best][0]);
      ch.setAttribute('visibility', 'visible');
    }
    var tip = ui.wakeTooltip;
    tip.textContent = '';
    var head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = 'Row j = ' + s.y + (s.solid ? ' (solid)' : '');
    tip.appendChild(head);
    [
      ['u_x', s.ux.toFixed(4), cssVar('--series-1')],
      ['|u|', s.speed.toFixed(4), cssVar('--series-2')],
      ['Cp', s.cp.toFixed(3), cssVar('--series-3')]
    ].forEach(function (row) {
      var r = document.createElement('div');
      r.className = 'tt-row';
      var label = document.createElement('span');
      label.className = 'tt-series';
      var key = document.createElement('span');
      key.className = 'tt-key';
      key.style.background = row[2];
      label.appendChild(key);
      label.appendChild(document.createTextNode(row[0]));
      var value = document.createElement('strong');
      value.textContent = row[1];
      r.appendChild(label); r.appendChild(value);
      tip.appendChild(r);
    });
    tip.hidden = false;
    var host = tip.parentElement.getBoundingClientRect();
    var lx = clientX - host.left + 14;
    var ly = clientY - host.top - 12;
    tip.style.left = Math.max(4, Math.min(host.width - tip.offsetWidth - 4, lx)) + 'px';
    tip.style.top = Math.max(4, Math.min(host.height - tip.offsetHeight - 4, ly)) + 'px';
  }

  function hideTooltip(tip, svg) {
    tip.hidden = true;
    var ch = crosshairFor(svg);
    if (ch) ch.setAttribute('visibility', 'hidden');
  }

  /* ---------------- Force chart ---------------- */

  function renderForceChart() {
    var svg = ui.forceChart;
    var hist = app.state.forceHistory;
    clearSvg(svg);
    if (hist.length === 0) {
      chartFrame(svg, [{ x: PLOT.left, label: '0' }, { x: PLOT.right, label: '1' }],
        [{ y: PLOT.bottom, label: '0' }, { y: PLOT.top, label: '1' }],
        'Lattice step', 'Force coefficient');
      svg.appendChild(svgEl('text', {
        x: (PLOT.left + PLOT.right) / 2, y: (PLOT.top + PLOT.bottom) / 2,
        'text-anchor': 'middle', class: 'axis-title'
      }, 'Collecting aerodynamic balance samples'));
      app.forcePoints = [];
      ui.forceSamplesLabel.textContent = '0 samples';
      return;
    }
    var n = hist.length;
    var x0 = hist[0].step;
    var x1 = hist[n - 1].step;
    if (x1 === x0) x1 = x0 + 1;
    var lo = 0;
    var hi = 0;
    for (var k = 0; k < n; k++) {
      lo = Math.min(lo, hist[k].cd, hist[k].cl);
      hi = Math.max(hi, hist[k].cd, hist[k].cl);
    }
    var pad = Math.max(0.2, (hi - lo) * 0.10);
    var scale = niceTicks(lo - pad, hi + pad, 5);
    var stepY = scale.ticks.length > 1 ? scale.ticks[1] - scale.ticks[0] : 1;
    var xOf = function (step) { return PLOT.left + (step - x0) / (x1 - x0) * (PLOT.right - PLOT.left); };
    var yOf = function (v) { return PLOT.bottom - (v - scale.lo) / (scale.hi - scale.lo) * (PLOT.bottom - PLOT.top); };
    var xTicks = [0, 0.25, 0.5, 0.75, 1].map(function (t) {
      return { x: PLOT.left + t * (PLOT.right - PLOT.left), label: String(Math.round(x0 + t * (x1 - x0))) };
    });
    chartFrame(svg, xTicks,
      scale.ticks.map(function (v) { return { y: yOf(v), label: fmtTick(v, stepY) }; }),
      'Lattice step', 'Coefficient (Cd, Cl)');
    if (scale.lo < 0 && scale.hi > 0) {
      svg.appendChild(svgEl('line', {
        x1: PLOT.left, x2: PLOT.right, y1: yOf(0), y2: yOf(0), class: 'ref-line'
      }));
    }
    var series = [
      { key: 'cd', color: cssVar('--series-1'), name: 'Drag Cd' },
      { key: 'cl', color: cssVar('--series-2'), name: 'Lift Cl' }
    ];
    app.forcePoints = hist.map(function (h) { return { x: xOf(h.step), cd: yOf(h.cd), cl: yOf(h.cl), sample: h }; });
    series.forEach(function (s) {
      var pts = app.forcePoints.map(function (p) { return [p.x, p[s.key]]; });
      svg.appendChild(svgEl('path', { d: pathFrom(pts), class: 'series-line', stroke: s.color }));
      var last = pts[pts.length - 1];
      svg.appendChild(svgEl('circle', {
        cx: last[0], cy: last[1], r: 4, fill: s.color, class: 'end-dot'
      }));
      var value = hist[n - 1][s.key];
      var labelY = Math.max(PLOT.top + 10, Math.min(PLOT.bottom - 3, last[1] - 8));
      var anchor = 'end';
      var lx = last[0] - 7;
      if (last[0] < PLOT.left + 50) { anchor = 'start'; lx = last[0] + 7; }
      svg.appendChild(svgEl('text', {
        x: lx, y: labelY, class: 'end-label', 'text-anchor': anchor, fill: cssVar('--text-primary')
      }, value.toFixed(2)));
    });
    svg.appendChild(svgEl('line', {
      x1: 0, x2: 0, y1: PLOT.top, y2: PLOT.bottom, class: 'crosshair', visibility: 'hidden'
    }));
    ui.forceSamplesLabel.textContent = n + ' samples';
  }

  function showForceTooltip(clientX, clientY) {
    var rect = ui.forceChart.getBoundingClientRect();
    var sx = CHART_W / rect.width;
    var sy = CHART_H / rect.height;
    var px = (clientX - rect.left) * sx;
    var py = (clientY - rect.top) * sy;
    if (app.forcePoints.length === 0 || px < PLOT.left - 12 || px > PLOT.right + 12 ||
        py < PLOT.top - 12 || py > PLOT.bottom + 12) {
      hideTooltip(ui.forceTooltip, ui.forceChart);
      return;
    }
    var best = 0;
    var bestDist = Infinity;
    for (var k = 0; k < app.forcePoints.length; k++) {
      var d = Math.abs(app.forcePoints[k].x - px);
      if (d < bestDist) { bestDist = d; best = k; }
    }
    var p = app.forcePoints[best];
    var h = p.sample;
    var ch = crosshairFor(ui.forceChart);
    if (ch) {
      ch.setAttribute('x1', p.x); ch.setAttribute('x2', p.x);
      ch.setAttribute('visibility', 'visible');
    }
    var tip = ui.forceTooltip;
    tip.textContent = '';
    var head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = 'Step ' + h.step;
    tip.appendChild(head);
    [
      ['Drag Cd', h.cd.toFixed(3), cssVar('--series-1')],
      ['Lift Cl', h.cl.toFixed(3), cssVar('--series-2')],
      ['L/D', h.ld.toFixed(3), cssVar('--series-3')]
    ].forEach(function (row) {
      var r = document.createElement('div');
      r.className = 'tt-row';
      var label = document.createElement('span');
      label.className = 'tt-series';
      var key = document.createElement('span');
      key.className = 'tt-key';
      key.style.background = row[2];
      label.appendChild(key);
      label.appendChild(document.createTextNode(row[0]));
      var value = document.createElement('strong');
      value.textContent = row[1];
      r.appendChild(label); r.appendChild(value);
      tip.appendChild(r);
    });
    tip.hidden = false;
    var host = tip.parentElement.getBoundingClientRect();
    var lx = clientX - host.left + 14;
    var ly = clientY - host.top - 12;
    tip.style.left = Math.max(4, Math.min(host.width - tip.offsetWidth - 4, lx)) + 'px';
    tip.style.top = Math.max(4, Math.min(host.height - tip.offsetHeight - 4, ly)) + 'px';
  }

  /* ---------------- Section chart ---------------- */

  function renderSection(withTables) {
    var svg = ui.sectionChart;
    var mask = app.state.mask;
    clearSvg(svg);
    var W = 540;
    var H = 220;
    var left = 36;
    var midR = 302;
    var polL = 354;
    var right = 524;
    var top = 18;
    var bottom = 186;
    var g = svgEl('g');
    g.appendChild(svgEl('line', { x1: left, x2: midR, y1: bottom, y2: bottom, class: 'axis-line' }));
    g.appendChild(svgEl('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'axis-line' }));
    for (var t = 0; t <= 5; t++) {
      var x = left + (midR - left) * t / 5;
      g.appendChild(svgEl('line', { x1: x, x2: x, y1: top, y2: bottom, class: 'gridline' }));
      g.appendChild(svgEl('text', { x: x, y: bottom + 14, 'text-anchor': 'middle', class: 'tick-text' }, (t / 5).toFixed(1)));
    }
    g.appendChild(svgEl('text', {
      x: (left + midR) / 2, y: H - 5, 'text-anchor': 'middle', class: 'axis-title'
    }, 'Section ordinate x / c'));

    /* Right sub-panel: Cl vs Cd polar locus */
    g.appendChild(svgEl('line', { x1: polL, x2: right, y1: bottom, y2: bottom, class: 'axis-line' }));
    g.appendChild(svgEl('line', { x1: polL, x2: polL, y1: top, y2: bottom, class: 'axis-line' }));
    var history = app.state.forceHistory.slice(-160);
    var cds = history.map(function (entry) { return entry.cd; });
    var cls = history.map(function (entry) { return entry.cl; });
    var cdScale = niceTicks(Math.min.apply(null, cds.concat([0])), Math.max.apply(null, cds.concat([0.1])), 3);
    var clScale = niceTicks(Math.min.apply(null, cls.concat([-0.1])), Math.max.apply(null, cls.concat([0.1])), 3);
    var pxPol = function (cd) { return polL + (cd - cdScale.lo) / (cdScale.hi - cdScale.lo) * (right - polL); };
    var pyPol = function (cl) { return bottom - (cl - clScale.lo) / (clScale.hi - clScale.lo) * (bottom - top); };
    cdScale.ticks.forEach(function (value) { g.appendChild(svgEl('text', { x: pxPol(value), y: bottom + 13, 'text-anchor': 'middle', class: 'tick-text' }, value.toFixed(1))); });
    clScale.ticks.forEach(function (value) { g.appendChild(svgEl('text', { x: polL - 5, y: pyPol(value) + 3, 'text-anchor': 'end', class: 'tick-text' }, value.toFixed(1))); });
    g.appendChild(svgEl('text', { x: (polL + right) / 2, y: H - 5, 'text-anchor': 'middle', class: 'axis-title' }, 'Measured Cd / Cl trajectory'));
    svg.appendChild(g);

    var isAirfoil = mask.kind === 'naca4';
    if (isAirfoil) {
      var c = mask.coordinates;
      var yMax = Math.max(0.32, c.maxThickness * 2.2, c.maxCamber * 2.4);
      var xOf = function (x) { return left + x * (midR - left); };
      var yOf = function (y) { return (top + bottom) / 2 - y / yMax * (bottom - top) * 0.46; };
      var upper = c.upper.map(function (p) { return [xOf(p.x), yOf(p.y)]; });
      var lower = c.lower.map(function (p) { return [xOf(p.x), yOf(p.y)]; });
      var outline = upper.concat(lower.slice().reverse());
      svg.appendChild(svgEl('path', {
        d: pathFrom(outline) + ' Z', fill: cssVar('--seq-250'), opacity: '0.28',
        stroke: cssVar('--series-1'), 'stroke-width': 2, 'stroke-linejoin': 'round'
      }));
      svg.appendChild(svgEl('path', {
        d: pathFrom(c.camberLine.map(function (p) { return [xOf(p.x), yOf(p.y)]; })),
        fill: 'none', stroke: cssVar('--series-2'), 'stroke-width': 1.8, 'stroke-dasharray': '5 4'
      }));
      var chord = svgEl('path', { d: pathFrom([[xOf(0), yOf(0)], [xOf(1), yOf(0)]]), fill: 'none', stroke: cssVar('--axis'), 'stroke-width': 1 });
      svg.appendChild(chord);
      svg.appendChild(svgEl('circle', {
        cx: xOf(0.25), cy: yOf(SF.naca4Camber(0.25, c.maxCamber, c.camberPosition)),
        r: 3.2, fill: cssVar('--series-2')
      }));
      svg.appendChild(svgEl('text', { x: xOf(0.25) + 5, y: yOf(0) + 13, class: 'tick-text' }, '0.25c'));
      ui.sectionSub.textContent = 'Exact NACA ' + c.code + ' thickness and camber polynomials offset along the local normal across ' + c.samples + ' cosine-clustered stations.';
      if (withTables !== false) renderSectionTable(c);
    } else {
      var scale = Math.min((midR - left) / NX, (bottom - top) / NY) * 0.92;
      var ox = left + ((midR - left) - NX * scale) / 2;
      var oy = top + ((bottom - top) - NY * scale) / 2;
      var path = [];
      var i;
      var j;
      for (i = 0; i < NX; i++) {
        var topY = -1;
        var botY = -1;
        for (j = 0; j < NY; j++) {
          if (mask[j * NX + i] === 1) { if (topY < 0) topY = j; botY = j; }
        }
        if (topY >= 0) path.push([ox + i * scale, oy + topY * scale, oy + (botY + 1) * scale]);
      }
      var fill = app.colors['--seq-250'];
      var fillCss = rgbToCss(fill);
      for (i = 0; i < NX; i++) {
        var start = -1;
        for (j = 0; j <= NY; j++) {
          var solid = j < NY && mask[j * NX + i] === 1;
          if (solid && start < 0) start = j;
          if (!solid && start >= 0) {
            svg.appendChild(svgEl('rect', { x: ox + i * scale, y: oy + start * scale, width: Math.max(0.7, scale), height: (j - start) * scale, fill: fillCss, opacity: '0.55' }));
            start = -1;
          }
        }
      }
      svg.appendChild(svgEl('text', {
        x: (left + midR) / 2, y: (top + bottom) / 2,
        'text-anchor': 'middle', class: 'axis-title'
      }, mask.shape + ' (' + mask.solidCount + ' nodes)'));
      ui.sectionSub.textContent = 'Solid cell raster for ' + mask.shape + '. Select a NACA airfoil to inspect continuous section ordinates.';
      if (withTables !== false) renderSectionTable(null);
    }

    app.polarPoints = history.map(function (entry) { return [pxPol(entry.cd), pyPol(entry.cl)]; });
    if (app.polarPoints.length) {
      svg.appendChild(svgEl('path', { d: pathFrom(app.polarPoints), fill: 'none', stroke: cssVar('--series-3'), 'stroke-width': 1.8 }));
      var last = app.polarPoints[app.polarPoints.length - 1];
      svg.appendChild(svgEl('circle', { cx: last[0], cy: last[1], r: 4, fill: cssVar('--series-2'), class: 'end-dot' }));
      svg.appendChild(svgEl('text', { x: polL + 4, y: top + 10, class: 'tick-text' }, history.length + ' measured pairs'));
    }
    renderSpecs(mask);
  }

  function renderSpecs(mask) {
    var d = app.diag;
    var rows = [
      ['Model geometry', mask.shape],
      ['NACA designation', mask.code || 'non-airfoil'],
      ['Incidence alpha', (mask.angleDeg || 0).toFixed(1) + ' deg'],
      ['Solid lattice nodes', String(mask.solidCount)],
      ['Force reference length', app.state.referenceHeight.toFixed(2) + ' px'],
      ['Coefficient convention', mask.kind === 'naca4' ? 'chord x unit span' : 'projected height x unit span'],
      ['Reynolds number Re', d.reynolds.toFixed(1)],
      ['BGK tau / omega', app.state.tau.toFixed(4) + ' / ' + app.state.omega.toFixed(3)],
      ['Peak speed |u|_max', d.maxSpeed.toFixed(4)],
      ['Pressure Cp span', d.minCp.toFixed(2) + ' to ' + d.maxCp.toFixed(2)]
    ];
    if (mask.kind === 'naca4') {
      rows.splice(3, 0,
        ['Max camber m/c', mask.maxCamber.toFixed(3)],
        ['Camber station p/c', mask.camberPosition.toFixed(2)],
        ['Thickness ratio t/c', mask.thickness.toFixed(3)]);
    }
    ui.specList.textContent = '';
    var dl = document.createElement('dl');
    dl.style.margin = '0';
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'spec-row';
      var dt = document.createElement('dt');
      dt.textContent = r[0];
      var dd = document.createElement('dd');
      dd.textContent = r[1];
      row.appendChild(dt); row.appendChild(dd);
      dl.appendChild(row);
    });
    ui.specList.appendChild(dl);
  }

  /* ---------------- Accessible tables ---------------- */

  function buildTable(table, headers, rows, defaultCaption) {
    var existing = table.querySelector('caption');
    var captionText = table.getAttribute('data-caption') ||
      (existing ? existing.textContent : (defaultCaption || 'Data table'));
    table.setAttribute('data-caption', captionText);
    table.textContent = '';
    var caption = document.createElement('caption');
    caption.textContent = captionText;
    table.appendChild(caption);
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    headers.forEach(function (h) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (cells) {
      var tr = document.createElement('tr');
      cells.forEach(function (v, k) {
        var td = document.createElement(k === 0 ? 'th' : 'td');
        if (k === 0) td.scope = 'row';
        td.textContent = String(v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function renderTables() {
    var wake = app.diag.wake.samples;
    buildTable(ui.wakeTable, ['Row j', 'u_x', 'u_y', '|u|', 'rho', 'Cp', 'curl', 'Solid'],
      wake.map(function (s) {
        return [s.y, s.ux.toFixed(4), s.uy.toFixed(4), s.speed.toFixed(4),
          s.rho.toFixed(4), s.cp.toFixed(3), s.curl.toFixed(4), s.solid ? 'yes' : 'no'];
      }), 'Streamwise velocity by transverse grid position');
    var hist = app.state.forceHistory.slice(-120);
    buildTable(ui.forceTable, ['Step', 'F_x', 'F_y', 'Cd', 'Cl', 'L/D'],
      hist.map(function (h) {
        return [h.step, h.fx.toFixed(4), h.fy.toFixed(4), h.cd.toFixed(3), h.cl.toFixed(3), h.ld.toFixed(3)];
      }), 'Instantaneous force coefficients by simulation step');
  }

  function renderSectionTable(coords) {
    if (!coords) {
      buildTable(ui.sectionTable, ['Property', 'Value'], [
        ['Shape', app.state.mask.shape],
        ['Solid cells', String(app.state.mask.solidCount)],
        ['Grid', NX + ' x ' + NY]
      ], 'Obstacle raster summary');
      return;
    }
    var rows = [];
    var step = Math.max(1, Math.round(coords.samples / 40));
    for (var k = 0; k <= coords.samples; k += step) {
      var u = coords.upper[k];
      var l = coords.lower[k];
      var c = coords.camberLine[k];
      rows.push([c.x.toFixed(4), u.y.toFixed(5), l.y.toFixed(5), c.y.toFixed(5),
        c.thickness.toFixed(5), c.slope.toFixed(5)]);
    }
    buildTable(ui.sectionTable, ['x/c', 'Upper y', 'Lower y', 'Camber y', 'Half thickness', 'Camber slope'],
      rows, 'NACA ' + coords.code + ' section coordinates');
  }

  /* ---------------- Stats and frame render ---------------- */

  function fmtSigned(v) {
    if (!Number.isFinite(v)) return '--';
    return (v >= 0 ? '' : '-') + Math.abs(v).toFixed(3);
  }

  function renderStats() {
    var d = app.diag;
    ui.statRe.textContent = Math.round(d.reynolds).toLocaleString('en-US');
    ui.statReNote.textContent = 'u0 L / nu, L = ' + d.referenceLength.toFixed(1) + ' px';
    ui.statCd.textContent = fmtSigned(d.meanCd);
    ui.statCl.textContent = fmtSigned(d.meanCl);
    ui.statLd.textContent = fmtSigned(d.meanLd);
    ui.statTime.textContent = 'step ' + app.state.time;
    if (ui.statTau) {
      ui.statTau.textContent = app.state.tau.toFixed(3) + ' / ' + app.state.omega.toFixed(2);
    }
    if (ui.statMach) {
      var ma = app.state.u0 * Math.sqrt(3);
      ui.statMach.textContent = 'Ma = ' + ma.toFixed(3) + ' (cs = 0.577)';
    }
  }

  function renderAll(withTables) {
    computeSchlierenField();
    renderField();
    renderLegend(currentFieldLimit());
    renderCpChart();
    renderWakeChart();
    renderForceChart();
    renderStats();
    renderSection(!!withTables);
    renderProbeReadout();
    renderHealth();
    ui.fieldDescription.textContent = fieldDescriptions()[app.field];
    if (withTables) renderTables();
  }

  function frame() {
    app.raf = null;
    if (!app.running || !app.diag) return;
    var tables = false;
    try {
      var steps = app.warmRemaining > 0 ? Math.min(20, app.warmRemaining) : STEPS_PER_FRAME;
      SF.stepLBM(app.state, steps);
      app.warmRemaining = Math.max(0, app.warmRemaining - steps);
      app.diag = SF.computeDiagnostics(app.state);
      app.frame++;
      if (app.field === 'tracers') advanceTracers();
      if (app.frame % CHART_EVERY === 0) renderAll(false);
      else { computeSchlierenField(); renderField(); renderProbeReadout(); }
      if (app.scenario) ui.scenarioStatus.textContent = SF.getScenario(app.scenario).label + (app.warmRemaining ? ': ' + app.warmRemaining + ' preparation steps left' : ': live experiment');
      if (app.frame % TABLE_EVERY === 0) { renderTables(); tables = true; }
      if (app.frame % (CHART_EVERY * 10) === 0) {
        announce('Step ' + app.state.time + '. Mean drag ' + fmtSigned(app.diag.meanCd) +
          ', mean lift ' + fmtSigned(app.diag.meanCl) + '.');
      }
    } catch (err) {
      app.running = false;
      ui.runToggle.textContent = 'Resume tunnel';
      ui.runToggle.setAttribute('aria-pressed', 'false');
      reportError('Simulation stopped: ' + (err && err.message ? err.message : 'solver error'));
    }
    if (app.running) scheduleFrame();
    else if (!tables) renderTables();
  }

  function setRunning(on) {
    app.running = on;
    ui.runToggle.textContent = on ? 'Pause tunnel' : 'Resume tunnel';
    ui.runToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    announce(on ? 'Simulation running.' : 'Simulation paused.');
    if (!on && app.raf != null) { cancelAnimationFrame(app.raf); app.raf = null; }
    if (on) scheduleFrame();
  }

  function scheduleFrame() {
    if (app.running && app.raf == null && !document.hidden) app.raf = requestAnimationFrame(frame);
  }

  function renderHealth() {
    var d = app.diag;
    var passes = d.nonFiniteNodes === 0 && d.inletResidual < 1e-8 && !d.unstable;
    ui.solverStatus.textContent = (passes ? 'SOLVER CHECKS PASS' : 'SOLVER NEEDS ATTENTION') + ' | ' + app.state.cellCount.toLocaleString('en-US') + ' finite cells | inlet residual ' + d.inletResidual.toExponential(1) + ' | ' + d.sanitizedNodes + ' repaired nodes | peak Ma ' + d.maxMach.toFixed(3);
    ui.solverStatus.className = passes ? 'is-pass' : 'is-warning';
  }

  function renderProbeReadout() {
    var probe = SF.sampleField(app.state, app.probe.i, app.probe.j, app.diag.fields);
    ui.probeReadout.textContent = 'i=' + probe.i + ', j=' + probe.j + (probe.solid ? ' | solid, no-slip' : ' | ux=' + probe.ux.toFixed(4) + ' | uy=' + probe.uy.toFixed(4) + ' | Cp=' + probe.cp.toFixed(3) + ' | vorticity=' + probe.vorticity.toFixed(4));
  }

  function toggleProbePin() {
    app.probePinned = !app.probePinned;
    ui.pinProbe.setAttribute('aria-pressed', String(app.probePinned));
    ui.pinProbe.textContent = app.probePinned ? 'Release probe' : 'Pin probe';
    announce(app.probePinned ? 'Probe pinned. ' + ui.probeReadout.textContent : 'Probe released.');
  }

  /* ---------------- Downloads ---------------- */

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function fileTag() {
    var s = app.state;
    return 'step' + s.time + '-' + (s.obstacle.code || s.obstacle.kind || 'flow');
  }

  /* ---------------- Field tooltip ---------------- */

  function showFieldTooltip(event) {
    var rect = ui.canvas.getBoundingClientRect();
    var x = (event.clientX - rect.left) / rect.width * NX;
    var y = (event.clientY - rect.top) / rect.height * NY;
    if (x < 0 || y < 0 || x >= NX || y >= NY) { ui.fieldTooltip.hidden = true; return; }
    var i = Math.floor(x);
    var j = Math.floor(y);
    app.probe = { i: i, j: j };
    renderProbeReadout();
    var cell = j * NX + i;
    var f = app.diag.fields;
    var st = app.state;
    var tip = ui.fieldTooltip;
    tip.textContent = '';
    var head = document.createElement('div');
    head.style.fontWeight = '700';
    head.textContent = st.mask[cell] === 1
      ? 'Solid node (i=' + i + ', j=' + j + ')'
      : 'Fluid node (i=' + i + ', j=' + j + ')';
    tip.appendChild(head);
    var rows = st.mask[cell] === 1
      ? [['boundary', 'halfway bounce-back, u = 0']]
      : [
          ['u_x', st.ux[cell].toFixed(4)], ['u_y', st.uy[cell].toFixed(4)],
          ['|u|', f.speed[cell].toFixed(4)], ['rho', st.rho[cell].toFixed(4)],
          ['Cp', f.cp[cell].toFixed(3)], ['vorticity', f.vorticity[cell].toFixed(4)]
        ];
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.textContent = r[0] + ': ' + r[1];
      tip.appendChild(row);
    });
    tip.hidden = false;
    var host = ui.canvas.parentElement.getBoundingClientRect();
    var lx = event.clientX - host.left + 14;
    var ly = event.clientY - host.top - 10;
    tip.style.left = Math.max(4, Math.min(host.width - tip.offsetWidth - 4, lx)) + 'px';
    tip.style.top = Math.max(4, Math.min(host.height - tip.offsetHeight - 4, ly)) + 'px';
  }

  /* ---------------- Theme ---------------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var dark = theme === 'dark';
    ui.themeLabel.textContent = dark ? 'Light theme' : 'Dark theme';
    ui.themeToggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
    try { localStorage.setItem('spectralflow-theme', theme); } catch (e) { /* storage optional */ }
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('spectralflow-theme'); } catch (e) { /* storage optional */ }
    if (saved === 'light' || saved === 'dark') { applyTheme(saved); return; }
    applyTheme('dark');
  }

  /* ---------------- Event wiring ---------------- */

  function setField(field) {
    if (['curl', 'schlieren', 'cp', 'speed', 'tracers'].indexOf(field) < 0) return;
    app.field = field;
    var segs = document.querySelectorAll('.seg');
    for (var k = 0; k < segs.length; k++) {
      segs[k].setAttribute('aria-checked', segs[k].getAttribute('data-field') === field ? 'true' : 'false');
      segs[k].setAttribute('tabindex', segs[k].getAttribute('data-field') === field ? '0' : '-1');
    }
    app.lutKey = '';
    renderAll(false);
    announce('Field view: ' + field + '.');
  }

  function bindEvents() {
    document.querySelector('.showcase').addEventListener('click', function (event) {
      var node = event.target.closest ? event.target.closest('[data-scenario]') : null;
      if (node) loadScenario(node.dataset.scenario);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && app.raf != null) { cancelAnimationFrame(app.raf); app.raf = null; }
      else scheduleFrame();
    });
    ui.themeToggle.addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      refreshColors();
      renderAll(false);
      });
    ui.printBtn.addEventListener('click', function () {
      renderAll(true);
        setTimeout(function () { globalThis.print(); }, 60);
    });

    ui.obstacleKind.addEventListener('change', function () {
      app.scenario = ''; ui.scenarioStatus.textContent = 'Custom experiment';
      updateControlLabels();
      rebuild(true);
    });
    ui.customCode.addEventListener('change', function () {
      if (ui.obstacleKind.value === 'custom') rebuild(true);
    });
    ui.customCode.addEventListener('input', function () {
      if (/^[0-9]{4}$/.test(ui.customCode.value.trim()) && ui.obstacleKind.value === 'custom') rebuild(true);
    });

    var ranges = [ui.angleRange, ui.speedRange, ui.viscosityRange, ui.chordRange];
    ranges.forEach(function (r) {
      r.addEventListener('input', updateControlLabels);
      r.addEventListener('change', function () { app.scenario = ''; ui.scenarioStatus.textContent = 'Custom experiment'; rebuild(true); });
    });

    ui.runToggle.addEventListener('click', function () { setRunning(!app.running); });
    ui.stepBtn.addEventListener('click', function () {
      setRunning(false);
      try {
        SF.stepLBM(app.state, 20);
        if (app.field === 'tracers') advanceTracers();
        app.diag = SF.computeDiagnostics(app.state);
        renderAll(true);
        announce('Advanced 20 steps to step ' + app.state.time + '.');
      } catch (err) {
        reportError('Step failed: ' + (err && err.message ? err.message : 'solver error'));
      }
    });
    ui.resetBtn.addEventListener('click', function () { rebuild(true); });

    var segs = document.querySelectorAll('.seg');
    for (var k = 0; k < segs.length; k++) {
      segs[k].addEventListener('click', function () { setField(this.getAttribute('data-field')); });
    }
    document.querySelector('.segmented').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      var all = Array.prototype.slice.call(this.querySelectorAll('.seg'));
      var cur = all.indexOf(document.activeElement);
      if (cur < 0) return;
      var dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      var next = all[(cur + dir + all.length) % all.length];
      e.preventDefault();
      next.focus();
      setField(next.getAttribute('data-field'));
    });

    ui.textureToggle.addEventListener('click', function () {
      app.texture = !app.texture;
      document.documentElement.setAttribute('data-texture', app.texture ? 'on' : 'off');
      ui.textureToggle.setAttribute('aria-pressed', app.texture ? 'true' : 'false');
      ui.textureToggle.textContent = app.texture ? 'Hatching on' : 'Hatching';
      app.lutKey = '';
      renderField();
      announce('Hatching ' + (app.texture ? 'enabled' : 'disabled') + '.');
    });

    ui.canvas.addEventListener('pointermove', function (event) { if (!app.probePinned) showFieldTooltip(event); });
    ui.canvas.addEventListener('pointerdown', function (event) { if (!app.probePinned) showFieldTooltip(event); toggleProbePin(); });
    ui.canvas.addEventListener('focus', renderProbeReadout);
    ui.canvas.addEventListener('keydown', function (event) {
      var amount = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft') app.probe.i = Math.max(0, app.probe.i - amount);
      else if (event.key === 'ArrowRight') app.probe.i = Math.min(NX - 1, app.probe.i + amount);
      else if (event.key === 'ArrowUp') app.probe.j = Math.max(0, app.probe.j - amount);
      else if (event.key === 'ArrowDown') app.probe.j = Math.min(NY - 1, app.probe.j + amount);
      else if (event.key === 'Home') app.probe.i = 0;
      else if (event.key === 'End') app.probe.i = NX - 1;
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleProbePin(); return; }
      else if (event.key === 'Escape') { if (app.probePinned) toggleProbePin(); ui.fieldTooltip.hidden = true; return; }
      else return;
      event.preventDefault(); renderProbeReadout(); renderField(); announce(ui.probeReadout.textContent);
    });
    ui.pinProbe.addEventListener('click', toggleProbePin);
    ui.canvas.addEventListener('pointerleave', function () { ui.fieldTooltip.hidden = true; });
    ui.wakeChart.addEventListener('pointermove', function (e) { showWakeTooltip(e.clientX, e.clientY); });
    ui.wakeChart.addEventListener('pointerleave', function () { hideTooltip(ui.wakeTooltip, ui.wakeChart); });
    ui.forceChart.addEventListener('pointermove', function (e) { showForceTooltip(e.clientX, e.clientY); });
    ui.forceChart.addEventListener('pointerleave', function () { hideTooltip(ui.forceTooltip, ui.forceChart); });

    ui.wakeChart.parentElement.addEventListener('focusin', function () {
      if (app.wakePoints.length === 0) return;
      var mid = app.wakePoints[Math.floor(app.wakePoints.length / 2)];
      var rect = ui.wakeChart.getBoundingClientRect();
      showWakeTooltip(rect.left + mid[0] / CHART_W * rect.width,
        rect.top + mid[1] / CHART_H * rect.height);
    });
    ui.forceChart.parentElement.addEventListener('focusin', function () {
      if (app.forcePoints.length === 0) return;
      var last = app.forcePoints[app.forcePoints.length - 1];
      var rect = ui.forceChart.getBoundingClientRect();
      showForceTooltip(rect.left + last.x / CHART_W * rect.width,
        rect.top + (PLOT.top + PLOT.bottom) / 2 / CHART_H * rect.height);
    });

    ui.wakeChart.setAttribute('tabindex', '0');
    ui.forceChart.setAttribute('tabindex', '0');
    ui.wakeChart.addEventListener('focusout', function () { hideTooltip(ui.wakeTooltip, ui.wakeChart); });
    ui.forceChart.addEventListener('focusout', function () { hideTooltip(ui.forceTooltip, ui.forceChart); });

    ui.csvBtn.addEventListener('click', function () {
      download('spectralflow-wake-' + fileTag() + '.csv',
        SF.exportWakeProfileCSV(app.state), 'text/csv');
      announce('Wake profile CSV downloaded.');
    });
    ui.forceCsvBtn.addEventListener('click', function () {
      download('spectralflow-forces-' + fileTag() + '.csv',
        SF.exportForceHistoryCSV(app.state), 'text/csv');
      announce('Force history CSV downloaded.');
    });
    ui.jsonBtn.addEventListener('click', function () {
      try {
        var result = SF.verifySnapshotRoundTrip(app.state);
        if (!result.passes) throw new Error('Checkpoint verification failed');
        download('spectralflow-checkpoint-' + fileTag() + '.json', SF.exportSnapshotJSON(app.state, { includePopulations: true }), 'application/json');
        ui.scenarioStatus.textContent = 'Checkpoint round trip PASS: ' + result.populations.toLocaleString('en-US') + ' populations restored exactly';
        announce(ui.scenarioStatus.textContent);
      } catch (error) { reportError(error.message); }
    });
    ui.fieldCsvBtn.addEventListener('click', function () { download('spectralflow-field-' + fileTag() + '.csv', SF.exportFieldCSV(app.state), 'text/csv'); announce('Full lattice field CSV downloaded.'); });
    ui.importBtn.addEventListener('click', function () { ui.snapshotInput.click(); });
    ui.snapshotInput.addEventListener('change', async function () {
      var file = ui.snapshotInput.files && ui.snapshotInput.files[0];
      if (!file) return;
      try {
        if (file.size > 32 * 1024 * 1024) throw new Error('Checkpoint exceeds the 32 MB import limit');
        var restored = SF.importSnapshotJSON(await file.text());
        if (restored.nx !== NX || restored.ny !== NY) throw new Error('This viewport requires a 220 by 92 checkpoint');
        if (['naca4', 'cylinder', 'bluff', 'venturi'].indexOf(restored.mask.kind) < 0) throw new Error('This viewport requires a supported model family');
        setRunning(false); app.state = restored; app.scenario = ''; app.warmRemaining = 0;
        var code = restored.mask.code;
        if (restored.mask.kind === 'naca4') {
          if (['0012', '2412', '4415'].indexOf(code) >= 0) ui.obstacleKind.value = 'naca' + code;
          else { ui.obstacleKind.value = 'custom'; ui.customCode.value = code; }
          ui.angleRange.value = restored.mask.angleDeg; ui.chordRange.value = restored.mask.chordPx;
        } else ui.obstacleKind.value = restored.mask.kind;
        ui.speedRange.min = Math.min(Number(ui.speedRange.min), restored.u0); ui.speedRange.max = Math.max(Number(ui.speedRange.max), restored.u0);
        ui.viscosityRange.min = Math.min(Number(ui.viscosityRange.min), restored.viscosity); ui.viscosityRange.max = Math.max(Number(ui.viscosityRange.max), restored.viscosity);
        ui.speedRange.value = restored.u0; ui.viscosityRange.value = restored.viscosity;
        updateControlLabels(); seedTracers(); app.diag = SF.computeDiagnostics(restored); renderAll(true);
        ui.errorStatus.hidden = true; ui.scenarioStatus.textContent = 'Checkpoint restored at step ' + restored.time + '. Resume when ready.';
        announce(ui.scenarioStatus.textContent);
      } catch (error) { reportError('Import failed: ' + error.message); }
      ui.snapshotInput.value = '';
    });

    globalThis.addEventListener('resize', function () {
      refreshColors();
      renderField();
      renderLegend(currentFieldLimit());
    });
  }

  /* ---------------- Bootstrap ---------------- */

  initTheme();
  refreshColors();
  bindEvents();
  rebuild(true);
  setRunning(true);
})();
