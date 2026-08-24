# Bra Auto Measure

A single-page browser tool that reads a bra technical sketch and drafts its 18
points of measure (POMs) for a technical designer to check.

Everything runs locally in the browser — the detection pass, the drafting, the
Excel and PDF export. There is no server, no API key, and no upload step: a
sketch never leaves the machine it was opened on.

**[Try it →](https://adrian9596.github.io/bra-sketch-annotation-tool/)**

> This repository is the public mirror of the app. The sketch fixtures, ground
> truth, measurement library, and internal design docs stay in the private
> working repo — see [What isn't here](#what-isnt-here).

## How it works

The app is **auto-first**. A fresh sketch always boots into Auto Mode, and the
whole design bets on making that first pass good enough to correct rather than
redo.

**1 · Detect.** Offline computer vision segments the ink, finds how many garment
views are on the sheet and which is front / back / inside, then locates the
landmarks a pattern maker would point at — band, chest, cradle seams, cup edges,
strap joins, apex. OpenCV compiled to WebAssembly does the heavy lifting when it
finishes loading; a dependency-free fallback keeps detection deterministic when
it hasn't.

**2 · Anchors.** Those landmarks become draggable pins, stored in normalized
`[0,1]` image space so they survive pan, zoom, resize, and save. A pin in the
wrong place is one drag away from right — and that correction is the whole
point, because it is far cheaper than redrawing a line.

**3 · Generate.** The 18 POM lines are drafted from the anchor positions and
applied. Where the evidence isn't good enough for a reliable line, the row is
marked review-only rather than guessed — a wrong number that looks confident is
worse than a blank one. The app then hands off to Manual Mode so the designer
can fix what auto couldn't.

From there: a measurements panel with a graded size run, three tech-pack pages
(main page, construction callouts, BOM), and export to `.xlsx` / PDF / clipboard
PNG — all still offline.

Manual Mode also includes a browser-local **Personal Sketch Library**. Save a
multi-path detail such as a back wing as one reusable Template, or apply an
editable layered Line Treatment such as Binding along any existing straight or
curved path. Templates and Treatments remain sketch elements rather than POMs,
and the library can be moved between browsers with JSON export/import.

Press **Cmd/Ctrl+K** anywhere to search every stable command. Use
**Cmd/Ctrl+1…5** to switch Board, Main Page, Construction, BOM, and Preview &
Export; existing Board drawing shortcuts stay scoped to the Board.

## Run it locally

```sh
npm run serve
```

Then open the printed URL. There is no build step to run first — `app.js` is
committed.

If you edit anything under `src/`:

```sh
npm run build   # regenerate app.js  (required — see Code layout)
npm run check   # read-only validation; fails if you forgot the build
```

### Tests

These pass in this repository:

```sh
npm run check              # build freshness, syntax, wiring, shared-scope gates
npm run pipeline-tests     # detection pipeline stages
npm run junction-tests     # skeleton topology / junction detection
npm run export-xlsx        # Excel export, byte-level
npm run export-hidden      # hidden-POM export behaviour
npm run suggestions-tests  # library-value suggestion layer
npm run autosave-check     # crash-safe autosave and restore
npm run curve-polyline-tests # multi-anchor curve sampling accuracy
npm run keyboard-shortcuts-check # command palette and five-page keyboard access
npm run board-shape-check    # Board Graphics, Edit Path, Cut Path, ownership
npm run board-toolbar-check  # Board toolbar states and responsive layout
npm run mainpage-check     # tech-pack MAIN PAGE sheet
npm run construction-check # construction annotation page
npm run bom-check          # BOM page
npm run preview-check      # preview & export tab
npm run line-presets-check # line looks, Treatments, and measurement isolation
npm run shape-stamps-check # Templates: grouped reusable path geometry
npm run personal-library-check # Templates + layered Treatments + local persistence
```

The suites that score detection accuracy against real sketches — `golden`,
`accuracy`, `contract`, `invariants`, `smoke`,
`board-interaction-check`, and the per-POM limitation guards — need the sketch
fixtures, which aren't published here. They run in the private repo.

## Code layout

`index.html` holds the layout and CSS. `app.js` holds all the logic — and it is
**generated**, not written: `npm run build` concatenates ~150 single-concern
files from `src/` in the order declared in `scripts/source-parts.mjs`, inlining
the rule JSON. **Edit `src/*` and rebuild; never edit `app.js` directly**, or
your change is overwritten on the next build.

| Directory | What lives there |
|---|---|
| `auto/detect/` | The detection pipeline: ink mask, view boxes, segmentation, geometry, the per-feature landmark finders, and the two heavily-tuned seam detectors |
| `auto/anchors/` | Turning detected landmarks into draggable anchors, then deriving and dragging them |
| `auto/drafts/` | Anchors → the 18 POM rows → drafts → applied lines |
| `auto/learning/` | The optional, local-only calibration and evidence stores |
| `manual/` | The Manual-Mode input stack: selection, pointer events, touch, tools, shortcuts |
| `render/` | The canvas draw loop, overlays, and the PDF / Excel exporters |
| `ui/` | The measurements panel, the tech-pack pages, and every dialog |
| `project/` | Save / open / autosave / undo history / the project library |

The 18 POMs and the anchor schema are a versioned contract in
`auto_mode_rules/*.json`. The learning layer only biases where anchors start —
it never edits that JSON.

### One shared scope

Every part is concatenated into a single IIFE, so all top-level declarations
share one scope with no module boundary. That is why a bare cross-file call
works with no import. Two rules follow, and `npm run check` enforces both,
because neither is a syntax error:

- **One declaration per name, bundle-wide.** Two `function foo(){}` in different
  files is legal JS — the later silently replaces the earlier for *every*
  caller, so editing one copy appears to do nothing.
- **Anything called across files stays a `function` declaration.** Those hoist
  across the whole bundle; `const foo = () => {}` does not, and a load-time read
  of one throws a `ReferenceError`.

## What isn't here

This mirror deliberately excludes, and always will:

- **`demo/`** — real brand sketches used as test fixtures
- **`scripts/golden/`, `scripts/groundtruth/`** — baseline outputs and
  designer-labelled ground truth derived from them
- **`library/`** — the measurement library mined from historical production data
- **`docs/`** and the internal design docs — architecture notes, decision
  records, and story packets

The app itself is complete: what's published runs, builds, and exports exactly
as it does internally.
