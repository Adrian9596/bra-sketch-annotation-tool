// US-097 + US-098 / ADR 0059: the Template quick action in the Tools menu.
//
// US-107: this used to also render #shapeStampList (a quick-pick browse list)
// and own Export/Import Templates JSON here — all of that moved into the
// unified Library dialog (src/ui/dialogs/library-manager-dialog.js), which is
// now the ONLY place a TD browses, picks, or manages saved Templates. What
// stays here is "Save selection as Template…" specifically BECAUSE it reads
// the board's live selection — a board-context action, not a library-browsing
// one — so it belongs in the toolbar the TD is already looking at, not buried
// behind a modal. Every mutation still goes through src/manual/shape-stamps.js,
// which owns the model, the storage and the placement semantics.
// Source part for app.js. Run `npm run build` after editing.

  // One truthful toast per action, worded for that action — the US-096 lesson:
  // showToast queues rather than replaces, so a message fired from inside the
  // storage layer is buried by the caller's own.
  function shapeStampToast(message) {
    showToast(shapeStampsPersisted()
      ? message
      : message + ' (this session only — the browser refused to store it)');
  }

  function saveSelectedLineAsShape() {
    const reason = canSaveShapeStampReason();
    if (reason !== true) { showToast(reason); return; }
    const targets = shapeStampSaveTargets();
    const kind = targets.length > 1 ? `${targets.length} selected paths` : (targets[0].type === 'curved' ? 'Curve' : 'Straight line');
    openLinePresetNameDialog({
      title: 'Save Template',
      sub: `${kind}, including Scratch Area paths outside the sketch. Geometry, styles and Treatments are kept; POM identity and measurements are excluded.`,
      value: '',
      confirmLabel: 'Save Template',
      onConfirm: (name) => {
        const stamp = addShapeStampFromSelection(name);
        if (!stamp) { showToast('Could not save that Template.'); return; }
        shapeStampToast(`Saved "${stamp.name}" — open the Library to place it.`);
      },
    });
  }

  function bindShapeStampPanel() {
    if (!el.shapeStampSaveBtn) return;
    el.shapeStampSaveBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeBoardToolbarMenus(null, false);
      saveSelectedLineAsShape();
    });
  }
