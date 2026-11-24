# SpectralFlow

**See the flow. Measure the physics.** A local 2D wind tunnel laboratory with live flow fields, surface pressure integration, numerical health checks and resumable solver checkpoints.

[Open the laboratory](https://aariv.me/spectralflow/). All browser assets are local. There are no runtime dependencies, build steps, accounts or network requests. Open `index.html` directly from disk or publish the directory on a static host.

## Four experiments to try immediately

| Experiment | Inspect |
| --- | --- |
| Test symmetry | NACA 0012 at zero incidence, upper/lower pressure and near-zero lift |
| Make lift visible | Camber, incidence, pressure contours and momentum-exchange force |
| Follow the wake | Separated cylinder shear layers, rotation signs and velocity deficit |
| Accelerate a fluid | Venturi inlet and throat speed, pressure recovery and channel geometry |

Each preset prepares a real solver state in bounded animation batches. Pause, advance twenty steps, pin a probe or download the state. Every plotted force-trajectory point comes from the current simulation history.

## Engine and numerical conventions

The solver advances nine D2Q9 populations on a 220 by 92 browser lattice, with BGK collision, a Zou-He velocity inlet, neighbor-copy or equilibrium outlet treatment, halfway bounce-back solid links and selectable no-slip or free-slip top/bottom walls.

```text
rho       = sum(f_i)
rho u     = sum(c_i f_i)
f_i(eq)   = w_i rho [1 + 3(c_i.u) + 4.5(c_i.u)^2 - 1.5(u.u)]
tau       = 3 nu + 0.5
omega     = 1 / tau
Cp        = (rho - rho0) / (3 * 0.5 * rho0 * u0^2)
```

NACA geometry uses cosine sampling, a closed trailing edge and perpendicular thickness offsets. Surface pressure samples fluid values along the actual rotated surface normals. A closed-contour pressure integral reports force coefficients without viscous shear, allowing comparison with total link momentum exchange.

Airfoil lift and drag use **chord times unit span**. Cylinders and bluff bodies use projected height times unit span. Projected height remains a separate geometry measurement. Coordinates have x right and grid row j down; `fields.curl` retains the screen-space derivative, while `fields.vorticity` and the field viewport use its negative for physical y-up vorticity.

## Inspection and export

- Five field views: physical vorticity, numerical Schlieren, pressure coefficient, speed and smoke tracers.
- Pointer and keyboard lattice probes with actual rho, velocity, pressure and vorticity readings.
- Arrow keys move one cell; Shift moves ten. Home/End select the inlet/outlet. Enter pins a probe and Escape releases it.
- Live finite-field, inlet-residual, repaired-node and peak-Mach readouts in a six-cell telemetry strip (Reynolds, mean drag, mean lift, lift-to-drag, BGK relaxation, Strouhal).
- Chordwise Cp, wake traverse, force history, geometry and measured force trajectory plots, with accessible data tables.
- Spectral lab: five deterministic analysis windows (Rectangular, Hann, Hamming, Blackman-Harris, Kaiser beta=8) compared on five test signals across FFT sizes 128 to 2048, with main-lobe width, peak sidelobe, coherent gain, ENBW, Parseval residual, parabolic-interpolated peak error and the sigma_t x sigma_f uncertainty product.
- An interactive dB magnitude-response chart overlays all five windows with per-window legend toggles and a pointer probe; a self-test button replays Parseval, FFT round-trip, ordering and SHA-256 known-answer proofs live on the page.
- Wake CSV, force CSV and a complete nine-column field CSV with one row per lattice site.
- Spectral audits export as JSON, CSV or Markdown with a SHA-256 integrity digest and replay verification; `#sf=` URL bookmarks restore the bench state.
- Checkpoint JSON preserves all populations, boundary modes, operating conditions and force samples. The browser verifies its round trip before download.
- Import restores a compatible 220 by 92 checkpoint and pauses it for inspection. The engine supports other grid sizes within its memory budget.

The 20,240-site browser lattice has **182,160 populations**. Tests preserve each population exactly through JSON and reproduce the same next twenty collision/streaming steps after restoring a checkpoint.

## Numerical integrity

Repairs update the distributions and their macroscopic moments together. A repaired cell is counted and remains visible as a numerical-health warning. Crossing the stability limit stops the run with its time and evidence intact. The engine rejects nonfinite exports, malformed masks, degenerate sections, inconsistent checkpoints and invalid step counts.

One-sided fluid stencils avoid halving gradients at solid neighbors. Diagnostics reuse one computed field set across profiles. Hot-loop numerical helpers are bound locally, reducing repeated global lookup overhead in browser-controller checks.

The engine bounds grid allocation to 262,144 cells and coordinate sampling to 4,096 intervals. Inflow speed is bounded to 0.002 through 0.16, viscosity to 0.004 through 0.18, and repaired lattice speed to 0.38. Those limits manage computation; they do not establish high-Reynolds-number accuracy.

## Verification

Node.js 22 or newer:

```sh
node --test --test-reporter=spec test.js regression-test.js ui-test.js revamp-test.js audit-test.js spectral-test.js
```

**412 tests passed, 0 failed, 0 skipped:** 67 base engine checks, 29 numerical/export regressions, 20 DOM/controller checks, 16 revamp/adversarial regressions, 73 Wave 3 audit checks (SHA-256 checkpoint integrity, conservation stencils, fail-closed clamps, NACA invariants, obstacle symmetry, Strouhal edges, adversarial checkpoint defenses, WCAG 2.1.4 shortcut toggle, CSP and injection fences) and 207 spectral-lab checks (FFT/DFT agreement, Parseval conservation at every size, published window constants, sidelobe ordering, dual-tone resolution, uncertainty bound, audit digest tamper and replay forgery, bookmark codec, controller DOM checks).

Coverage includes lattice isotropy, equilibrium mass and momentum, NACA symmetry, positive/negative incidence trends, solid and inlet boundary behavior, Venturi acceleration, bounded force history, analytic gradients, coherent repair, finite CSV schemas, strict checkpoint validation, exact resumed evolution and every showcase scenario.

The deterministic DOM adapter executes the actual HTML scripts and checks startup, preset handlers, single animation scheduling, visibility suspension, probe keys, pinning, DPI resize, SVG metadata, downloads, imports and error recovery. It records zero console/reference errors. It does not measure browser layout or claim a rendered screenshot.

Headless-Chrome spot checks on 2026-11-20 (Wave 2 polish pass) additionally confirmed zero console errors, zero external requests and no horizontal page overflow at 1440x900 and 390x844, in both themes.

## Node API

```js
const S = require('./cfd.js');
const mask = S.generateNaca4Mask('2412', 77, 8, 220, 92);
const state = S.createWindTunnel(220, 92, 0.07, 0.024, { mask });
S.stepLBM(state, 240);
const diagnostics = S.computeDiagnostics(state);
const pressure = S.surfacePressureProfile(state, diagnostics.fields);
const checkpoint = S.exportSnapshotJSON(state, { includePopulations: true });
const resumed = S.importSnapshotJSON(checkpoint);
console.log(S.verifySnapshotRoundTrip(state));
```

A telemetry-only JSON export can omit populations or heavy fields. Only a complete schema-v2 checkpoint is resumable. Imports check field lengths, finite values, population consistency, boundary modes and reference lengths.

## Source map

| File | Responsibility |
| --- | --- |
| `cfd.js` | Geometry, solver, boundaries, fields, pressure integration, scenarios and exporters |
| `app.js` | Animation scheduling, controls, plots, probes and checkpoint workflow |
| `spectral-lab.js` | Radix-2 FFT, analysis windows, test signals, leakage/resolution metrics, checksummed audit export and bookmarks |
| `spectral-app.js` | Spectral bench controller: response chart, metrics table, audit downloads and self-test panel |
| `index.html`, `style.css` | Responsive laboratory, themes and accessible controls |
| `test.js`, `regression-test.js` | Physics, numerical, schema and resumed-evolution checks |
| `ui-test.js`, `revamp-test.js`, `audit-test.js`, `dom-harness.js` | Actual controller, revamp and Wave 3 audit tests with deterministic DOM/canvas adapters |
| `spectral-test.js` | Spectral lab checks: transform correctness, window invariants, audit tamper/replay and controller DOM |

## Scope and next steps

This is a two-dimensional, coarse-grid, low-Mach educational solver. The staircase solid boundary, simple outlet, startup transient and finite tunnel affect coefficients. A force trajectory at one operating condition is not an angle-of-attack polar. Mesh refinement, convergence studies, improved collision/outlet treatment and validated reference benchmarks are the next engineering steps before quantitative design use.

MIT. See [LICENSE](LICENSE). Submission copy is in [DEVPOST_UPGRADE.md](DEVPOST_UPGRADE.md).
