# How to Measure project status

Updated: 2026-06-18

## What is done so far

### Manual annotation tool

- Image add, paste, drag/drop, select, move, scale, pan, and zoom.
- PPTX sketch import.
- Straight and curved measurement lines.
- Select, delete, erase, clear, undo/redo.
- Editable POM labels and side measurement table.
- POM mode and stitch/production-diagram mode.
- JSON save/open with image and annotation state.
- Older project JSON compatibility.

### Auto Mode workflow

- Manual / Auto top-level mode switch.
- Manual annotations stay visible but locked in Auto Mode.
- Auto Mode uses the selected image, otherwise the first image on the board.
- Detect Sketch runs local offline vision; no cloud/API dependency.
- Detection seeds editable anchors.
- Reset Anchors re-seeds anchors from current detection.
- Generate POM Drafts creates the fixed 16-POM draft set from current anchors.
- Drafts remain separate from final project annotations.
- TD can edit, approve, bulk-approve, mark review-only, apply, or discard drafts.
- Draft-review bulk controls support Approve all and Approve high-confidence.
- Apply Approved Lines is atomic.
- Duplicate Auto-applied POM rows on the same image are blocked with a summarized message.
- Exit/open guard protects unapplied drafts.
- Applied Auto Mode annotations save and reopen with audit metadata.
- The app is split into `index.html` for layout, generated `app.js` for browser loading, and editable `src/*.js` source parts for state, manual tools, Auto detection, Auto drafts, and rendering.
- Fixed POM/rule/anchor data lives in `auto_mode_rules.js`, separate from app behavior.
- `npm run serve` starts a local static server; `npm run check` runs syntax/wiring checks.
- `scripts/auto-mode-smoke.mjs` runs a headless Auto Mode smoke check against demo imagery.

### Detection improvements already added

- Ink-mask analysis with OpenCV helper when available.
- In-browser fallback detector.
- Connected-component cleanup.
- View box grouping and front/back classification.
- Band, chest, cradle, apex, inner-cup, side-seam, back-strap, and back-panel signals.
- Optional Potrace contour tracing for curved landmarks.
- Anchor confidence tiers.
- Cross-view awareness for lines spanning front/back areas.

### Review/data hub

- The separate review_tool hub remains the cross-style measurement browser.
- Pipeline scripts still build measurement libraries, construction profiles, selected POMs, factory drafts, review reports, and the master review_tool/index.html.
- Size L remains the only populated production size; 3D-L remains excluded.

## Current production workflow

1. Add or select a sketch image.
2. Switch to Auto Mode.
3. Click Detect Sketch.
4. Adjust anchors if needed.
5. Click Generate POM Drafts.
6. Edit/approve/review-only draft rows.
7. Click Apply Approved Lines.
8. Save project JSON.

## Current open work

- Label collision avoidance for dense POM groups.
- Better measurement-panel readability for long descriptions.
- Lower-density Auto Mode toolbar layout.
- Visible confidence/drawability after apply.
- Representative sketch benchmark and per-POM accepted-without-edit tracking.

## Cleanup completed in this update

- Replaced obsolete workflow docs with current Auto Mode notes.
- Removed obsolete workflow labels from the live Auto Mode metadata strings.
- Fixed a legacy fallback detector bug.
- Removed generated/system cruft that should not be treated as project data.
- Updated stale bulk-approval status across docs.
- Split fixed POM/rule/anchor data out of `index.html`.
- Added a dependency-free headless smoke/benchmark runner.
- Split the main inline app script out of `index.html` into `app.js`.
- Added dependency-free local run/check commands.
- Shared the local static-server helper between serve and smoke tooling.
- Split generated `app.js` source into `src/state.js`, `src/manual-tools.js`, `src/auto-detection.js`, `src/auto-drafts.js`, and `src/rendering.js`.
- Added `npm run build` to regenerate `app.js` from the source parts.
