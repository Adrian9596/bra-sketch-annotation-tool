// Board text notes (US-092): the note record and the pure geometry that acts
// on it. Rendering lives in src/render/render-notes.js; pointer handling in
// src/manual/pointer-events.js.
// Source part for app.js. Run `npm run build` after editing.
//
// A note is NOT an annotation, and that separation is the point of the whole
// feature. state.annotations is the MEASUREMENT collection — the spec panel,
// the tolerance check, the grading model, the Excel table and
// state.deletedPomKeys all bucket it by getLabelText(), which falls back to
// whatever text the annotation carries. So the pre-US-092 way of writing free
// text on the board (draw a line, type into its label) turned every remark into
// a POM row and leaked it into the exported workbook. Notes live here instead,
// and nothing in the measurement path ever reads them.
//
// Coordinates are WORLD pixels, like annotations — not normalized to an owning
// image the way anchors and Construction callouts are. A note may sit in blank
// space beside the sketch, where there is no owner to normalize against. The
// cost is that the two transforms that carry board content with its photo
// (US-089 drag, US-091 resize) have to carry notes explicitly.

  // The note record. `leaders` starts empty: a new note is a plain caption, and
  // the TD adds arrows only where they mean something. Each leader is a world
  // point; the renderer draws box-edge -> point with an arrowhead and NO number
  // (unlike the Construction/BOM callouts, whose pin carries its row's seq).
  function createNote(text, pos, options) {
    const opts = options || {};
    // Older internal callers supplied only `color`. Treat that shape exactly
    // like a pre-US-100 note so tests/integrations keep their boxed, one-colour
    // pixels. The real Text tool passes all three new fields explicitly.
    const legacyOptions = opts.color != null && opts.textColor == null
      && opts.leaderColor == null && opts.appearance == null && opts.widthMode == null;
    const textColor = normalizeColorKey(opts.textColor != null
      ? opts.textColor : (opts.color != null ? opts.color : state.noteTextColor));
    const leaderColor = normalizeColorKey(opts.leaderColor != null
      ? opts.leaderColor : (legacyOptions ? textColor : state.noteLeaderColor));
    return {
      id: state.idCounter++,
      text: String(text == null ? '' : text),
      pos: { x: Number(pos && pos.x) || 0, y: Number(pos && pos.y) || 0 },
      // `color` remains as a compatibility alias for older integrations. New
      // rendering and UI use the explicit text/leader fields.
      color: textColor,
      textColor,
      leaderColor,
      appearance: normalizeNoteAppearance(opts.appearance != null
        ? opts.appearance : (legacyOptions ? NOTE_APPEARANCE_BOX : state.noteAppearance)),
      fontSize: normalizeNoteFontSize(opts.fontSize),
      boxWidth: normalizeNoteBoxWidth(opts.boxWidth),
      widthMode: normalizeNoteWidthMode(opts.widthMode,
        legacyOptions ? NOTE_WIDTH_MODE_CONTENT : NOTE_WIDTH_MODE_FIXED),
      leaders: normalizeNoteLeaders(opts.leaders),
    };
  }

  function normalizeNoteAppearance(value, fallback) {
    if (value === NOTE_APPEARANCE_BOX) return NOTE_APPEARANCE_BOX;
    if (value === NOTE_APPEARANCE_TEXT_ONLY) return NOTE_APPEARANCE_TEXT_ONLY;
    return fallback === NOTE_APPEARANCE_BOX
      ? NOTE_APPEARANCE_BOX : NOTE_APPEARANCE_TEXT_ONLY;
  }

  function normalizeNoteWidthMode(value, fallback) {
    if (value === NOTE_WIDTH_MODE_FIXED) return NOTE_WIDTH_MODE_FIXED;
    if (value === NOTE_WIDTH_MODE_CONTENT) return NOTE_WIDTH_MODE_CONTENT;
    return fallback === NOTE_WIDTH_MODE_FIXED
      ? NOTE_WIDTH_MODE_FIXED : NOTE_WIDTH_MODE_CONTENT;
  }

  // Drop anything that is not a finite point rather than trusting the caller —
  // a leader with a NaN coordinate would draw an invisible arrow and silently
  // poison getContentBounds(), cropping the whole export.
  function normalizeNoteLeaders(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(p => ({ x: Number(p && p.x), y: Number(p && p.y) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  function normalizeNoteFontSize(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) return NOTE_DEFAULT_FONT_SIZE;
    return clamp(size, NOTE_MIN_FONT_SIZE, NOTE_MAX_FONT_SIZE);
  }

  function normalizeNoteBoxWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width) || width <= 0) return NOTE_DEFAULT_BOX_WIDTH;
    return clamp(width, NOTE_MIN_BOX_WIDTH, NOTE_MAX_BOX_WIDTH);
  }

  // Coerce one record from a project file / history snapshot into the current
  // shape. Returns null for anything that cannot be placed on the board, so a
  // hand-edited or truncated file drops the bad note instead of throwing during
  // load — the same forgiveness loadProject already applies to image records
  // whose pixel data the autosave quota fallback stripped.
  function normalizeNote(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.pos && raw.pos.x);
    const y = Number(raw.pos && raw.pos.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const id = Number(raw.id);
    const hasExplicitAppearance = raw.appearance === NOTE_APPEARANCE_TEXT_ONLY
      || raw.appearance === NOTE_APPEARANCE_BOX;
    const hasExplicitColors = raw.textColor != null || raw.leaderColor != null;
    const legacy = !hasExplicitAppearance && !hasExplicitColors;
    const legacyColor = normalizeColorKey(raw.color);
    const textColor = normalizeColorKey(raw.textColor != null ? raw.textColor
      : (legacy ? legacyColor : 'black'));
    const leaderColor = normalizeColorKey(raw.leaderColor != null ? raw.leaderColor
      : (legacy ? legacyColor : 'red'));
    return {
      id: Number.isFinite(id) ? id : state.idCounter++,
      text: String(raw.text == null ? '' : raw.text),
      pos: { x, y },
      color: textColor,
      textColor,
      leaderColor,
      // Pre-US-100 notes were visibly boxed and used one colour for everything.
      // Preserve those pixels; only newly-authored notes default Text-only.
      appearance: normalizeNoteAppearance(raw.appearance,
        legacy ? NOTE_APPEARANCE_BOX : NOTE_APPEARANCE_TEXT_ONLY),
      fontSize: normalizeNoteFontSize(raw.fontSize),
      boxWidth: normalizeNoteBoxWidth(raw.boxWidth),
      // Legacy `boxWidth` was a wrap ceiling and the painted box shrink-wrapped
      // to content. Keep that until the TD explicitly drags the width handle.
      widthMode: normalizeNoteWidthMode(raw.widthMode,
        legacy ? NOTE_WIDTH_MODE_CONTENT : NOTE_WIDTH_MODE_FIXED),
      leaders: normalizeNoteLeaders(raw.leaders),
    };
  }

  function noteTextColorOf(note) {
    return normalizeColorKey(note && note.textColor != null ? note.textColor : note && note.color);
  }

  function noteLeaderColorOf(note) {
    return normalizeColorKey(note && note.leaderColor != null
      ? note.leaderColor : (note && note.color != null ? note.color : 'red'));
  }

  function noteAppearanceOf(note) {
    return normalizeNoteAppearance(note && note.appearance, NOTE_APPEARANCE_BOX);
  }

  function noteWidthModeOf(note) {
    return normalizeNoteWidthMode(note && note.widthMode, NOTE_WIDTH_MODE_CONTENT);
  }

  function getNoteById(id) {
    return (state.notes || []).find(note => note.id === id) || null;
  }

  // ---- Geometry -----------------------------------------------------------
  // Every size below is in WORLD units, derived from the note's own fontSize —
  // deliberately NOT divided by featureZoom() the way POM lines and callout
  // numbers are. Those are review chrome and must hold a constant SCREEN size;
  // a note is part of the drawing, so it scales with the sketch, and every
  // export path then reproduces it correctly with no special casing.

  function noteFontSpec(note) {
    return '500 ' + noteFontSizeOf(note) + 'px system-ui, -apple-system, sans-serif';
  }

  function noteFontSizeOf(note) {
    return normalizeNoteFontSize(note && note.fontSize);
  }

  function noteLineHeight(note) {
    return noteFontSizeOf(note) * NOTE_LINE_HEIGHT_RATIO;
  }

  function notePadding(note) {
    return noteFontSizeOf(note) * NOTE_PADDING_RATIO;
  }

  // Greedy word wrap at the note's boxWidth. Explicit newlines are kept — a TD
  // typing a two-line instruction gets two lines. A blank line stays blank
  // rather than collapsing, so paragraph spacing survives the round trip.
  function wrapNoteLines(note) {
    const text = String(note && note.text != null ? note.text : '');
    const maxWidth = normalizeNoteBoxWidth(note && note.boxWidth) - notePadding(note) * 2;
    const lines = [];
    ctx.save();
    ctx.font = noteFontSpec(note);
    for (const paragraph of text.split('\n')) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const word of words) {
        const next = line ? line + ' ' + word : word;
        if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
        else line = next;
      }
      lines.push(line);
    }
    ctx.restore();
    return lines.length ? lines : [''];
  }

  // The note's text box in world coordinates. US-100 notes use boxWidth as a
  // real wrap-width boundary; legacy notes remain content-width until a TD
  // explicitly resizes them. pos is its TOP-LEFT corner.
  function noteBounds(note) {
    if (!note || !note.pos) return null;
    const lines = wrapNoteLines(note);
    const pad = notePadding(note);
    const fontSize = noteFontSizeOf(note);
    let widest = 0;
    ctx.save();
    ctx.font = noteFontSpec(note);
    for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
    ctx.restore();
    // An empty note still needs a body: it has to stay visible and grabbable.
    const inner = Math.max(widest, fontSize * 1.6);
    const contentWidth = inner + pad * 2;
    return {
      x: note.pos.x,
      y: note.pos.y,
      width: noteWidthModeOf(note) === NOTE_WIDTH_MODE_FIXED
        ? normalizeNoteBoxWidth(note.boxWidth) : contentWidth,
      height: lines.length * noteLineHeight(note) + pad * 2,
      contentWidth,
      lines,
    };
  }

  // Text-only notes have no painted rectangle, so their broad empty wrap area
  // must not steal clicks or inflate export bounds. Box notes own the full box.
  function noteVisibleBounds(note, box) {
    const bounds = box || noteBounds(note);
    if (!bounds) return null;
    return {
      x: bounds.x,
      y: bounds.y,
      width: noteAppearanceOf(note) === NOTE_APPEARANCE_BOX
        ? bounds.width : Math.min(bounds.width, bounds.contentWidth || bounds.width),
      height: bounds.height,
    };
  }

  // Box plus every leader tip — what the export frame has to contain, and what
  // a "does this note fit on the page" question is really asking.
  function noteOuterBounds(note) {
    const box = noteBounds(note);
    if (!box) return null;
    const visible = noteVisibleBounds(note, box);
    let minX = visible.x, minY = visible.y;
    let maxX = visible.x + visible.width, maxY = visible.y + visible.height;
    for (const leader of (note.leaders || [])) {
      minX = Math.min(minX, leader.x);
      minY = Math.min(minY, leader.y);
      maxX = Math.max(maxX, leader.x);
      maxY = Math.max(maxY, leader.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // Where a leader leaves the box: the point on the box's edge facing the
  // target, so the line starts at the border instead of under the text. Same
  // idea as the Construction engine's ccEdgeToward, kept separate on purpose
  // (ADR 0041 — those callout engines stay parallel forks, not shared code).
  function noteEdgeToward(box, target) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const dx = target.x - cx;
    const dy = target.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const tx = dx ? (box.width / 2) / Math.abs(dx) : Infinity;
    const ty = dy ? (box.height / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty, 1);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  // US-092 step 6: where the "pull a new arrow out of here" handle sits — just
  // outside the box's bottom-right corner, at a constant SCREEN offset so it is
  // reachable at any zoom and never covers the text. Deliberately OUTSIDE the
  // box, not on its corner: the real width-resize handle is at the right-edge
  // midpoint, while this lower-right control is reserved for Add Leader.
  function noteLeaderAddHandle(note) {
    const box = noteBounds(note);
    if (!box) return null;
    const off = 9 / state.zoom;
    return { x: box.x + box.width + off, y: box.y + box.height + off };
  }

  function noteResizeHandle(note) {
    const box = noteBounds(note);
    if (!box) return null;
    return { x: box.x + box.width, y: box.y + box.height / 2 };
  }

  // Move the note and everything attached to it. Leaders are absolute world
  // points, so they travel with the box rather than staying pinned to the
  // sketch — a note dragged aside keeps pointing at the same relative spot,
  // which is what "move the whole callout" means to a TD.
  function moveNote(note, dx, dy) {
    if (!note || !dx && !dy) return;
    note.pos.x += dx;
    note.pos.y += dy;
    for (const leader of note.leaders || []) {
      leader.x += dx;
      leader.y += dy;
    }
  }

  // Scale a note about `origin` by `factor` — the photo-resize path (US-091).
  // Position, leader targets, type size and wrap width all scale together, so
  // the note keeps its size and place relative to the garment it annotates.
  function scaleNoteAbout(note, origin, factor) {
    if (!note || !origin) return;
    if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-9) return;
    note.pos.x = origin.x + (note.pos.x - origin.x) * factor;
    note.pos.y = origin.y + (note.pos.y - origin.y) * factor;
    for (const leader of note.leaders || []) {
      leader.x = origin.x + (leader.x - origin.x) * factor;
      leader.y = origin.y + (leader.y - origin.y) * factor;
    }
    note.fontSize = normalizeNoteFontSize(note.fontSize * factor);
    note.boxWidth = normalizeNoteBoxWidth(note.boxWidth * factor);
  }
