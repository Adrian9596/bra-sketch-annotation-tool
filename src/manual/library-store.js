// US-097 / ADR 0056: the storage policy shared by the two board libraries —
// line presets (US-096) and shape stamps.
//
// This exists because every rule below was bought with a bug in US-096, and a
// second hand-written copy of them for stamps would have bought each one again:
//
//   - a corrupt payload falls back to the built-in set instead of throwing;
//   - "stored an empty library" and "never stored one" are DIFFERENT states,
//     distinguished by a one-shot `seeded` marker, or deleting every entry
//     silently resurrects the built-ins on the next reload (the US-074 trap);
//   - a refused write (quota, private mode) is reported to the caller rather
//     than toasted from in here — showToast queues rather than replaces, so a
//     message fired here is buried by the caller's own, and its wording cannot
//     be right for every action;
//   - import MERGES by id rather than replacing, so importing a colleague's
//     set never costs the TD their own.
//
// Callers own their normalizer and their built-in set; this owns the policy.
// Source part for app.js. Run `npm run build` after editing.

  // Read a library out of localStorage. `listKey` is the payload's array field
  // ('presets' / 'stamps'). Returns { list, seeded }.
  function readLibraryStore(storageKey, listKey, normalizeList) {
    let stored = null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) stored = JSON.parse(raw);
    } catch (_) {
      stored = null;
    }
    return {
      list: normalizeList(stored && stored[listKey]),
      // Only a payload we could actually parse can claim to have been seeded.
      seeded: !!(stored && stored.seeded),
    };
  }

  // Returns true when the write reached durable storage. Deliberately silent on
  // failure — see the header.
  function writeLibraryStore(storageKey, listKey, version, list) {
    try {
      const payload = { version, seeded: true };
      payload[listKey] = list;
      localStorage.setItem(storageKey, JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Merge incoming entries into `current` by id: an id that already exists is
  // replaced, a new one is appended. Returns the merged list.
  function libraryImportMerge(current, incoming) {
    const byId = new Map((current || []).map(entry => [entry.id, entry]));
    for (const entry of (incoming || [])) byId.set(entry.id, entry);
    return [...byId.values()];
  }

  // The entries in `incoming` that `current` does not already have, by id. Both
  // libraries use this for the "this project uses N you don't have" offer.
  function libraryUnknownEntries(current, incoming) {
    const known = new Set((current || []).map(entry => entry.id));
    return (incoming || []).filter(entry => !known.has(entry.id));
  }

  // Move one entry up (-1) or down (+1), clamped rather than wrapping: a TD
  // holding the button expects the row to stop at the end, not jump to the
  // other one. Returns a new list, or null when nothing moved.
  function libraryMoveEntry(list, id, delta) {
    const next = (list || []).slice();
    const from = next.findIndex(entry => entry.id === id);
    if (from < 0) return null;
    const to = Math.max(0, Math.min(next.length - 1, from + delta));
    if (to === from) return null;
    next.splice(to, 0, next.splice(from, 1)[0]);
    return next;
  }

  // A stable-enough id for a user-created library entry. Not the shared
  // idCounter: these outlive any one project and travel between machines, so
  // they must not collide with board object ids or with each other after an
  // import.
  function libraryEntryId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 10);
  }

  // US-097 code review, 2026-08-23: both library panels rebuild their whole row
  // list with innerHTML after every reorder / rename / delete, which destroys
  // the focused control. Focus then falls to <body>, and because
  // moveBoardMenuFocus is bound on the menu element, keydown no longer passes
  // through it — arrow-key navigation of the menu goes completely dead after
  // one row mutation, and a TD reordering with the keyboard is stranded.
  //
  // Re-focusing the SAME action on the SAME entry also makes the obvious
  // gesture work: press Down-arrow-button repeatedly to walk an entry to the
  // bottom of the list without re-grabbing it each time.
  function refocusLibraryRowControl(listId, entryId, action) {
    const list = document.getElementById(listId);
    if (!list || !entryId || !action) return false;
    const row = list.querySelector('[data-' + action.kind + '-id="' + entryId + '"]');
    if (!row) return false;
    const pick = (name) => row.querySelector(
      '[data-' + action.kind + '-action="' + name + '"]:not([disabled])');
    const control = pick(action.name);
    if (control) { control.focus(); return true; }
    // The control that was pressed can legitimately become disabled — walking
    // an entry to the first row disables its own Up. Fall back to the OPPOSITE
    // arrow, named explicitly.
    //
    // Code review, 2026-08-23: the first version took "the first control in the
    // row that is not disabled", which is the wide Apply/Use button — the one
    // control in the row that CHANGES something. Parking keyboard focus on it
    // at the exact moment a TD is repeat-pressing means the next Space applies
    // the preset (under ADR 0055 a stitch preset silently turns the selected
    // measurement line into a construction mark) or arms the stamp tool and
    // closes the menu. A fallback must never land on a state-changing command.
    const opposite = action.name === 'up' ? 'down' : (action.name === 'down' ? 'up' : null);
    const alternate = opposite ? pick(opposite) : null;
    if (alternate) { alternate.focus(); return true; }
    // Nothing safe in this row (a one-entry list has both arrows disabled).
    // Leave focus where it is rather than move it somewhere destructive.
    return false;
  }
