// US-109 Oracle Semantic ROI contract shared by the seed, overlay, and
// validation scripts. Product runtime must not import this benchmark module.

export const ROI_ZONES = Object.freeze([
  'shoulder_strap',
  'neckline',
  'armhole',
  'cup_edge',
  'cup_seam',
  'underbust_band',
  'side_seam',
  'center_front',
]);

export const PAIRED_ROI_ZONES = Object.freeze(ROI_ZONES.filter(zone => zone !== 'center_front'));
export const ROI_SOURCES = Object.freeze(['draft_pending_td', 'td_confirmed']);
export const ROI_AVAILABILITY = Object.freeze(['available', 'unavailable']);

export function semanticRoiId(zone, side) {
  return `roi-${zone}-${side}`;
}

export function semanticRoiIdentities() {
  return [
    ...PAIRED_ROI_ZONES.flatMap(zone => ['left', 'right'].map(side => ({ zone, side }))),
    { zone: 'center_front', side: 'center' },
  ];
}

export function isUnitPoint(point) {
  return !!point
    && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
    && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1;
}

export function validateSemanticRois(records, filename, assert) {
  const check = typeof assert === 'function'
    ? assert
    : (condition, message) => { if (!condition) throw new Error(message); };
  const label = `${filename}: semanticRois`;
  check(Array.isArray(records), `${label} must be an array`);
  check(records.length === 15, `${label} must contain exactly 15 records, got ${records.length}`);

  const expected = new Set(semanticRoiIdentities().map(({ zone, side }) => `${zone}:${side}`));
  const seenIds = new Set();
  const seenIdentities = new Set();

  records.forEach((roi, index) => {
    const at = `${label}[${index}]`;
    check(roi && typeof roi === 'object', `${at} must be an object`);
    check(ROI_ZONES.includes(roi.zone), `${at}.zone is not in the frozen eight-zone vocabulary`);
    const allowedSides = roi.zone === 'center_front' ? ['center'] : ['left', 'right'];
    check(allowedSides.includes(roi.side), `${at}.side is invalid for ${roi.zone}`);

    const identity = `${roi.zone}:${roi.side}`;
    check(expected.has(identity), `${at} has unexpected identity ${identity}`);
    check(!seenIdentities.has(identity), `${at} duplicates identity ${identity}`);
    seenIdentities.add(identity);

    check(roi.id === semanticRoiId(roi.zone, roi.side),
      `${at}.id must be deterministic (${semanticRoiId(roi.zone, roi.side)})`);
    check(!seenIds.has(roi.id), `${at}.id duplicates ${roi.id}`);
    seenIds.add(roi.id);
    check(ROI_AVAILABILITY.includes(roi.availability), `${at}.availability must be available|unavailable`);
    check(ROI_SOURCES.includes(roi.source), `${at}.source must be draft_pending_td|td_confirmed`);
    check(roi.reviewer === null || (typeof roi.reviewer === 'string' && roi.reviewer.trim().length > 0),
      `${at}.reviewer must be null or non-empty string`);
    check(roi.reviewedAt === null || (typeof roi.reviewedAt === 'string' && Number.isFinite(Date.parse(roi.reviewedAt))),
      `${at}.reviewedAt must be null or a parseable timestamp`);

    if (roi.availability === 'available') {
      check(Array.isArray(roi.polygon) && roi.polygon.length >= 4 && roi.polygon.length <= 8,
        `${at}.polygon must contain 4-8 points when available`);
      roi.polygon.forEach((point, pointIndex) => check(isUnitPoint(point),
        `${at}.polygon[${pointIndex}] must be a finite normalized [0,1] point`));
      check(roi.unavailableReason === null, `${at}.unavailableReason must be null when available`);
    } else {
      check(roi.polygon === null, `${at}.polygon must be null when unavailable`);
      check(typeof roi.unavailableReason === 'string' && roi.unavailableReason.trim().length > 0,
        `${at}.unavailableReason must be non-empty when unavailable`);
    }

    if (roi.source === 'td_confirmed') {
      check(typeof roi.reviewer === 'string' && roi.reviewer.trim().length > 0,
        `${at}: td_confirmed requires reviewer`);
      check(typeof roi.reviewedAt === 'string' && Number.isFinite(Date.parse(roi.reviewedAt)),
        `${at}: td_confirmed requires reviewedAt`);
    }
  });

  for (const identity of expected) check(seenIdentities.has(identity), `${label} is missing ${identity}`);
}
