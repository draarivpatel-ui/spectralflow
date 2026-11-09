# SpectralFlow

A 2D lattice Boltzmann wind tunnel and NACA 4-digit airfoil test bench that runs entirely in the browser. Zero runtime dependencies, zero build steps, and zero network requests. Open `index.html` directly from disk (`file://`) or serve the repository from any static host.

**Live bench:** https://draarivpatel-ui.github.io/spectralflow/

The test bench streams nine discrete velocity populations across a 220 by 92 Cartesian lattice in real time. Switch between screen-space vorticity (`curl`), numerical Schlieren density gradient (`|grad rho|`), pressure coefficient (`Cp`), speed (`|u|`), and smoke-wire tracer filaments; adjust the NACA 4-digit section, angle of attack, inflow speed, viscosity, and chord length; and inspect the chordwise surface pressure distribution `Cp(x/c)`, downstream wake rake `u_x(y)`, aerodynamic force history `Cd(t)` and `Cl(t)`, and section polar locus. Every figure includes an expandable numerical table and exports to CSV or JSON.

---

## Repository Layout

| File | Purpose |
| --- | --- |
| `cfd.js` | UMD solver kernel: NACA 4-digit geometry, D2Q9 BGK lattice Boltzmann, boundary closures, diagnostics, exporters |
| `index.html` | NACA / Langley technical report layout and accessible SVG plot scaffolding |
| `style.css` | Archival technical report paper (light) and Schlieren optical darkroom (dark) themes, print stylesheet |
| `app.js` | Browser controller: test-section canvas, Schlieren gradient pass, `Cp(x/c)` integrator, wake rake, force balance, polar locus |
| `test.js` | 67 `node:test` assertions covering lattice invariants, geometry, solver stability, boundaries, and exports |
| `LICENSE` | MIT |

No `package.json` or bundler is required. Node.js 18+ is used only for the automated test suite and command-line batch sweeps.

---

## Quick Start

Open `index.html` directly in a browser, or run a local static server:

```sh
python3 -m http.server 8000
```

Run the 67-test verification suite and syntax checks:

```sh
node --test test.js
node --check cfd.js
node --check app.js
```

---

## Governing Mathematics & Numerical Physics

### 1. D2Q9 Lattice Stencil and Moment Isotropy

The solver advances nine discrete velocity vectors `c_i` on a square lattice with rest particle `i = 0`, four axis-aligned links (`i = 1..4`), and four diagonal links (`i = 5..8`). In lattice units (`dx = dt = 1`), the isothermal speed of sound is `c_s = 1 / sqrt(3)` (`c_s^2 = 1/3`).

| Direction `i` | `c_{i,x}` | `c_{i,y}` | Weight `w_i` |
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

Screen row index `j` increases downward, so `i = 2` points toward the upper tunnel wall (north) and `i = 4` points toward the lower wall (south). The quadrature weights satisfy the four moment identities required to recover the compressible Navier-Stokes equations at low Mach number:

```
sum_i w_i           = 1
sum_i w_i c_i       = 0
sum_i w_i c_i c_i   = c_s^2 I = (1/3) I
sum_i w_i c_i c_i c_i = 0
```

### 2. Second-Order Discrete Maxwellian Equilibrium

Expanding the local Maxwell-Boltzmann distribution to second order in `u / c_s` gives:

```
f_i^eq(rho, u) = w_i rho [ 1 + 3 (c_i . u) + (9/2) (c_i . u)^2 - (3/2) (u . u) ]
```

Macroscopic density, momentum, and pressure are exact zeroth and first velocity moments of the populations:

```
rho   = sum_i f_i
rho u = sum_i c_i f_i
p     = c_s^2 rho = rho / 3
```

Because `sum_i f_i^eq = rho` and `sum_i c_i f_i^eq = rho u`, the collision operator conserves mass and linear momentum to machine precision (`< 1e-12` in `test.js`).

### 3. BGK Collision and Why `tau` Blows Up Near `0.5`

Under the Bhatnagar-Gross-Krook (BGK) single-relaxation-time approximation, non-equilibrium moments relax at rate `omega = 1 / tau`:

```
f_i^*(x, t)       = f_i(x, t) + omega [ f_i^eq(x, t) - f_i(x, t) ]
f_i(x + c_i, t+1) = f_i^*(x, t)
```

A Chapman-Enskog multiscale expansion links the dimensionless relaxation time `tau` to the kinematic shear viscosity `nu`:

```
nu = c_s^2 (tau - 1/2) = (tau - 1/2) / 3
tau = 3 nu + 1/2
omega = 1 / tau
```

The `-1/2` shift comes from the second-order discrete lattice truncation error of the streaming operator `f_i(x + c_i dt, t + dt)`. As kinematic viscosity `nu` approaches zero, `tau` approaches `0.5` from above and `omega = 1 / tau` approaches `2`. In that regime (`1 < omega < 2`), every BGK collision step **over-relaxes** the distribution past `f_i^eq`: the post-collision non-equilibrium part `f_i^{neq,*} = (1 - omega) f_i^{neq}` flips sign at every time step with amplification factor `|1 - omega| -> 1`. Simultaneously, higher-order dispersive errors grow as `(tau - 1/2)^{-1}`, and non-hydrodynamic ghost modes are no longer damped. Any sharp velocity gradient near the airfoil leading edge or trailing edge excites checkerboard acoustic waves that drive individual populations negative (`f_i < 0`) and blow up the macroscopic velocity `u = (sum c_i f_i) / rho`.

SpectralFlow prevents this instability in two ways:
1. Viscosity is clamped to `nu >= 0.004` (`tau >= 0.512`, `omega <= 1.953`), keeping the linear relaxation factor strictly inside the stable unit disk.
2. During macroscopic moment reconstruction, any fluid cell whose local speed exceeds the lattice Mach cap (`|u| > 0.38`, `Ma > 0.66`) has its velocity rescaled and its populations blended 50/50 toward `f_i^eq(rho, u_clamped)`, damping high-wavenumber ghost oscillations before the next collision pass.

### 4. Boundary Closures and Staircase Bounce-Back Effects on `Cp(x/c)`

- **West Inlet (Zou-He Velocity Closure):** Reconstructs density `rho = [f_0 + f_2 + f_4 + 2(f_3 + f_6 + f_7)] / (1 - u_0)` and solves the three inward populations `f_1, f_5, f_8` by enforcing conservation of mass, streamwise momentum, and bounce-back of the normal non-equilibrium part.
- **East Outlet (Convective Outflow):** Copies incoming populations (`c_{i,x} < 0`) from column `nx - 2` so shed vortices exit the test section without acoustic reflection.
- **Solid Obstacles (Halfway Bounce-Back):** When a fluid node at `x_f` pulls along direction `q` from a solid neighbor `x_s = x_f + c_d` (`d = OPP[q]`), it reflects the post-collision population `f_q(x_f, t+1) = f_d^*(x_f, t)`. Each cut link transfers momentum `2 c_d f_d^*(x_f, t)` to the body, giving total hydrodynamic force `F = sum 2 c_d f_d^*`.

On a Curved NACA 2412 section rotated to angle of attack `alpha`, rasterizing the continuous coordinates onto a uniform Cartesian grid produces a **staircase boundary** where the effective halfway bounce-back wall is a piecewise-constant sequence of horizontal and vertical steps rather than a smooth curve tangent to the airfoil surface. That staircase geometry affects chordwise surface pressure `Cp(x/c)` in two ways:
1. **Corner Diffraction Spikes:** At every `j`-row step along the upper cambered surface, a concave fluid corner stagnates one link while the adjacent convex corner accelerates flow, superimposing grid-scale sawtooth oscillations onto the smooth inviscid suction peak.
2. **Normal Offset vs. Vertical Sampling:** Sampling `Cp = (rho - rho_0) / (3 q)` one fluid node above (`j_top - 1`) and below (`j_bot + 1`) each solid column integrates the vertical pressure jump `Cl_p = integral (Cp_lower - Cp_upper) d(x/c)`, whereas momentum exchange `F = sum 2 c_i f_i^*` sums both normal pressure and tangential viscous shear across every cut horizontal, vertical, and diagonal link. Comparing `Cl_p` against the momentum-exchange `Cl` in the workbench makes this coarse-grid boundary layer and staircase effect directly visible.

---

## Command-Line & Node.js API

`cfd.js` is a standalone UMD module:

```js
const SF = require('./cfd.js');

const mask = SF.generateNaca4Mask('2412', 77, 6, 220, 92);
const state = SF.createWindTunnel(220, 92, 0.08, 0.02, { mask });

SF.stepLBM(state, 600);
const d = SF.computeDiagnostics(state);

console.log('Re     ', d.reynolds.toFixed(1));
console.log('mean Cd', d.meanCd.toFixed(4));
console.log('mean Cl', d.meanCl.toFixed(4));
console.log('L/D    ', d.meanLd.toFixed(3));
```

Export CSV or JSON directly from the shell:

```sh
node -e "const S=require('./cfd.js');const s=S.createWindTunnel(220,92,0.08,0.02,{obstacle:'naca2412'});S.stepLBM(s,400);process.stdout.write(S.exportWakeProfileCSV(s))" > wake.csv
node -e "const S=require('./cfd.js');const s=S.createWindTunnel(220,92,0.08,0.02,{obstacle:'naca2412'});S.stepLBM(s,400);process.stdout.write(S.exportForceHistoryCSV(s))" > forces.csv
node -e "const S=require('./cfd.js');const s=S.createWindTunnel(220,92,0.08,0.02,{obstacle:'cylinder'});S.stepLBM(s,400);process.stdout.write(S.exportSnapshotJSON(s,{includeFields:false}))" > snapshot.json
```

---

## License

MIT. See `LICENSE`.
