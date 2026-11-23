/*
 * SpectralFlow spectral-test.js
 * Spectral lab coverage: radix-2 FFT correctness, window invariants,
 * leakage/resolution metrics, test signals, SHA-256 audit export,
 * bookmark codec, self-tests and the spectral-app controller.
 * Zero dependencies: node:test + node:assert/strict + the DOM adapter.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./cfd.js');
const L = require('./spectral-lab.js');
const { boot } = require('./dom-harness.js');

const HERE = __dirname;
const WINDOWS = L.WINDOW_KEYS;   /* rect, hann, hamming, blackmanHarris, kaiser8 */
const SIGNALS = L.SIGNAL_KEYS;

function signal(fn, n) { return Float64Array.from({ length: n }, (_, k) => fn(k)); }
function naiveDft(x) {
  const n = x.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = -2 * Math.PI * k * t / n;
      re[k] += x[t] * Math.cos(a);
      im[k] += x[t] * Math.sin(a);
    }
  }
  return { re, im };
}

/* ---------------- FFT core ---------------- */

test('fft of a unit impulse is a flat unit spectrum', () => {
  const x = signal(k => (k === 0 ? 1 : 0), 128);
  const s = L.fft(x);
  for (let k = 0; k < 128; k++) {
    assert.ok(Math.abs(s.re[k] - 1) < 1e-12, `re[${k}]`);
    assert.ok(Math.abs(s.im[k]) < 1e-12, `im[${k}]`);
  }
});

test('fft of a DC signal puts all energy in bin zero', () => {
  const s = L.fft(signal(() => 1, 256));
  assert.ok(Math.abs(s.re[0] - 256) < 1e-9);
  for (let k = 1; k < 256; k++) assert.ok(Math.abs(s.re[k]) < 1e-9 && Math.abs(s.im[k]) < 1e-9);
});

test('a bin-centred cosine puts N/2 into its mirrored bins only', () => {
  const n = 256, bin = 40;
  const s = L.fft(signal(k => Math.cos(2 * Math.PI * bin * k / n), n));
  for (let k = 0; k < n; k++) {
    const mag = Math.hypot(s.re[k], s.im[k]);
    if (k === bin || k === n - bin) assert.ok(Math.abs(mag - n / 2) < 1e-8, `bin ${k} mag ${mag}`);
    else assert.ok(mag < 1e-8, `leakage at bin ${k}: ${mag}`);
  }
});

test('fft spectrum is conjugate symmetric for real input', () => {
  const rand = L.makeLcg(7);
  const x = signal(() => rand() * 2 - 1, 128);
  const s = L.fft(x);
  for (let k = 1; k < 64; k++) {
    assert.ok(Math.abs(s.re[k] - s.re[128 - k]) < 1e-10, `re ${k}`);
    assert.ok(Math.abs(s.im[k] + s.im[128 - k]) < 1e-10, `im ${k}`);
  }
});

test('fft is linear: F(a*x + b*y) = a*F(x) + b*F(y)', () => {
  const rand = L.makeLcg(11);
  const x = signal(() => rand(), 128), y = signal(() => rand(), 128);
  const a = 0.7, b = -1.3;
  const s = L.fft(signal(k => a * x[k] + b * y[k], 128));
  const sx = L.fft(x), sy = L.fft(y);
  for (let k = 0; k < 128; k++) {
    assert.ok(Math.abs(s.re[k] - (a * sx.re[k] + b * sy.re[k])) < 1e-9);
    assert.ok(Math.abs(s.im[k] - (a * sx.im[k] + b * sy.im[k])) < 1e-9);
  }
});

test('a circular time shift rotates phase but preserves magnitude', () => {
  const rand = L.makeLcg(13);
  const x = signal(() => rand(), 128);
  const shift = 17;
  const xs = signal(k => x[(k - shift + 128) % 128], 128);
  const m0 = L.magnitudes(L.fft(x)), m1 = L.magnitudes(L.fft(xs));
  for (let k = 0; k < 128; k++) assert.ok(Math.abs(m0[k] - m1[k]) < 1e-9, `bin ${k}`);
});

test('fft agrees with a naive O(N^2) DFT on random input', () => {
  const rand = L.makeLcg(19);
  const x = signal(() => rand() * 4 - 2, 64);
  const s = L.fft(x), ref = naiveDft(x);
  for (let k = 0; k < 64; k++) {
    assert.ok(Math.abs(s.re[k] - ref.re[k]) < 1e-9, `re[${k}]`);
    assert.ok(Math.abs(s.im[k] - ref.im[k]) < 1e-9, `im[${k}]`);
  }
});

test('fft of the Nyquist cosine is real and sits in the Nyquist bin only', () => {
  const n = 128;
  const s = L.fft(signal(k => (k % 2 ? -1 : 1), n)); /* cos(pi k) */
  assert.ok(Math.abs(s.re[n / 2] - n) < 1e-9);
  for (let k = 0; k < n; k++) if (k !== n / 2) assert.ok(Math.hypot(s.re[k], s.im[k]) < 1e-9);
});

for (const n of [8, 128, 512, 2048]) {
  test(`fft/ifft round trip is lossless at N=${n}`, () => {
    const rand = L.makeLcg(n);
    const x = signal(() => rand() * 2 - 1, n);
    assert.ok(L.fftRoundTripError(x) < 1e-10);
  });
}

test('fft rejects non-power-of-two, oversized and nonfinite input', () => {
  assert.throws(() => L.fft(new Float64Array(100)), /power of two/);
  assert.throws(() => L.fft(new Float64Array(8192)), /power of two/);
  assert.throws(() => L.fft(new Float64Array(4)), /power of two/);
  const bad = new Float64Array(16); bad[3] = NaN;
  assert.throws(() => L.fft(bad), /nonfinite/i);
});

test('ifft reconstructs a complex spectrum exactly', () => {
  const rand = L.makeLcg(23);
  const x = signal(() => rand(), 256);
  const back = L.ifft(L.fft(x));
  for (let k = 0; k < 256; k++) assert.ok(Math.abs(back[k] - x[k]) < 1e-10, `sample ${k}`);
});

/* ---------------- Parseval ---------------- */

for (const sig of SIGNALS) {
  for (const n of L.FFT_SIZES) {
    test(`Parseval residual < 1e-10 on ${sig} at N=${n}`, () => {
      const { samples } = L.testSignal(sig, n);
      const r = L.parsevalResidualFor(samples);
      assert.ok(r.et > 0);
      assert.ok(r.residual < 1e-10, `residual ${r.residual}`);
    });
  }
}

for (const n of L.FFT_SIZES) {
  for (const w of WINDOWS) {
    test(`Parseval on windowed frame < 1e-10: ${w} N=${n}`, () => {
      const { samples } = L.testSignal('noisyHarmonicStack', n);
      const win = L.windowSamples(w, n);
      const xw = signal(k => samples[k] * win[k], n);
      assert.ok(L.parsevalResidualFor(xw).residual < 1e-10);
    });
  }
}

/* ---------------- Window sequences ---------------- */

test('every window is finite, unit peak at N/2 and periodic-symmetric', () => {
  for (const name of WINDOWS) {
    for (const n of [128, 512]) {
      const w = L.windowSamples(name, n);
      assert.equal(w.length, n);
      for (let k = 0; k < n; k++) assert.ok(Number.isFinite(w[k]), `${name}[${k}]`);
      const peak = Math.max(...w);
      assert.ok(Math.abs(peak - 1) < 1e-9, `${name} peak ${peak}`);
      for (let k = 1; k < n / 2; k++) {
        assert.ok(Math.abs(w[k] - w[n - k]) < 1e-12, `${name} w[${k}] vs w[${n - k}]`);
      }
    }
  }
});

test('tapering windows start near zero while rectangular is flat', () => {
  for (const [name, expected] of [['hann', 0], ['hamming', 0.08], ['blackmanHarris', 0.00006]]) {
    const w = L.windowSamples(name, 256);
    assert.ok(Math.abs(w[0] - expected) < 1e-4, `${name} w[0] = ${w[0]}`);
  }
  const rect = L.windowSamples('rectangular', 256);
  for (let k = 0; k < 256; k++) assert.equal(rect[k], 1);
});

test('Kaiser endpoints equal 1/I0(beta) and the window is sampled symmetric', () => {
  const w = L.windowSamples('kaiser8', 256);
  const endpoint = 1 / L.besselI0(L.KAISER_BETA);
  assert.ok(Math.abs(w[0] - endpoint) < 1e-12, `w[0] ${w[0]} vs ${endpoint}`);
  assert.ok(w[0] < 0.01 && w[0] > 0, `kaiser edge ${w[0]}`);
});

test('coherent gain matches published window constants', () => {
  const n = 1024;
  const expected = { rectangular: 1, hann: 0.5, hamming: 0.54, blackmanHarris: 0.35875, kaiser8: 0.4357 };
  for (const name of WINDOWS) {
    const cg = L.coherentGain(L.windowSamples(name, n));
    assert.ok(Math.abs(cg - expected[name]) < 0.001, `${name} CG ${cg} vs ${expected[name]}`);
  }
});

test('ENBW ordering: rectangular < hamming < hann < kaiser < Blackman-Harris', () => {
  const n = 1024;
  const e = {};
  for (const name of WINDOWS) e[name] = L.enbwBins(L.windowSamples(name, n));
  assert.ok(Math.abs(e.rectangular - 1) < 0.01, `rect ${e.rectangular}`);
  assert.ok(e.rectangular < e.hamming && e.hamming < e.hann && e.hann < e.kaiser8 && e.kaiser8 < e.blackmanHarris,
    JSON.stringify(e));
  assert.ok(Math.abs(e.hann - 1.5) < 0.01 && Math.abs(e.blackmanHarris - 2.0) < 0.02);
});

test('besselI0 matches published values to 1e-9', () => {
  const cases = [[0, 1], [1, 1.2660658777520084], [2, 2.2795853023360673], [8, 427.5641157218048]];
  for (const [x, v] of cases) assert.ok(Math.abs(L.besselI0(x) - v) / v < 1e-9, `I0(${x})`);
});

test('windowSamples rejects unknown windows and bad lengths', () => {
  assert.throws(() => L.windowSamples('kaiser9', 128), /Unknown window/);
  assert.throws(() => L.windowSamples('hann', 1), /out of range/);
  assert.throws(() => L.windowSamples('hann', 8192), /out of range/);
});

/* ---------------- Window response & leakage metrics ---------------- */

test('peak sidelobe attenuation matches published window figures', () => {
  const n = 512;
  const approx = { rectangular: -13.3, hann: -31.5, hamming: -42.7, blackmanHarris: -92, kaiser8: -58.6 };
  for (const name of WINDOWS) {
    const db = L.peakSidelobeDb(name, n);
    assert.ok(Math.abs(db - approx[name]) < 2.5, `${name} sidelobe ${db} vs ${approx[name]}`);
  }
});

test('sidelobe ordering: Blackman-Harris < Kaiser < Hamming < Hann < Rectangular', () => {
  const n = 512;
  const s = {};
  for (const name of WINDOWS) s[name] = L.peakSidelobeDb(name, n);
  assert.ok(s.blackmanHarris < s.kaiser8 && s.kaiser8 < s.hamming && s.hamming < s.hann && s.hann < s.rectangular,
    JSON.stringify(s));
});

test('main-lobe -3 dB width matches theory and orders resolution', () => {
  const n = 512;
  const approx = { rectangular: 0.886, hann: 1.44, hamming: 1.30, blackmanHarris: 1.90, kaiser8: 1.58 };
  for (const name of WINDOWS) {
    const w = L.mainLobeWidthDb3(name, n);
    assert.ok(Math.abs(w - approx[name]) < 0.06, `${name} width ${w} vs ${approx[name]}`);
  }
});

/* The taper shape is scale-invariant, so both metrics hold at every size. */
for (const n of L.FFT_SIZES) {
  for (const name of WINDOWS) {
    test(`sidelobe floor at N=${n}: ${name}`, () => {
      const approx = { rectangular: -13.3, hann: -31.5, hamming: -42.7, blackmanHarris: -92, kaiser8: -58.6 };
      const db = L.peakSidelobeDb(name, n);
      assert.ok(Math.abs(db - approx[name]) < 2.5, `${name}@${n} ${db} vs ${approx[name]}`);
    });
    test(`main-lobe width at N=${n}: ${name}`, () => {
      const approx = { rectangular: 0.886, hann: 1.44, hamming: 1.30, blackmanHarris: 1.90, kaiser8: 1.58 };
      const w = L.mainLobeWidthDb3(name, n);
      assert.ok(Math.abs(w - approx[name]) < 0.08, `${name}@${n} ${w} vs ${approx[name]}`);
    });
  }
}

test('first null positions match the textbook bin counts', () => {
  const n = 512;
  const nulls = { rectangular: 1, hann: 2, hamming: 2, blackmanHarris: 4 };
  for (const [name, expected] of Object.entries(nulls)) {
    const db = L.windowResponseDb(name, n);
    const nb = L.firstNullBin(db, L.RESPONSE_PAD);
    assert.ok(Math.abs(nb - expected) < 0.05, `${name} null ${nb} vs ${expected}`);
  }
});

test('window response is normalised to 0 dB at its peak and decays past the lobe', () => {
  const db = L.windowResponseDb('hann', 512);
  assert.ok(Math.abs(db[0]) < 1e-9, `peak ${db[0]}`);
  assert.ok(db[4 * L.RESPONSE_PAD] < -20, `bin 4 should sit below -20 dB, got ${db[4 * L.RESPONSE_PAD]}`);
});

test('wider main lobes trade for deeper floors, per window', () => {
  const n = 512;
  const width = {}, floor = {};
  for (const name of WINDOWS) {
    width[name] = L.mainLobeWidthDb3(name, n);
    floor[name] = L.peakSidelobeDb(name, n);
  }
  /* The classic ordering: sorted by lobe width the floors deepen almost
     monotonically (hamming breaks the rule on purpose). */
  assert.ok(width.rectangular < width.hamming && width.hamming < width.hann && width.hann < width.blackmanHarris);
  assert.ok(floor.blackmanHarris < floor.hamming && floor.hamming < floor.hann && floor.hann < floor.rectangular);
});

/* ---------------- Heisenberg uncertainty ---------------- */

for (const name of WINDOWS) {
  test(`uncertainty product >= 1/(4pi) for ${name}`, () => {
    const h = L.heisenbergProduct(L.windowSamples(name, 512));
    assert.ok(h.product >= h.bound - 1e-9, `${name} product ${h.product} bound ${h.bound}`);
    assert.ok(h.sigmaT > 0 && h.sigmaF > 0);
  });
}

test('Blackman-Harris is the closest window to the uncertainty bound', () => {
  const products = {};
  for (const name of WINDOWS) products[name] = L.heisenbergProduct(L.windowSamples(name, 512)).product;
  const min = Math.min(...Object.values(products));
  assert.equal(products.blackmanHarris, min, JSON.stringify(products));
});

test('rectangular pays for its edge discontinuity with a large sigma_f', () => {
  const rect = L.heisenbergProduct(L.windowSamples('rectangular', 512));
  const hann = L.heisenbergProduct(L.windowSamples('hann', 512));
  /* The 1/f sidelobe tail makes its frequency variance the worst of the five;
     the bound still holds because sigma_t is finite on the same grid. */
  assert.ok(rect.sigmaF > 10 * hann.sigmaF, `sigmaF ${rect.sigmaF} vs ${hann.sigmaF}`);
  assert.ok(rect.product >= rect.bound);
});

/* ---------------- Parabolic interpolation ---------------- */

test('parabolicPeak recovers the exact vertex of a parabola', () => {
  const vertex = 40.4;
  const mag = signal(k => -(k - vertex) * (k - vertex) + 10, 128);
  const est = L.parabolicPeak(mag, 40);
  assert.ok(Math.abs(est - vertex) < 1e-9, `est ${est}`);
});

test('parabolicPeak is safe at edges and on flat tops', () => {
  const flat = signal(() => 5, 64);
  assert.equal(L.parabolicPeak(flat, 0), 0);
  assert.equal(L.parabolicPeak(flat, 63), 63);
  assert.equal(L.parabolicPeak(flat, 30), 30);
});

test('parabolic interpolation beats the raw bin on an off-bin tone', () => {
  const n = 512, f0 = 85.37;
  const x = signal(k => Math.sin(2 * Math.PI * f0 * k / n), n);
  const win = L.windowSamples('hann', n);
  const xw = signal(k => x[k] * win[k], n);
  const mag = L.magnitudes(L.fft(xw));
  let peak = 0;
  for (let k = 1; k < n / 2; k++) if (mag[k] > mag[peak]) peak = k;
  const rawErr = Math.abs(peak - f0);
  const estErr = Math.abs(L.parabolicPeak(mag, peak) - f0);
  assert.ok(rawErr > 0.3, `raw err ${rawErr}`);
  assert.ok(estErr < rawErr / 5, `interp err ${estErr} vs raw ${rawErr}`);
});

/* ---------------- Test signals ---------------- */

test('every test signal is deterministic to the last bit', () => {
  for (const name of SIGNALS) {
    const a = L.testSignal(name, 256), b = L.testSignal(name, 256);
    assert.deepEqual(a.samples, b.samples, `${name} differs between calls`);
    assert.deepEqual(a.params, b.params);
    assert.deepEqual(a.truth, b.truth);
  }
});

test('signal length and finiteness hold at every FFT size', () => {
  for (const name of SIGNALS) for (const n of L.FFT_SIZES) {
    const s = L.testSignal(name, n);
    assert.equal(s.samples.length, n);
    assert.ok(s.samples.every(Number.isFinite), `${name}@${n}`);
    assert.equal(s.params.fs, n, `${name} fs`);
  }
});

test('pure tone energy is N/2 and its truth records the off-bin frequency', () => {
  const s = L.testSignal('pureTone', 512);
  let e = 0;
  for (const v of s.samples) e += v * v;
  assert.ok(Math.abs(e / 512 - 0.5) < 0.05, `energy ${e}`);
  assert.ok(Math.abs(s.truth.peakHz - (Math.round(512 / 6) + 0.37)) < 1e-12);
  assert.equal(s.params.fs, 512);
});

test('dual close tones sit exactly two bins apart with a 0.6 relative level', () => {
  const s = L.testSignal('dualCloseTones', 512);
  assert.equal(s.params.f2 - s.params.f1, 2);
  assert.equal(s.params.a2, 0.6);
  assert.equal(s.truth.peakHz, s.params.f1);
});

test('impulse transient peaks at the frame centre with bounded noise', () => {
  const s = L.testSignal('impulseTransient', 256);
  let max = 0, at = -1;
  s.samples.forEach((v, k) => { if (v > max) { max = v; at = k; } });
  assert.equal(at, 128);
  assert.ok(max > 1 && max < 1.01, `peak ${max}`);
  for (let k = 0; k < 256; k++) if (k !== at) assert.ok(Math.abs(s.samples[k]) < 0.01);
  assert.equal(s.truth.peakHz, null);
});

test('the chirp spreads energy across its sweep, unlike a tone', () => {
  const n = 512;
  const chirp = L.testSignal('linearChirp', n).samples;
  const tone = L.testSignal('pureTone', n).samples;
  const occupied = (x) => {
    const mag = L.magnitudes(L.fft(x));
    const peak = Math.max(...mag);
    let count = 0;
    for (let k = 0; k < n / 2; k++) if (mag[k] > peak * 0.05) count++;
    return count;
  };
  assert.ok(occupied(chirp) > 10 * occupied(tone), 'chirp should occupy a wide band');
});

test('the harmonic stack peaks at its fundamental and its multiples', () => {
  const n = 512;
  const s = L.testSignal('noisyHarmonicStack', n);
  const mag = L.magnitudes(L.fft(s.samples));
  /* Harmonics land between bins (f0 is fractional): a local maximum must sit
     within one bin of each true harmonic frequency. */
  for (const hnum of [1, 2, 3]) {
    const centre = Math.round(s.params.f0 * hnum);
    let found = false;
    for (let b = centre - 1; b <= centre + 1; b++) {
      if (mag[b] > mag[b - 1] && mag[b] >= mag[b + 1] && mag[b] > mag[Math.round(centre / 2)]) found = true;
    }
    assert.ok(found, `harmonic ${hnum} should peak near bin ${centre}`);
  }
});

test('testSignal rejects unknown names and bad sizes', () => {
  assert.throws(() => L.testSignal('sineSweep', 128), /Unknown signal/);
  assert.throws(() => L.testSignal('pureTone', 300), /power of two/);
  assert.throws(() => L.runComparison('pureTone', 4096), /one of/);
});

/* ---------------- runComparison ---------------- */

test('runComparison returns all five windows with every metric field', () => {
  const c = L.runComparison('pureTone', 512);
  assert.equal(c.fftSize, 512);
  assert.equal(c.sampleRate, 512);
  for (const name of WINDOWS) {
    const r = c.results[name];
    for (const key of ['coherentGain', 'enbwBins', 'mainLobeWidthBins', 'peakSidelobeDb',
      'parsevalResidual', 'peakBin', 'peakHz', 'sigmaT', 'sigmaF', 'heisenbergProduct', 'heisenbergBound']) {
      assert.ok(Number.isFinite(r[key]), `${name}.${key} = ${r[key]}`);
    }
    assert.ok(r.parsevalResidual < 1e-10, `${name} parseval`);
    assert.ok(r.heisenbergProduct >= r.heisenbergBound - 1e-9, `${name} heisenberg`);
  }
});

test('peakErrorHz is null exactly on non-tonal signals', () => {
  for (const [sig, expectNull] of [['pureTone', false], ['dualCloseTones', false], ['linearChirp', true], ['impulseTransient', true], ['noisyHarmonicStack', false]]) {
    const c = L.runComparison(sig, 256);
    for (const name of WINDOWS) {
      assert.equal(c.results[name].peakErrorHz === null, expectNull, `${sig} ${name}`);
    }
  }
});

test('on off-bin tones the tapered windows out-estimate rectangular leakage', () => {
  for (const sig of ['pureTone', 'noisyHarmonicStack']) {
    const c = L.runComparison(sig, 512);
    const rect = c.results.rectangular.peakErrorHz;
    for (const name of ['hann', 'blackmanHarris', 'kaiser8']) {
      assert.ok(c.results[name].peakErrorHz < rect, `${sig}: ${name} ${c.results[name].peakErrorHz} vs rect ${rect}`);
    }
    assert.ok(c.results.blackmanHarris.peakErrorHz < 0.1, `BH err ${c.results.blackmanHarris.peakErrorHz}`);
  }
});

test('only the rectangular window resolves the 2-bin dual-tone pair', () => {
  const n = 512;
  const { samples, params } = L.testSignal('dualCloseTones', n);
  const resolved = {};
  for (const name of WINDOWS) {
    const w = L.windowSamples(name, n);
    const mag = L.magnitudes(L.fft(signal(k => samples[k] * w[k], n)));
    const f2 = params.f2;
    resolved[name] = mag[f2] > mag[f2 - 1] && mag[f2] >= mag[f2 + 1];
  }
  assert.equal(resolved.rectangular, true, 'rect should keep a local peak at f2');
  for (const name of ['hann', 'hamming', 'blackmanHarris', 'kaiser8']) {
    assert.equal(resolved[name], false, `${name} merges the 2-bin pair`);
  }
});

test('strongest-window peak estimate sits within one bin of the truth', () => {
  for (const sig of ['pureTone', 'dualCloseTones', 'noisyHarmonicStack']) {
    const c = L.runComparison(sig, 512);
    for (const name of WINDOWS) {
      assert.ok(c.results[name].peakErrorHz < 1, `${sig} ${name} err ${c.results[name].peakErrorHz}`);
    }
  }
});

for (const n of L.FFT_SIZES) {
  for (const sig of ['pureTone', 'dualCloseTones', 'noisyHarmonicStack']) {
    test(`peak estimate within 1 Hz of truth: ${sig} N=${n}`, () => {
      const c = L.runComparison(sig, n);
      for (const name of WINDOWS) {
        assert.ok(c.results[name].peakErrorHz < 1, `${sig}@${n} ${name} err ${c.results[name].peakErrorHz}`);
      }
    });
  }
}

test('runComparison is byte deterministic', () => {
  const a = L.runComparison('noisyHarmonicStack', 256);
  const b = L.runComparison('noisyHarmonicStack', 256);
  assert.deepEqual(a, b);
});

/* ---------------- Audit export ---------------- */

function audit() {
  return L.buildSpectralAudit(L.runComparison('noisyHarmonicStack', 256), '2026-11-22T00:00:00.000Z');
}

test('audit payload carries the schema envelope and all five windows', () => {
  const p = audit();
  assert.equal(p.format, 'spectralflow-spectral-audit');
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.results.length, 5);
  for (const key of ['format', 'version', 'schemaVersion', 'generatedBy', 'params', 'results', 'disclosure', 'integrity']) {
    assert.ok(key in p, `missing ${key}`);
  }
  assert.match(p.integrity.digest, /^[0-9a-f]{64}$/);
  assert.equal(p.integrity.algorithm, 'SHA-256');
  assert.equal(p.integrity.scope, 'full-audit');
});

test('audit digest equals a platform SHA-256 of the canonical payload', () => {
  const p = audit();
  const signed = {};
  for (const key of ['format', 'version', 'schemaVersion', 'generatedBy', 'params', 'results', 'disclosure']) {
    signed[key] = p[key];
  }
  const expected = crypto.createHash('sha256').update(JSON.stringify(signed), 'utf8').digest('hex');
  assert.equal(p.integrity.digest, expected);
});

test('audit export is deterministic for a fixed generatedAt', () => {
  const c = L.runComparison('pureTone', 256);
  assert.equal(L.exportAuditJSON(c, '2026-01-01T00:00:00Z'), L.exportAuditJSON(c, '2026-01-01T00:00:00Z'));
});

test('a valid signed audit verifies', () => {
  const p = audit();
  const v = L.verifySpectralAudit(JSON.stringify(p));
  assert.equal(v.valid, true);
  assert.equal(v.results, 5);
});

test('editing any metric or parameter trips the digest', () => {
  for (const mutate of [
    p => { p.results[0].peakSidelobeDb += 0.5; },
    p => { p.results[2].parsevalResidual = 0.5; },
    p => { p.params.fftSize = 512; },
    p => { p.params.signal = 'pureTone'; },
    p => { p.results[1].heisenbergProduct = 9; },
    p => { const t = p.results[0]; p.results[0] = p.results[4]; p.results[4] = t; },
    p => { p.results.pop(); }
  ]) {
    const p = audit();
    mutate(p);
    assert.throws(() => L.verifySpectralAudit(JSON.stringify(p)), /integrity/, 'mutated payload accepted');
  }
});

test('forged and malformed digests are refused', () => {
  const p = audit();
  p.integrity.digest = '0'.repeat(64);
  assert.throws(() => L.verifySpectralAudit(p), /integrity/);
  const up = audit();
  up.integrity.digest = up.integrity.digest.toUpperCase();
  assert.throws(() => L.verifySpectralAudit(up), /integrity/);
  const scoped = audit();
  scoped.integrity.scope = 'results';
  assert.throws(() => L.verifySpectralAudit(scoped), /integrity/);
  const gone = audit();
  delete gone.integrity;
  assert.throws(() => L.verifySpectralAudit(gone), /integrity/);
  assert.throws(() => L.verifySpectralAudit({ format: 'other' }), /schema/);
  assert.throws(() => L.verifySpectralAudit('{"format":"spectralflow-spectral-audit","schemaVersion":99}'), /schema/);
});

test('replay recomputes the audit numbers identically', () => {
  const p = audit();
  const r = L.replaySpectralAudit(JSON.stringify(p));
  assert.equal(r.valid, true);
  assert.equal(r.replayed, 5);
});

test('a self-consistent forgery passes the digest but fails the replay', () => {
  /* An attacker can recompute our unkeyed checksum — the replay defence is
     that the numbers must come from the actual engine. */
  const p = audit();
  p.results[0].peakSidelobeDb = -12.34;
  p.integrity.digest = L.auditDigest(p); /* re-signed, internally consistent */
  assert.doesNotThrow(() => L.verifySpectralAudit(p));
  assert.throws(() => L.replaySpectralAudit(p), /Replay mismatch/);
});

test('audit CSV: six rows, finite numeric cells, stable column order', () => {
  const csv = L.exportAuditCSV(L.runComparison('pureTone', 256));
  const rows = csv.trim().split('\n');
  assert.equal(rows.length, 6);
  const header = rows[0].split(',');
  assert.deepEqual(header.slice(0, 4), ['signal', 'fftSize', 'sampleRate', 'window']);
  const seen = [];
  for (let k = 1; k < rows.length; k++) {
    const cols = rows[k].split(',');
    assert.equal(cols.length, header.length);
    seen.push(cols[3]);
    for (const [i, c] of cols.entries()) {
      if (['window', 'signal', 'peakErrorHz'].includes(header[i])) continue;
      assert.ok(Number.isFinite(Number(c)), `row ${k} col ${header[i]} = ${c}`);
    }
  }
  assert.deepEqual(seen, WINDOWS);
  assert.ok(csv.endsWith('\n'));
});

test('csvCellSafe guards spreadsheet formula injection but not numbers', () => {
  for (const trigger of ['=1+1', '+SUM(A1)', '-3', '@tweet', '\ttab', '\rret']) {
    const out = L.csvCellSafe(trigger);
    /* Quoted or not, the first payload character is the guarding apostrophe. */
    assert.match(out, /^"?'/, `trigger ${JSON.stringify(trigger)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(L.csvCellSafe('plain'), 'plain');
  assert.equal(L.csvCellSafe('a,b'), '"a,b"');
  assert.equal(L.csvCellSafe('say "hi"'), '"say ""hi"""');
  assert.equal(L.csvCellSafe(-13.263), '-13.263', 'negative numbers are data, not formulas');
  assert.throws(() => L.csvCellSafe(NaN), /nonfinite/);
});

test('audit markdown is self-describing and honest about the digest', () => {
  const md = L.exportAuditMarkdown(L.runComparison('pureTone', 256), '2026-11-22T00:00:00.000Z');
  assert.match(md, /# SpectralFlow spectral audit/);
  assert.match(md, /SHA-256 digest: [0-9a-f]{64}/);
  assert.match(md, /unkeyed checksum.*not a signature/);
  assert.match(md, /1\/\(4\*?\\?\*? ?pi?\)|1\/\(4\*pi\) = 0\.0796/);
  const rows = md.split('\n').filter(l => /^\| /.test(l) && !/Window/.test(l) && !/---/.test(l));
  assert.equal(rows.length, 5, 'one row per window');
});

test('exportAuditCSV refuses nonfinite metrics instead of emitting NaN', () => {
  const c = L.runComparison('pureTone', 128);
  c.results.hann.coherentGain = NaN;
  assert.throws(() => L.exportAuditCSV(c), /nonfinite/);
});

/* ---------------- Bookmark codec ---------------- */

test('bookmark round-trips every signal and FFT size', () => {
  for (const sig of SIGNALS) {
    for (const n of L.FFT_SIZES) {
      const enc = L.encodeBookmark({ signal: sig, fftSize: n });
      assert.match(enc, /^sf=[A-Za-z0-9_-]+$/);
      assert.deepEqual(L.parseBookmark('#' + enc), { signal: sig, fftSize: n });
      assert.deepEqual(L.parseBookmark(enc), { signal: sig, fftSize: n });
    }
  }
});

test('parseBookmark returns null on non-spectral hashes', () => {
  assert.equal(L.parseBookmark(''), null);
  assert.equal(L.parseBookmark('#workbench'), null);
  assert.equal(L.parseBookmark('#other=abc'), null);
});

test('parseBookmark fails closed on every malformed field', () => {
  const good = L.encodeBookmark({ signal: 'pureTone', fftSize: 512 });
  const withPayload = (mutate) => {
    const b64 = good.slice(3).replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const payload = mutate(JSON.parse(json));
    const raw = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'sf=' + raw;
  };
  assert.throws(() => L.parseBookmark('#sf=!!!not-base64!!!'), /Malformed/);
  assert.throws(() => L.parseBookmark('#' + withPayload(() => ({ v: 2, sig: 'pureTone', n: 512 }))), /version/);
  assert.throws(() => L.parseBookmark('#' + withPayload(p => ({ ...p, sig: 'sine' }))), /signal/);
  assert.throws(() => L.parseBookmark('#' + withPayload(p => ({ ...p, n: 384 }))), /FFT size/);
  assert.throws(() => L.parseBookmark('#' + withPayload(p => ({ ...p, admin: true }))), /Unknown fields/);
});

/* ---------------- Self-tests ---------------- */

test('the in-page self-test battery passes all checks', () => {
  const results = L.runSpectralSelfTests();
  assert.ok(results.length >= 8);
  for (const r of results) assert.equal(r.pass, true, `${r.name}: ${r.detail}`);
});

test('the battery covers every required proof', () => {
  const names = L.runSpectralSelfTests().map(r => r.name).join(' | ');
  for (const needle of ['Parseval', 'FFT/IFFT', 'symmetry', 'Sidelobe ordering', 'Heisenberg', 'CSV', 'tamper', 'SHA-256', 'replay']) {
    assert.match(names, new RegExp(needle, 'i'), `missing check: ${needle}`);
  }
});

/* ---------------- DOM controller ---------------- */

test('spectral panel binds at startup with five curves and a full metrics table', () => {
  const h = boot(HERE);
  assert.deepEqual(h.errors, []);
  assert.equal(h.get('slChart').querySelectorAll('path').length, 5);
  assert.equal(h.get('slTable').querySelectorAll('tbody tr').length, 5);
  assert.equal(h.get('slLegend').querySelectorAll('.legend-item').length, 5);
  assert.match(h.get('slTag').textContent, /1 bin = 1 Hz/);
  h.dispose();
});

test('changing signal and FFT size recomputes the bench honestly', () => {
  const h = boot(HERE);
  const cap = () => h.get('slTable').querySelector('caption').textContent;
  const before = cap();
  h.get('slSignal').value = 'dualCloseTones';
  h.event(h.get('slSignal'), 'change');
  assert.match(cap(), /Dual close tones/);
  assert.notEqual(cap(), before);
  h.get('slFftSize').value = '2048';
  h.event(h.get('slFftSize'), 'change');
  assert.match(cap(), /FFT 2048/);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('legend toggles remove and restore a response curve', () => {
  const h = boot(HERE);
  h.get('slLegend').querySelectorAll('.legend-item')[0].click();
  assert.equal(h.get('slChart').querySelectorAll('path').length, 4);
  assert.equal(h.get('slLegend').querySelectorAll('.legend-item')[0].getAttribute('aria-pressed'), 'false');
  h.get('slLegend').querySelectorAll('.legend-item')[0].click();
  assert.equal(h.get('slChart').querySelectorAll('path').length, 5);
  assert.equal(h.get('slLegend').querySelectorAll('.legend-item')[0].getAttribute('aria-pressed'), 'true');
  h.dispose();
});

test('chart pointer probe shows per-window dB readout', () => {
  const h = boot(HERE);
  h.event(h.get('slChart'), 'pointermove', { clientX: 60, clientY: 100 });
  const tip = h.get('slTooltip');
  assert.equal(tip.hidden, false);
  assert.match(tip.textContent, /bins/);
  assert.ok(tip.querySelectorAll('.tt-row').length === 5);
  h.event(h.get('slChart'), 'pointerleave');
  assert.equal(tip.hidden, true);
  h.dispose();
});

test('all rendered chart geometry stays finite', () => {
  const h = boot(HERE);
  for (const p of h.get('slChart').querySelectorAll('path')) {
    assert.doesNotMatch(p.getAttribute('d'), /NaN|Infinity/);
  }
  h.get('slFftSize').value = '128';
  h.event(h.get('slFftSize'), 'change');
  for (const p of h.get('slChart').querySelectorAll('path')) {
    assert.doesNotMatch(p.getAttribute('d'), /NaN|Infinity/);
  }
  h.dispose();
});

test('audit downloads are signed JSON, escaped CSV and honest Markdown', async () => {
  const h = boot(HERE);
  h.get('slJsonBtn').click();
  h.get('slCsvBtn').click();
  h.get('slMdBtn').click();
  assert.equal(h.document.downloads.length, 3);
  const [json, csv, md] = await Promise.all(h.document.downloads.map(d => h.blobs.get(d.href).text()));
  const payload = JSON.parse(json);
  assert.equal(payload.format, 'spectralflow-spectral-audit');
  assert.equal(L.verifySpectralAudit(payload).valid, true);
  assert.equal(L.replaySpectralAudit(payload).valid, true);
  assert.match(csv, /^signal,fftSize,sampleRate,window/);
  assert.match(md, /unkeyed checksum.*not a signature/);
  h.flushTimers();
  h.dispose();
});

test('copy link writes a restorable #sf= bookmark', () => {
  const h = boot(HERE);
  h.get('slSignal').value = 'noisyHarmonicStack';
  h.event(h.get('slSignal'), 'change');
  h.get('slLinkBtn').click();
  assert.equal(h.copied.length, 1);
  const bookmark = L.parseBookmark(h.copied[0].split('#')[1]);
  assert.deepEqual(bookmark, { signal: 'noisyHarmonicStack', fftSize: 512 });
  h.dispose();
});

test('a valid #sf= bookmark restores the bench on boot', () => {
  const hash = '#' + L.encodeBookmark({ signal: 'dualCloseTones', fftSize: 1024 });
  const h = boot(HERE, {
    beforeBoot: ({ sandbox }) => { sandbox.location = { hash, origin: 'https://aariv.me', pathname: '/spectralflow/' }; }
  });
  assert.equal(h.get('slSignal').value, 'dualCloseTones');
  assert.equal(h.get('slFftSize').value, '1024');
  assert.match(h.get('slNote').textContent, /Restored spectral bench/);
  assert.match(h.get('slTable').querySelector('caption').textContent, /FFT 1024/);
  h.dispose();
});

test('a malformed #sf= bookmark is ignored with a visible note', () => {
  const h = boot(HERE, {
    beforeBoot: ({ sandbox }) => { sandbox.location = { hash: '#sf=broken' }; }
  });
  assert.match(h.get('slNote').textContent, /Ignored malformed bookmark/);
  assert.equal(h.get('slSignal').value, 'pureTone');
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('self-test button renders nine passing checks in the panel', () => {
  const h = boot(HERE);
  h.get('slSelfTestBtn').click();
  const items = h.get('slSelfTestResults').querySelectorAll('li');
  assert.equal(items.length, 9);
  for (const li of items) assert.match(li.textContent, /^PASS /, li.textContent);
  assert.match(h.get('slNote').textContent, /9\/9 passed/);
  h.dispose();
});

test('spectral panel survives blocked storage and missing hash', () => {
  const h = boot(HERE, { storageBlocked: true });
  assert.equal(h.get('slChart').querySelectorAll('path').length, 5);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

for (const sig of SIGNALS) {
  test(`signal ${sig} fills the metrics table and caption`, () => {
    const h = boot(HERE);
    h.get('slSignal').value = sig;
    h.event(h.get('slSignal'), 'change');
    assert.match(h.get('slTable').querySelector('caption').textContent, new RegExp(L.signalLabel(sig)));
    assert.equal(h.get('slTable').querySelectorAll('tbody tr').length, 5);
    assert.deepEqual(h.errors, []);
    h.dispose();
  });
}

test('theme flip redraws the response curves in the new palette', () => {
  const h = boot(HERE);
  const strokeOf = () => h.get('slChart').querySelector('path').getAttribute('stroke');
  const dark = strokeOf();
  h.get('themeToggle').click();
  const light = strokeOf();
  assert.notEqual(light, dark, 'series colour should follow the theme');
  h.dispose();
});

test('audit CSV on a non-tonal signal writes n/a error cells', async () => {
  const h = boot(HERE);
  h.get('slSignal').value = 'linearChirp';
  h.event(h.get('slSignal'), 'change');
  h.get('slCsvBtn').click();
  const csv = await h.blobs.get(h.document.downloads[0].href).text();
  assert.match(csv, /n\/a/);
  assert.doesNotMatch(csv, /NaN|Infinity/);
  h.flushTimers();
  h.dispose();
});

/* ---------------- Source hygiene ---------------- */

test('spectral sources carry no injection sinks or debug leftovers', () => {
  const js = fs.readFileSync(path.join(HERE, 'spectral-lab.js'), 'utf8') +
    fs.readFileSync(path.join(HERE, 'spectral-app.js'), 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/);
  assert.doesNotMatch(js, /console\.(log|debug|info)|debugger/);
  assert.doesNotMatch(js, /[\u2014\u2013]/);
});

test('spectral sources make zero external references', () => {
  for (const file of ['spectral-lab.js', 'spectral-app.js']) {
    const refs = fs.readFileSync(path.join(HERE, file), 'utf8').match(/https?:\/\/[^\s'"<>)]+/g) || [];
    const external = refs.filter(u => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(external, [], `${file} references ${external.join(', ')}`);
  }
});
