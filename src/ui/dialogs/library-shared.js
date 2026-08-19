// Library dialog: cross-view grouping/formatting helpers used by BOTH the
// "By Style" card grid and the "By Save" flat list.
// Source part for app.js. Run `npm run build` after editing.

  function groupLibraryEntriesByStyle(entries) {
    const byStyle = new Map();
    entries.forEach(entry => {
      const key = entry.styleId || '';
      if (!byStyle.has(key)) byStyle.set(key, []);
      byStyle.get(key).push(entry);
    });
    const groups = [];
    byStyle.forEach((items, styleId) => {
      items.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      groups.push({ styleId, entries: items, latestSavedAt: items[0] ? items[0].savedAt : '' });
    });
    groups.sort((a, b) => {
      if (!a.styleId && b.styleId) return 1;
      if (a.styleId && !b.styleId) return -1;
      return (b.latestSavedAt || '').localeCompare(a.latestSavedAt || '');
    });
    return groups;
  }

  function countDistinctStyles(entries) {
    const seen = new Set();
    entries.forEach(e => seen.add(e.styleId || ''));
    return seen.size;
  }

  function formatLibraryDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + '  ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function buildBadge(text, bg, fg) {
    const el = document.createElement('span');
    el.textContent = text;
    el.style.fontSize = '11px';
    el.style.fontWeight = '600';
    el.style.padding = '2px 8px';
    el.style.borderRadius = '999px';
    el.style.background = bg;
    el.style.color = fg;
    return el;
  }
