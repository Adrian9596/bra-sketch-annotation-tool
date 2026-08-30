#!/usr/bin/env node
// US-106: Template Library Manager — the gallery dialog over
// src/manual/shape-stamps.js (categories, tags, notes, favorites, usage,
// savedSize, mirror-on-place) built on top of the existing US-097/098
// Template contract (scripts/shape-stamps-check.mjs already owns the
// geometric normalize/denormalize claim; this suite owns the LIBRARY
// MANAGEMENT surface — schema, storage, and the real dialog's DOM/pointer
// behavior).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, startStaticServer } from './static-server.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
}

async function main() {
  const started = await startStaticServer(appDir);
  const cdpPort = await getFreePort();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'library-manager-check-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900', `${started.baseUrl}/index.html?contract=librarymanager${Date.now()}`,
  ]);
  let session = null;
  try {
    await waitForCdp(cdpPort);
    session = await openCdpSession(cdpPort);
    await session.waitFor(`!!window.__braAutoModeDebug`, 20000);
    await session.eval(`window.__lmErrors=[];window.addEventListener('error',e=>window.__lmErrors.push(String(e.message||e.type)));window.addEventListener('unhandledrejection',e=>window.__lmErrors.push(String(e.reason&&e.reason.message||e.reason)));true`);

    // ---- 1. Schema: v3 fields + v2 backward compatibility -------------------
    const schema = await session.eval(`(() => {
      const d = window.__braAutoModeDebug;
      d.resetShapeStamps();
      const categories = d.library.categories();
      const asset = d.addTemplateFromAnnotationIds; // sanity: still present (shared with personal-library-check)
      // A hand-built v2 payload (no category/tags/notes/favorite/timestamps/
      // usage/savedSize) must import and normalize with safe defaults, never
      // throw and never silently invent a savedSize.
      const legacy = { format: 'bra-shape-stamps', version: 2, stamps: [{
        id: 'st-legacy', name: 'Legacy stamp', type: 'straight',
        start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, style: 'solid', color: 'black',
        lineWidth: 2, arrowType: 'none', aspect: 1,
      }] };
      d.importShapeStampsJson(JSON.stringify(legacy));
      const stamp = d.getShapeStamps().find(s => s.id === 'st-legacy');
      return { categories, hasAddFn: typeof asset === 'function', stamp };
    })()`);
    check(Array.isArray(schema.categories) && schema.categories.length >= 8
      && schema.categories.every(c => c.id && c.label),
      'libraryCategories() must expose a fixed, non-empty, labeled category list');
    check(schema.categories.some(c => c.id === 'other'), '"other" must be a valid fallback category');
    check(!!schema.stamp, 'a v2 (no US-106 fields) payload must still import');
    check(schema.stamp.category === 'other', 'a v2 stamp with no category must normalize to "other", not throw or drop the entry');
    check(Array.isArray(schema.stamp.tags) && schema.stamp.tags.length === 0, 'a v2 stamp must default to an empty tags array');
    check(schema.stamp.notes === '' && schema.stamp.favorite === false, 'a v2 stamp must default notes to "" and favorite to false');
    check(schema.stamp.usage && schema.stamp.usage.count === 0 && schema.stamp.usage.lastUsedAt === null,
      'a v2 stamp must default usage to {count:0, lastUsedAt:null}');
    check(schema.stamp.savedSize === null, 'a v2 stamp (no captured box) must NOT be given an invented savedSize');

    // ---- 2. A real save captures category + savedSize -----------------------
    const saved = await session.eval(`(() => {
      const d = window.__braAutoModeDebug;
      const ann = { id: 8801, seq: 1, purpose: 'sketch-element', type: 'straight', style: 'solid',
        color: 'red', arrowType: 'none', lineWidth: 2, start: { x: 100, y: 200 }, end: { x: 300, y: 260 },
        control1: null, control2: null, points: [], label: { x: 200, y: 210 }, labelManual: false, text: null, value: null };
      d.styleEvidence.pushAnnotation(ann);
      const asset = d.addTemplateFromAnnotationIds('Cup panel', [8801], { category: 'cup', tags: ['Molded', 'molded', ' padded '], notes: '  test note  ' });
      return { asset };
    })()`);
    check(saved.asset && saved.asset.category === 'cup', 'addTemplateFromAnnotationIds must accept and store an explicit category');
    check(JSON.stringify(saved.asset.tags) === JSON.stringify(['molded', 'padded']),
      `tags must lowercase-trim and dedupe case-insensitively (got ${JSON.stringify(saved.asset.tags)})`);
    check(saved.asset.notes === 'test note', 'notes must be trimmed');
    check(!!saved.asset.createdAt && saved.asset.createdAt === saved.asset.updatedAt, 'a fresh save must stamp createdAt === updatedAt');
    check(!!saved.asset.savedSize && Math.abs(saved.asset.savedSize.width - 200) < 1e-6 && Math.abs(saved.asset.savedSize.height - 60) < 1e-6,
      `savedSize must capture the exact WORLD-unit control-point box (got ${JSON.stringify(saved.asset.savedSize)})`);

    // ---- 3. Metadata mutation + duplicate + favorite/usage -----------------
    const mutations = await session.eval(`(() => {
      const d = window.__braAutoModeDebug;
      const stamp = d.getShapeStamps().find(s => s.name === 'Cup panel');
      const okCategory = d.library.setCategory(stamp.id, 'strap');
      const okTags = d.library.setTags(stamp.id, ['A', 'a', 'b']);
      const okNotes = d.library.setNotes(stamp.id, 'updated note');
      const okFav = d.library.toggleFavorite(stamp.id);
      const after = d.getShapeStamps().find(s => s.id === stamp.id);
      const copy = d.library.duplicate(stamp.id);
      const listAfterCopy = d.getShapeStamps();
      // Mutating the copy must never touch the source (independent records).
      d.library.setCategory(copy.id, 'neckline');
      const sourceStillStrap = d.getShapeStamps().find(s => s.id === stamp.id).category;
      return { okCategory, okTags, okNotes, okFav, after, copy, listAfterCopy, sourceStillStrap };
    })()`);
    check(mutations.okCategory && mutations.okTags && mutations.okNotes && mutations.okFav,
      'every US-106 setter must report success for a real entry id');
    check(mutations.after.category === 'strap', 'setCategory must persist');
    check(JSON.stringify(mutations.after.tags) === JSON.stringify(['a', 'b']), 'setTags must normalize and persist');
    check(mutations.after.notes === 'updated note', 'setNotes must persist');
    check(mutations.after.favorite === true, 'toggleFavorite must flip favorite on from false');
    check(mutations.after.updatedAt !== mutations.after.createdAt, 'any edit must advance updatedAt away from createdAt');
    check(!!mutations.copy && typeof mutations.copy.id === 'string' && mutations.copy.id !== mutations.after.id,
      'duplicate must return a new entry with its own id, distinct from the source');
    check(mutations.copy.name === mutations.after.name + ' copy', 'duplicate must suffix the name with " copy"');
    check(mutations.copy.favorite === false && mutations.copy.usage.count === 0, 'a duplicate must reset favorite and usage, not inherit them');
    check(mutations.listAfterCopy.length === 3, 'duplicate must add exactly one new entry (legacy + cup-panel + its copy)');
    check(mutations.sourceStillStrap === 'strap', 'editing a duplicate must never mutate its source (independent records)');

    // ---- 4. Usage tracking on a REAL mouse-driven placement ----------------
    // Arms the tool through the actual Library dialog card (US-107: this
    // moved from a Tools ▾ row to #libraryBtn's Templates tab) — exactly what
    // library-manager-dialog.js's own card click does (armShapeStampForPlacement,
    // which now also calls setTool('stamp') itself), not the armForPlacement
    // debug seam called from node — a dispatched mousedown/mouseup only
    // reaches placeShapeStamp's code path at all while state.tool==='stamp',
    // and only a real click through the dialog proves the wiring, not just
    // the model function.
    const usage = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug, canvas = document.getElementById('boardCanvas');
      d.meaning.setAppMode('manual');
      document.getElementById('sketchFocusBtn').click();
      const stamp = d.getShapeStamps().find(s => s.name === 'Cup panel');
      const before = stamp.usage.count;
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const card = Array.from(document.querySelectorAll('[data-stamp-id]')).find(c => c.textContent.includes('Cup panel'));
      card.querySelector('[data-card-action="place"]').click();
      const view = d.getView(), rect = canvas.getBoundingClientRect();
      const client = (p) => ({ x: p.x * view.zoom + view.panX + rect.left, y: p.y * view.zoom + view.panY + rect.top });
      const send = (type, p, target = canvas) => target.dispatchEvent(new MouseEvent(type, { clientX: client(p).x, clientY: client(p).y, bubbles: true, button: 0 }));
      send('mousedown', { x: 600, y: 300 }); send('mouseup', { x: 600, y: 300 }, window);
      await new Promise(r => setTimeout(r, 60));
      const after = d.getShapeStamps().find(s => s.id === stamp.id).usage;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { before, after };
    })()`);
    check(usage.before === 0 && usage.after.count === 1 && !!usage.after.lastUsedAt,
      `a real click-placement must bump usage.count and stamp lastUsedAt (got ${JSON.stringify(usage)})`);

    // ---- 5. Bare click reproduces savedSize; mirror flips geometry ---------
    const placement = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug, canvas = document.getElementById('boardCanvas');
      const stamp = d.getShapeStamps().find(s => s.name === 'Cup panel');
      const box = d.library.defaultBoxAt(stamp.id, { x: 500, y: 500 });
      const placedPlain = d.placeTemplateInBox(stamp.id, box);
      const placedMirrored = d.placeTemplateInBox(stamp.id, { x: 900, y: 500, width: box.width, height: box.height }, true);
      return { box, savedSize: stamp.savedSize, placedPlain, placedMirrored };
    })()`);
    check(Math.abs(placement.box.width - placement.savedSize.width) < 1e-6
      && Math.abs(placement.box.height - placement.savedSize.height) < 1e-6,
      'defaultStampBoxAt must reproduce savedSize exactly when present');
    const plainAnn = placement.placedPlain[0];
    const mirroredAnn = placement.placedMirrored[0];
    check(Math.abs((plainAnn.end.x - plainAnn.start.x) - (mirroredAnn.start.x - mirroredAnn.end.x)) < 1e-6
      && Math.abs((plainAnn.end.y - plainAnn.start.y) - (mirroredAnn.end.y - mirroredAnn.start.y)) < 1e-6,
      `mirroring must flip the X extent of the placed geometry while leaving Y unchanged (plain ${JSON.stringify({ s: plainAnn.start, e: plainAnn.end })}, mirrored ${JSON.stringify({ s: mirroredAnn.start, e: mirroredAnn.end })})`);
    check(placement.placedPlain.every(a => a.purpose === 'sketch-element')
      && placement.placedMirrored.every(a => a.purpose === 'sketch-element'),
      'placed Templates (plain and mirrored) must stay Sketch Elements, never POMs (ADR 0058)');

    // ---- 6. Isolation: none of the new fields leak onto BOARD geometry ----
    // Project JSON legitimately embeds a full copy of the shape-stamp
    // LIBRARY itself (state.shapeStamps, via serializeShapeStampsForProject —
    // pre-existing US-097/ADR 0056 behavior so a project can be opened
    // elsewhere and still offer the Templates it was drawn with); that copy
    // is expected to carry every US-106 field. What must NEVER happen is a
    // PLACED annotation on the board (state.annotations — real POM/board
    // geometry) picking up Library-only bookkeeping like savedSize or usage.
    const isolation = await session.eval(`(() => {
      const d = window.__braAutoModeDebug;
      const measured = d.getMeasurementAnnIds();
      const placedIds = [${JSON.stringify(placement.placedPlain.map(a => a.id))}, ${JSON.stringify(placement.placedMirrored.map(a => a.id))}].flat();
      const project = d.exportProject();
      const placedAnns = project.state.annotations.filter(a => placedIds.includes(a.id));
      return {
        anyMeasured: placedIds.some(id => measured.includes(id)),
        placedAnnCount: placedAnns.length,
        annotationsHaveLibraryKeys: placedAnns.some(a => 'savedSize' in a || 'usage' in a || 'favorite' in a),
      };
    })()`);
    check(!isolation.anyMeasured, 'Template members placed via the Library must never enter the POM/measurement set');
    check(isolation.placedAnnCount === 2, `precondition: both placed members (1 plain + 1 mirrored, "Cup panel" has one path) must be found in the exported project (got ${isolation.placedAnnCount})`);
    check(!isolation.annotationsHaveLibraryKeys,
      'a PLACED annotation (board/POM geometry) must never carry Library-only bookkeeping (savedSize/usage/favorite) — only the embedded library snapshot may');

    // ---- 7. The real dialog: open, categories, search, favorite, menu -----
    const dialogBasics = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      // US-107: #libraryBtn opens the unified Library dialog directly —
      // Templates is its default/first tab, so no tab click is needed here.
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const dialogOpen = !!document.querySelector('.lm-body');
      const onTemplatesTab = !!document.querySelector('.lm-tab-btn.lm-tab-active') &&
        document.querySelector('.lm-tab-btn.lm-tab-active').textContent.trim() === 'Templates';
      const railLabels = Array.from(document.querySelectorAll('.lm-rail-btn')).map(b => b.textContent.trim());
      const cardCount = document.querySelectorAll('.lm-card').length;
      // Search for a name only the legacy stamp has.
      const search = document.querySelector('.lm-search');
      search.value = 'Legacy';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const afterLegacySearch = document.querySelectorAll('.lm-card').length;
      search.value = 'zzz-nothing-matches';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const afterNoMatch = document.querySelectorAll('.lm-card').length;
      const emptyMessage = document.querySelector('.lm-empty')?.textContent || '';
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return { dialogOpen, onTemplatesTab, railLabels, cardCount, afterLegacySearch, afterNoMatch, emptyMessage };
    })()`);
    check(dialogBasics.dialogOpen, 'clicking the Library toolbar button must open the unified Library dialog');
    check(dialogBasics.onTemplatesTab, 'the dialog must open on the Templates tab by default');
    check(dialogBasics.railLabels.some(l => l.startsWith('All')) && dialogBasics.railLabels.some(l => l.includes('Favorites'))
      && dialogBasics.railLabels.some(l => l.startsWith('Recent')),
      `rail must include All/Favorites/Recent (got ${JSON.stringify(dialogBasics.railLabels)})`);
    check(dialogBasics.cardCount === 3, `all 3 saved Templates must render as cards (got ${dialogBasics.cardCount})`);
    check(dialogBasics.afterLegacySearch === 1, 'searching "Legacy" must narrow to exactly the one matching card');
    check(dialogBasics.afterNoMatch === 0 && /nothing matches/i.test(dialogBasics.emptyMessage),
      'a query matching nothing must show zero cards and an explicit empty-state message, not a blank grid');

    // ---- 8. Favorite toggle via a real click updates the card + rail ------
    const favoriteClick = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      const card = Array.from(document.querySelectorAll('.lm-card')).find(c => c.textContent.includes('Legacy stamp'));
      const favBtn = card.querySelector('[data-card-action="favorite"]');
      const before = favBtn.getAttribute('aria-pressed');
      favBtn.click();
      await new Promise(r => requestAnimationFrame(r));
      const stamp = d.getShapeStamps().find(s => s.name === 'Legacy stamp');
      const railFavorites = Array.from(document.querySelectorAll('.lm-rail-btn')).find(b => b.textContent.includes('Favorites'))?.textContent;
      return { before, stampFavorite: stamp.favorite, railFavorites };
    })()`);
    check(favoriteClick.before === 'false' && favoriteClick.stampFavorite === true,
      'clicking the card favorite star must flip the underlying model, not just repaint');
    check(/2/.test(favoriteClick.railFavorites || ''), `Favorites rail count must reflect the new total (got "${favoriteClick.railFavorites}")`);

    // ---- 9. The "⋯" card menu renders on-screen (not zero-size/off-viewport) ----
    const cardMenu = await session.eval(`(async () => {
      const card = Array.from(document.querySelectorAll('.lm-card')).find(c => c.textContent.includes('Legacy stamp'));
      const moreBtn = card.querySelector('[data-card-action="menu"]');
      moreBtn.click();
      await new Promise(r => requestAnimationFrame(r));
      const menu = document.querySelector('.lm-card-menu');
      // DOMRect's fields are prototype accessors, not own enumerable
      // properties — JSON.stringify (and CDP's returnByValue) would
      // otherwise serialize it as {}. Copy the needed fields into a plain
      // object explicitly.
      const r = menu ? menu.getBoundingClientRect() : null;
      const rect = r ? { width: r.width, height: r.height, top: r.top, left: r.left } : null;
      const actions = menu ? Array.from(menu.querySelectorAll('[data-menu-action]')).map(b => b.dataset.menuAction) : [];
      const expandedAttr = moreBtn.getAttribute('aria-expanded');
      // Clicking the SAME trigger again must close it (toggle), not open a second copy.
      moreBtn.click();
      await new Promise(r => requestAnimationFrame(r));
      const closedAfterToggle = !document.querySelector('.lm-card-menu');
      return { rect, actions, expandedAttr, closedAfterToggle };
    })()`);
    check(!!cardMenu.rect && cardMenu.rect.width > 0 && cardMenu.rect.height > 0
      && cardMenu.rect.width < 400 && cardMenu.rect.height < 400,
      `the card menu must render at a real, bounded on-screen size, not stretch to fill the viewport (got ${JSON.stringify(cardMenu.rect)})`);
    check(cardMenu.rect.top >= 0 && cardMenu.rect.left >= 0, 'the card menu must not be positioned off the top/left of the viewport');
    check(JSON.stringify(cardMenu.actions) === JSON.stringify(['place-mirrored', 'rename', 'details', 'duplicate', 'export', 'delete']),
      `the card menu must offer exactly the documented actions in order (got ${JSON.stringify(cardMenu.actions)})`);
    check(cardMenu.expandedAttr === 'true', 'the trigger button must report aria-expanded=true while its menu is open');
    check(cardMenu.closedAfterToggle, 'clicking the same "⋯" trigger again must close its own menu (toggle), not stack a second one');

    // ---- 10. Closing the dialog (not via our own Close button) must not ----
    //          orphan a floating card menu in the DOM.
    const orphanCheck = await session.eval(`(async () => {
      const card = Array.from(document.querySelectorAll('.lm-card')).find(c => c.textContent.includes('Legacy stamp'));
      card.querySelector('[data-card-action="menu"]').click();
      await new Promise(r => requestAnimationFrame(r));
      const menuOpenBefore = !!document.querySelector('.lm-card-menu');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      return { menuOpenBefore, dialogGone: !document.querySelector('.lm-body'), menuGone: !document.querySelector('.lm-card-menu') };
    })()`);
    check(orphanCheck.menuOpenBefore, 'precondition: the card menu was open before pressing Escape');
    check(orphanCheck.dialogGone, 'Escape must close the whole Library Manager dialog');
    check(orphanCheck.menuGone, 'closing the dialog via Escape must not leave the floating card menu orphaned in the DOM');

    // ---- 11. Rename / delete via the real dialog + card menu ---------------
    const renameAndDelete = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(r));
      // By stable id, not name — the whole point of this section is to
      // RENAME the card, so a name-based lookup would break on its own
      // second half.
      const card = () => document.querySelector('.lm-card[data-stamp-id="st-legacy"]');
      // The Library Manager dialog's OWN footer "Close" button also carries
      // classes "picker-btn primary" — the same classes every dialog built on
      // buildDialog() gives its confirm button. With the Rename sub-dialog
      // open ON TOP of the still-open Library Manager, a document-wide
      // '.picker-overlay .picker-btn.primary' query matches BOTH; it would
      // find the Library Manager's underlying Close button first (its overlay
      // was appended to <body> earlier and so sorts first in document order),
      // closing the wrong dialog entirely. Always scope to the LAST (i.e.
      // topmost / most-recently-opened) '.picker-overlay'.
      const topOverlay = () => Array.from(document.querySelectorAll('.picker-overlay')).pop();
      card().querySelector('[data-card-action="menu"]').click();
      await new Promise(r => requestAnimationFrame(r));
      document.querySelector('.lm-card-menu [data-menu-action="rename"]').click();
      await new Promise(r => requestAnimationFrame(r));
      const renameOverlay = topOverlay();
      const input = renameOverlay.querySelector('input[type="text"]');
      input.value = 'Renamed legacy stamp';
      renameOverlay.querySelector('.picker-btn.primary').click();
      await new Promise(r => requestAnimationFrame(r));
      const renamed = d.getShapeStamps().find(s => s.id === 'st-legacy')?.name;
      const countBefore = d.getShapeStamps().length;
      card().querySelector('[data-card-action="menu"]').click();
      await new Promise(r => requestAnimationFrame(r));
      const nativeConfirm = window.confirm;
      window.confirm = () => true;
      document.querySelector('.lm-card-menu [data-menu-action="delete"]').click();
      window.confirm = nativeConfirm;
      await new Promise(r => requestAnimationFrame(r));
      const countAfter = d.getShapeStamps().length;
      return { renamed, countBefore, countAfter };
    })()`);
    check(renameAndDelete.renamed === 'Renamed legacy stamp', 'Rename… in the card menu must persist the new name');
    check(renameAndDelete.countAfter === renameAndDelete.countBefore - 1, 'Delete… (after confirm) must remove exactly that entry');

    // ---- 12. US-107: tab switching, and the Treatments tab's own rail/search/apply/duplicate ----
    //
    // shape-stamps-check.mjs and line-presets-check.mjs each drive isolated
    // Treatments-tab actions (arm-by-name, export, import-project, delete)
    // for THEIR OWN narrower claims; this is the one place that owns the
    // Treatments tab's own gallery contract — parallel to section 7-9 above
    // for Templates — and the mechanics of switching between all three tabs.
    const treatmentsTab = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      d.resetLinePresets();
      // Section 11 left its own dialog open (it never clicks Close) — close
      // it before opening a fresh one, or this would stack a second
      // .picker-overlay on top and "Treatments" would only ever get clicked
      // in whichever copy sorts first in document order.
      document.querySelector('.dialog-close')?.click();
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tabBtn = (label) => Array.from(document.querySelectorAll('.lm-tab-btn')).find(b => b.textContent.trim() === label);
      // Scoped to the VISIBLE panel throughout: both tabs' markup stays in
      // the DOM at once ([hidden] on the inactive one, per US-107's
      // .lm-content-body:not([hidden]) CSS rule), and Templates + Treatments
      // both use .lm-search/.lm-rail-btn/[data-card-action="menu"] — an
      // unscoped query silently hits whichever tab was built first.
      const active = () => document.querySelector('.lm-content-body:not([hidden])');
      tabBtn('Treatments').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const activeLabel = document.querySelector('.lm-tab-btn.lm-tab-active').textContent.trim();
      const visiblePanelCount = document.querySelectorAll('.lm-content-body:not([hidden])').length;
      const railLabels = Array.from(active().querySelectorAll('.lm-rail-btn')).map(b => b.textContent.trim());
      const allCount = active().querySelectorAll('[data-preset-id]').length;
      const search = active().querySelector('.lm-search');
      search.value = 'Zigzag';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const afterSearch = active().querySelectorAll('[data-preset-id]').length;
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      // Rail: filter to Treatments only (excludes the 2 built-in Looks).
      Array.from(active().querySelectorAll('.lm-rail-btn')).find(b => b.textContent.trim().startsWith('Treatments')).click();
      const treatmentsOnlyCount = active().querySelectorAll('[data-preset-id]').length;
      Array.from(active().querySelectorAll('.lm-rail-btn')).find(b => b.textContent.trim().startsWith('All')).click();
      // Duplicate via the card menu (parallels section 11's Templates coverage).
      const zigzagCard = Array.from(active().querySelectorAll('[data-preset-id]')).find(c => c.textContent.includes('Zigzag'));
      const beforeDup = d.getLinePresets().length;
      zigzagCard.querySelector('[data-card-action="menu"]').click();
      await new Promise(r => requestAnimationFrame(r));
      document.querySelector('.lm-card-menu [data-menu-action="duplicate"]').click();
      await new Promise(r => requestAnimationFrame(r));
      const afterDup = d.getLinePresets();
      // Apply a "look" (POM line) with nothing selected: sets board defaults
      // and closes the dialog (mirrors library-manager-dialog.js's own
      // applyLinePreset-return-value gate). The dialog is still open on
      // Treatments from the duplicate step above — Duplicate never closes
      // it, so re-clicking #libraryBtn here would stack a second overlay.
      const pomCard = Array.from(active().querySelectorAll('[data-preset-id]')).find(c => c.textContent.includes('POM line'));
      pomCard.querySelector('[data-card-action="apply"]').click();
      await new Promise(r => requestAnimationFrame(r));
      const closedAfterApply = !document.querySelector('.picker-overlay');
      return {
        activeLabel, visiblePanelCount, railLabels, allCount, afterSearch, treatmentsOnlyCount,
        beforeDup, afterDupCount: afterDup.length,
        duplicateName: afterDup.find(p => p.name === 'Zigzag (blue, no arrow) copy')?.name || null,
        closedAfterApply,
      };
    })()`);
    check(treatmentsTab.activeLabel === 'Treatments', 'clicking the Treatments tab must make it the active tab');
    check(treatmentsTab.visiblePanelCount === 1, 'switching to Treatments must hide the Templates panel, not stack both visibly');
    check(treatmentsTab.railLabels.map(l => l.replace(/\s+\d+$/, '')).join('|') === 'All|Treatments|Looks',
      `the Treatments rail must be All/Treatments/Looks, not the Templates category taxonomy (got ${JSON.stringify(treatmentsTab.railLabels)})`);
    check(treatmentsTab.allCount === 6, `the 6 built-in Treatments/Looks must all render as cards (got ${treatmentsTab.allCount})`);
    check(treatmentsTab.afterSearch === 1, `searching "Zigzag" must narrow to exactly one card (got ${treatmentsTab.afterSearch})`);
    check(treatmentsTab.treatmentsOnlyCount === 4,
      `the Treatments rail filter must show only kind:"treatment" entries, excluding the 2 Looks (got ${treatmentsTab.treatmentsOnlyCount})`);
    check(treatmentsTab.afterDupCount === treatmentsTab.beforeDup + 1, 'Duplicate in the Treatments card menu must add exactly one entry');
    check(treatmentsTab.duplicateName === 'Zigzag (blue, no arrow) copy', 'the duplicate must suffix the name with " copy", matching Templates');
    check(treatmentsTab.closedAfterApply === true,
      'applying a Look with nothing selected must succeed (sets board defaults) and close the dialog');

    // ---- 13. US-107: the Projects tab embeds the (async, IndexedDB-backed) ----
    //          Project Library pane, lazily and without its own footer/Close.
    const projectsTab = await session.eval(`(async () => {
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tabBtn = (label) => Array.from(document.querySelectorAll('.lm-tab-btn')).find(b => b.textContent.trim() === label);
      tabBtn('Projects').click();
      // Read immediately: if this pane were NOT lazy, "Loading…" would already
      // have resolved by the time a real IndexedDB round trip could finish.
      const summaryImmediately = document.querySelector('.library-summary')?.textContent || '';
      await new Promise(r => setTimeout(r, 200));
      const hasStyleTab = Array.from(document.querySelectorAll('.library-tabs button')).some(b => b.textContent === 'By Style');
      const hasSaveTab = Array.from(document.querySelectorAll('.library-tabs button')).some(b => b.textContent === 'By Save');
      // The Projects pane renders no footer/Close of its own — only the ONE
      // shared dialog footer, or Escape/Close would do nothing different from
      // the outer dialog's already-proven behavior in section 10 above.
      const footerCloseCount = document.querySelectorAll('.picker-footer .picker-btn.primary').length;
      document.querySelector('.dialog-close').click();
      return { summaryImmediately, hasStyleTab, hasSaveTab, footerCloseCount,
        dialogGone: !document.querySelector('.picker-overlay') };
    })()`);
    check(projectsTab.summaryImmediately === 'Loading…',
      `the Projects pane must show a Loading state immediately, proving its IndexedDB fetch is genuinely async, not pre-fetched (got ${JSON.stringify(projectsTab.summaryImmediately)})`);
    check(projectsTab.hasStyleTab && projectsTab.hasSaveTab, 'the embedded Projects pane must keep its own By Style / By Save sub-tabs');
    check(projectsTab.footerCloseCount === 1, 'the Projects tab must use the ONE shared dialog footer, not render a second Close button of its own');
    check(projectsTab.dialogGone === true, 'the shared Close button must still close the whole dialog from the Projects tab');

    // ---- 14. Codex audit LIB-01 (2026-08-30): the top-level tab strip is a ----
    //          REAL ARIA tab pattern (id/aria-controls/roving tabindex, arrow-
    //          key navigation), and the rail filters no longer misuse role=tab.
    const ariaTabs = await session.eval(`(async () => {
      document.querySelector('.dialog-close')?.click();
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tabBtn = (label) => Array.from(document.querySelectorAll('.lm-tab-btn')).find(b => b.textContent.trim() === label);
      const relationOk = (label) => {
        const btn = tabBtn(label);
        if (!btn || !btn.id || !btn.getAttribute('aria-controls')) return false;
        const panel = document.getElementById(btn.getAttribute('aria-controls'));
        return !!panel && panel.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === btn.id;
      };
      const relationsOk = ['Templates', 'Treatments', 'Projects'].every(relationOk);
      const tabindexOf = (label) => tabBtn(label).getAttribute('tabindex');
      const initialTabindexes = { templates: tabindexOf('Templates'), treatments: tabindexOf('Treatments'), projects: tabindexOf('Projects') };
      const press = (key) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      tabBtn('Templates').focus();
      press('ArrowRight');
      await new Promise(r => requestAnimationFrame(r));
      const afterRight = {
        activeLabel: document.querySelector('.lm-tab-btn.lm-tab-active').textContent.trim(),
        focusedLabel: document.activeElement.textContent.trim(),
        visiblePanelCount: document.querySelectorAll('.lm-content-body:not([hidden])').length,
        treatmentsPanelHidden: document.getElementById('lm-panel-treatments').hidden,
      };
      press('ArrowLeft');
      await new Promise(r => requestAnimationFrame(r));
      const afterLeft = { activeLabel: document.querySelector('.lm-tab-btn.lm-tab-active').textContent.trim(), focusedLabel: document.activeElement.textContent.trim() };
      press('End');
      await new Promise(r => requestAnimationFrame(r));
      const afterEnd = { activeLabel: document.querySelector('.lm-tab-btn.lm-tab-active').textContent.trim() };
      press('Home');
      await new Promise(r => requestAnimationFrame(r));
      const afterHome = { activeLabel: document.querySelector('.lm-tab-btn.lm-tab-active').textContent.trim() };
      const zeroCount = Array.from(document.querySelectorAll('.lm-tab-btn')).filter(b => b.getAttribute('tabindex') === '0').length;
      const templatesRail = document.querySelector('.lm-content-body:not([hidden]) .lm-rail');
      const railBtn = templatesRail.querySelector('.lm-rail-btn');
      const railRoleOk = templatesRail.getAttribute('role') !== 'tab' && railBtn.getAttribute('role') !== 'tab';
      const railPressedOk = railBtn.hasAttribute('aria-pressed');
      document.querySelector('.dialog-close').click();
      return { relationsOk, initialTabindexes, afterRight, afterLeft, afterEnd, afterHome, zeroCount, railRoleOk, railPressedOk };
    })()`);
    check(ariaTabs.relationsOk, 'every top-level tab must have an id/aria-controls pair pointing at a role=tabpanel with a matching aria-labelledby');
    check(ariaTabs.initialTabindexes.templates === '0' && ariaTabs.initialTabindexes.treatments === '-1' && ariaTabs.initialTabindexes.projects === '-1',
      `only the active tab may be a Tab stop (got ${JSON.stringify(ariaTabs.initialTabindexes)})`);
    check(ariaTabs.afterRight.activeLabel === 'Treatments' && ariaTabs.afterRight.focusedLabel === 'Treatments',
      `ArrowRight from Templates must select AND focus Treatments (got ${JSON.stringify(ariaTabs.afterRight)})`);
    check(ariaTabs.afterRight.visiblePanelCount === 1 && ariaTabs.afterRight.treatmentsPanelHidden === false,
      'ArrowRight must show only the Treatments panel, not stack both visibly');
    check(ariaTabs.afterLeft.activeLabel === 'Templates' && ariaTabs.afterLeft.focusedLabel === 'Templates',
      `ArrowLeft from Treatments must select AND focus Templates back (got ${JSON.stringify(ariaTabs.afterLeft)})`);
    check(ariaTabs.afterEnd.activeLabel === 'Projects', `End must select the last tab (got "${ariaTabs.afterEnd.activeLabel}")`);
    check(ariaTabs.afterHome.activeLabel === 'Templates', `Home must select the first tab (got "${ariaTabs.afterHome.activeLabel}")`);
    check(ariaTabs.zeroCount === 1, `exactly one top-level tab may carry tabindex="0" at a time (got ${ariaTabs.zeroCount})`);
    check(ariaTabs.railRoleOk, 'the Templates rail (a filter, not a tabpanel switcher) must not declare role="tab"');
    check(ariaTabs.railPressedOk, 'a rail filter button must expose aria-pressed instead of the retired aria-selected/role=tab pairing');

    // ---- 15. Codex audit LIB-02 (2026-08-30): the Save CTAs are honest about ----
    //          which branch they are about to take, proven through the real
    //          dialog UI (not the debug seam) per the audit's own requirement.
    const honestCtas = await session.eval(`(async () => {
      const d = window.__braAutoModeDebug;
      const topOverlay = () => Array.from(document.querySelectorAll('.picker-overlay')).pop();
      const tabBtn = (label) => Array.from(document.querySelectorAll('.lm-tab-btn')).find(b => b.textContent.trim() === label);
      d.clearSelection();
      document.querySelector('.dialog-close')?.click();
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const templatesTopRow = () => document.querySelector('.lm-content-body:not([hidden]) .lm-top-row');
      const noSelectionTemplateBtn = templatesTopRow().querySelector('.picker-btn');
      const noSelectionState = {
        disabled: noSelectionTemplateBtn.disabled,
        hasReason: /select one or more lines/i.test(noSelectionTemplateBtn.title || '')
          || /select one or more lines/i.test(noSelectionTemplateBtn.getAttribute('aria-label') || ''),
      };
      tabBtn('Treatments').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const treatmentsTopRow = () => document.querySelector('.lm-content-body:not([hidden]) .lm-top-row');
      const noSelectionTreatmentBtn = treatmentsTopRow().querySelector('.picker-btn');
      const noSelectionLabel = noSelectionTreatmentBtn.textContent.trim();
      noSelectionTreatmentBtn.click();
      await new Promise(r => requestAnimationFrame(r));
      const noSelectionDialogTitle = topOverlay().querySelector('h2')?.textContent.trim() || '';
      const noSelectionDialogHasPlaceholder = !!topOverlay().querySelector('input[placeholder="e.g. Zigzag 3 mm"]');
      topOverlay().querySelector('.dialog-close').click();
      await new Promise(r => requestAnimationFrame(r));
      // #libraryBtn has no "already open" guard — close the Library dialog
      // itself before seeding a board selection and reopening, or the next
      // click would stack a second .picker-overlay on top of this one.
      document.querySelector('.dialog-close')?.click();
      await new Promise(r => requestAnimationFrame(r));
      const ann = { id: 88801, seq: 900, purpose: 'sketch-element', type: 'straight', style: 'solid',
        color: 'black', arrowType: 'none', lineWidth: 2, start: { x: 50, y: 50 }, end: { x: 150, y: 60 },
        control1: null, control2: null, points: [], label: { x: 100, y: 40 }, labelManual: false, text: null, value: null };
      d.styleEvidence.pushAnnotation(ann);
      d.selectAnnotation(88801);
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const withSelectionTemplateBtn = templatesTopRow().querySelector('.picker-btn');
      const withSelectionState = { disabled: withSelectionTemplateBtn.disabled, label: withSelectionTemplateBtn.textContent.trim() };
      tabBtn('Treatments').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const withSelectionTreatmentBtn = treatmentsTopRow().querySelector('.picker-btn');
      const withSelectionLabel = withSelectionTreatmentBtn.textContent.trim();
      withSelectionTreatmentBtn.click();
      await new Promise(r => requestAnimationFrame(r));
      const withSelectionDialogTitle = topOverlay().querySelector('h2')?.textContent.trim() || '';
      topOverlay().querySelector('.dialog-close').click();
      await new Promise(r => requestAnimationFrame(r));
      document.querySelector('.dialog-close')?.click();
      d.clearSelection();
      return {
        noSelectionState, noSelectionLabel, noSelectionDialogTitle, noSelectionDialogHasPlaceholder,
        withSelectionState, withSelectionLabel, withSelectionDialogTitle,
      };
    })()`);
    check(honestCtas.noSelectionState.disabled === true, 'the Template CTA must be disabled with nothing selected on the board');
    check(honestCtas.noSelectionState.hasReason,
      'the Template CTA must expose the "select one or more lines" reason as a tooltip/accessible description while disabled');
    check(honestCtas.noSelectionLabel === 'Save current Line Look…',
      `with nothing selected, the Treatment CTA must say it will save the current Line Look, not "Save selection as Treatment…" (got "${honestCtas.noSelectionLabel}")`);
    check(honestCtas.noSelectionDialogTitle === 'Save line preset' && honestCtas.noSelectionDialogHasPlaceholder,
      `the no-selection Treatment CTA must open the Save-line-preset (Look) flow (got title "${honestCtas.noSelectionDialogTitle}")`);
    check(honestCtas.withSelectionState.disabled === false && honestCtas.withSelectionState.label === 'Save selection as Template…',
      `with a line selected, the Template CTA must be enabled with its normal label (got ${JSON.stringify(honestCtas.withSelectionState)})`);
    check(honestCtas.withSelectionLabel === 'Save selected path as Treatment…',
      `with a line selected, the Treatment CTA must say it will save the SELECTED PATH as a Treatment (got "${honestCtas.withSelectionLabel}")`);
    check(honestCtas.withSelectionDialogTitle === 'Save Line Treatment',
      `with a line selected, the Treatment CTA must open the layered Treatment editor, not the Look name-prompt (got title "${honestCtas.withSelectionDialogTitle}")`);

    // ---- 16. Codex audit LIB-03 (2026-08-30): 480px / large-zoom reflow -------
    const referenceHeights = await session.eval(`(async () => {
      document.querySelector('.dialog-close')?.click();
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const panel = document.querySelector('.lm-content-body:not([hidden])');
      const heights = Array.from(panel.querySelectorAll('.lm-top-row .picker-btn')).map(b => Math.round(b.getBoundingClientRect().height));
      document.querySelector('.dialog-close').click();
      return heights;
    })()`);
    await session.cdp('Emulation.setDeviceMetricsOverride', { width: 480, height: 800, deviceScaleFactor: 1, mobile: false });
    await session.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))`);
    const reflow480 = await session.eval(`(async () => {
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const panel = document.querySelector('.lm-content-body:not([hidden])');
      const topRow = panel.querySelector('.lm-top-row');
      const searchRect = topRow.querySelector('.lm-search').getBoundingClientRect();
      const buttons = Array.from(topRow.querySelectorAll('.picker-btn'));
      const btnRects = buttons.map(b => b.getBoundingClientRect());
      const dialogRect = document.querySelector('.dialog-panel').getBoundingClientRect();
      const gridRect = panel.querySelector('.lm-grid').getBoundingClientRect();
      const footerBtn = document.querySelector('.picker-footer .picker-btn.primary');
      return {
        searchBottom: Math.round(searchRect.bottom), topRowWidth: Math.round(topRow.getBoundingClientRect().width),
        searchWidth: Math.round(searchRect.width),
        btnHeights: btnRects.map(r => Math.round(r.height)), btnTops: btnRects.map(r => Math.round(r.top)),
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        dialogLeft: Math.round(dialogRect.left), dialogRight: Math.round(dialogRect.right),
        viewportWidth: document.documentElement.clientWidth,
        gridWidth: Math.round(gridRect.width),
        footerVisible: !!footerBtn && !!footerBtn.offsetParent,
      };
    })()`);
    check(!reflow480.pageOverflow, `480px must not create document-level horizontal overflow (got ${JSON.stringify(reflow480)})`);
    check(reflow480.dialogLeft >= 0 && reflow480.dialogRight <= reflow480.viewportWidth + 1,
      `480px: the dialog must stay fully inside the viewport (got left ${reflow480.dialogLeft}, right ${reflow480.dialogRight}, viewport ${reflow480.viewportWidth})`);
    check(reflow480.searchWidth >= reflow480.topRowWidth - 4,
      `480px: the search field must wrap onto its own full-width row, not share a row with the buttons (search ${reflow480.searchWidth}px vs row ${reflow480.topRowWidth}px)`);
    check(reflow480.btnTops.every(top => top >= reflow480.searchBottom - 1),
      '480px: the action buttons must sit BELOW the wrapped search row, not squeezed onto the same line');
    check(JSON.stringify(reflow480.btnHeights) === JSON.stringify(referenceHeights),
      `480px must not wrap either action button's own label onto multiple lines — heights must match the un-squeezed reference (480px ${JSON.stringify(reflow480.btnHeights)} vs reference ${JSON.stringify(referenceHeights)})`);
    check(reflow480.gridWidth >= 150, `480px: the gallery must keep at least one card's usable width, the grid's own minmax() floor (got ${reflow480.gridWidth}px)`);
    check(reflow480.footerVisible, '480px: the shared footer/Close button must stay visible, not hidden by the reflow');
    await session.cdp('Emulation.clearDeviceMetricsOverride', {});
    await session.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))`);

    // ---- 17. Codex audit LIB-04 (2026-08-30): Projects empty state is a SINGLE ----
    //          message, and the shared footer follows the Projects tab too.
    const projectsEmpty = await session.eval(`(async () => {
      document.querySelector('.dialog-close')?.click();
      document.getElementById('libraryBtn').click();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const tabBtn = (label) => Array.from(document.querySelectorAll('.lm-tab-btn')).find(b => b.textContent.trim() === label);
      tabBtn('Projects').click();
      await new Promise(r => setTimeout(r, 250));
      const footerText = document.querySelector('.picker-footer .picker-count').textContent;
      const summaryText = document.querySelector('.library-summary').textContent;
      const bodyEmptyMessages = Array.from(document.querySelectorAll('.library-list')).map(el => el.textContent.trim()).filter(Boolean);
      tabBtn('Templates').click();
      await new Promise(r => requestAnimationFrame(r));
      tabBtn('Projects').click();
      await new Promise(r => requestAnimationFrame(r));
      const footerAfterReturn = document.querySelector('.picker-footer .picker-count').textContent;
      document.querySelector('.dialog-close').click();
      return { footerText, summaryText, bodyEmptyMessages, footerAfterReturn };
    })()`);
    check(projectsEmpty.footerText === '0 saves' && projectsEmpty.summaryText === '0 saves',
      `an empty Projects library must show a terse "0 saves" in both the near-filter summary and the shared footer, not the body's own "No projects/styles…" wording repeated (got footer "${projectsEmpty.footerText}", summary "${projectsEmpty.summaryText}")`);
    check(projectsEmpty.bodyEmptyMessages.length === 1 && /no (projects|styles)/i.test(projectsEmpty.bodyEmptyMessages[0]),
      `exactly one empty-state message with a clear next action must remain, in the grid/list body itself (got ${JSON.stringify(projectsEmpty.bodyEmptyMessages)})`);
    check(projectsEmpty.footerAfterReturn === '0 saves',
      `returning to the Projects tab must restore ITS OWN status in the shared footer, not leave whichever tab was open just before it (got "${projectsEmpty.footerAfterReturn}")`);

    // ---- 18. No page errors across the whole run ---------------------------
    const errors = await session.eval(`window.__lmErrors||[]`);
    check(errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
    console.log(`library-manager-check: PASS (${passed} checks)`);
  } finally {
    if (session) session.close();
    await new Promise(resolve => { chrome.once('exit', resolve); chrome.kill('SIGTERM'); });
    await new Promise(resolve => started.server.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

async function waitForCdp(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch (_) {}
    await sleep(100);
  }
  throw new Error('Chrome CDP did not start');
}

async function openCdpSession(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  if (!target) throw new Error('No Chrome page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await cdp('Runtime.enable');
  const evalJs = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'eval failed');
    return result.result.value;
  };
  const waitFor = async (expression, timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { if (await evalJs(expression)) return; } catch (_) {}
      await sleep(100);
    }
    throw new Error(`waitFor timeout: ${expression}`);
  };
  return { eval: evalJs, waitFor, cdp, close: () => ws.close() };
}

main().catch(error => {
  console.error('library-manager-check: FAIL');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
