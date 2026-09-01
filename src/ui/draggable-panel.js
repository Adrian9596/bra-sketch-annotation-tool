// Drag-to-reposition for a floating `.anchor-panel` by its header — generic,
// reusable across every panel that opts in (currently Pattern Pieces and
// Pattern Measurements; Anchor Manager deliberately not wired, see its CSS
// comment). Each panel's CSS docks it to a corner via left/right/top/bottom;
// the FIRST pointerdown converts whichever of those the panel currently has
// into an explicit left/top in pixels (relative to its offsetParent, the
// board card), so every drag after that is a plain delta regardless of which
// corner the panel started in. Position persists for the session simply
// because it lives in the element's own inline style — closing/reopening the
// panel (a `hidden` toggle) never touches it, and nothing here claims to
// survive a reload.
// Source part for app.js. Run `npm run build` after editing.

  // Keeps the panel fully inside its offsetParent (the board card) so a TD
  // can never drag one somewhere its own header is no longer reachable to
  // drag back.
  function clampDraggablePanelPosition(panel, left, top) {
    const parent = panel.offsetParent;
    const maxLeft = parent ? Math.max(0, parent.clientWidth - panel.offsetWidth) : left;
    const maxTop = parent ? Math.max(0, parent.clientHeight - panel.offsetHeight) : top;
    return { left: clamp(left, 0, maxLeft), top: clamp(top, 0, maxTop) };
  }

  // A STRICTLY INCREASING counter, not a fixed bump value — shared across
  // every draggable panel. Two panels ever sharing one literal z-index value
  // (e.g. both set to '21') fall back to DOM order to break the tie, which
  // silently ignores which one the TD actually touched most recently; only
  // an always-higher value guarantees "last touched is on top" holds even
  // after both panels have been raised at least once.
  let draggablePanelZIndexCounter = 20;

  function bringDraggablePanelToFront(panel) {
    draggablePanelZIndexCounter += 1;
    panel.style.zIndex = String(draggablePanelZIndexCounter);
  }

  // Every panel that has opted into dragging, so a single board-card resize
  // can re-clamp all of them at once (see armDraggablePanelResizeObserver).
  const registeredDraggablePanels = [];

  // Re-clamps one already-dragged panel (i.e. one with an explicit
  // style.left/top, not still CSS-docked to a corner) back inside its
  // CURRENT offsetParent bounds. A panel a TD parked near an edge is valid
  // the moment they let go of it, but the board card can shrink later for
  // reasons that have nothing to do with dragging — narrowing the window, a
  // contextual toolbar row appearing/disappearing and reflowing the layout —
  // and nothing about a resize on its own re-runs the drag's own clamp.
  // Left uncorrected, that can push the panel (including its own header)
  // outside `.board-card`'s `overflow:hidden` box, with nothing left
  // on-screen to click to drag it back — the same "TD's own header becomes
  // unreachable" failure the overlap bring-to-front fix exists for, just
  // from a resize instead of another panel.
  function reclampDraggablePanelIfPositioned(panel) {
    if (panel.hidden || panel.style.left === '' || panel.style.top === '') return;
    const { left, top } = clampDraggablePanelPosition(panel, parseFloat(panel.style.left), parseFloat(panel.style.top));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function reclampAllDraggablePanels() {
    for (const panel of registeredDraggablePanels) reclampDraggablePanelIfPositioned(panel);
  }

  // One shared observer for every draggable panel's common offsetParent
  // (the board card), armed once on the first panel registered — mirrors
  // src/manual/viewport.js's initCanvasResizeObserver, the same "react to
  // the actual box changing, not every event that might cause it" approach
  // this codebase already uses for the canvas's own backing-buffer invariant.
  let draggablePanelResizeObserverArmed = false;
  function armDraggablePanelResizeObserver(boardCard) {
    if (draggablePanelResizeObserverArmed || typeof ResizeObserver !== 'function' || !boardCard) return;
    draggablePanelResizeObserverArmed = true;
    new ResizeObserver(() => reclampAllDraggablePanels()).observe(boardCard);
  }

  // `handle` is what starts the drag (the panel's header); `excludeSelector`
  // (e.g. '.anchor-panel-close') marks real controls inside it that must
  // start their own click, never a drag. Pointer Events (not mouse+touch
  // duplicated) so mouse, touch and pen all work through one path — this is
  // an isolated DOM-panel gesture, independent of the canvas's own separate
  // touch-input.js translation layer.
  function makeDraggablePanel(panel, handle, excludeSelector) {
    if (!panel || !handle) return;
    registeredDraggablePanels.push(panel);
    // el.boardCard, not panel.offsetParent — at bind time (app init) every
    // panel is still `hidden` (display:none), and a display:none element's
    // offsetParent is always null.
    armDraggablePanelResizeObserver(el.boardCard);
    let drag = null; // { pointerId, startClientX, startClientY, startLeft, startTop }

    // Bring-to-front on ANY press inside the panel, not only a drag. Once
    // two panels overlap, the covered one's HEADER can end up physically
    // hidden under the other panel's body — a TD who clicks a still-visible
    // sliver or button on the covered panel first raises it (exposing its
    // header again), and only then can they actually grab it to drag it
    // clear. Capture phase, so this always runs before any inner button's
    // own click handler, and it fires for every panel unconditionally
    // (there is nothing to exclude here — being touched at all, even via
    // the close button, still means "this is the one the TD means right now").
    panel.addEventListener('pointerdown', () => bringDraggablePanelToFront(panel), true);

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (excludeSelector && event.target.closest(excludeSelector))) return;
      const parentRect = panel.offsetParent ? panel.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
      const panelRect = panel.getBoundingClientRect();
      // Lock in the CURRENT visual position as explicit left/top — replaces
      // whatever right/bottom docked the panel to its starting corner. Also
      // clamped right here, not only in pointermove below: if the panel was
      // already out of bounds (e.g. a resize shrank the board card before
      // this click — the ResizeObserver above should have already fixed
      // that, but a plain click-no-move gesture must self-heal too, not
      // only a real drag), the very click that starts a new drag is what
      // snaps it back rather than starting the drag from an invalid origin.
      const locked = clampDraggablePanelPosition(panel, panelRect.left - parentRect.left, panelRect.top - parentRect.top);
      panel.style.left = locked.left + 'px';
      panel.style.top = locked.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.classList.add('anchor-panel-dragging');
      drag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: locked.left,
        startTop: locked.top,
      };
      // Capture keeps the drag tracking even if the pointer leaves the
      // header mid-move (a fast drag). Not load-bearing for correctness —
      // pointermove still bubbles through the handle while the pointer stays
      // over it either way — so a browser/environment that refuses capture
      // (e.g. a pointerId with no matching active-pointer entry) degrades to
      // "works while over the handle" instead of throwing out of the whole
      // gesture.
      try { handle.setPointerCapture(event.pointerId); } catch (err) { /* degrade gracefully, see above */ }
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { left, top } = clampDraggablePanelPosition(
        panel,
        drag.startLeft + (event.clientX - drag.startClientX),
        drag.startTop + (event.clientY - drag.startClientY),
      );
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    });

    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      panel.classList.remove('anchor-panel-dragging');
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
