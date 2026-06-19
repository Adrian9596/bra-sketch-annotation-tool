# Bra Measurement Assistant

Local annotation and Auto Mode drafting app for bra technical sketches.

## Run

```sh
npm run serve
```

Then open the printed local URL.

## Check

```sh
npm run check
```

This rebuilds `app.js`, verifies JavaScript syntax, required script wiring, and confirms the app/debug/rule files are present.

## Smoke test Auto Mode

```sh
npm run smoke
```

The smoke test opens the app in headless Chrome, runs Auto Mode on `demo/demo1.jpg`, generates 16 POM drafts, bulk-approves drawable drafts, applies them, exports a project snapshot, reloads it, and verifies required metadata survived.

## Code layout

- `index.html` — HTML/CSS layout and script includes.
- `app.js` — generated browser bundle. Do not edit directly.
- `src/state.js` — constants, DOM handles, app state, initialization, URL demo bootstrap.
- `src/manual-tools.js` — manual annotation tools, imports, save/open, measurement panel, history, selection, geometry helpers.
- `src/auto-detection.js` — Auto Mode boundaries, offline sketch detection, feature extraction, anchor seeding/dragging.
- `src/auto-drafts.js` — POM draft generation, TD review actions, apply/discard/reset behavior, debug hooks.
- `src/rendering.js` — canvas rendering, export rendering, hit testing, drawing primitives, math helpers.
- `auto_mode_rules.js` — fixed POM template, POM pairings, anchor schema, and rule versions.
- `opencv_free_api.js` / `opencv_real_api.js` — local/free and real OpenCV adapters.
- `potrace.js` — optional contour tracing helper.
- `scripts/build-app.mjs` — builds `app.js` from `src/*.js`.
- `scripts/serve.mjs` — dependency-free local static server.
- `scripts/static-server.mjs` — shared static-server helper used by local serve and smoke tests.
- `scripts/check.mjs` — dependency-free syntax/wiring check.
- `scripts/auto-mode-smoke.mjs` — headless Auto Mode smoke/benchmark runner.
