/*
 * SpectralFlow spectral-app.js
 * Spectral lab controller: window/signal controls, magnitude-response SVG,
 * metrics table, checksummed audit downloads, #sf= bookmark, self-test panel.
 * Zero dependencies. No network requests.
 */
(function () {
  'use strict';

  var SF = globalThis.SpectralFlow;
  var SL = globalThis.SpectralLab;
  var $ = function (id) { return document.getElementById(id); };

  if (!SF || !SL) {
    var liveStatus = $('liveStatus');
    if (liveStatus) liveStatus.textContent = 'The spectral lab module did not load.';
    return;
  }

  var ui = {
    signal: $('slSignal'), fftSize: $('slFftSize'), tag: $('slTag'), note: $('slNote'),
    chart: $('slChart'), tooltip: $('slTooltip'), legend: $('slLegend'),
    table: $('slTable'), linkBtn: $('slLinkBtn'), jsonBtn: $('slJsonBtn'),
    csvBtn: $('slCsvBtn'), mdBtn: $('slMdBtn'),
    selfTestBtn: $('slSelfTestBtn'), selfTestResults: $('slSelfTestResults'),
    liveStatus: $('liveStatus')
  };

  if (!ui.chart || !ui.signal) return;

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var CHART_W = 540;
  var CHART_H = 280;
  var PLOT = { left: 52, right: 524, top: 16, bottom: 238 };
  var X_MAX = 40;       /* bins shown around the main lobe */
  var Y_MIN = -140, Y_MAX = 3;
  var SERIES_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'];

  var state = {
    signal: 'pureTone',
    fftSize: 512,
    comparison: null,
    hidden: {},
    responses: {}
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function announce(text) { if (ui.liveStatus) ui.liveStatus.textContent = text; }
  function note(text) { ui.note.textContent = text || ''; }

  /* ---------------- SVG helpers (same idioms as app.js) ---------------- */

  function svgEl(tag, attrs, text) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    if (text !== undefined) el.textContent = String(text);
    return el;
  }

  function clearSvg(svg) {
    Array.from(svg.childNodes).forEach(function (node) {
      if (node.nodeType !== 1 || (node.localName !== 'title' && node.localName !== 'desc')) svg.removeChild(node);
    });
  }

  function xOf(bins) { return PLOT.left + (bins / X_MAX) * (PLOT.right - PLOT.left); }
  function yOf(db) { return PLOT.top + ((Y_MAX - db) / (Y_MAX - Y_MIN)) * (PLOT.bottom - PLOT.top); }
  function binsAt(x) { return (x - PLOT.left) / (PLOT.right - PLOT.left) * X_MAX; }

  function pathFrom(points) {
    var d = '';
    for (var k = 0; k < points.length; k++) {
      d += (k === 0 ? 'M' : 'L') + points[k][0].toFixed(2) + ' ' + points[k][1].toFixed(2);
    }
    return d;
  }

  /* ---------------- Chart ---------------- */

  function seriesColor(i) { return cssVar(SERIES_VARS[i % SERIES_VARS.length]) || '#888'; }

  function renderFrame() {
    var g = svgEl('g');
    var db;
    for (db = 0; db >= Y_MIN; db -= 20) {
      var y = yOf(db);
      g.appendChild(svgEl('line', { x1: PLOT.left, x2: PLOT.right, y1: y, y2: y, class: 'gridline' }));
      g.appendChild(svgEl('text', { x: PLOT.left - 8, y: y + 3.5, 'text-anchor': 'end', class: 'tick-text' }, String(db)));
    }
    for (var b = 0; b <= X_MAX; b += 8) {
      var x = xOf(b);
      g.appendChild(svgEl('line', { x1: x, x2: x, y1: PLOT.top, y2: PLOT.bottom, class: 'gridline' }));
      g.appendChild(svgEl('text', { x: x, y: PLOT.bottom + 17, 'text-anchor': 'middle', class: 'tick-text' }, String(b)));
    }
    g.appendChild(svgEl('line', {
      x1: PLOT.left, x2: PLOT.right, y1: yOf(-3), y2: yOf(-3), class: 'ref-line'
    }));
    g.appendChild(svgEl('text', {
      x: PLOT.right - 4, y: yOf(-3) - 4, 'text-anchor': 'end', class: 'tick-text'
    }, '-3 dB'));
    g.appendChild(svgEl('line', { x1: PLOT.left, x2: PLOT.right, y1: PLOT.bottom, y2: PLOT.bottom, class: 'axis-line' }));
    g.appendChild(svgEl('line', { x1: PLOT.left, x2: PLOT.left, y1: PLOT.top, y2: PLOT.bottom, class: 'axis-line' }));
    g.appendChild(svgEl('text', {
      x: (PLOT.left + PLOT.right) / 2, y: CHART_H - 10, 'text-anchor': 'middle', class: 'axis-title'
    }, 'frequency offset (bins = Hz)'));
    g.appendChild(svgEl('text', {
      x: 14, y: (PLOT.top + PLOT.bottom) / 2, 'text-anchor': 'middle', class: 'axis-title',
      transform: 'rotate(-90 14 ' + ((PLOT.top + PLOT.bottom) / 2) + ')'
    }, '|W(f)| dB'));
    ui.chart.appendChild(g);
  }

  function renderSeries() {
    var keys = SL.WINDOW_KEYS;
    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      if (state.hidden[name]) continue;
      var db = state.responses[name];
      var pad = SL.RESPONSE_PAD;
      var pts = [];
      var last = Math.min(Math.floor(X_MAX * pad), db.length - 1);
      for (var s = 0; s <= last; s += 2) {
        pts.push([xOf(s / pad), yOf(Math.max(db[s], Y_MIN))]);
      }
      ui.chart.appendChild(svgEl('path', {
        d: pathFrom(pts), class: 'series-line',
        stroke: seriesColor(i), 'data-window': name
      }));
    }
  }

  var crosshair = null;
  function showCrosshair(clientX) {
    var rect = ui.chart.getBoundingClientRect();
    var bx = binsAt((clientX - rect.left) / rect.width * CHART_W);
    if (bx < 0 || bx > X_MAX) { hideTooltip(); return; }
    if (crosshair) crosshair.remove();
    crosshair = svgEl('line', {
      x1: xOf(bx), x2: xOf(bx), y1: PLOT.top, y2: PLOT.bottom, class: 'crosshair'
    });
    ui.chart.appendChild(crosshair);
    var pad = SL.RESPONSE_PAD;
    var idx = Math.round(bx * pad);
    var tip = ui.tooltip;
    tip.textContent = '';
    var head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = '+ ' + bx.toFixed(2) + ' bins';
    tip.appendChild(head);
    SL.WINDOW_KEYS.forEach(function (name, i) {
      if (state.hidden[name]) return;
      var db = state.responses[name];
      var v = db[Math.min(idx, db.length - 1)];
      var row = document.createElement('div');
      row.className = 'tt-row';
      var key = document.createElement('span');
      key.className = 'tt-key';
      key.style.background = seriesColor(i);
      var lab = document.createElement('span');
      lab.className = 'tt-series';
      lab.textContent = SL.windowLabel(name);
      var val = document.createElement('span');
      val.textContent = (v <= Y_MIN ? '< ' : '') + Math.max(v, Y_MIN).toFixed(1) + ' dB';
      row.appendChild(key); row.appendChild(lab); row.appendChild(val);
      tip.appendChild(row);
    });
    tip.hidden = false;
    var host = ui.chart.parentElement.getBoundingClientRect();
    var lx = clientX - host.left + 14;
    tip.style.left = Math.max(4, Math.min(host.width - tip.offsetWidth - 4, lx)) + 'px';
    tip.style.top = '12px';
  }

  function hideTooltip() {
    ui.tooltip.hidden = true;
    if (crosshair) { crosshair.remove(); crosshair = null; }
  }

  /* ---------------- Legend (toggle buttons) ---------------- */

  function renderLegend() {
    ui.legend.textContent = '';
    SL.WINDOW_KEYS.forEach(function (name, i) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'legend-item' + (state.hidden[name] ? ' is-off' : '');
      item.setAttribute('aria-pressed', state.hidden[name] ? 'false' : 'true');
      item.setAttribute('data-window', name);
      var line = document.createElement('span');
      line.className = 'legend-line';
      line.style.setProperty('--line', 'var(' + SERIES_VARS[i % SERIES_VARS.length] + ')');
      line.setAttribute('aria-hidden', 'true');
      item.appendChild(line);
      item.appendChild(document.createTextNode(SL.windowLabel(name)));
      item.addEventListener('click', function () {
        state.hidden[name] = !state.hidden[name];
        renderChart();
        renderLegend();
      });
      ui.legend.appendChild(item);
    });
  }

  function renderChart() {
    clearSvg(ui.chart);
    hideTooltip();
    renderFrame();
    renderSeries();
  }

  /* ---------------- Metrics table ---------------- */

  function cell(row, text, cls) {
    var td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    row.appendChild(td);
  }

  function fmt(v, digits) {
    if (v == null) return 'n/a';
    if (!Number.isFinite(v)) return String(v);
    if (v !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e6)) return v.toExponential(2);
    return v.toFixed(digits == null ? 4 : digits);
  }

  function renderTable() {
    var c = state.comparison;
    ui.table.textContent = '';
    var cap = document.createElement('caption');
    cap.textContent = 'Window metrics on ' + c.signalLabel + ', FFT ' + c.fftSize +
      ' (1 bin = 1 Hz). Parseval residual |E_t - E_f| / E_t; sigma product bound ' + fmt(1 / (4 * Math.PI), 4) + '.';
    ui.table.appendChild(cap);
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['Window', 'CG', 'ENBW', 'Lobe -3dB', 'Sidelobe dB', 'Parseval', 'Peak Hz', 'Err Hz', 'sigma*f'].forEach(function (h) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    ui.table.appendChild(thead);
    var tbody = document.createElement('tbody');
    SL.WINDOW_KEYS.forEach(function (name) {
      var r = c.results[name];
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.scope = 'row';
      th.textContent = r.label;
      tr.appendChild(th);
      cell(tr, fmt(r.coherentGain, 3));
      cell(tr, fmt(r.enbwBins, 3));
      cell(tr, fmt(r.mainLobeWidthBins, 2));
      cell(tr, fmt(r.peakSidelobeDb, 1));
      cell(tr, fmt(r.parsevalResidual, 2));
      cell(tr, fmt(r.peakHz, 2));
      cell(tr, r.peakErrorHz == null ? 'n/a' : fmt(r.peakErrorHz, 4));
      cell(tr, fmt(r.heisenbergProduct, 4));
      tbody.appendChild(tr);
    });
    ui.table.appendChild(tbody);
  }

  /* ---------------- Bookmark ---------------- */

  function bookmarkText() {
    return '#' + SL.encodeBookmark({ signal: state.signal, fftSize: state.fftSize });
  }

  function writeHash() {
    try {
      if (typeof history !== 'undefined' && history && typeof location !== 'undefined') {
        history.replaceState(null, '', bookmarkText());
      }
    } catch (e) { /* hash is a nicety */ }
  }

  function readHash() {
    try {
      if (typeof location === 'undefined' || !location || !location.hash) return null;
      return SL.parseBookmark(location.hash);
    } catch (e) {
      note('Ignored malformed bookmark: ' + e.message);
      return null;
    }
  }

  /* ---------------- Run ---------------- */

  function applyAndRender(source) {
    state.signal = ui.signal.value;
    state.fftSize = Number(ui.fftSize.value);
    try {
      state.comparison = SL.runComparison(state.signal, state.fftSize);
    } catch (e) {
      note('Comparison failed: ' + e.message);
      return;
    }
    state.responses = {};
    SL.WINDOW_KEYS.forEach(function (name) {
      state.responses[name] = SL.windowResponseDb(name, state.fftSize);
    });
    ui.tag.textContent = '1 bin = 1 Hz, fs = ' + state.comparison.sampleRate;
    renderChart();
    renderTable();
    renderLegend();
    if (source !== 'boot') writeHash();
    if (source === 'change') announce('Spectral comparison recomputed for ' + SL.signalLabel(state.signal) + ', FFT ' + state.fftSize + '.');
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

  function fileTag() { return state.signal + '-n' + state.fftSize; }

  /* ---------------- Events ---------------- */

  ui.signal.addEventListener('change', function () { applyAndRender('change'); });
  ui.fftSize.addEventListener('change', function () { applyAndRender('change'); });

  ui.chart.addEventListener('pointermove', function (e) { showCrosshair(e.clientX); });
  ui.chart.addEventListener('pointerleave', hideTooltip);
  ui.chart.addEventListener('focusout', hideTooltip);

  /* Series colours are resolved at render time; a theme flip must redraw so
     the curves follow the new palette like the rest of the page. */
  var themeToggle = $('themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', renderChart);

  ui.jsonBtn.addEventListener('click', function () {
    download('spectralflow-audit-' + fileTag() + '.json',
      SL.exportAuditJSON(state.comparison), 'application/json');
    announce('Spectral audit JSON downloaded with SHA-256 digest.');
  });
  ui.csvBtn.addEventListener('click', function () {
    download('spectralflow-audit-' + fileTag() + '.csv',
      SL.exportAuditCSV(state.comparison), 'text/csv');
    announce('Spectral audit CSV downloaded.');
  });
  ui.mdBtn.addEventListener('click', function () {
    download('spectralflow-audit-' + fileTag() + '.md',
      SL.exportAuditMarkdown(state.comparison), 'text/markdown');
    announce('Spectral audit Markdown downloaded.');
  });
  ui.linkBtn.addEventListener('click', function () {
    var text = '';
    try {
      text = (typeof location !== 'undefined' && location ? location.origin + location.pathname : '') + bookmarkText();
    } catch (e) { text = bookmarkText(); }
    var done = function () { note('Link copied: ' + bookmarkText()); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    } catch (e) { done(); }
  });

  ui.selfTestBtn.addEventListener('click', function () {
    var results = SL.runSpectralSelfTests();
    ui.selfTestResults.textContent = '';
    var passed = 0;
    results.forEach(function (r) {
      var li = document.createElement('li');
      var mark = document.createElement('span');
      mark.className = r.pass ? 'st-pass' : 'st-fail';
      mark.textContent = r.pass ? 'PASS' : 'FAIL';
      li.appendChild(mark);
      li.appendChild(document.createTextNode(' ' + r.name + '. ' + r.detail));
      ui.selfTestResults.appendChild(li);
      if (r.pass) passed++;
    });
    var msg = 'Spectral self-tests: ' + passed + '/' + results.length + ' passed.';
    note(msg);
    announce(msg);
  });

  /* ---------------- Boot ---------------- */

  var bookmark = readHash();
  if (bookmark) {
    ui.signal.value = bookmark.signal;
    ui.fftSize.value = String(bookmark.fftSize);
    note('Restored spectral bench from the link: ' + SL.signalLabel(bookmark.signal) + ', FFT ' + bookmark.fftSize + '.');
  }
  applyAndRender('boot');
})();
