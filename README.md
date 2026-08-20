# Bra Auto Measure

Auto-first drafting tool for bra technical sketches. This is a focused fork of
the "How to measure1" Bra Measurement Assistant: the same offline detection
engine and POM drafting pipeline. The app boots straight into **Auto Mode**,
which is the priority — the auto pass detects the sketch and generates the 18
POM lines. After the lines are applied it hands off to **Manual Mode** so the
technical designer can make the small fixes auto can't get perfect. Manual is
the correction step, not a blank-canvas drawing tool, and the app never boots
into it on a fresh sketch (see
[`docs/decisions/0008-reenable-manual-mode.md`](docs/decisions/0008-reenable-manual-mode.md)).

## Documentation

- **Why / goals:** [`PROJECT_CHARTER.md`](PROJECT_CHARTER.md)
- **Architecture / project map:** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **The 18 POMs:** [`POMS_CONTRACT.md`](POMS_CONTRACT.md)
- **Tests:** [`TESTING.md`](TESTING.md)
- **Working context (agents):** [`CLAUDE.md`](CLAUDE.md) · [`AGENTS.md`](AGENTS.md)

## Workflow

1. Add a sketch image (button, paste with Ctrl/Cmd+V, or drag-drop).
2. Click **Detect** — local offline vision estimates views, landmarks, and
   seeds draggable anchors. No cloud/API dependency.
3. Drag anchors to correct them if needed (**Reset Anchors** re-seeds).
4. Click **Generate Drafts** — the 18 POM lines are generated from the anchors
   and applied to the project immediately; no per-row approval step.
   Review-only rows (no reliable line) are dropped with a note.
5. On Apply the app switches to **Manual Mode** to correct the applied lines:
   drag / reshape / relabel / delete a line, copy/paste, reflect, or **Copy
   Image** (⌘⇧C) to put the whole board on the clipboard as a PNG. The
   Manual/Auto toggle returns to Auto (e.g. to re-detect).
6. **Save** the project JSON. **Open** reopens a project with applied lines in
   Manual Mode, ready to edit.

The Approve / Review-Only / Apply Lines / Discard controls only come into play
when an apply fails (e.g. duplicate POM rows on the same image): the drafts then
stay on the board for row-by-row resolution.

## Run

```sh
npm run serve
```

Then open the printed local URL.

## Check

```sh
npm run check   # read-only: build freshness + syntax/wiring + shared-scope gates
npm run smoke   # headless end-to-end Auto Mode run on demo/demo1.jpg
npm run library-l0-tests # governed library contracts, schemas, fingerprints
```

`check` never writes `app.js` — run `npm run build` yourself after editing
`src/*`, or `check` will fail with a stale-build error (that is the point).

Other suites: `golden`, `accuracy`, `invariants`, `contract`, `pipeline-tests`,
`junction-tests`, `learning-tests`, `evidence-tests`, `autosave-check`,
`pom6/7/14-limitations`, `viewrole-limitations`, plus the tech-pack page suites
`mainpage-check`, `construction-check`, `bom-check`, `preview-check`,
`board-toolbar-check`. See [`TESTING.md`](TESTING.md).

## Auto vs. Manual Mode

The tool is **Auto-first**: a fresh sketch always boots into Auto Mode, and the
roadmap invests in making the auto pass better. **Manual Mode** is the bounded
correction step that follows the auto Apply — it is not a fresh-load entry
point and not a general drawing tool.

Manual controls carry the `manual-only` class and are hidden only while in Auto
(`index.html` scopes the rule to `body.app-auto`); they reveal after the
post-Apply handoff or via the Manual/Auto toggle. Available in Manual: line edit
(drag/reshape/relabel/delete), undo/redo, copy/paste, reflect, clear, lock,
styles, Hide Numbers, Export PDF, Copy Image, and Help. The Manual/Auto toggle
is visible in both modes.

## Code layout

`index.html` is layout/CSS; `app.js` is **generated** by concatenating ~150
single-concern parts under `src/`, in the order declared in
`scripts/source-parts.mjs`. **Edit `src/*`, then `npm run build` — never edit
`app.js` directly.** Fixed POM/rule/anchor data lives in `auto_mode_rules/*.json`.

Roughly, `src/` is grouped by role:

| Directory | What lives there |
|---|---|
| `auto/detect/` | The detection pipeline: ink mask, view boxes, segmentation, geometry, the per-feature landmark finders, and the POM 6 / POM 7 seam detectors |
| `auto/anchors/` | Seeding those landmarks into draggable anchors, then deriving/dragging them |
| `auto/drafts/` | Anchors → the 18 POM rows → drafts → applied lines |
| `auto/learning/` | The optional local calibration / meaning / style-evidence stores |
| `manual/` | The Manual-Mode input stack: selection, pointer events, touch, tools, shortcuts |
| `render/` | The canvas draw loop, overlays, and the PDF / Excel exporters |
| `ui/` | The measurements panel, the tech-pack pages (MAIN PAGE, Construction, BOM, Preview), and every dialog |
| `project/` | Save / open / autosave / undo history / the project library |

Because every part is concatenated into **one shared scope**, two rules apply
when moving code: keep one declaration per name bundle-wide, and keep anything
called across files a `function` declaration (it hoists; `const` arrows do not).
`npm run check` enforces both. Full map and rationale in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Harness

This repo uses [Harness](https://github.com/hoangnb24/repository-harness) — an
agent-operating layer that gives coding agents project context, feature intake,
story packets, a validation matrix, and decision records before they touch code.

- Agents start at [`AGENTS.md`](AGENTS.md) and [`docs/HARNESS.md`](docs/HARNESS.md).
- Work is classified via [`docs/FEATURE_INTAKE.md`](docs/FEATURE_INTAKE.md)
  (tiny / normal / high-risk lanes).
- Product truth, stories, decisions, and templates live under [`docs/`](docs/README.md).
- Operational state (intake, stories, traces, matrix) is managed by the Rust
  Harness CLI at `scripts/bin/harness-cli`, backed by a local `harness.db`.
- If the CLI binary is absent, agents use [`docs/TEST_MATRIX.md`](docs/TEST_MATRIX.md)
  as the fallback proof map and report that durable intake/trace rows were not
  recorded.

The Harness CLI binary is not committed. Install it (and refresh any harness
files) with:

```sh
curl -fsSL "https://raw.githubusercontent.com/hoangnb24/repository-harness/main/scripts/install-harness.sh?$(date +%s)" | bash -s -- --merge --claude --yes
```

Then initialize the durable layer:

```sh
scripts/bin/harness-cli init
```

The installer executes a remote script. In restricted environments, inspect or
run it outside the sandbox with explicit human approval, then return here and
run `scripts/bin/harness-cli query matrix`.
