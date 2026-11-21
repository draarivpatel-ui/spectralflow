# SpectralFlow: See the flow. Measure the physics.

## Inspiration

Flow is easy to animate and difficult to explain. We wanted a wind tunnel where the picture, the numerical state and the evidence travel together. A judge should be able to point at a wake, inspect the actual velocity and take the complete experiment away as a resumable file.

## What it does

SpectralFlow is an offline browser wind tunnel powered by a real D2Q9 lattice Boltzmann solver. Four one-click experiments reveal symmetry, lift, separated shear and Venturi acceleration. Five field views, surface pressure, wake profiles, force histories and keyboard-accessible probes connect the visual result to its measured state.

Live health readouts expose inlet residual, repaired nodes and peak Mach number. Every force-trajectory point is a recorded solver sample. Full-field CSV exports contain every lattice site, while checkpoint JSON stores all populations and can resume the simulation exactly.

## How we built it

The standalone JavaScript kernel shares its geometry and solver with the browser and Node tests. Nine populations per cell undergo BGK collision and pull streaming. Zou-He inlet reconstruction, halfway bounce-back and link momentum exchange provide the boundary and force calculations.

NACA sections use the closed trailing-edge thickness polynomial and normal offsets from their mean camber line. Pressure sampling follows the rotated section normals. Integrating pressure around the closed contour produces a pressure-only force that can be compared with the total link force in the same coefficient convention.

The controller draws with local Canvas and SVG, schedules one animation loop and prepares presets in bounded batches. It reads a checkpoint back and compares all populations before offering the download. Import validation also checks whether the rounded diagnostic fields agree with the full distributions, and a SHA-256 digest signed over the whole payload rejects edits that would still look valid, such as an in-range speed change or a swapped wake sample.

## Challenges

Some numerical defects looked stable on screen. Density and speed clamping could leave the populations inconsistent with the displayed moments. Automatic recovery could reset time and erase the evidence of an unstable run. Derivatives next to solids could halve a real gradient, and the requested perturbation amplitude was ignored.

Geometry and convention bugs mattered just as much. NACA-prefixed preset names did not all reach the correct generator. Degenerate sections could produce no solid cells. Airfoil coefficients used projected frontal height instead of chord, and rectangular raster dimensions included an extra cell.

The UI preserved stale SVG children by position, could schedule duplicate animation loops and showed a fabricated reference curve beside a stale operating point. The upgraded laboratory preserves actual metadata, follows measured force pairs, suspends hidden-tab work and makes failed geometry and imports visible.

## Accomplishments

- A 20,240-site browser grid exposes its real fields and numerical-health checks.
- Repairs change distributions and moments together and retain their counters.
- The closed pressure contour has zero integrated force under uniform pressure to the tested tolerance.
- Airfoil forces use chord times unit span, matching their displayed pressure integral.
- A checkpoint restores all 182,160 populations with zero population error.
- The restored solver produces the same next twenty steps as its original state.
- Every shipped experiment runs through its preparation steps without numerical repair in the scenario suite.
- Checkpoints carry a SHA-256 integrity digest; forged or hand-edited payloads are refused on import.
- Probe keyboard shortcuts honor WCAG 2.1.4 with a persistent off toggle, and a strict content policy closes script, object, form and network surfaces.

## Verification numbers

Verified on Node v24.16.0 with:

```sh
node --test --test-reporter=spec test.js regression-test.js ui-test.js revamp-test.js audit-test.js
```

**205 passed, 0 failed, 0 skipped.**

| Verification | Observed result |
| --- | --- |
| Base physics and export checks | 67 tests |
| Numerical and checkpoint regressions | 29 tests |
| DOM/controller checks | 20 tests |
| Revamp/adversarial regressions | 16 tests |
| Wave 3 audit checks | 73 tests |
| Browser lattice sites | 20,240 |
| Browser checkpoint populations | 182,160 |
| Full-field CSV data rows | 20,240 |
| Checkpoint maximum population error | 0 |
| Resumed-evolution comparison | 20 additional steps, identical populations and force history |
| Showcase experiments | 4, all finite and without repair at their tested preparation steps |
| Uniform-flow mass error tolerance | Below 1e-10 on the 512-site regression grid |
| Uniform-flow inlet/outlet flux agreement tolerance | Below 1e-12 |
| Captured DOM console/reference errors | 0 |

These results verify the implemented low-Mach model and controller. They do not establish a refined-grid aerodynamic benchmark or physical wind-tunnel agreement.

## What's next

Grid refinement and convergence studies, improved collision and outlet models, reference benchmark comparisons and an actual incidence sweep would make the next version a stronger quantitative laboratory. The checkpoint format already makes experiments reproducible and portable between runs.

## Judge demo

Open [SpectralFlow](https://aariv.me/spectralflow/), choose **Accelerate a fluid**, and move the probe from inlet to throat. Choose **Make lift visible** and compare the Cp integral with the link-force history. Save a checkpoint, advance the solver and restore the saved file to return to the same numerical state.
