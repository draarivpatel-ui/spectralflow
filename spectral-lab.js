/*
 * SpectralFlow spectral-lab.js
 * STFT windowing workbench: radix-2 FFT, five deterministic analysis windows,
 * five deterministic test signals, leakage/resolution metrics, SHA-256
 * checksummed audit export and #sf= URL bookmarks. Zero dependencies; reuses
 * sha256Hex/csvEscape from cfd.js. CommonJS, AMD and browser global.
 */
(function (root, factory) {
  'use strict';
  var deps;
  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    deps = { SF: require('./cfd.js') };
    module.exports = factory(deps);
  } else if (typeof define === 'function' && define.amd) {
    define([], function () { return factory({ SF: root.SpectralFlow }); });
  } else {
    root.SpectralLab = factory({ SF: root.SpectralFlow });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (deps) {
  'use strict';

  var VERSION = '1.0.0';
  var isFiniteNumber = Number.isFinite;
  var TWO_PI = Math.PI * 2;

  var FFT_SIZES = [128, 256, 512, 1024, 2048];
  var MAX_FFT_SIZE = 4096;
  var MIN_FFT_SIZE = 8;

  function ownValue(table, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
  }

  /* Sample rate equals the frame length, so one DFT bin is exactly 1 Hz and
     bin offsets read directly as Hertz in the workbench. */
  function sampleRateFor(n) { return n; }

  /* ---------------- Deterministic PRNG (LCG) ---------------- */

  /* Same constants as the glibc rand() family used elsewhere in the repo's
     synthetic histories; seeded per signal so exports are reproducible. */
  function makeLcg(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  /* Box-Muller on the LCG stream; deterministic Gaussian noise. */
  function gaussian(rand) {
    var u = Math.max(rand(), 1e-12);
    var v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
  }

  /* ---------------- Radix-2 FFT ---------------- */

  function validateLength(n) {
    if (!Number.isSafeInteger(n) || n < MIN_FFT_SIZE || n > MAX_FFT_SIZE || (n & (n - 1)) !== 0) {
      throw new RangeError('FFT size must be a power of two between ' + MIN_FFT_SIZE + ' and ' + MAX_FFT_SIZE);
    }
  }

  function validateSignal(x, n) {
    if (!x || x.length !== n) throw new RangeError('Signal length must equal the FFT size');
    for (var k = 0; k < n; k++) {
      if (!isFiniteNumber(x[k])) throw new RangeError('Signal contains a nonfinite sample at ' + k);
    }
  }

  /* In-place iterative Cooley-Tukey on parallel re/im arrays. */
  function fftInPlace(re, im) {
    if (!re || !im || re.length !== im.length) {
      throw new RangeError('FFT real and imaginary arrays must have equal length');
    }
    var n = re.length;
    if (!Number.isSafeInteger(n) || n < 2 || (n & (n - 1)) !== 0) {
      throw new RangeError('FFT array length must be a power of two of at least 2');
    }
    for (var q = 0; q < n; q++) {
      if (!isFiniteNumber(re[q]) || !isFiniteNumber(im[q])) {
        throw new RangeError('FFT input contains a nonfinite coefficient at ' + q);
      }
    }
    var j = 0;
    for (var i = 1; i < n; i++) {
      var bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var half = len >> 1;
      var ang = -TWO_PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var s = 0; s < n; s += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < half; k++) {
          var i0 = s + k, i1 = s + k + half;
          var xr = re[i1] * cr - im[i1] * ci;
          var xi = re[i1] * ci + im[i1] * cr;
          re[i1] = re[i0] - xr;
          im[i1] = im[i0] - xi;
          re[i0] += xr;
          im[i0] += xi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  /* fft(realArray) -> {re, im} Float64Arrays, full N-point spectrum. */
  function fft(x) {
    var n = x.length;
    validateLength(n);
    validateSignal(x, n);
    var re = Float64Array.from(x);
    var im = new Float64Array(n);
    fftInPlace(re, im);
    return { re: re, im: im };
  }

  /* ifft({re, im}) -> Float64Array of the reconstructed real signal. */
  function ifft(spectrum) {
    var n = spectrum.re.length;
    validateLength(n);
    /* Conjugate trick: ifft(X) = conj(fft(conj(X)))/N. */
    var re = Float64Array.from(spectrum.re);
    var im = Float64Array.from(spectrum.im, function (v) { return -v; });
    fftInPlace(re, im);
    var out = new Float64Array(n);
    for (var k = 0; k < n; k++) out[k] = re[k] / n;
    return out;
  }

  /* fft/ifft round-trip error: max |x - ifft(fft(x))|. */
  function fftRoundTripError(x) {
    var back = ifft(fft(x));
    var max = 0;
    for (var k = 0; k < x.length; k++) {
      var d = Math.abs(back[k] - x[k]);
      if (d > max) max = d;
    }
    return max;
  }

  /* Parseval residual |E_t - E_f| / E_t for the transform pair
     E_t = sum|x|^2 and E_f = sum|X|^2 / N. */
  function parsevalResidualFor(x) {
    var n = x.length;
    var s = fft(x);
    var et = 0, ef = 0;
    for (var k = 0; k < n; k++) {
      et += x[k] * x[k];
      ef += s.re[k] * s.re[k] + s.im[k] * s.im[k];
    }
    ef /= n;
    return { et: et, ef: ef, residual: et > 0 ? Math.abs(et - ef) / et : 0 };
  }

  function magnitudes(spectrum) {
    var n = spectrum.re.length;
    var mag = new Float64Array(n);
    for (var k = 0; k < n; k++) mag[k] = Math.hypot(spectrum.re[k], spectrum.im[k]);
    return mag;
  }

  /* ---------------- Window functions ---------------- */

  /* Modified Bessel I0 by power series; deterministic to double precision. */
  function besselI0(x) {
    var sum = 1;
    var term = 1;
    var y = (x * x) / 4;
    for (var k = 1; k < 60; k++) {
      term *= y / (k * k);
      sum += term;
      if (term < sum * 1e-16) break;
    }
    return sum;
  }

  var KAISER_BETA = 8;

  /* Periodic (N denominator) forms, the spectral-analysis convention: the
     taper reaches exactly 1 at n = N/2 and satisfies w[n] = w[N-n]. */
  var WINDOW_DEFS = {
    rectangular: {
      label: 'Rectangular',
      sample: function () { return 1; }
    },
    hann: {
      label: 'Hann',
      sample: function (n, nn) { return 0.5 - 0.5 * Math.cos(TWO_PI * n / nn); }
    },
    hamming: {
      label: 'Hamming',
      sample: function (n, nn) { return 0.54 - 0.46 * Math.cos(TWO_PI * n / nn); }
    },
    blackmanHarris: {
      label: 'Blackman-Harris 4-term',
      sample: function (n, nn) {
        var a = TWO_PI * n / nn;
        return 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
      }
    },
    kaiser8: {
      label: 'Kaiser beta=8',
      sample: function (n, nn) {
        var t = (2 * n - nn) / nn;
        return besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - t * t))) / besselI0(KAISER_BETA);
      }
    }
  };

  var WINDOW_KEYS = Object.keys(WINDOW_DEFS);

  function windowSamples(name, n) {
    var def = ownValue(WINDOW_DEFS, name);
    if (!def) throw new RangeError('Unknown window: ' + name);
    if (!Number.isSafeInteger(n) || n < 2 || n > MAX_FFT_SIZE) throw new RangeError('Window length out of range');
    var w = new Float64Array(n);
    for (var k = 0; k < n; k++) w[k] = def.sample(k, n);
    return w;
  }

  /* Coherent gain: mean of the window, the DC derating of a bin-centred tone. */
  function coherentGain(w) {
    var s = 0;
    for (var k = 0; k < w.length; k++) s += w[k];
    return s / w.length;
  }

  /* Equivalent noise bandwidth in bins: N * sum(w^2) / (sum w)^2. */
  function enbwBins(w) {
    var n = w.length;
    var s = 0, q = 0;
    for (var k = 0; k < n; k++) { s += w[k]; q += w[k] * w[k]; }
    return (n * q) / (s * s);
  }

  /* ---------------- Window frequency response ---------------- */

  var RESPONSE_PAD = 64; /* zero-padding factor for continuous-ish response */

  /* |W(f)| in dB, normalised so the main-lobe peak is 0 dB. Covers
     frequencies 0 .. n/2 in units of original DFT bins: out[b] is the
     response at b bins (fractional, from the padded transform). */
  function windowResponseDb(name, n) {
    var w = windowSamples(name, n);
    var m = n * RESPONSE_PAD;
    var re = new Float64Array(m);
    var im = new Float64Array(m);
    for (var k = 0; k < n; k++) re[k] = w[k];
    fftInPlace(re, im);
    var half = m >> 1;
    var db = new Float64Array(half + 1);
    var peak = 0;
    for (var k = 0; k <= half; k++) {
      var v = Math.hypot(re[k], im[k]);
      if (v > peak) peak = v;
      db[k] = v;
    }
    for (k = 0; k <= half; k++) db[k] = 20 * Math.log10(Math.max(db[k] / peak, 1e-9));
    db.binsPerPoint = RESPONSE_PAD;
    db.peakRaw = peak;
    return db;
  }

  /* First local minimum after the main-lobe peak: boundary between main lobe
     and sidelobes in bins. Falls back to twice the -3 dB half-width. */
  function firstNullBin(db, pad) {
    var peak = 0;
    for (var k = 1; k < db.length; k++) if (db[k] > db[peak]) peak = k;
    for (var b = peak + 1; b < db.length - 1; b++) {
      if (db[b] <= db[b - 1] && db[b] <= db[b + 1]) return b / pad;
    }
    return -1;
  }

  /* Peak sidelobe attenuation: the highest response beyond the first null,
     in dB relative to the main-lobe peak (negative numbers). */
  function peakSidelobeDb(name, n) {
    var pad = RESPONSE_PAD;
    var db = windowResponseDb(name, n);
    var nullBin = firstNullBin(db, pad);
    if (nullBin < 0) return null;
    var start = Math.ceil(nullBin * pad);
    var max = -Infinity;
    for (var k = start; k < db.length; k++) if (db[k] > max) max = db[k];
    return max;
  }

  /* Main-lobe width in bins at -3 dB. The response array covers positive
     frequencies only and these windows peak at DC, so the full width is
     twice the interpolated right-hand -3 dB crossing. Well defined even for
     Kaiser (no exact nulls). */
  function mainLobeWidthDb3(name, n) {
    var pad = RESPONSE_PAD;
    var db = windowResponseDb(name, n);
    var hi = 1;
    while (hi < db.length - 1 && db[hi] > -3) hi++;
    if (hi >= db.length - 1) return null; /* lobe never falls to -3 dB */
    var d = db[hi] - db[hi - 1];
    var frac = Math.abs(d) < 1e-12 ? 0 : (-3 - db[hi - 1]) / d;
    return 2 * (hi - 1 + frac) / pad;
  }

  /* ---------------- Uncertainty product ---------------- */

  /* sigma_t from the window energy in samples; sigma_f from |W(f)|^2 on a
     padded grid in cycles/sample. Product >= 1/(4*pi) for the true rms
     spreads. For the rectangular window the frequency variance grows with
     the grid extent (its 1/f sidelobes make it unbounded), so the reported
     number is the value on the fixed pad grid. */
  function heisenbergProduct(w) {
    var n = w.length;
    var m = n * RESPONSE_PAD;
    var re = new Float64Array(m);
    var im = new Float64Array(m);
    var et = 0, mt = 0;
    for (var k = 0; k < n; k++) {
      re[k] = w[k];
      var e = w[k] * w[k];
      et += e;
      mt += e * k;
    }
    fftInPlace(re, im);
    var meanT = mt / et;
    var vt = 0;
    for (k = 0; k < n; k++) {
      var dt = k - meanT;
      vt += w[k] * w[k] * dt * dt;
    }
    vt /= et;
    var ef = 0, vf = 0;
    for (k = 0; k < m; k++) {
      var p = re[k] * re[k] + im[k] * im[k];
      var f = k > m / 2 ? (k - m) / m : k / m; /* cycles/sample, centred at DC */
      ef += p;
      vf += p * f * f;
    }
    vf /= ef;
    return {
      sigmaT: Math.sqrt(vt),
      sigmaF: Math.sqrt(vf),
      product: Math.sqrt(vt) * Math.sqrt(vf),
      bound: 1 / (4 * Math.PI)
    };
  }

  /* ---------------- Parabolic interpolation ---------------- */

  /* Quadratic peak fit on linear magnitude around bin k. */
  function parabolicPeak(mag, k) {
    if (k <= 0 || k >= mag.length - 1) return k;
    var a = mag[k - 1], b = mag[k], c = mag[k + 1];
    var den = a - 2 * b + c;
    if (Math.abs(den) < 1e-18) return k;
    var delta = 0.5 * (a - c) / den;
    if (delta > 1) delta = 1;
    if (delta < -1) delta = -1;
    return k + delta;
  }

  /* ---------------- Test signals ---------------- */

  /* All frequencies are in Hz; with fs = n the numbers equal bin indices. */
  var SIGNAL_DEFS = {
    pureTone: {
      label: 'Pure tone',
      gen: function (n, fs) {
        var f0 = Math.round(n / 6) + 0.37;
        return {
          params: { f0: f0, fs: fs },
          truth: { peakHz: f0 },
          samples: sample(n, function (k) { return Math.sin(TWO_PI * f0 * k / fs); })
        };
      }
    },
    dualCloseTones: {
      label: 'Dual close tones',
      gen: function (n, fs) {
        var f1 = Math.round(n / 5), f2 = f1 + 2;
        return {
          params: { f1: f1, f2: f2, a2: 0.6, fs: fs },
          truth: { peakHz: f1 },
          samples: sample(n, function (k) {
            return Math.sin(TWO_PI * f1 * k / fs) + 0.6 * Math.sin(TWO_PI * f2 * k / fs + 0.9);
          })
        };
      }
    },
    linearChirp: {
      label: 'Linear chirp',
      gen: function (n, fs) {
        var f0 = Math.round(n * 0.04), f1 = Math.round(n * 0.30);
        var t1 = (n - 1) / fs;
        var slope = (f1 - f0) / t1;
        return {
          params: { f0: f0, f1: f1, fs: fs },
          truth: { peakHz: null },
          samples: sample(n, function (k) {
            var t = k / fs;
            return Math.sin(TWO_PI * (f0 * t + 0.5 * slope * t * t));
          })
        };
      }
    },
    impulseTransient: {
      label: 'Impulse transient',
      gen: function (n, fs) {
        var at = Math.floor(n / 2);
        var rand = makeLcg(777);
        return {
          params: { at: at, fs: fs },
          truth: { peakHz: null },
          samples: sample(n, function (k) {
            return (k === at ? 1 : 0) + 0.001 * gaussian(rand);
          })
        };
      }
    },
    noisyHarmonicStack: {
      label: 'Noisy harmonic stack',
      gen: function (n, fs) {
        var f0 = Math.round(n / 10) + 0.25;
        var rand = makeLcg(4242);
        return {
          params: { f0: f0, harmonics: 6, noise: 0.02, fs: fs },
          truth: { peakHz: f0 },
          samples: sample(n, function (k) {
            var v = 0;
            for (var h = 1; h <= 6; h++) v += Math.sin(TWO_PI * f0 * h * k / fs) / h;
            return v + 0.02 * gaussian(rand);
          })
        };
      }
    }
  };

  var SIGNAL_KEYS = Object.keys(SIGNAL_DEFS);

  function sample(n, fn) {
    var x = new Float64Array(n);
    for (var k = 0; k < n; k++) x[k] = fn(k);
    return x;
  }

  function testSignal(name, n) {
    var def = ownValue(SIGNAL_DEFS, name);
    if (!def) throw new RangeError('Unknown signal: ' + name);
    validateLength(n);
    return def.gen(n, sampleRateFor(n));
  }

  /* ---------------- Comparison metrics ---------------- */

  function analyze(name, x, truth) {
    var n = x.length;
    var w = windowSamples(name, n);
    var xw = new Float64Array(n);
    for (var k = 0; k < n; k++) xw[k] = x[k] * w[k];
    var spectrum = fft(xw);
    var mag = magnitudes(spectrum);
    var par = parsevalResidualFor(xw);
    var heis = heisenbergProduct(w);
    /* Peak search on the positive half-plane. */
    var kPeak = 0;
    for (var b = 1; b < n / 2; b++) if (mag[b] > mag[kPeak]) kPeak = b;
    var fs = sampleRateFor(n);
    var peakBin = parabolicPeak(mag, kPeak);
    var peakHz = peakBin * fs / n;
    var result = {
      window: name,
      label: ownValue(WINDOW_DEFS, name).label,
      coherentGain: coherentGain(w),
      enbwBins: enbwBins(w),
      mainLobeWidthBins: mainLobeWidthDb3(name, n),
      peakSidelobeDb: peakSidelobeDb(name, n),
      parsevalResidual: par.residual,
      peakBin: peakBin,
      peakHz: peakHz,
      peakErrorHz: truth && truth.peakHz != null ? Math.abs(peakHz - truth.peakHz) : null,
      sigmaT: heis.sigmaT,
      sigmaF: heis.sigmaF,
      heisenbergProduct: heis.product,
      heisenbergBound: heis.bound
    };
    return result;
  }

  function runComparison(signalName, n) {
    validateLength(n);
    if (FFT_SIZES.indexOf(n) < 0) throw new RangeError('FFT size must be one of ' + FFT_SIZES.join(', '));
    var sig = testSignal(signalName, n);
    var results = {};
    for (var k = 0; k < WINDOW_KEYS.length; k++) {
      var name = WINDOW_KEYS[k];
      results[name] = analyze(name, sig.samples, sig.truth);
    }
    return {
      signal: signalName,
      signalLabel: ownValue(SIGNAL_DEFS, signalName).label,
      fftSize: n,
      sampleRate: sig.params.fs,
      params: sig.params,
      truth: sig.truth,
      results: results
    };
  }

  /* ---------------- Audit export ---------------- */

  function sf() {
    if (!deps.SF || typeof deps.SF.sha256Hex !== 'function') {
      throw new Error('cfd.js is required for audit digests');
    }
    return deps.SF;
  }

  var AUDIT_SIGNED_KEYS = ['format', 'version', 'schemaVersion', 'generatedBy', 'params', 'results', 'disclosure'];

  function auditDigest(payload) {
    var signed = {};
    AUDIT_SIGNED_KEYS.forEach(function (key) {
      signed[key] = payload[key] === undefined ? null : payload[key];
    });
    return sf().sha256Hex(JSON.stringify(signed));
  }

  /* Deterministic payload; generatedAt is injected, never read inside. */
  function buildSpectralAudit(comparison, generatedAt) {
    var c = comparison;
    var rows = WINDOW_KEYS.map(function (name) {
      var r = c.results[name];
      return {
        window: name,
        label: r.label,
        coherentGain: r.coherentGain,
        enbwBins: r.enbwBins,
        mainLobeWidthBins: r.mainLobeWidthBins,
        peakSidelobeDb: r.peakSidelobeDb,
        parsevalResidual: r.parsevalResidual,
        peakBin: r.peakBin,
        peakHz: r.peakHz,
        peakErrorHz: r.peakErrorHz,
        sigmaT: r.sigmaT,
        sigmaF: r.sigmaF,
        heisenbergProduct: r.heisenbergProduct,
        heisenbergBound: r.heisenbergBound
      };
    });
    var payload = {
      format: 'spectralflow-spectral-audit',
      version: VERSION,
      schemaVersion: 1,
      generatedBy: 'SpectralFlow Spectral Lab',
      params: {
        signal: c.signal,
        signalLabel: c.signalLabel,
        fftSize: c.fftSize,
        sampleRate: c.sampleRate,
        signalParams: c.params,
        truth: c.truth,
        generatedAt: generatedAt || null
      },
      results: rows,
      disclosure: 'SHA-256 digest detects edits to this file; it is an unkeyed checksum, not a signature. Numbers are deterministic: replay the same signal and FFT size to reproduce them.'
    };
    payload.integrity = { algorithm: 'SHA-256', scope: 'full-audit', digest: auditDigest(payload) };
    return payload;
  }

  function exportAuditJSON(comparison, generatedAt) {
    return JSON.stringify(buildSpectralAudit(comparison, generatedAt), null, 2);
  }

  function verifySpectralAudit(source) {
    var payload = typeof source === 'string' ? JSON.parse(source) : source;
    if (!payload || payload.format !== 'spectralflow-spectral-audit' || payload.schemaVersion !== 1) {
      throw new RangeError('Unsupported spectral audit schema');
    }
    var allowedKeys = AUDIT_SIGNED_KEYS.concat(['integrity']);
    var unexpected = Object.keys(payload).filter(function (key) { return allowedKeys.indexOf(key) < 0; });
    if (unexpected.length) {
      throw new RangeError('Audit contains unsigned extra fields: ' + unexpected.join(', '));
    }
    if (!payload.params || typeof payload.params !== 'object' || !Array.isArray(payload.results)) {
      throw new RangeError('Missing or malformed audit params or results');
    }
    var integrity = payload.integrity;
    if (!integrity || integrity.algorithm !== 'SHA-256' || integrity.scope !== 'full-audit' ||
        typeof integrity.digest !== 'string' || !/^[0-9a-f]{64}$/.test(integrity.digest)) {
      throw new RangeError('Missing or malformed audit integrity block');
    }
    var expected = auditDigest(payload);
    if (expected !== integrity.digest) {
      throw new RangeError('Audit integrity digest mismatch: payload was edited after export');
    }
    return { valid: true, results: payload.results.length, digest: integrity.digest };
  }

  /* Re-run the comparison from the audit's own params and require the exact
     recorded numbers back: the replay proof behind the export. */
  function replaySpectralAudit(source) {
    var payload = typeof source === 'string' ? JSON.parse(source) : source;
    verifySpectralAudit(payload);
    var c = runComparison(payload.params.signal, payload.params.fftSize);
    var fields = ['coherentGain', 'enbwBins', 'mainLobeWidthBins', 'peakSidelobeDb',
      'parsevalResidual', 'peakBin', 'peakHz', 'peakErrorHz', 'heisenbergProduct'];
    for (var k = 0; k < payload.results.length; k++) {
      var rec = payload.results[k];
      var rep = c.results[rec.window];
      if (!rep) throw new RangeError('Replay missing window ' + rec.window);
      for (var f = 0; f < fields.length; f++) {
        var key = fields[f];
        if (rec[key] == null && rep[key] == null) continue;
        if (rec[key] !== rep[key]) {
          throw new RangeError('Replay mismatch on ' + rec.window + '.' + key);
        }
      }
    }
    return { valid: true, replayed: payload.results.length };
  }

  /* CSV cell escape with formula-injection guard: spreadsheet hosts treat a
     leading = + - @ as a formula, so hostile strings get a ' prefix.
     Numbers are never formulas and stay raw. */
  function csvCellSafe(value) {
    if (typeof value === 'number') {
      if (!isFiniteNumber(value)) throw new RangeError('Cannot write a nonfinite CSV cell');
      return String(value);
    }
    var s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportAuditCSV(comparison) {
    var c = comparison;
    var rows = ['signal,fftSize,sampleRate,window,coherentGain,enbwBins,mainLobeWidthBins,peakSidelobeDb,parsevalResidual,peakBin,peakHz,peakErrorHz,sigmaT,sigmaF,heisenbergProduct'];
    WINDOW_KEYS.forEach(function (name) {
      var r = c.results[name];
      var values = [c.signal, c.fftSize, c.sampleRate, name,
        r.coherentGain, r.enbwBins, r.mainLobeWidthBins, r.peakSidelobeDb,
        r.parsevalResidual, r.peakBin, r.peakHz,
        r.peakErrorHz == null ? 'n/a' : r.peakErrorHz,
        r.sigmaT, r.sigmaF, r.heisenbergProduct];
      if (values.some(function (v) { return typeof v === 'number' && !isFiniteNumber(v); })) {
        throw new RangeError('Cannot export nonfinite audit CSV');
      }
      rows.push(values.map(csvCellSafe).join(','));
    });
    return rows.join('\n') + '\n';
  }

  function fmtNum(v, digits) {
    if (v == null) return 'n/a';
    if (!isFiniteNumber(v)) return String(v);
    if (Math.abs(v) !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e6)) return v.toExponential(2);
    return v.toFixed(digits == null ? 4 : digits);
  }

  function exportAuditMarkdown(comparison, generatedAt) {
    var payload = buildSpectralAudit(comparison, generatedAt);
    var c = comparison;
    var lines = [];
    lines.push('# SpectralFlow spectral audit');
    lines.push('');
    lines.push('- Signal: ' + c.signalLabel + ' (' + c.signal + ')');
    lines.push('- FFT size: ' + c.fftSize + ', sample rate: ' + c.sampleRate + ' Hz (1 bin = 1 Hz)');
    lines.push('- Generated: ' + (generatedAt || 'not recorded'));
    lines.push('- SHA-256 digest: ' + payload.integrity.digest);
    lines.push('- Digest scope: unkeyed checksum over the payload; detects edits, not a signature.');
    lines.push('');
    lines.push('| Window | CG | ENBW (bins) | Main lobe -3dB (bins) | Peak sidelobe (dB) | Parseval residual | Peak (Hz) | Peak err (Hz) | sigma_t * sigma_f |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    WINDOW_KEYS.forEach(function (name) {
      var r = c.results[name];
      lines.push('| ' + r.label + ' | ' + fmtNum(r.coherentGain) + ' | ' + fmtNum(r.enbwBins) +
        ' | ' + fmtNum(r.mainLobeWidthBins) + ' | ' + fmtNum(r.peakSidelobeDb, 1) +
        ' | ' + fmtNum(r.parsevalResidual, 2) + ' | ' + fmtNum(r.peakHz, 2) +
        ' | ' + (r.peakErrorHz == null ? 'n/a' : fmtNum(r.peakErrorHz, 4)) +
        ' | ' + fmtNum(r.heisenbergProduct, 4) + ' |');
    });
    lines.push('');
    lines.push('Uncertainty bound sigma_t * sigma_f >= 1/(4*pi) = ' + fmtNum(1 / (4 * Math.PI), 4) + '.');
    lines.push('');
    lines.push('Replay: every number is reproduced by runComparison("' + c.signal + '", ' + c.fftSize + ') in spectral-lab.js. Verification: verifySpectralAudit checks the digest; replaySpectralAudit re-runs the comparison and requires identical numbers.');
    return lines.join('\n') + '\n';
  }

  /* ---------------- URL bookmark (#sf=) ---------------- */

  /* Hand-rolled base64url codec: the page may run where neither btoa nor
     Buffer exists (the deterministic DOM adapter). */
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.codePointAt(i);
      if (cp > 0xffff) i++;
      else if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
  }

  function utf8Decode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i], cp;
      if (b < 0x80) { cp = b; }
      else if (b < 0xe0) { cp = ((b & 31) << 6) | (bytes[++i] & 63); }
      else if (b < 0xf0) { cp = ((b & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63); }
      else { cp = ((b & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63); }
      if (cp > 0xffff) { cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
      else s += String.fromCharCode(cp);
    }
    return s;
  }

  function b64EncodeBytes(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)] +
        (b === undefined ? '=' : B64[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)]) +
        (c === undefined ? '=' : B64[c & 63]);
    }
    return out;
  }

  function b64DecodeBytes(str) {
    var clean = str.replace(/=+$/, '');
    var bytes = [];
    var acc = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
      var v = B64.indexOf(clean[i]);
      if (v < 0) throw new RangeError('Malformed spectral bookmark');
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 255);
      }
    }
    return bytes;
  }

  function encodeBookmark(state) {
    if (!state || typeof state !== 'object') throw new RangeError('Spectral bookmark state is required');
    if (typeof state.signal !== 'string' || !ownValue(SIGNAL_DEFS, state.signal)) throw new RangeError('Unknown signal in spectral bookmark state');
    if (FFT_SIZES.indexOf(state.fftSize) < 0) throw new RangeError('Invalid FFT size in spectral bookmark state');
    var payload = { v: 1, sig: state.signal, n: state.fftSize };
    var b64 = b64EncodeBytes(utf8Encode(JSON.stringify(payload)));
    return 'sf=' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function parseBookmark(hash) {
    var s = String(hash || '');
    s = s.replace(/^#/, '');
    if (s.indexOf('sf=') !== 0) return null;
    var b64 = s.slice(3).replace(/-/g, '+').replace(/_/g, '/');
    var payload;
    try {
      payload = JSON.parse(utf8Decode(b64DecodeBytes(b64)));
    } catch (e) {
      if (e instanceof RangeError) throw e;
      throw new RangeError('Malformed spectral bookmark');
    }
    if (!payload || payload.v !== 1) throw new RangeError('Unsupported spectral bookmark version');
    if (typeof payload.sig !== 'string' || !ownValue(SIGNAL_DEFS, payload.sig)) throw new RangeError('Unknown signal in spectral bookmark');
    if (FFT_SIZES.indexOf(payload.n) < 0) throw new RangeError('Invalid FFT size in spectral bookmark');
    var extra = Object.keys(payload).filter(function (k) { return ['v', 'sig', 'n'].indexOf(k) < 0; });
    if (extra.length) throw new RangeError('Unknown fields in spectral bookmark: ' + extra.join(', '));
    return { signal: payload.sig, fftSize: payload.n };
  }

  /* ---------------- In-page self-tests ---------------- */

  function check(name, fn) {
    try {
      var detail = fn();
      return { name: name, pass: true, detail: detail || 'ok' };
    } catch (e) {
      return { name: name, pass: false, detail: e && e.message ? e.message : String(e) };
    }
  }

  function runSpectralSelfTests() {
    var out = [];
    var sig = testSignal('noisyHarmonicStack', 512);
    var c = runComparison('noisyHarmonicStack', 512);

    out.push(check('Parseval energy conservation, all five windows (<1e-10)', function () {
      WINDOW_KEYS.forEach(function (name) {
        var r = c.results[name].parsevalResidual;
        if (!(r < 1e-10)) throw new Error(name + ' residual ' + r);
      });
      return 'max residual ' + Math.max.apply(null, WINDOW_KEYS.map(function (w) { return c.results[w].parsevalResidual; })).toExponential(2);
    }));

    out.push(check('FFT/IFFT round-trip residual (<1e-10)', function () {
      var err = fftRoundTripError(sig.samples);
      if (!(err < 1e-10)) throw new Error('round-trip ' + err);
      return 'max error ' + err.toExponential(2);
    }));

    out.push(check('Window symmetry and unit peak, all five windows', function () {
      WINDOW_KEYS.forEach(function (name) {
        var w = windowSamples(name, 512);
        var max = Math.max.apply(null, Array.prototype.slice.call(w));
        if (Math.abs(max - 1) > 1e-9) throw new Error(name + ' peak ' + max);
        for (var k = 1; k < 256; k++) {
          if (Math.abs(w[k] - w[512 - k]) > 1e-12) throw new Error(name + ' asymmetry at ' + k);
        }
      });
      return 'w[n] = w[N-n], peak at n = N/2';
    }));

    out.push(check('Sidelobe ordering: Blackman-Harris < Hann < Rectangular', function () {
      var bh = c.results.blackmanHarris.peakSidelobeDb;
      var hann = c.results.hann.peakSidelobeDb;
      var rect = c.results.rectangular.peakSidelobeDb;
      if (!(bh < hann && hann < rect)) throw new Error('BH ' + bh + ', Hann ' + hann + ', Rect ' + rect);
      return 'BH ' + bh.toFixed(1) + ' dB < Hann ' + hann.toFixed(1) + ' dB < Rect ' + rect.toFixed(1) + ' dB';
    }));

    out.push(check('Heisenberg bound sigma_t * sigma_f >= 1/(4*pi), all windows', function () {
      WINDOW_KEYS.forEach(function (name) {
        var r = c.results[name];
        if (!(r.heisenbergProduct >= r.heisenbergBound - 1e-9)) {
          throw new Error(name + ' product ' + r.heisenbergProduct);
        }
      });
      return 'bound ' + (1 / (4 * Math.PI)).toFixed(4);
    }));

    out.push(check('CSV escaping and formula-injection guard', function () {
      if (csvCellSafe('=cmd') !== "'=cmd") throw new Error('formula cell not guarded');
      if (csvCellSafe('a,b') !== '"a,b"') throw new Error('comma not quoted');
      if (csvCellSafe('x"y') !== '"x""y"') throw new Error('quote not doubled');
      return 'leading = + - @ get an apostrophe, commas and quotes quoted';
    }));

    out.push(check('Audit digest detects tampering', function () {
      var payload = buildSpectralAudit(c);
      var text = JSON.stringify(payload);
      verifySpectralAudit(text);
      var forged = JSON.parse(text);
      forged.results[0].peakSidelobeDb += 1;
      var threw = false;
      try { verifySpectralAudit(forged); } catch (e) { threw = /integrity/.test(e.message); }
      if (!threw) throw new Error('edited payload accepted');
      return 'a +1 dB edit on one metric is refused';
    }));

    out.push(check('FIPS 180-4 SHA-256 known answers', function () {
      var h = sf().sha256Hex;
      var kat = [
        ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592']
      ];
      kat.forEach(function (pair) {
        if (h(pair[0]) !== pair[1]) throw new Error('digest mismatch for ' + JSON.stringify(pair[0]).slice(0, 20));
      });
      return '3 published vectors';
    }));

    out.push(check('Audit replay reproduces the recorded numbers', function () {
      replaySpectralAudit(JSON.stringify(buildSpectralAudit(c)));
      return '5 windows replayed identically';
    }));

    return out;
  }

  /* ---------------- Public API ---------------- */

  return {
    VERSION: VERSION,
    FFT_SIZES: FFT_SIZES.slice(),
    WINDOW_KEYS: WINDOW_KEYS.slice(),
    SIGNAL_KEYS: SIGNAL_KEYS.slice(),
    KAISER_BETA: KAISER_BETA,
    RESPONSE_PAD: RESPONSE_PAD,
    fft: fft,
    ifft: ifft,
    fftInPlace: fftInPlace,
    fftRoundTripError: fftRoundTripError,
    magnitudes: magnitudes,
    parsevalResidualFor: parsevalResidualFor,
    besselI0: besselI0,
    windowSamples: windowSamples,
    windowResponseDb: windowResponseDb,
    windowLabel: function (name) { var d = ownValue(WINDOW_DEFS, name); return d ? d.label : name; },
    coherentGain: coherentGain,
    enbwBins: enbwBins,
    mainLobeWidthDb3: mainLobeWidthDb3,
    peakSidelobeDb: peakSidelobeDb,
    firstNullBin: firstNullBin,
    heisenbergProduct: heisenbergProduct,
    parabolicPeak: parabolicPeak,
    testSignal: testSignal,
    signalLabel: function (name) { var d = ownValue(SIGNAL_DEFS, name); return d ? d.label : name; },
    sampleRateFor: sampleRateFor,
    analyze: analyze,
    runComparison: runComparison,
    buildSpectralAudit: buildSpectralAudit,
    exportAuditJSON: exportAuditJSON,
    exportAuditCSV: exportAuditCSV,
    exportAuditMarkdown: exportAuditMarkdown,
    verifySpectralAudit: verifySpectralAudit,
    replaySpectralAudit: replaySpectralAudit,
    auditDigest: auditDigest,
    csvCellSafe: csvCellSafe,
    encodeBookmark: encodeBookmark,
    parseBookmark: parseBookmark,
    runSpectralSelfTests: runSpectralSelfTests,
    makeLcg: makeLcg
  };
});
