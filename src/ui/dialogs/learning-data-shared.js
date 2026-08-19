// Transparent Learning panel: pure formatting helpers reused across the
// telemetry, corrections, meanings and evidence tabs.
// Source part for app.js. Run `npm run build` after editing.

  function td(text, className) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text == null ? '' : String(text);
    return cell;
  }

  // ---- Formatters -----------------------------------------------------
  function formatEvidenceTimestamp(iso, withTime) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (!withTime) return date;
    return date + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function buildSummaryCard({ label, value, tone }) {
    const card = document.createElement('div');
    card.className = 'ld-card';
    const labelEl = document.createElement('div');
    labelEl.className = 'ld-card-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'ld-card-value' + (tone ? ' ' + tone : '');
    valueEl.textContent = value;
    card.appendChild(labelEl);
    card.appendChild(valueEl);
    return card;
  }

  function statusLabelForRow(status) {
    switch (status) {
      case 'active': return 'Active';
      case 'needs-more-samples': return 'Needs more samples';
      case 'large-correction': return 'Large correction';
      case 'conflicting': return 'Conflicting';
      case 'empty': return 'Empty';
      default: return status;
    }
  }

  // Spread/MAD as a percentage of image dimension — mirrors how the
  // median dx/dy column is displayed so the TD can compare magnitudes
  // at a glance.
  function formatLearningSpread(value) {
    const num = Math.abs(Number(value) || 0);
    const pct = num * 100;
    return '±' + pct.toFixed(1) + '%';
  }

  function formatLearningDelta(value) {
    const num = Number(value) || 0;
    const pct = num * 100;
    const sign = pct > 0 ? '+' : (pct < 0 ? '' : ' ');
    return sign + pct.toFixed(1) + '%';
  }

  function formatViewRole(viewRole) {
    if (!viewRole) return '—';
    const map = {
      front: 'Front',
      back: 'Back',
      side: 'Side',
      inside: 'Inside',
      detail: 'Detail',
    };
    return map[String(viewRole).toLowerCase()] || String(viewRole);
  }

  function formatEvidenceSourceKind(kind) {
    if (!kind) return null;
    switch (kind) {
      case 'td-edited-auto-line': return 'Auto + TD edit';
      case 'manual-confirmed-line': return 'Manual confirm';
      case 'td-deleted-auto-line': return 'Auto removed';
      default: return kind;
    }
  }

  function formatTelemetryDuration(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n < 1000) return Math.round(n) + 'ms';
    return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  }

  function formatTelemetryNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '—';
  }
