// US-097 / ADR 0056: the shape-stamp library.
//
// A stamp is ONE line's geometry — every anchor and both handles of every
// interior anchor — normalized into a unit box, plus the look it was saved
// with. Nothing absolute survives the save: not position, not size, not the
// sketch it came from. That is what makes a curve saved on a 2000px sketch
// usable on a 600px one, which is the entire point.
//
// A placed stamp is an ORDINARY annotation. Its measurement role is derived
// from its style exactly as ADR 0055 defines, so a stamp saved from a plain
// line places a POM line and one saved from a zigzag places a construction
// mark. There is deliberately no new collection — see ADR 0056, which
// supersedes ADR 0055's Follow-Up on this point.
//
// Sibling files: the Tools-menu UI is src/ui/shape-stamp-panel.js; the shared
// storage policy is src/manual/library-store.js; the placement gesture lives
// with the other tools in src/manual/pointer-events.js.
// Source part for app.js. Run `npm run build` after editing.

  // Functions, not module-scope consts: the parts share one scope and a const
  // read during load would throw a TDZ ReferenceError.
  function shapeStampsStorageKey() { return 'bra-shape-stamps-v1'; }
  function shapeStampsFormatVersion() { return 1; }

  // Below this the drag is treated as a click and the stamp is placed at a
  // default size. Screen pixels, like BG_MIN_CREATE_SCREEN_PX.
  function stampMinCreateScreenPx() { return 8; }

  // A geometry point is degenerate along an axis when the source line had no
  // extent there — a perfectly horizontal line has zero height.
  function stampEpsilon() { return 1e-6; }

  // ---- Normalizing a line into a stamp -------------------------------------

  // Every point that defines the drawn shape, handles included. The handles
  // have to be inside the box too, or a re-placed curve's bulge is scaled
  // against a different rectangle than its anchors and the shape changes.
  function shapeStampGeometryPoints(ann) {
    const out = [];
    const push = (p) => { if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out.push(p); };
    push(ann.start);
    push(ann.end);
    if (ann.type === 'curved') {
      push(ann.control1);
      push(ann.control2);
      for (const pt of (Array.isArray(ann.points) ? ann.points : [])) {
        push(pt && pt.point);
        push(pt && pt.handleIn);
        push(pt && pt.handleOut);
      }
    }
    return out;
  }

  function shapeStampBounds(ann) {
    const points = shapeStampGeometryPoints(ann);
    if (!points.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // Fraction of the bounding box. A collapsed axis maps to 0.5 — the line's
  // own centreline — so a horizontal line stamps back as a horizontal line
  // through the middle of whatever box it is given.
  function normalizeStampPoint(p, bounds) {
    const eps = stampEpsilon();
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return {
      x: bounds.width > eps ? (p.x - bounds.x) / bounds.width : 0.5,
      y: bounds.height > eps ? (p.y - bounds.y) / bounds.height : 0.5,
    };
  }

  function denormalizeStampPoint(p, box) {
    if (!p) return null;
    return { x: box.x + p.x * box.width, y: box.y + p.y * box.height };
  }

  // Build a stamp from a drawn line. Returns null for anything unusable rather
  // than saving a stamp that cannot be placed.
  function shapeStampFromAnnotation(ann, name) {
    const trimmed = String(name == null ? '' : name).trim();
    if (!trimmed || !ann || !ann.start || !ann.end) return null;
    const bounds = shapeStampBounds(ann);
    if (!bounds) return null;
    const eps = stampEpsilon();
    const n = (p) => normalizeStampPoint(p, bounds);
    const curved = ann.type === 'curved';
    return {
      id: libraryEntryId('st'),
      name: trimmed.slice(0, 60),
      type: curved ? 'curved' : 'straight',
      start: n(ann.start),
      end: n(ann.end),
      control1: curved ? n(ann.control1) : null,
      control2: curved ? n(ann.control2) : null,
      points: curved
        ? (Array.isArray(ann.points) ? ann.points : []).map(pt => ({
          point: n(pt && pt.point),
          handleIn: n(pt && pt.handleIn),
          handleOut: n(pt && pt.handleOut),
        })).filter(pt => pt.point && pt.handleIn && pt.handleOut)
        : [],
      // 0 means "no preferred aspect": one of the axes had no extent, so any
      // box height is as faithful as any other.
      aspect: (bounds.width > eps && bounds.height > eps) ? (bounds.height / bounds.width) : 0,
      // The look travels with the shape. It is what decides, via ADR 0055,
      // whether the placed line is a measurement or a construction mark.
      style: normalizeLineStyle(ann.style),
      color: normalizeColorKey(ann.color),
      lineWidth: normalizeLineWidth(ann.lineWidth),
      arrowType: getArrowType(ann),
    };
  }

  function normalizeStampStoredPoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x), y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function normalizeShapeStamp(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim();
    const start = normalizeStampStoredPoint(raw.start);
    const end = normalizeStampStoredPoint(raw.end);
    if (!name || !start || !end) return null;
    const curved = raw.type === 'curved';
    const control1 = curved ? normalizeStampStoredPoint(raw.control1) : null;
    const control2 = curved ? normalizeStampStoredPoint(raw.control2) : null;
    // A curved stamp missing a control point is not repairable here — its
    // shape is gone. Fall back to straight rather than inventing a bow.
    const usableCurve = curved && control1 && control2;
    const aspect = Number(raw.aspect);
    return {
      id: String(raw.id || libraryEntryId('st')),
      name: name.slice(0, 60),
      type: usableCurve ? 'curved' : 'straight',
      start,
      end,
      control1: usableCurve ? control1 : null,
      control2: usableCurve ? control2 : null,
      points: usableCurve
        ? (Array.isArray(raw.points) ? raw.points : []).map(pt => ({
          point: normalizeStampStoredPoint(pt && pt.point),
          handleIn: normalizeStampStoredPoint(pt && pt.handleIn),
          handleOut: normalizeStampStoredPoint(pt && pt.handleOut),
        })).filter(pt => pt.point && pt.handleIn && pt.handleOut)
        : [],
      aspect: (Number.isFinite(aspect) && aspect > 0) ? aspect : 0,
      style: normalizeLineStyle(raw.style),
      color: normalizeColorKey(raw.color),
      lineWidth: normalizeLineWidth(raw.lineWidth),
      arrowType: ['single', 'double', 'none'].includes(raw.arrowType) ? raw.arrowType : 'none',
    };
  }

  function normalizeShapeStampList(list) {
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(list) ? list : [])) {
      const stamp = normalizeShapeStamp(raw);
      if (!stamp || seen.has(stamp.id)) continue;
      seen.add(stamp.id);
      out.push(stamp);
    }
    return out;
  }

  // ---- Storage -------------------------------------------------------------
  //
  // Module scope, like lineClipboard and linePresetStore: deliberately outside
  // `state`, so it is absent from history snapshots and Undo cannot roll the
  // library back.
  let shapeStampStore = null;
  let lastShapeStampWritePersisted = true;

  // The library ships EMPTY. Seeding house curves would mean inventing
  // geometry no TD has approved, which is worse than an empty list (ADR 0056).
  function builtinShapeStamps() { return []; }

  function getShapeStamps() {
    if (shapeStampStore) return shapeStampStore;
    const read = readLibraryStore(shapeStampsStorageKey(), 'stamps', normalizeShapeStampList);
    shapeStampStore = (read.list.length || read.seeded) ? read.list : builtinShapeStamps();
    return shapeStampStore;
  }

  function shapeStampsPersisted() { return lastShapeStampWritePersisted; }

  function commitShapeStamps(list) {
    shapeStampStore = normalizeShapeStampList(list);
    lastShapeStampWritePersisted = writeLibraryStore(
      shapeStampsStorageKey(), 'stamps', shapeStampsFormatVersion(), shapeStampStore);
    if (typeof updateUI === 'function') updateUI();
    return lastShapeStampWritePersisted;
  }

  function getShapeStampById(id) {
    return getShapeStamps().find(stamp => stamp.id === id) || null;
  }

  // ---- Mutations -----------------------------------------------------------

  // Exactly one selected line. A group has no single geometry to save, and
  // silently picking the primary would save something the TD did not point at.
  function shapeStampSaveTarget() {
    const selected = (typeof getSelectedAnnotations === 'function') ? getSelectedAnnotations() : [];
    if (selected.length === 1) return selected[0];
    if (!selected.length && typeof getSelectedAnnotation === 'function') return getSelectedAnnotation();
    return null;
  }

  function canSaveShapeStampReason() {
    const selected = (typeof getSelectedAnnotations === 'function') ? getSelectedAnnotations() : [];
    if (selected.length > 1) return 'Select just one line — a shape holds one line.';
    if (!shapeStampSaveTarget()) return 'Select a line to save its shape.';
    return true;
  }

  function addShapeStampFromSelection(name) {
    const ann = shapeStampSaveTarget();
    if (!ann) return null;
    const stamp = shapeStampFromAnnotation(ann, name);
    if (!stamp) return null;
    commitShapeStamps([...getShapeStamps(), stamp]);
    return stamp;
  }

  function renameShapeStamp(id, name) {
    const trimmed = String(name == null ? '' : name).trim();
    if (!trimmed) return false;
    commitShapeStamps(getShapeStamps().map(stamp => (stamp.id === id
      ? { ...stamp, name: trimmed.slice(0, 60) } : stamp)));
    return true;
  }

  function deleteShapeStamp(id) {
    const list = getShapeStamps().filter(stamp => stamp.id !== id);
    if (list.length === getShapeStamps().length) return false;
    // Code review, 2026-08-23: leave the stamp TOOL as well, not just the
    // armed id. Clearing only activeStampId left the board in a modal creation
    // mode that could create nothing — the trigger read "Tools: Shape", the
    // status said "pick a saved shape first", and the whole context-actions
    // group stays hidden while a non-select tool is active. Dropping to Select
    // is the same thing Escape does, and it is what the TD wanted anyway:
    // they just deleted the thing they were about to place.
    if (state.activeStampId === id) {
      setActiveShapeStamp(null);
      if (state.tool === 'stamp' && typeof setTool === 'function') setTool('select');
    }
    commitShapeStamps(list);
    return true;
  }

  function moveShapeStamp(id, delta) {
    const list = libraryMoveEntry(getShapeStamps(), id, delta);
    if (!list) return false;
    commitShapeStamps(list);
    return true;
  }

  // ---- Placement -----------------------------------------------------------

  // Shift locks the stamp's saved aspect, matching ADR 0054's Rectangle gesture
  // (Shift constrains, Alt draws from the centre). Without it the dragged box
  // is what you get, distortion included — the tooltip names the saved aspect
  // so the TD knows what they are stretching.
  //
  // Code review, 2026-08-23: the lock derives from whichever axis the TD
  // dragged FURTHER, not always from dx. Driving it from dx alone collapsed the
  // whole box on a vertical drag — 400px down with 5px of horizontal wander
  // produced a 5px box, which then fell through placeShapeStamp's
  // too-small branch and placed a default-size stamp at the press point. The
  // peer gesture (bgBoxFromDrag) degenerates the same way, but there the
  // outcome is "nothing was created", which reads as a too-small drag; here it
  // was a real line of an unrelated size in an unrelated place.
  function stampBoxFromDrag(stamp, start, current, shiftKey, altKey) {
    let dx = current.x - start.x;
    let dy = current.y - start.y;
    if (shiftKey && stamp && stamp.aspect > 0) {
      if (Math.abs(dy) > Math.abs(dx) * stamp.aspect) {
        dx = (dx < 0 ? -1 : 1) * (Math.abs(dy) / stamp.aspect);
      } else {
        dy = (dy < 0 ? -1 : 1) * (Math.abs(dx) * stamp.aspect);
      }
    }
    let x1 = start.x, y1 = start.y, x2 = start.x + dx, y2 = start.y + dy;
    if (altKey) { x1 = start.x - dx; y1 = start.y - dy; }
    return {
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
    };
  }

  // The box a bare click gets. ADR 0056 diverges from ADR 0054 here on purpose:
  // a too-small Rectangle drag creates nothing because the gesture IS the
  // object's definition, but a stamp already exists and the TD has explicitly
  // chosen it, so a click that produces nothing reads as a broken tool.
  function defaultStampBoxAt(stamp, world) {
    const image = (typeof bgTopImageAt === 'function') ? bgTopImageAt(world) : null;
    const maxWidth = image && image.width ? image.width * 0.3 : 200;
    // Code review, 2026-08-23: bound BOTH axes. Sizing only the width meant a
    // tall stamp (aspect 4, say) was placed four times the sketch's own
    // width high — off the sketch entirely for a gesture that is supposed to
    // be the safe, no-thought one.
    const maxHeight = image && image.height ? image.height * 0.3 : 100;
    const aspect = (stamp && stamp.aspect > 0) ? stamp.aspect : 0.5;
    let width = maxWidth;
    let height = width * aspect;
    if (height > maxHeight) { height = maxHeight; width = height / aspect; }
    return { x: world.x - width / 2, y: world.y - height / 2, width, height };
  }

  // A box too thin to see in one axis would collapse the shape; give it a
  // visible minimum so a near-horizontal drag still places a usable line.
  //
  // Code review, 2026-08-23: this is a MINIMUM and nothing else. It used to
  // floor the height at `width * stamp.aspect`, which is not a minimum — it is
  // the Shift-locked height, applied unconditionally. Three things followed:
  // a free drag could never place a stamp flatter than it was saved (so Shift
  // was a no-op across that whole regime, contradicting this module's own
  // contract and the toast the TD is shown); the extra height was added
  // entirely BELOW the drag, so the shape was in the wrong place as well as
  // the wrong size; and an Alt placement stopped being centred on the press.
  // A steep stamp made it dramatic — aspect 2 with a flat drag placed a shape
  // hundreds of world units below the cursor.
  //
  // Growing about the CENTRE, not the origin, is the other half: a minimum
  // applied to one edge would drift the placement away from the drag.
  function normalizeStampBox(stamp, box) {
    const minSide = 4 / Math.max(state.zoom, 0.0001);
    let { x, y, width, height } = box;
    if (width < minSide) { x -= (minSide - width) / 2; width = minSide; }
    if (height < minSide) { y -= (minSide - height) / 2; height = minSide; }
    return { x, y, width, height };
  }

  // Build the annotation. Mirrors pasteLineFromClipboard's record shape and its
  // ordering lesson (US-093): normalize the curve FIRST, derive the label after,
  // because computeDefaultLabelPosition walks getCurveBeziers and therefore
  // reads the very controls ensureCurveControls exists to supply.
  function createAnnotationFromStamp(stamp, rawBox) {
    if (!stamp) return null;
    const box = normalizeStampBox(stamp, rawBox);
    const d = (p) => denormalizeStampPoint(p, box);
    const curved = stamp.type === 'curved';
    const ann = {
      id: state.idCounter++,
      seq: state.nextSequence,
      type: curved ? 'curved' : 'straight',
      style: stamp.style,
      color: stamp.color,
      arrowType: stamp.arrowType,
      lineWidth: stamp.lineWidth,
      start: d(stamp.start),
      end: d(stamp.end),
      midPoint: null,
      midHandleIn: null,
      midHandleOut: null,
      control1: curved ? d(stamp.control1) : null,
      control2: curved ? d(stamp.control2) : null,
      points: curved ? stamp.points.map(pt => ({
        point: d(pt.point), handleIn: d(pt.handleIn), handleOut: d(pt.handleOut),
      })) : [],
      label: null,
      labelManual: false,
      // Deliberately NOT inherited from the source line: a POM number is an
      // identity, not a look, and stamping the same curve twice would otherwise
      // produce two lines claiming one POM.
      text: null,
      value: null,
    };
    if (curved) ensureCurveControls(ann);
    ann.label = computeDefaultLabelPosition(ann);
    const owner = (typeof bgTopImageAt === 'function')
      ? bgTopImageAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 }) : null;
    if (owner) ann.sourceImageId = owner.id;
    return ann;
  }

  // The one entry point the pointer layer calls on mouseup.
  function placeShapeStamp(stamp, start, current, shiftKey, altKey) {
    if (!stamp) return null;
    const dragged = stampBoxFromDrag(stamp, start, current, shiftKey, altKey);
    const tooSmall = Math.max(dragged.width, dragged.height) * state.zoom < stampMinCreateScreenPx();
    const box = tooSmall ? defaultStampBoxAt(stamp, start) : dragged;
    const ann = createAnnotationFromStamp(stamp, box);
    if (!ann) return null;
    state.annotations.push(ann);
    state.selection = { kind: 'annotation', id: ann.id };
    state.selectedAnnotationIds = [ann.id];
    // ADR 0055: a construction stamp spends no POM number.
    consumePomSequenceFor(ann);
    pushHistoryIfChanged();
    return ann;
  }

  // Drawn by building the annotation the release WOULD create and handing it to
  // the ordinary line renderer at reduced alpha. Not an approximation of the
  // shape: it is the shape, so what the TD drags is exactly what they get —
  // including the stitch pattern and the arrowheads.
  function drawShapeStampPreview() {
    const inter = state.interaction;
    if (!inter || inter.type !== 'draw-stamp') return;
    const stamp = getShapeStampById(inter.stampId);
    if (!stamp) return;
    const dragged = stampBoxFromDrag(stamp, inter.startWorld, inter.currentWorld,
      inter.shiftKey, inter.altKey);
    const tooSmall = Math.max(dragged.width, dragged.height) * state.zoom < stampMinCreateScreenPx();
    const box = tooSmall ? defaultStampBoxAt(stamp, inter.startWorld) : dragged;
    // Built WITHOUT touching state.idCounter / nextSequence — a preview must
    // not spend an id every mousemove.
    const savedId = state.idCounter;
    const savedSeq = state.nextSequence;
    const preview = createAnnotationFromStamp(stamp, box);
    state.idCounter = savedId;
    state.nextSequence = savedSeq;
    if (preview) drawLineCore(preview, 0.6);
  }

  function setActiveShapeStamp(id) {
    state.activeStampId = id || null;
  }

  function getActiveShapeStamp() {
    return state.activeStampId ? getShapeStampById(state.activeStampId) : null;
  }

  // ---- Portability ---------------------------------------------------------

  function shapeStampsEnvelope() {
    return { format: 'bra-shape-stamps', version: shapeStampsFormatVersion(), stamps: getShapeStamps() };
  }

  function exportShapeStampsFile() {
    const blob = new Blob([JSON.stringify(shapeStampsEnvelope(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'shape-stamps.json');
  }

  function importShapeStamps(list) {
    const incoming = normalizeShapeStampList(list);
    if (!incoming.length) return 0;
    commitShapeStamps(libraryImportMerge(getShapeStamps(), incoming));
    return incoming.length;
  }

  function importShapeStampsFromJson(text) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { return 0; }
    const list = Array.isArray(parsed) ? parsed : (parsed && parsed.stamps);
    return importShapeStamps(list);
  }

  // ---- Project embedding ---------------------------------------------------

  function serializeShapeStampsForProject() {
    return clone(getShapeStamps());
  }

  let pendingProjectShapeStamps = [];

  function offerShapeStampsFromProject(list) {
    pendingProjectShapeStamps = libraryUnknownEntries(
      getShapeStamps(), normalizeShapeStampList(list));
    if (!pendingProjectShapeStamps.length) return 0;
    const count = pendingProjectShapeStamps.length;
    showToast(`This project uses ${count} saved shape${count > 1 ? 's' : ''} you don't have — Tools ▸ Import from project.`);
    return count;
  }

  function getPendingProjectShapeStamps() { return pendingProjectShapeStamps; }

  function importPendingProjectShapeStamps() {
    const added = importShapeStamps(pendingProjectShapeStamps);
    pendingProjectShapeStamps = [];
    return added;
  }
