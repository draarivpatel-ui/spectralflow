# SpectralFlow

A 2D lattice Boltzmann wind tunnel and NACA 4 digit airfoil analyzer that runs entirely in the browser. No dependencies, no build step, no network calls. Open `index.html` directly from disk, or serve the repository from any static host.

**Live demo:** https://draarivpatel-ui.github.io/spectralflow/

![Field views: vorticity, velocity magnitude, pressure coefficient, and streamline tracers](https://raw.githubusercontent.com/draarivpatel-ui/spectralflow/main/docs/field-views.svg)

The workbench renders a 220 by 92 lattice in real time. Switch between vorticity, speed, pressure, and tracer streamlines; change the section, angle of attack, inflow speed, viscosity, and chord; then read the wake deficit, Reynolds number, and drag and lift coefficients from the charts. Every chart has an accompanying data table, and telemetry exports to CSV or JSON.

---

## Contents

| File | Purpose |
| --- | --- |
| `cfd.js` | UMD solver module: NACA geometry, D2Q9 BGK lattice Boltzmann, diagnostics, exporters |
| `index.html` | Workbench markup and accessible chart scaffolding |
| `style.css` | Light and dark themes, responsive layout, print stylesheet |
| `app.js` | Browser controller: canvas field, SVG charts, tables, controls, downloads |
| `test.js` | 67 `node:test` assertions covering lattice invariants, geometry, solver, and exports |
| `LICENSE` | MIT |

No package manifest is needed. Node.js 18 or later is required only for the test suite and the command line examples.

---

## Quick start

Browser: open `index.html`. The scripts are classic `<script>` tags, so the `file://` protocol works and nothing is fetched from a server.

Static host:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000/
```

Tests:

```sh
node --test test.js
```

---

## Mathematics

### D2Q9 lattice and weights

The solver uses nine discrete velocities `c_i` on a square lattice, with the rest particle at `i = 0`, four axis aligned links, and four diagonals. In lattice units the speed of sound is `c_s = 1/sqrt(3)` and `c_s^2 = 1/3`.

| i | `c_{i,x}` | `c_{i,y}` | `w_i` |
| --- | --- | --- | --- |
| 0 | 0 | 0 | 4/9 |
| 1 | 1 | 0 | 1/9 |
| 2 | 0 | -1 | 1/9 |
| 3 | -1 | 0 | 1/9 |
| 4 | 0 | 1 | 1/9 |
| 5 | 1 | -1 | 1/36 |
| 6 | -1 | -1 | 1/36 |
| 7 | -1 | 1 | 1/36 |
| 8 | 1 | 1 | 1/36 |

The row index `j` increases downward on screen, so direction 2 points north and direction 4 points south. The weights are the tensor product of the one dimensional stencils `{2/3, 1/6, 1/6}`:

```
sum_i w_i = 4/9 + 4(1/9) + 4(1/36) = 1
sum_i w_i c_i = 0
sum_i w_i c_i c_i = c_s^2 I = I / 3
sum_i w_i c_i c_i c_i = 0
```

Those four moment conditions are what make the discrete equilibrium recover the Navier-Stokes equations at second order.

### Discrete equilibrium

Expanding the Maxwellian in Mach number to second order gives

```
f_i^eq(rho, u) = w_i rho [ 1 + 3 (c_i . u) + (9/2) (c_i . u)^2 - (3/2) (u . u) ]
```

with `u = (u_x, u_y)`. The macroscopic fields are moments of the populations:

```
rho      = sum_i f_i
rho u    = sum_i c_i f_i
p        = c_s^2 rho = rho / 3
```

Because `sum_i f_i^eq = rho` and `sum_i c_i f_i^eq = rho u`, collisions conserve mass and momentum exactly. `test.js` checks both identities to machine precision for several densities and velocities.

### BGK collision and streaming

The Bhatnagar-Gross-Krook approximation relaxes all nonconserved moments toward equilibrium with a single rate `omega`:

```
f_i(x + c_i, t + 1) = f_i(x, t) + omega [ f_i^eq(x, t) - f_i(x, t) ]
```

Chapman-Enskog expansion of this equation yields the incompressible Navier-Stokes equations with kinematic viscosity

```
nu = c_s^2 (tau - 1/2) = (tau - 1/2) / 3
tau = 3 nu + 1/2
omega = 1 / tau
```

The implementation splits each time step into a local collision, boundary closure, and a pull style streaming pass. Fluid nodes near Mach 0.3 or above are blended toward equilibrium to keep the simulation stable at aggressive control settings; the number of such nodes is reported as `sanitizedNodes`.

### Boundary conditions

**West inlet (Zou-He velocity closure).** Density and the unknown populations are solved from the prescribed velocity `u0` using the two conservation laws plus the bounce-back rule for the nonhydrodynamic moment:

```
rho = [ f_0 + f_2 + f_4 + 2 (f_3 + f_6 + f_7) ] / (1 - u0)
f_1 = f_3 + (2/3) rho u0
f_5 = f_7 + (1/6) rho u0 + (1/2)(f_4 - f_2)
f_8 = f_6 + (1/6) rho u0 + (1/2)(f_2 - f_4)
```

The remaining populations are copied from the post collision state. An optional equilibrium inlet writes `f_i^eq(1, u0, 0)` instead.

**East outlet.** The convective outflow copies the incoming populations from the adjacent interior column with a relaxation toward the free stream equilibrium. An equilibrium outlet is also available. This is an open boundary, not a prescribed pressure, and it keeps the tunnel from reflecting waves.

**Solid walls (halfway bounce-back).** Any population that would stream from a fluid node into a solid node is reflected into the opposite direction at the same node:

```
f_OPP(i)(x, t + 1) = f_i^*(x, t)
```

This places the no-slip wall halfway along the link and forces `u = 0` at solid cells. `test.js` verifies zero velocity on every solid cell. Free-slip top and bottom walls mirror the normal component instead.

### Momentum-exchange force

Each reflected link transfers momentum `2 c_i f_i^*` to the body. Summing over all such links gives the hydrodynamic force:

```
F = sum_reflected 2 c_i f_i^*
```

Screen `y` grows downward, so lift uses `F_y = -F_lift`. The dimensionless coefficients use the projected frontal height `L_ref` of the obstacle and the dynamic pressure `q = rho_0 u_0^2 L_ref / 2`:

```
Cd = F_x / q
Cl = -F_y / q
L/D = Cl / Cd
Re = u_0 L / nu
```

Vortex shedding makes the instantaneous lift oscillate, so the workbench displays a 160 sample running mean alongside the instantaneous history. The Reynolds number uses the section chord for airfoils and the projected diameter for bluff bodies.

### Diagnostics

Velocity magnitude, vorticity, and pressure coefficient are computed from the macroscopic fields:

```
|u|   = sqrt(u_x^2 + u_y^2)
curl  = du_y/dx - du_x/dy        (central differences, solid cells excluded)
Cp    = (rho - rho_0) / (3 q)    where q = rho_0 u_0^2 / 2 and (rho - rho_0)/3 = p - p_0
```

The wake profile samples a vertical column at 75 percent of the domain width, and the centerline profile samples the horizontal mid row. Both skip or flag solid cells. `test.js` checks the analytic curl of a solid-body rotation field and the exact `Cp` relation.

---

## NACA 4 digit geometry

A code `MPXX` encodes maximum camber `m = M/100`, its chordwise position `p = P/10`, and thickness ratio `t = XX/100`. For example `2412` gives `m = 0.02`, `p = 0.4`, `t = 0.12`.

### Thickness distribution

```
y_t(x) = 5 t [ 0.2969 sqrt(x) - 0.1260 x - 0.3516 x^2 + 0.2843 x^3 - 0.1036 x^4 ]
```

The final coefficient is the closed trailing edge variant, so `y_t(1) = 0` to within `1.4e-4`. The open trailing edge variant uses `-0.1015` instead.

### Mean camber line

```
for 0 <= x < p:   y_c(x) = (m / p^2) [ 2 p x - x^2 ]
for p <= x <= 1:  y_c(x) = (m / (1-p)^2) [ (1 - 2p) + 2 p x - x^2 ]

dy_c/dx = (2m / p^2)(p - x)             for x < p
dy_c/dx = (2m / (1-p)^2)(p - x)        for x >= p
```

For a symmetric section (`m = 0`) the camber line and its slope vanish everywhere. `test.js` asserts that the `0012` raster is exactly symmetric at zero angle of attack and asymmetric at positive angle.

### Upper and lower surfaces

Thickness is applied along the local normal, not vertically:

```
theta = atan(dy_c/dx)
x_u = x - y_t sin(theta)      y_u = y_c + y_t cos(theta)
x_l = x + y_t sin(theta)      y_l = y_c - y_t cos(theta)
```

Cosine clustering places more stations near the leading and trailing edges:

```
x_k = (1 - cos(pi k / N)) / 2       k = 0 ... N
```

The polygon is rotated about the quarter chord by the requested angle of attack, scaled by the chord in pixels, and rasterized with a point-in-polygon test. The projected frontal height is computed analytically from the chord, thickness, camber slope, and rotation.

### Other obstacles

- **Cylinder**: a circular raster with a small deterministic transverse perturbation that seeds the Karman vortex street.
- **Bluff body**: a rectangular block with sharp separation corners.
- **Venturi channel**: smooth cosine constriction walls with fully open inlet and outlet reservoirs. Centerline speed increases through the throat and recovers downstream.

---

## Node and CLI use

`cfd.js` is a UMD module. In CommonJS:

```js
const SF = require('./cfd.js');

const mask = SF.generateNaca4Mask('2412', 70, 6, 220, 92);
const state = SF.createWindTunnel(220, 92, 0.08, 0.02, { mask: mask });

SF.stepLBM(state, 600);
const d = SF.computeDiagnostics(state);

console.log('Re     ', d.reynolds.toFixed(1));
console.log('mean Cd', d.meanCd.toFixed(4));
console.log('mean Cl', d.meanCl.toFixed(4));
console.log('L/D    ', d.meanLd.toFixed(3));
console.log('wake   ', d.wakeDeficit.toFixed(5));
```

One line CSV and JSON exports:

```sh
node -e "const S=require('./cfd.js');const s=S.createWindTunnel(220,92,0.08,0.02,{obstacle:'naca0012'});S.stepLBM(s,400);process.stdout.write(S.exportWakeProfileCSV(s))" > wake.csv
node -e "const S=require('./cfd.js');const s=S.createWindTunnel(220,92,0.08,0.02,{obstacle:'cylinder'});S.stepLBM(s,400);process.stdout.write(S.exportSnapshotJSON(s,{includeFields:false}))" > snapshot.json
node -e "const S=require('./cfd.js');const s=S.createWindTunnel(220,92,0.08,0.02);S.stepLBM(s,400);process.stdout.write(S.exportForceHistoryCSV(s))" > forces.csv
```

Batch sweep of angle of attack:

```js
const SF = require('./cfd.js');
for (const angle of [-10, -5, 0, 5, 10]) {
  const mask = SF.generateNaca4Mask('0012', 70, angle, 220, 92);
  const s = SF.createWindTunnel(220, 92, 0.08, 0.02, { mask: mask });
  SF.stepLBM(s, 800);
  const d = SF.computeDiagnostics(s);
  console.log(angle, d.meanCd.toFixed(3), d.meanCl.toFixed(3), d.meanLd.toFixed(2));
}
```

In a browser without a bundler, load `cfd.js` with a `<script>` tag and use `window.SpectralFlow`. AMD loaders are supported through `define`.

### Public API

| Function | Returns |
| --- | --- |
| `generateNaca4Mask(code, chordPx, angleDeg, nx, ny)` | `Uint8Array` raster with geometry metadata |
| `generateCylinderMask(radiusPx, nx, ny, centerX, centerY)` | circular raster |
| `generateBluffBodyMask(nx, ny, widthPx, heightPx)` | rectangular raster |
| `generateVenturiMask(nx, ny, throatRatio, lipFraction)` | channel raster |
| `generateObstacleMask(kind, options)` | dispatcher for any preset |
| `naca4Coordinates(code, samples)` | upper, lower, and camber line point arrays |
| `parseNaca4(code)` | `{code, maxCamber, camberPosition, thickness}` |
| `createWindTunnel(nx, ny, u0, viscosity, options)` | mutable solver state |
| `setObstacle(state, mask, reset)` | updated state |
| `setFlowParameters(state, u0, viscosity)` | updated state |
| `initializeFlow(state)` | reset state to equilibrium inflow |
| `stepLBM(state, steps)` | updated state after `steps` cycles |
| `computeFields(state)` | `{speed, curl, cp}` row-major arrays |
| `computeDiagnostics(state)` | full diagnostics including fields and profiles |
| `computeForceCoefficients(state)` | instantaneous and windowed `Cd`, `Cl`, `L/D` |
| `centerlineProfile(state)` | horizontal mid row samples |
| `wakeProfile(state, xFraction)` | vertical column samples |
| `exportWakeProfileCSV(state, xFraction)` | CSV string |
| `exportForceHistoryCSV(state)` | CSV string |
| `exportSnapshotJSON(state, options)` | JSON string |
| `equilibrium(rho, ux, uy, i)` | single equilibrium population |

Constants exported: `VERSION`, `CX`, `CY`, `W`, `OPP`, `Q9`, `CS2`, `LIMITS`.

---

## Field views and charts

| View | Encoding | Purpose |
| --- | --- | --- |
| Vorticity | blue and red diverging scale with neutral gray midpoint | signed rotation and shear layers |
| Velocity | single blue sequential ramp | stagnation zones, jets, and wake deficit |
| Pressure | diverging scale, reversed polarity | suction over the upper surface and compression at the stagnation point |
| Tracers | massless particles advected by bilinear velocity | separation, recirculation, and vortex shedding |

Charts follow a single shared axis, with a legend for the two force series and direct end labels. Hover or focus a chart for a crosshair and value tooltip. The optional texture mode adds 45 and 135 degree hatching as a second visual channel for color vision deficiency, print, and forced colors. Every chart has an expandable data table with a caption and row headers.

---

## Accessibility and offline behavior

- Light and dark themes are selected explicitly, with an optional system preference on first load. The choice is stored in `localStorage`.
- Charts are `role="img"` with `<title>` and `<desc>`, plus equivalent data tables.
- Field buttons form an ARIA radiogroup with arrow key navigation.
- A polite live region announces rebuilds, steps, view changes, and downloads.
- The print stylesheet reveals all tables, hides interactive controls, and forces light colors.
- All computation, rendering, and downloads happen locally. `index.html` makes no network requests and works from `file://`.

---

## Numerical limits

The solver works in dimensionless lattice units. Speeds are clamped to `0.002` to `0.16` and viscosity to `0.004` to `0.18`, which keeps `tau` above `0.512` and the lattice Mach number moderate. These are exploration settings, not a substitute for a validated RANS or DNS solver. Force coefficients are momentum-exchange proxies on a coarse raster and should be read as trends rather than certified engineering data.

---

## License

MIT. See `LICENSE`.
