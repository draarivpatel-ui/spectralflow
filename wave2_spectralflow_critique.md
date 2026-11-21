# SpectralFlow  -  Wave 2 polish critique (2026-11-20)

Judge pass over `index.html`, `app.js`, `cfd.js`, `style.css` at commit `126cab5`
baseline. Method: full source read, 132-test baseline run, headless Chrome
(CDP) at 1440x900 and 390x844 with console/external-request/overflow
enumeration, scrolled section screenshots at both widths, light+dark themes.

**Baseline:** 132/132 tests pass (67 base + 29 regression + 20 UI + 16 revamp).
**Score after fixes: 9.4 / 10.**

## Fixed defects

### [must] Favicon 404 console error on every page load  -  index.html (head)
No `favicon` link existed; Chrome requests `/favicon.ico` automatically and the
static server 404s, producing a console error on every load of this
"zero-defect" showcase (`/tmp/sf-http.log`: `GET /favicon.ico 404`).
**Fix:** inline SVG data-URI icon (`index.html:8`)  -  stays offline, no new
request. Verified: `consoleErrors: []` at both viewports.

### [must] Theme flash on reload (FOUC)  -  index.html + app.js
`data-theme="dark"` is hard-coded in the markup, so a visitor with saved
`light` repaints dark→light after `app.js` boots (`initTheme`). Fix is a tiny
pre-paint inline script in `<head>` reading `localStorage` before stylesheets
paint. DOM-harness tests still pass (sandbox provides `localStorage`; script is
inline so the nonlocal-src guard is unaffected).

### [must] Wake "min" callout labeled the wall row as the deficit  -  app.js:709-712 (pre-fix)
`renderWakeChart` picked the global minimum of the rake, but rows j=0 and
j=91 are no-slip walls with u=0, so the "min 0.000" dot was pinned to the top
wall instead of the actual wake deficit (mid-channel). That is a wrong data
annotation on a measurement figure. **Fix:** exclude wall rows (`m===0`,
`m===samples.length-1`) and solid cells before taking the minimum. Verified in
screenshots: callout now rides the deficit lobe (`min 0.019` at j≈46 region).

### [should] "Inflow speed u 0"  -  control label split by flex layout  -  index.html:71 + style.css:280-289
`.control-field > label` is `display:flex; justify-content:space-between`, so
the bare text node `Inflow speed u<sub>0</sub>` and the `<output>` became two
flex items: the subscript `0` rendered at the horizontal center of the label
("Inflow speed u&nbsp;&nbsp;&nbsp;0 ... 0.080") at every width. **Fix:** wrap
the caption in a `<span>`; `sub { line-height: 0 }` keeps the line box tight.

### [should] Telemetry strip orphaned its 6th cell  -  style.css:327-331
`.telemetry-strip` declared `repeat(5, ...)` but the markup has **six** cells;
the Strouhal cell wrapped onto a stretched, left-alone second row (baseline
screenshots). **Fix:** 6-column track, with 3-col at ≤1100px and 2-col at
≤800px breakpoints. Verified at 1440 and 390.

### [should] Formula boxes clipped mid-token  -  style.css:810-822 + sub/sup line boxes
`.formula` is `white-space:nowrap; overflow-x:auto`; combined with default
`sub/sup` line-height inflation, A.1 and A.3 formulas rendered past the panel
edge with no scroll affordance ("f_i(x + c_iΔt, t + Δt) = f_i(x, t) + ω [f_i(x"
cut mid-token at 1440). **Fix:** `sub, sup { line-height: 0 }` compacts the
line box; verified complete formulas visible at 1440 and 390 (dark theme
screenshots).

### [should] Force-chart end labels collided  -  app.js (renderForceChart)
When Cd and Cl converge, the two end-value labels overlap and become
unreadable ("0.48/0.48", "-0.35/-0.69" in baseline screenshots). **Fix:**
series order reserves label slots with ≥14 px separation, clamped to the plot
area. Verified: "0.52" / "1.09" render separately.

### [should] Per-frame GC churn in `scaleLimit`  -  app.js:158-168
Every rendered frame allocated a fresh ~20k-element `Array` and sorted it with
a comparator (also a non-default sort). **Fix:** module-level `Float64Array`
scratch reused across frames; typed-array sort is numeric by default; NaNs are
skipped defensively. 132/132 still green; renders identical.

## Deferred (with reason)

- **[nit] Dead CSS hooks** `.report-id`/`.report-sub` (style.css:167-178) have
  no matching markup  -  harmless design-system slack; removing risks nothing
  but gains nothing.
- **[nit] Closed-`<details>` tables appear in overflow enumerators at 390**
  (`TABLE#wakeTable right=507`). Probed via CDP: `details.open === false` yet
  Chrome lays out the table inside its `overflow-x:auto` scroll container;
  page `scrollWidth` = `clientWidth` = 390 (no visible overflow, nothing
  scrollable while closed). Enumerator false positive; no code change
  warranted. Mitigated as a lint on the harness side, not the app.
- **[nit] `video/steps.json` choreography file absent**  -  only
  `video/VIDEO_URL.txt` (YouTube link) ships, so no selector-drift replay
  check applies (task step 6: N/A).
- **Physics scope** (staircase boundary, BGK, coarse 220×92 grid) is
  disclosed honestly in README/footer and out of a polish-judge scope.

## Honesty audit of printed claims

- "Runs entirely on your device"  -  verified: zero external requests at both
  viewports (CDP network log), favicon is a data URI.
- Health strip numbers (`20,240 finite cells`, `inlet residual 4.2e-17`,
  `0 repaired nodes`, `peak Ma 0.211`) come from live `computeDiagnostics`.
- Footer "220 × 92 lattice", "182,160 populations" (checkpoint test)  -  exact.
- "Checkpoint round trip PASS: 182,160 populations restored exactly"  -  backed
  by `verifySnapshotRoundTrip` before download.
- No fabricated metrics introduced by Wave 2 fixes.

## Final verification (2026-11-20)

- `npm test` → **132 pass / 0 fail / 0 skipped** (run 3× during the pass).
- 1440×900: `consoleErrors: []`, `horizontalOverflow: false`, exit 0.
- 390×844: `consoleErrors: []`, `horizontalOverflow: false`, exit 0.
- Light theme, chart panel, math panel and mobile sections re-screenshot
  clean.

**Score: 9.4/10** (Wave 1 baseline 8.8)  -  deductions: closed-details overflow
noise, absent steps.json choreography for the video, and the disclosed
coarse-grid physics ceiling.
