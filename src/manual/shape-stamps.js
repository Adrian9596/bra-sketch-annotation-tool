// US-097 + US-098 / ADR 0059: reusable multi-path Templates.
//
// A Template is one or more selected paths — every anchor and both handles of
// every interior anchor — normalized into one collective unit box, plus the
// look and Treatment each member was saved with. Nothing absolute survives
// the save: not position, size, source sketch, POM identity or measurement.
//
// A placed Template becomes a session-only group of Sketch Elements. Normal
// selection moves the group; double-click enters one-member editing. Members
// stay outside the measurement contract even when their visual style is solid.
// ADR 0059 supersedes the single-line/POM semantics in ADR 0056.
//
// Sibling files: the Tools-menu UI is src/ui/shape-stamp-panel.js; the shared
// storage policy is src/manual/library-store.js; the placement gesture lives
// with the other tools in src/manual/pointer-events.js.
// Source part for app.js. Run `npm run build` after editing.

  // Functions, not module-scope consts: the parts share one scope and a const
  // read during load would throw a TDZ ReferenceError.
  function shapeStampsStorageKey() { return 'bra-shape-stamps-v1'; }
  // US-106: v3 adds category/tags/notes/favorite/timestamps/usage/
  // sourceStyleId/savedSize. Purely additive — a v2 payload still parses
  // (normalizeShapeStamp fills every new field with its v2-safe default) and
  // is not rewritten until the TD next saves/edits something, so bumping this
  // costs nothing for an existing library and is not itself a migration.
  function shapeStampsFormatVersion() { return 3; }

  // ---- Library taxonomy (US-106) ---------------------------------------------
  //
  // A FIXED, versioned list — not free text — because the category rail and
  // the starter pack both need stable buckets to filter/group by. The
  // free-form axis is `tags`. Order here is the order the Library Manager's
  // rail shows them in.
  function libraryCategories() {
    return [
      { id: 'cup', label: 'Cup' },
      { id: 'cradle-band', label: 'Cradle / Band' },
      { id: 'wing-back', label: 'Wing / Back' },
      { id: 'strap', label: 'Strap' },
      { id: 'neckline', label: 'Neckline' },
      { id: 'closure-hardware', label: 'Closure / Hardware' },
      { id: 'seam-detail', label: 'Seam Detail' },
      { id: 'embellishment', label: 'Embellishment' },
      { id: 'other', label: 'Other' },
    ];
  }

  function libraryCategoryLabel(id) {
    const found = libraryCategories().find(c => c.id === id);
    return found ? found.label : 'Other';
  }

  function normalizeStampCategory(raw) {
    return libraryCategories().some(c => c.id === raw) ? raw : 'other';
  }

  // Lowercased, trimmed, deduped, capped — a tag is a quick filter facet, not
  // a notes field (notes exists separately for prose).
  function normalizeStampTags(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const t of raw) {
      const tag = String(t == null ? '' : t).trim().toLowerCase().slice(0, 24);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= 12) break;
    }
    return out;
  }

  function normalizeStampNotes(raw) {
    return String(raw == null ? '' : raw).trim().slice(0, 240);
  }

  function normalizeStampTimestamp(raw) {
    return (typeof raw === 'string' && raw) ? raw : null;
  }

  function normalizeStampUsage(raw) {
    const count = Number(raw && raw.count);
    return {
      count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
      lastUsedAt: normalizeStampTimestamp(raw && raw.lastUsedAt),
    };
  }

  function normalizeStampSize(raw) {
    const width = Number(raw && raw.width), height = Number(raw && raw.height);
    return (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)
      ? { width, height } : null;
  }

  // Below this the drag is treated as a click and the stamp is placed at a
  // default size. Screen pixels, like BG_MIN_CREATE_SCREEN_PX.
  function stampMinCreateScreenPx() { return 8; }

  // A geometry point is degenerate along an axis when the source line had no
  // extent there — a perfectly horizontal line has zero height.
  function stampEpsilon() { return 1e-6; }

  // ---- Normalizing paths into a Template -----------------------------------

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

  function shapeTemplateBounds(annotations) {
    const points = [];
    for (const ann of (Array.isArray(annotations) ? annotations : [])) {
      points.push(...shapeStampGeometryPoints(ann));
    }
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
  function shapeTemplateMemberFromAnnotation(ann, bounds) {
    if (!ann || !ann.start || !ann.end || !bounds) return null;
    const n = (p) => normalizeStampPoint(p, bounds);
    const curved = ann.type === 'curved';
    return {
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
      style: normalizeLineStyle(ann.style),
      color: normalizeColorKey(ann.color),
      lineWidth: normalizeLineWidth(ann.lineWidth),
      arrowType: getArrowType(ann),
      lineTreatment: hasLineTreatment(ann) ? normalizeLineTreatment(ann.lineTreatment) : null,
    };
  }

  // `options` (US-106, all optional): { category, tags, notes } — the
  // Library Manager's "Edit details" action can also set these later via
  // setShapeStampCategory/Tags/Notes, so the quick Save-Template flow can
  // keep asking for a name only.
  function shapeStampFromAnnotations(annotations, name, options) {
    const trimmed = String(name == null ? '' : name).trim();
    const anns = (Array.isArray(annotations) ? annotations : []).filter(ann => ann && ann.start && ann.end);
    if (!trimmed || !anns.length) return null;
    const bounds = shapeTemplateBounds(anns);
    if (!bounds) return null;
    const eps = stampEpsilon();
    const members = anns.map(ann => shapeTemplateMemberFromAnnotation(ann, bounds)).filter(Boolean);
    if (!members.length) return null;
    const first = members[0];
    const opts = options || {};
    const now = new Date().toISOString();
    return {
      id: libraryEntryId('st'),
      name: trimmed.slice(0, 60),
      category: normalizeStampCategory(opts.category),
      tags: normalizeStampTags(opts.tags),
      notes: normalizeStampNotes(opts.notes),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      usage: { count: 0, lastUsedAt: null },
      sourceStyleId: (typeof state !== 'undefined' && state.styleId) ? String(state.styleId).trim() || null : null,
      // WORLD units at save time — see defaultStampBoxAt for how a bare click
      // on the stamp tool prefers this over the generic size heuristic.
      savedSize: { width: bounds.width, height: bounds.height },
      members,
      // Keep the first member mirrored at top level so v1 exports and the
      // existing one-path test/debug hooks remain readable during migration.
      ...clone(first),
      // 0 means "no preferred aspect": one of the axes had no extent, so any
      // box height is as faithful as any other.
      aspect: (bounds.width > eps && bounds.height > eps) ? (bounds.height / bounds.width) : 0,
    };
  }

  function shapeStampFromAnnotation(ann, name) {
    return shapeStampFromAnnotations(ann ? [ann] : [], name);
  }

  function normalizeStampStoredPoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x), y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function normalizeShapeStampMember(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const start = normalizeStampStoredPoint(raw.start);
    const end = normalizeStampStoredPoint(raw.end);
    if (!start || !end) return null;
    const curved = raw.type === 'curved';
    const control1 = curved ? normalizeStampStoredPoint(raw.control1) : null;
    const control2 = curved ? normalizeStampStoredPoint(raw.control2) : null;
    // A curved stamp missing a control point is not repairable here — its
    // shape is gone. Fall back to straight rather than inventing a bow.
    const usableCurve = curved && control1 && control2;
    return {
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
      style: normalizeLineStyle(raw.style),
      color: normalizeColorKey(raw.color),
      lineWidth: normalizeLineWidth(raw.lineWidth),
      arrowType: ['single', 'double', 'none'].includes(raw.arrowType) ? raw.arrowType : 'none',
      lineTreatment: normalizeLineTreatment(raw.lineTreatment),
    };
  }

  function normalizeShapeStamp(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name) return null;
    let members = (Array.isArray(raw.members) ? raw.members : [])
      .map(normalizeShapeStampMember).filter(Boolean).slice(0, 80);
    if (!members.length) {
      const legacy = normalizeShapeStampMember(raw);
      if (legacy) members = [legacy];
    }
    if (!members.length) return null;
    const aspect = Number(raw.aspect);
    return {
      id: String(raw.id || libraryEntryId('st')),
      name: name.slice(0, 60),
      // US-106 v3 fields — every one has a safe v2 default, so reading an
      // older payload never fails and never rewrites storage on its own.
      category: normalizeStampCategory(raw.category),
      tags: normalizeStampTags(raw.tags),
      notes: normalizeStampNotes(raw.notes),
      favorite: raw.favorite === true,
      createdAt: normalizeStampTimestamp(raw.createdAt),
      updatedAt: normalizeStampTimestamp(raw.updatedAt),
      usage: normalizeStampUsage(raw.usage),
      sourceStyleId: (typeof raw.sourceStyleId === 'string' && raw.sourceStyleId.trim()) ? raw.sourceStyleId.trim() : null,
      savedSize: normalizeStampSize(raw.savedSize),
      members,
      aspect: (Number.isFinite(aspect) && aspect > 0) ? aspect : 0,
      ...clone(members[0]),
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

  // One or more selected paths become one Template. A plain click on an
  // existing Template selects all its members, so saving a placed group again
  // is the same operation as saving a hand-built back wing.
  function shapeStampSaveTargets() {
    const selected = (typeof getSelectedAnnotations === 'function') ? getSelectedAnnotations() : [];
    if (selected.length) return selected;
    const primary = (typeof getSelectedAnnotation === 'function') ? getSelectedAnnotation() : null;
    return primary ? [primary] : [];
  }

  function shapeStampSaveTarget() {
    return shapeStampSaveTargets()[0] || null;
  }

  function canSaveShapeStampReason() {
    if (!shapeStampSaveTargets().length) return 'Select one or more lines to save as a Template.';
    return true;
  }

  function addShapeStampFromSelection(name, options) {
    const targets = shapeStampSaveTargets();
    if (!targets.length) return null;
    const stamp = shapeStampFromAnnotations(targets, name, options);
    if (!stamp) return null;
    commitShapeStamps([...getShapeStamps(), stamp]);
    return stamp;
  }

  // Every edit below stamps `updatedAt` and goes through the same
  // commitShapeStamps write path — one place a TD's edit becomes durable (or
  // visibly fails to), matching renameShapeStamp's existing shape.
  function updateShapeStamp(id, patch) {
    const list = getShapeStamps();
    if (!list.some(stamp => stamp.id === id)) return false;
    commitShapeStamps(list.map(stamp => (stamp.id === id
      ? { ...stamp, ...patch, updatedAt: new Date().toISOString() } : stamp)));
    return true;
  }

  function renameShapeStamp(id, name) {
    const trimmed = String(name == null ? '' : name).trim();
    if (!trimmed) return false;
    return updateShapeStamp(id, { name: trimmed.slice(0, 60) });
  }

  function setShapeStampCategory(id, category) {
    return updateShapeStamp(id, { category: normalizeStampCategory(category) });
  }

  function setShapeStampTags(id, tags) {
    return updateShapeStamp(id, { tags: normalizeStampTags(tags) });
  }

  function setShapeStampNotes(id, notes) {
    return updateShapeStamp(id, { notes: normalizeStampNotes(notes) });
  }

  function setShapeStampFavorite(id, favorite) {
    return updateShapeStamp(id, { favorite: !!favorite });
  }

  function toggleShapeStampFavorite(id) {
    const stamp = getShapeStampById(id);
    if (!stamp) return false;
    return setShapeStampFavorite(id, !stamp.favorite);
  }

  // Placement (not the Library Manager dialog) is the only caller — bumping
  // usage on every dialog open/preview would make "recently used" measure
  // browsing instead of reuse.
  function touchShapeStampUsage(id) {
    const stamp = getShapeStampById(id);
    if (!stamp) return;
    commitShapeStamps(getShapeStamps().map(s => (s.id === id
      ? { ...s, usage: { count: (s.usage && s.usage.count || 0) + 1, lastUsedAt: new Date().toISOString() } }
      : s)));
  }

  // A independent copy, never sharing identity with the source — renaming or
  // deleting one must never affect the other. Placed right after the source
  // in list order (libraryMoveEntry-friendly) rather than appended, so a
  // duplicate-then-tweak workflow keeps the two next to each other.
  function duplicateShapeStamp(id) {
    const list = getShapeStamps();
    const index = list.findIndex(stamp => stamp.id === id);
    if (index === -1) return null;
    const source = list[index];
    const now = new Date().toISOString();
    const copy = {
      ...clone(source),
      id: libraryEntryId('st'),
      name: (source.name + ' copy').slice(0, 60),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      usage: { count: 0, lastUsedAt: null },
    };
    const next = list.slice();
    next.splice(index + 1, 0, copy);
    commitShapeStamps(next);
    return copy;
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
  //
  // US-106: when the stamp carries a `savedSize` (the WORLD-unit box it was
  // saved from), a bare click reproduces that exact size — a strictly better
  // default than the generic 30%-of-image guess below, and the one thing
  // that makes "place a wing at the size it was cut" a one-click gesture. A
  // v2 stamp (imported, or saved before US-106) has no savedSize and falls
  // back to the original heuristic unchanged.
  function defaultStampBoxAt(stamp, world) {
    if (stamp && stamp.savedSize) {
      const { width, height } = stamp.savedSize;
      return { x: world.x - width / 2, y: world.y - height / 2, width, height };
    }
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

  // US-106: reflects a NORMALIZED ([0,1]-in-its-own-box) point across the
  // box's own vertical centerline. Applied uniformly to every point of every
  // member before denormalizing, which is enough on its own to mirror a
  // whole path (straight or curved) correctly — reflection is affine, so it
  // commutes with the Bézier construction, and handleIn/handleOut keep
  // their existing roles (arriving-from / leaving-toward) because mirroring
  // does not reverse the point order along the path, only its x placement.
  function mirrorStampPointX(p) {
    return p ? { x: 1 - p.x, y: p.y } : null;
  }

  // Build the annotation. Mirrors pasteLineFromClipboard's record shape and its
  // ordering lesson (US-093): normalize the curve FIRST, derive the label after,
  // because computeDefaultLabelPosition walks getCurveBeziers and therefore
  // reads the very controls ensureCurveControls exists to supply.
  function createAnnotationFromTemplateMember(member, rawBox, groupId, mirrored) {
    if (!member) return null;
    const box = normalizeStampBox(member, rawBox);
    const d = (p) => denormalizeStampPoint(mirrored ? mirrorStampPointX(p) : p, box);
    const curved = member.type === 'curved';
    const ann = {
      id: state.idCounter++,
      seq: state.nextSequence,
      type: curved ? 'curved' : 'straight',
      style: member.style,
      color: member.color,
      arrowType: member.arrowType,
      lineWidth: member.lineWidth,
      lineTreatment: member.lineTreatment ? clone(member.lineTreatment) : null,
      purpose: 'sketch-element',
      templateGroupId: groupId || null,
      start: d(member.start),
      end: d(member.end),
      midPoint: null,
      midHandleIn: null,
      midHandleOut: null,
      control1: curved ? d(member.control1) : null,
      control2: curved ? d(member.control2) : null,
      points: curved ? member.points.map(pt => ({
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

  function createAnnotationsFromStamp(stamp, rawBox, groupId, mirrored) {
    if (!stamp) return [];
    const members = Array.isArray(stamp.members) && stamp.members.length ? stamp.members : [stamp];
    return members.map(member => createAnnotationFromTemplateMember(member, rawBox, groupId, mirrored)).filter(Boolean);
  }

  function createAnnotationFromStamp(stamp, rawBox, mirrored) {
    return createAnnotationsFromStamp(stamp, rawBox, null, mirrored)[0] || null;
  }

  // The one entry point the pointer layer calls on mouseup. Mirroring
  // (US-106) is read from state — armed once per placement via
  // armShapeStampForPlacement/setActiveShapeStamp, not passed by the caller —
  // so the pointer layer does not need to know this feature exists.
  function placeShapeStamp(stamp, start, current, shiftKey, altKey) {
    if (!stamp) return null;
    const dragged = stampBoxFromDrag(stamp, start, current, shiftKey, altKey);
    const tooSmall = Math.max(dragged.width, dragged.height) * state.zoom < stampMinCreateScreenPx();
    const box = tooSmall ? defaultStampBoxAt(stamp, start) : dragged;
    const groupId = 'template-' + state.idCounter++;
    const anns = createAnnotationsFromStamp(stamp, box, groupId, state.activeStampMirrored);
    if (!anns.length) return null;
    state.annotations.push(...anns);
    state.selection = { kind: 'annotation', id: anns[0].id };
    state.selectedAnnotationIds = anns.map(ann => ann.id);
    state.templateGroupEditId = null;
    // ADR 0058: Template members are Sketch Elements and spend no POM number.
    pushHistoryIfChanged();
    if (stamp.id) touchShapeStampUsage(stamp.id);
    return anns[0];
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
    const preview = createAnnotationsFromStamp(stamp, box, null, state.activeStampMirrored);
    state.idCounter = savedId;
    state.nextSequence = savedSeq;
    for (const ann of preview) drawLineCore(ann, 0.6);
  }

  // Always resets mirroring — a fresh arm (choosing a Template, including
  // re-choosing the one already armed) starts un-mirrored; a TD who wants a
  // mirrored placement asks for it explicitly via
  // armShapeStampForPlacement/setActiveStampMirrored every time, so it can
  // never silently carry over onto an unrelated next placement.
  function setActiveShapeStamp(id) {
    state.activeStampId = id || null;
    state.activeStampMirrored = false;
  }

  function setActiveStampMirrored(mirrored) {
    state.activeStampMirrored = !!mirrored;
  }

  // US-106/US-107: arms the stamp tool, selects which saved Template it will
  // place, and requests mirroring — one call, so no caller (the Library
  // dialog, a test driving the debug seam) can set one part and forget
  // another, or leave the toolbar/status bar showing a stale armed name.
  // setTool('stamp') runs first: it only clears activeStampId when switching
  // AWAY from 'stamp' (src/ui/bindings.js), so it never undoes the
  // setActiveShapeStamp call that follows it here. The explicit updateUI()
  // at the end matters: setTool('stamp') already re-rendered once, but at
  // that point activeStampId still held whatever it was BEFORE this call —
  // without a second render after setActiveShapeStamp, the toolbar/status
  // bar would keep showing the previously armed (or no) stamp.
  function armShapeStampForPlacement(id, opts) {
    if (typeof setTool === 'function') setTool('stamp');
    setActiveShapeStamp(id);
    if (opts && opts.mirrored) setActiveStampMirrored(true);
    if (typeof updateUI === 'function') updateUI();
  }

  function getActiveShapeStamp() {
    return state.activeStampId ? getShapeStampById(state.activeStampId) : null;
  }

  // ---- Portability ---------------------------------------------------------

  function shapeStampsEnvelope() {
    return {
      format: 'bra-shape-stamps', version: shapeStampsFormatVersion(),
      exportedAt: new Date().toISOString(), stamps: getShapeStamps(),
    };
  }

  function exportShapeStampsFile() {
    const blob = new Blob([JSON.stringify(shapeStampsEnvelope(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'shape-stamps.json');
  }

  // Single-entry export (Library Manager card action) — same envelope shape
  // as the whole-library export, so importShapeStampsFromJson reads either
  // one back without a special case.
  function exportOneShapeStampFile(id) {
    const stamp = getShapeStampById(id);
    if (!stamp) return false;
    const envelope = {
      format: 'bra-shape-stamps', version: shapeStampsFormatVersion(),
      exportedAt: new Date().toISOString(), stamps: [stamp],
    };
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    downloadBlob(blob, (stamp.name || 'template').replace(/[^A-Za-z0-9._-]+/g, '-') + '.json');
    return true;
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
