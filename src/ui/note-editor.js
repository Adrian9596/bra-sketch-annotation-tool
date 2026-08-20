// The Board note editor (US-092): a floating <textarea> over the canvas that
// either places a NEW note where the Text tool was clicked, or re-opens an
// existing one for editing. The note record and its geometry live in
// src/manual/note-model.js; drawing in src/render/render-notes.js.
// Source part for app.js. Run `npm run build` after editing.
//
// Why not reuse #labelEditor: that one is a single-line <input> whose Enter
// COMMITS, because a POM callout label is one short token. A note is prose —
// multi-line by design — so Enter has to insert a newline, and the commit keys
// move to ⌘/Ctrl+Enter, Escape-cancels, and click-away.
//
// The one piece of real timing here is that click-away. A focus change is the
// DEFAULT ACTION of mousedown, so `blur` arrives AFTER the canvas mousedown
// handler has already run. If that same press were allowed to also place the
// next note, the sequence would be: open editor #2, then blur commits… whatever
// state.noteEditor now holds, which is #2's empty session — closing the editor
// the TD just opened. So onMouseDown commits and stops (see pointer-events.js),
// and by the time blur fires there is nothing open for it to act on. The blur
// listener still matters for every OTHER way focus can leave: a toolbar click,
// Tab, the window losing focus.

  function isNoteEditorOpen() {
    return !!state.noteEditor;
  }

  // A brand-new note is sized so it appears at the default size on SCREEN,
  // whatever the board zoom happens to be — then it is world geometry like ink
  // and scales with the sketch from that moment on (scaleNoteAbout, US-091).
  // Without the compensation a note placed on a zoomed-out board is written at
  // a few screen pixels and reads as broken; the clamps in note-model.js keep
  // the extremes sane.
  function newNoteWorldFontSize() {
    // state.noteFontSize is the TD's own sticky preference (the size chip,
    // Manual Mode change request 2026-08-20) — falls back to
    // NOTE_DEFAULT_FONT_SIZE only if it is somehow unset, exactly like
    // normalizeNoteFontSize's own NaN fallback.
    const target = Number(state.noteFontSize) || NOTE_DEFAULT_FONT_SIZE;
    return normalizeNoteFontSize(target / Math.max(state.zoom, 0.0001));
  }

  function newNoteWorldBoxWidth() {
    return normalizeNoteBoxWidth(NOTE_DEFAULT_BOX_WIDTH / Math.max(state.zoom, 0.0001));
  }

  function openNoteEditorForNewNote(world) {
    // Whatever was open finishes first, so two sessions can never overlap.
    commitNoteEditor();
    state.noteEditor = {
      id: null,
      pos: { x: world.x, y: world.y },
      color: normalizeColorKey(state.drawColor),
      fontSize: newNoteWorldFontSize(),
      boxWidth: newNoteWorldBoxWidth(),
    };
    showNoteEditor('');
  }

  function openNoteEditor(id) {
    const note = getNoteById(id);
    if (!note) return;
    commitNoteEditor();
    state.noteEditor = { id, pos: null };
    showNoteEditor(note.text);
  }

  function showNoteEditor(value) {
    el.noteEditor.value = String(value == null ? '' : value);
    el.noteEditor.style.display = 'block';
    positionNoteEditor(); // sizes, colours and grows it to fit
    requestRender();
    // Focus on the next frame for the same reason openLabelEditor does: the
    // element was display:none until a moment ago, and focusing a box the
    // browser has not laid out yet silently does nothing.
    requestAnimationFrame(() => {
      if (!isNoteEditorOpen()) return;
      el.noteEditor.focus();
      // Caret at the END, deliberately NOT select-all the way openLabelEditor
      // does. A callout label is one short token that is almost always being
      // replaced; a note is prose, and re-opening one is nearly always to fix a
      // word or add a line. Select-all there means the TD's next keystroke
      // silently destroys a paragraph they wrote.
      const end = el.noteEditor.value.length;
      el.noteEditor.setSelectionRange(end, end);
    });
  }

  // Runs from render(), so the editor tracks the note through pan, zoom and a
  // photo drag rather than sitting where the board used to be.
  function positionNoteEditor() {
    const session = state.noteEditor;
    if (!session) return;
    const note = session.id != null ? getNoteById(session.id) : null;
    // The note being edited can vanish under us — an Undo, or a photo delete
    // that took it along. Close rather than editing a ghost.
    if (session.id != null && !note) { cancelNoteEditor(); return; }
    const pos = note ? note.pos : session.pos;
    const worldFont = note ? noteFontSizeOf(note) : normalizeNoteFontSize(session.fontSize);
    const worldWidth = normalizeNoteBoxWidth(note ? note.boxWidth : session.boxWidth);
    const colorKey = normalizeColorKey(note ? note.color : session.color);
    const color = LINE_COLORS[colorKey] || LINE_COLOR;
    const screen = worldToScreen(pos.x, pos.y);
    const style = el.noteEditor.style;
    style.left = screen.x + 'px';
    style.top = screen.y + 'px';
    style.width = Math.max(90, worldWidth * state.zoom) + 'px';
    // Legibility floor and ceiling on the EDITOR only. A note itself may be any
    // size in the clamp range, but 4px text cannot be typed into and 200px text
    // does not fit on screen. The committed note re-wraps on the canvas, so a
    // clamped editor can differ from the final wrap by a word — cosmetic, and
    // far better than an unusable box.
    style.fontSize = clamp(worldFont * state.zoom, 11, 40) + 'px';
    style.lineHeight = String(NOTE_LINE_HEIGHT_RATIO);
    style.padding = Math.max(2, worldFont * NOTE_PADDING_RATIO * state.zoom) + 'px';
    style.color = color;
    // Same inversion the renderer applies: white ink needs a dark ground or the
    // TD is typing invisibly (see noteGroundFill).
    style.background = noteGroundFill(color);
    // The height is a function of the font size just set, so it has to follow a
    // zoom change — wheel-zooming mid-edit is entirely normal on this board.
    // Only ever runs while an editor is open, which is a rare state, and the
    // element is absolutely positioned so resizing it cannot reflow the canvas.
    autoGrowNoteEditor();
  }

  // Grow to fit the text instead of scrolling: a note the TD cannot see all of
  // while typing is worse than a tall box.
  function autoGrowNoteEditor() {
    if (!isNoteEditorOpen()) return;
    el.noteEditor.style.height = 'auto';
    el.noteEditor.style.height = (el.noteEditor.scrollHeight + 2) + 'px';
  }

  function onNoteEditorInput() {
    autoGrowNoteEditor();
  }

  function onNoteEditorKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelNoteEditor();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitNoteEditor();
    }
    // A plain Enter is deliberately left alone — it inserts a newline. Every
    // key stops here so the board-level shortcut router never sees a keystroke
    // meant for the text being typed.
    e.stopPropagation();
  }

  function closeNoteEditorElement() {
    el.noteEditor.style.display = 'none';
    el.noteEditor.value = '';
    el.noteEditor.style.height = '';
  }

  // Teardown with NO side effects — no history entry, no updateUI, no render.
  // The board-teardown paths (Reset Board, Clear Lines, opening a project) call
  // this exactly where they already drop the label editor: mid-rebuild, with
  // their own updateUI() to come. Discarding rather than committing matches
  // what those paths do to a half-typed label today.
  function discardNoteEditorSession() {
    state.noteEditor = null;
    closeNoteEditorElement();
  }

  function commitNoteEditor() {
    const session = state.noteEditor;
    if (!session) return;
    // Clear the session BEFORE doing any work: pushHistoryIfChanged and
    // requestRender can both reach back into positionNoteEditor, and a
    // half-committed session there would reopen what we are closing.
    state.noteEditor = null;
    const raw = String(el.noteEditor.value || '').replace(/\s+$/, '');
    closeNoteEditorElement();

    if (session.id != null) {
      const note = getNoteById(session.id);
      if (note) {
        if (raw === '') {
          // Emptying a note removes it. The alternative is an empty box the TD
          // then has to find, select and delete — content nobody asked for. One
          // history step, so Undo brings the text back.
          state.notes = (state.notes || []).filter(n => n.id !== note.id);
          if (state.selection.kind === 'note' && state.selection.id === note.id) {
            state.selection = { kind: null, id: null };
          }
          pushHistoryIfChanged();
          showToast('Empty note removed.');
        } else if (note.text !== raw) {
          note.text = raw;
          pushHistoryIfChanged();
        }
      }
    } else if (raw !== '') {
      // An empty commit creates nothing — a stray click with the Text tool is
      // the commonest way to open this editor by accident.
      const note = createNote(raw, session.pos, {
        color: session.color,
        fontSize: session.fontSize,
        boxWidth: session.boxWidth,
      });
      state.notes.push(note);
      // Audit-found bug: every OTHER creation gesture in this codebase selects
      // what it just made (handleDrawToolClick does this for every completed
      // line) — this one didn't, so state.selection kept pointing at whatever
      // was selected before the TD switched to the Text tool. The Text tool
      // deliberately stays active after a commit (so a run of remarks needs no
      // trip back to the toolbar), which made the stale selection persist
      // indefinitely: switching back to Select doesn't touch it either. A TD
      // who had a POM line selected, jotted a note, and then pressed Delete to
      // tidy up got the OLD LINE deleted instead of the note they just typed —
      // recoverable via Undo, but with no on-screen sign anything was wrong.
      setSelection('note', note.id);
      pushHistoryIfChanged();
    }
    updateUI();
    requestRender();
  }

  function cancelNoteEditor() {
    if (!state.noteEditor) return;
    discardNoteEditorSession();
    updateUI();
    requestRender();
  }
