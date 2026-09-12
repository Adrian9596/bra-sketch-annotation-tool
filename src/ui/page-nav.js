// Page navigation shell (US-069, ADR 0038). Source part for app.js.
//
// The tool now hosts more than one page of the tech pack: the Board (sketch
// photos + POM lines, the original single-page app), the MAIN PAGE sheet
// (US-068), and Construction annotation (US-070). They are peers — tabs on
// the shared toolbar, not an app-plus-popup — because all are pages of the
// same tech pack output, not a document you open over the app and dismiss.
//
// TECH_PACK_PAGES is the only place a page is registered. Adding a future
// tech-pack page means adding one entry here and a content element for it to
// show/hide; the tab bar, the show/hide toggle, and the print gating all
// read the registry generically — proven three times now by MAIN PAGE,
// Construction, and BOM (US-072) landing without touching this file's shape.
//
// state.activePage is session-only (like state.selectedImageIds) — which
// page is showing is a view concern, not project data, so it is not part of
// makeSnapshot/buildProjectSnapshot and does not round-trip through undo or
// a saved project. A reopened project always starts on the Board.

  // Each page names the elements it owns rather than one wrapper, because
  // the Board page is the original app shell (toolbar groups + statusbar +
  // canvas), not a single container — wrapping it in one div to get a single
  // toggle point would mean restructuring the whole existing layout.
  const TECH_PACK_PAGES = [
    { id: 'board', label: 'Board', els: ['boardToolbarGroups', 'statusbar', 'workspace'] },
    { id: 'mainpage', label: 'Main Page', els: ['mainPageOverlay'] },
    { id: 'construction', label: 'Construction', els: ['constructionPage'] },
    { id: 'bom', label: 'BOM', els: ['bomPage'] },
    { id: 'preview', label: 'Preview & Export', els: ['previewPage'] },
  ];

  function pageEls(page) {
    return page.els.map(function (idOrClass) {
      return document.getElementById(idOrClass) || document.querySelector('.' + idOrClass);
    }).filter(Boolean);
  }

  function moveTablistFocus(event, tabs) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return false;
    const items = Array.from(tabs || []);
    const current = items.indexOf(document.activeElement);
    if (current < 0 || !items.length) return false;
    event.preventDefault();
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length;
    else next = (current + 1) % items.length;
    const target = items[next];
    const identityAttr = target.hasAttribute('data-page') ? 'data-page'
      : (target.hasAttribute('data-cc-sheet') ? 'data-cc-sheet'
        : (target.hasAttribute('data-bom-variant') ? 'data-bom-variant' : null));
    const identityValue = identityAttr ? target.getAttribute(identityAttr) : null;
    target.focus();
    target.click();
    // Page tabs are rebuilt by setActivePage(). Restore focus to the new DOM
    // node representing the same tab; Construction/BOM tabs stay connected.
    if (!target.isConnected && identityAttr) {
      const replacement = document.querySelector('[' + identityAttr + '="' + identityValue + '"]');
      if (replacement) replacement.focus();
    }
    return true;
  }

  function renderPageTabs() {
    const bar = document.getElementById('pageTabBar');
    if (!bar) return;
    bar.innerHTML = TECH_PACK_PAGES.map(function (p) {
      const active = state.activePage === p.id;
      return '<button type="button" class="' + (active ? 'active' : '') + '" data-page="' + p.id + '"'
        + ' role="tab" aria-selected="' + active + '" tabindex="' + (active ? '0' : '-1') + '">'
        + escapeHtml(p.label) + '</button>';
    }).join('');
  }

  // Bug found 2026-09 by real-browser testing: the BOM and Construction
  // sheets (.bm-combined-view / .cc-combined-view) are wider than common
  // laptop viewports and scroll horizontally — that part was always true —
  // but their ::-webkit-scrollbar styling (index.html) never actually PAINTS
  // on the very first layout after the container goes from `.page-hidden`
  // (display:none) to visible: reading layout (getBoundingClientRect,
  // offsetHeight) does not trigger it, only an actual scroll-position change
  // does, confirmed empirically. Left alone, a TD landing on either page for
  // the first time saw a hard right edge with no scrollbar and no hint that
  // the Bill of Materials table (or the Construction board) continues past
  // it. One real frame at a 1px offset and back — invisible to the TD, since
  // it happens between two rAF callbacks before they perceive the page —
  // is what gets Chrome to paint the thumb; matches the rest of this app's
  // own double-rAF settle pattern (see the various `settle()` helpers used
  // by the test suites) rather than inventing a new timing idiom for it.
  function wakeOverflowScrollbar(container) {
    if (!container) return;
    const overflows = container.scrollWidth > container.clientWidth
      || container.scrollHeight > container.clientHeight;
    if (!overflows) return;
    const x = container.scrollLeft, y = container.scrollTop;
    requestAnimationFrame(() => {
      container.scrollLeft = x + 1;
      container.scrollTop = y + 1;
      requestAnimationFrame(() => {
        container.scrollLeft = x;
        container.scrollTop = y;
      });
    });
  }

  function setActivePage(id) {
    if (!TECH_PACK_PAGES.some(function (p) { return p.id === id; })) return;
    state.activePage = id;
    TECH_PACK_PAGES.forEach(function (p) {
      pageEls(p).forEach(function (el) { el.classList.toggle('page-hidden', p.id !== id); });
    });
    document.body.classList.toggle('mainpage-open', id === 'mainpage');
    document.body.classList.toggle('construction-open', id === 'construction');
    document.body.classList.toggle('bom-open', id === 'bom');
    document.body.classList.toggle('preview-open', id === 'preview');
    renderPageTabs();
    if (id === 'mainpage') {
      ensureMainPage();
      renderMainPage();
    }
    if (id === 'construction') {
      ensureConstruction();
      renderConstruction();
      wakeOverflowScrollbar(document.querySelector('.cc-combined-view'));
    }
    if (id === 'bom') {
      ensureBom();
      renderBom();
      wakeOverflowScrollbar(document.querySelector('.bm-combined-view'));
    }
    if (id === 'preview') {
      ensurePreviewPage();
      renderPreviewPage();
    }
    updateUI();
  }

  function initPageNav() {
    state.activePage = 'board';
    const bar = document.getElementById('pageTabBar');
    if (bar) {
      bar.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-page]');
        if (btn) setActivePage(btn.dataset.page);
      });
      bar.addEventListener('keydown', function (e) {
        moveTablistFocus(e, bar.querySelectorAll('[data-page]'));
      });
    }
    setActivePage('board');
  }
