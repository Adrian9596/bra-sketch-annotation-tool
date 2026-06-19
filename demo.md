# Auto Mode — current demo

This walkthrough verifies the current Auto Mode flow: local sketch detection, anchor review, 16-POM draft generation, TD approval, atomic apply, and save/reopen.

## Demo assets

- Primary sketch: `demo/demo1.jpg`
- Alternate sketches: `demo/demo2.jpg`, `demo/demo3.jpg`, `demo/demo4.jpg`, `demo/demo5.jpg`
- Saved project fixture: `demo/demo1-project.json`

The production path is `Detect Sketch → Generate POM Drafts`.

## 0. Pre-flight

1. Open `index.html` in Chrome or Safari.
2. Confirm the toolbar shows **Manual / Auto**, with **Manual** active.
3. Confirm Auto Mode actions are hidden until **Auto** is selected.

Pass: the app opens in Manual Mode and the existing drawing workflow still works.

## 1. Manual Mode regression check

1. Add or drag `demo/demo2.jpg` onto the board.
2. Press **L** or **0** and draw a straight line.
3. Press **C** or **B** and draw a curved line.
4. Press **S**, select a line, then delete it.
5. Use undo/redo.
6. Clear the board.

Pass: image loading, straight/curved drawing, select, delete, clear, undo/redo, fit, labels, and panel toggles still work.

## 2. Detect a sketch

1. Add `demo/demo1.jpg`.
2. Select **Auto**.
3. Click **Detect Sketch**.

Expected:

- Status changes through detecting to detected.
- The detection overlay shows the sketch bounds, view boxes, axis, band/chest/cradle guides, and detected feature markers where available.
- Anchor handles are seeded on the sketch.
- No project annotation is added yet.

Pass: `state.annotations` is unchanged and `state.autoMode.anchors` contains reviewable anchors.

## 3. Review anchors and generate drafts

1. Drag any anchor that is visibly wrong.
2. Use **Reset Anchors** only if you want to discard manual anchor edits and re-seed from the current detection.
3. Click **Generate POM Drafts**.

Expected:

- The Measurements panel shows 16 Auto Mode draft rows.
- Drafts render above project annotations in the draft layer.
- Rows show confidence and drawability state: `DRAWABLE`, `APPROXIMATE`, or `REVIEW_ONLY`.

Pass: 16 POM rows are produced or unsafe rows are explicitly marked review-only.

## 4. TD review

For each draft:

1. Select the row or line.
2. Move endpoints or curve handles if needed.
3. Click **Approve** for final geometry, or **Mark Review-Only** when the row should stay informational and not draw a line.
4. Use **Approve high-confidence** or **Approve all** from the draft review header when the generated set has been visually checked.

Pass: edited rows require approval before apply, review-only rows do not draw final geometry, and project annotations remain locked while Auto Mode is active.

## 5. Atomic apply

1. Approve at least one draft.
2. Click **Apply Approved Lines**.

Expected:

- Approved drafts move into `state.annotations`.
- Unapproved drafts remain in the draft layer.
- Applied annotations include Auto Mode metadata: `auto`, `sourceMode`, `sourceImageId`, `autoRunId`, `templateVersion`, `ruleVersion`, `confidence`, `drawability`, `tdApproved`, and source landmarks.
- If Auto-applied rows for the same POM/image already exist, apply is blocked with one summarized conflict message.

Pass: apply is all-or-nothing for the approved set. Failed apply does not partially change the project.

## 6. Exit guard

1. Leave some drafts unapplied.
2. Click **Manual** or try to open another project.

Expected:

- The guard asks whether to stay, discard drafts, or apply approved lines.
- Opening another file cannot silently wipe drafts.

Pass: no draft state is lost without an explicit choice.

## 7. Save and reopen

1. Apply at least one approved draft.
2. Save the project JSON.
3. Reload the page and reopen the saved JSON.

Expected:

- Applied Auto Mode annotations reload as normal project annotations with metadata preserved.
- Unapplied drafts are not saved.
- Older projects without Auto Mode metadata still open.

Pass: save/reopen preserves final approved work and does not require the draft layer.

## 8. Automated smoke check

Run the headless smoke/benchmark helper from this folder:

```sh
node scripts/auto-mode-smoke.mjs
```

Expected:

- 16 draft rows are generated from `demo/demo1.jpg`.
- validation returns no errors;
- review-only rows are not approved;
- drawable rows apply atomically;
- saved/reopened Auto Mode annotations keep required metadata.

Pass: the command prints `"status": "pass"` and exits with code 0.

## 8. Automated smoke helper

For quick local smoke testing, open the tool with:

```text
index.html?autoDraft=1
```

The helper drives the current path automatically: enter Auto Mode, detect the current/first image, generate POM drafts, and hand off to Manual Mode after approved application when possible.

## Sign-off checklist

- [ ] Manual mode regression passes.
- [ ] Detect Sketch produces anchors on the selected image.
- [ ] Reset Anchors re-seeds from current detection.
- [ ] Generate POM Drafts creates the 16 fixed POM rows.
- [ ] Edited rows require approval before apply.
- [ ] Review-only rows do not become project annotations.
- [ ] Apply Approved Lines is atomic.
- [ ] Duplicate Auto-applied rows are blocked with a summarized message.
- [ ] Exit/open guard protects unapplied drafts.
- [ ] Save/reopen preserves applied Auto Mode metadata.
