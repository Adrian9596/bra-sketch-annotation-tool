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
  // ('presets' / 'stamps'). Returns { list, seeded, version }.
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
      version: Number(stored && stored.version) || 0,
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

  // A stable-enough id for a user-created library entry. Not the shared
  // idCounter: these outlive any one project and travel between machines, so
  // they must not collide with board object ids or with each other after an
  // import.
  function libraryEntryId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 10);
  }

