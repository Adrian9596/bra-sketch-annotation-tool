// Board text note drawing (US-092). The record and its geometry live in
// src/manual/note-model.js; this file only paints.
// Source part for app.js. Run `npm run build` after editing.
//
// Everything here is drawn in WORLD coordinates and sized off the note's own
// fontSize, so it scales with the sketch the way ink does. That is what makes
// the export paths free: copy-image and export-pdf redirect the global ctx and
// re-run this same code, with no featureZoom() compensation of the kind the POM
// lines and callout numbers need (they hold a constant SCREEN size, notes do
// not — see noteFontSpec).
//
// A leader is a line plus an arrowhead and NOTHING else. The Construction and
// BOM callouts put a filled disc carrying the row's sequence number at the
// target; a Board note belongs to no table and has no number, and the TD asked
// for the arrow without it.

  function drawNote(note) {
    const box = noteBounds(note);
    if (!box) return;
    const textColor = LINE_COLORS[noteTextColorOf(note)] || '#111827';
    const leaderColor = LINE_COLORS[noteLeaderColorOf(note)] || LINE_COLOR;
    const fontSize = noteFontSizeOf(note);
    const leaderBox = noteVisibleBounds(note, box);

    ctx.save();
    for (const leader of (note.leaders || [])) drawNoteLeader(leaderBox, leader, leaderColor, fontSize);
    if (noteAppearanceOf(note) === NOTE_APPEARANCE_BOX) {
      drawNoteBox(box, textColor, fontSize, noteGroundFill(textColor));
    }
    drawNoteText(note, box, textColor, fontSize);
    ctx.restore();
  }

  // White is a first-class board colour — the toolbar swatch says "White line
  // (for dark sketch areas)" — and a white note on the default white ground is
  // an EMPTY BOX: measured, 0 non-white pixels where the text should be. So a
  // white note inverts: dark chip, white text. drawLabel in render-annotations.js
  // solves the same problem for POM numbers with a dark halo; a note has a real
  // ground to work with, so flipping the ground is cleaner than outlining every
  // glyph, and it keeps the border (drawn in the note's own colour) visible too.
  function noteGroundFill(color) {
    return String(color).toLowerCase() === '#ffffff'
      ? 'rgba(17,24,39,0.92)'
      : 'rgba(255,255,255,0.92)';
  }

  function drawNoteLeader(box, target, color, fontSize) {
    const from = noteEdgeToward(box, target);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, fontSize * 0.09);
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    const angle = Math.atan2(target.y - from.y, target.x - from.x);
    drawArrowhead(target, angle, fontSize * 0.5, color);
    ctx.restore();
  }

  // White ground so the text stays legible over sketch ink, plus a faint border
  // in the note's own colour. Without the border a note over the white page has
  // no edge at all, and the TD cannot see what a click will grab or where a
  // leader starts.
  function drawNoteBox(box, color, fontSize, groundFill) {
    ctx.save();
    ctx.fillStyle = groundFill;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.globalAlpha = 0.38;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.5, fontSize * 0.055);
    ctx.setLineDash([]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.restore();
  }

  // Selection chrome (US-092, step 5). Deliberately the same dashed
  // SELECT_COLOR outline the photo selection uses, at a constant SCREEN width
  // and dash length so it reads identically at any zoom — the note's own ink
  // scales with the board, but this is review chrome and must not. It sits a
  // few pixels OUTSIDE the box so it never covers the first line of text.
  //
  // Never called from the export paths: drawBoardContentForExport draws bodies,
  // not selection helpers, so a selected note exports clean.
  function drawNoteSelection(note) {
    const box = noteBounds(note);
    if (!box) return;
    const pad = 3 / state.zoom;
    ctx.save();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = SELECT_COLOR;
    ctx.setLineDash([8 / state.zoom, 5 / state.zoom]);
    ctx.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2);
    ctx.restore();
    // Step 6: a grab handle on each arrow's tip, and the one that pulls a new
    // arrow out. Drawn only here, so they exist exactly where they are
    // grabbable — hitTestSelectedNoteHandles is selected-only for the same
    // reason.
    for (const leader of (note.leaders || [])) drawNoteLeaderHandle(leader);
    const resize = noteResizeHandle(note);
    if (resize) drawNoteResizeHandle(resize);
    const add = noteLeaderAddHandle(note);
    if (add) drawNoteLeaderAddHandle(add);
  }

  function drawNoteResizeHandle(point) {
    const half = 5.5 / state.zoom;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 2 / state.zoom;
    ctx.setLineDash([]);
    ctx.fillRect(point.x - half, point.y - half, half * 2, half * 2);
    ctx.strokeRect(point.x - half, point.y - half, half * 2, half * 2);
    ctx.restore();
  }

  // Hollow, like the photo's resize handles: it marks a point you can pick up.
  function drawNoteLeaderHandle(point) {
    const r = 5.5 / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = SELECT_COLOR;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.restore();
  }

  // Filled with a white plus: this one MAKES something rather than moving
  // something, and it sits where a rectangle's corner handle would, so it has
  // to say "add" clearly enough not to be confused with the separate
  // right-edge width handle.
  function drawNoteLeaderAddHandle(point) {
    const r = 7 / state.zoom;
    const arm = 3.4 / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = SELECT_COLOR;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.8 / state.zoom;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(point.x - arm, point.y);
    ctx.lineTo(point.x + arm, point.y);
    ctx.moveTo(point.x, point.y - arm);
    ctx.lineTo(point.x, point.y + arm);
    ctx.stroke();
    ctx.restore();
  }

  // The arrows of a note that is open in the editor. The box and text are
  // skipped there (the textarea is showing them live), but the arrows are not
  // chrome — they say what the note is pointing at, which is exactly the thing
  // the TD is looking at while deciding what to type.
  function drawNoteLeadersOnly(note) {
    const box = noteBounds(note);
    if (!box) return;
    const color = LINE_COLORS[noteLeaderColorOf(note)] || LINE_COLOR;
    const fontSize = noteFontSizeOf(note);
    const leaderBox = noteVisibleBounds(note, box);
    ctx.save();
    for (const leader of (note.leaders || [])) drawNoteLeader(leaderBox, leader, color, fontSize);
    ctx.restore();
  }

  function drawNoteText(note, box, color, fontSize) {
    const pad = notePadding(note);
    const lineHeight = noteLineHeight(note);
    ctx.save();
    ctx.font = noteFontSpec(note);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // Centre each line's glyphs inside its line box: textBaseline 'top' anchors
    // to the em box, so the leftover leading has to be split by hand or the
    // text sits high in the note.
    const offset = (lineHeight - fontSize) / 2;
    box.lines.forEach((line, index) => {
      ctx.fillText(line, box.x + pad, box.y + pad + index * lineHeight + offset);
    });
    ctx.restore();
  }
