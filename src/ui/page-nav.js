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

  function renderPageTabs() {
    const bar = document.getElementById('pageTabBar');
    if (!bar) return;
    bar.innerHTML = TECH_PACK_PAGES.map(function (p) {
      const active = state.activePage === p.id;
      return '<button type="button" class="' + (active ? 'active' : '') + '" data-page="' + p.id + '"'
        + ' role="tab" aria-selected="' + active + '">' + escapeHtml(p.label) + '</button>';
    }).join('');
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
    }
    if (id === 'bom') {
      ensureBom();
      renderBom();
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
    }
    setActivePage('board');
  }
