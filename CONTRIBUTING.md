# Contributing to SpectralFlow

Thanks for your interest in SpectralFlow. This project is a 2D lattice
Boltzmann wind tunnel and NACA 4-digit airfoil test bench with vorticity,
Schlieren, pressure coefficient, speed, and smoke-wire tracer fields, plus a
chordwise surface pressure distribution and a section polar locus.

## Ground rules

- Be respectful and constructive. This project follows the Contributor
  Covenant, found in `CODE_OF_CONDUCT.md`.
- Keep the project dependency free. No `node_modules`, build steps, or runtime
  libraries. Node builtins and the `node:test` runner are fine.
- Keep the bench offline. No network requests, no CDN assets, no analytics.
- Numerics need a source. If you change the collision model, the boundary
  treatment, or a force integration, cite the method and show that the change
  holds the expected invariants.

## Development setup

Requirements:

- Node.js 22 or newer (the test runner is `node --test`)
- A modern browser for manual verification

```sh
git clone https://github.com/draarivpatel-ui/spectralflow.git
cd spectralflow
node --test
```

Open `index.html` directly from disk, or serve the repository from any static
host:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

## How the code is organised

| File | Role |
| --- | --- |
| `cfd.js` | The solver core: D2Q9 lattice, collision and streaming, obstacle masks, boundary conditions, and force integration |
| `app.js` | UI wiring: field viewports, control panel, figure tables, and CSV or JSON export |
| `index.html`, `style.css` | The bench shell and its styling |
| `test.js` | The test suite |

`cfd.js` is a UMD module, so `require('./cfd.js')` works in Node and
`window.SpectralFlow` is available in the browser. Match that pattern in new
modules.

## Coding standards

- Use 2-space indentation and single quotes, matching the surrounding file.
- Prefer `const`, and use `let` only when reassignment is required.
- Keep functions small and single purpose. Name them after what they do.
- No comments that restate the code. Comment the reason, the citation, or the
  non-obvious trade-off.
- Treat em-dashes and en-dashes as a defect in prose and identifiers. Use
  commas, parentheses, or a plain hyphen instead.
- Never swallow errors silently. Fail loudly with an actionable message.
- Keep the solver allocation-free in its inner loops. Preallocate typed arrays
  and reuse them rather than allocating per step.
- Prefer physical invariants over magic thresholds: mass conservation, the
  definition of the lattice constants, and the analytic NACA thickness curve are
  all better foundations than a tuned epsilon.

## Testing the solver

Assert the listed discrete velocity constants and the lattice weights, since
these are the spec of the model. For solver behaviour, test conservation,
symmetry, and convergence rather than a single snapshot value. The suite takes
several seconds to run because the lattice is integrated over many steps, so
keep added cases proportionate.

## Opening a pull request

1. Fork the repository and create a branch from `main`.
2. Make your change with tests. Every bug fix should include a regression test
  that fails before your fix.
3. Run the full suite locally: `node --test`.
4. Update documentation where a model, field, or default changed.
5. Open the PR against `main` with:
   - a short summary of what changed and why,
   - the commands you ran and their result,
   - screenshots for UI and field changes,
   - the reference or citation for any numerics you touched.
6. Keep the PR small enough to review in one sitting, and respond to review
   promptly.

Commit messages: use a short imperative subject line under 72 characters. Put
the reasoning in the body, not the subject.

## Reporting bugs

Open an issue with the smallest reproduction you can manage: the section,
angle of attack, inflow speed, and viscosity you used, the steps you ran, what
you expected, and what happened instead. State the reference value or expected
trend when a result looks wrong. Security issues follow `SECURITY.md` instead.
