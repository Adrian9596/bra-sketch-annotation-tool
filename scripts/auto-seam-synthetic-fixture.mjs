// The deterministic synthetic technical flat used by auto-seam-technical-flat-
// check and auto-seam-probe: a strapped front view carrying all four Phase 1
// technical-flat appearances, rendered by Chrome from SVG so the pipeline
// sees real anti-aliased pixels.

const zigzag = (x1, y1, x2, y2, count = 38, amplitude = 5) => {
  const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
  const nx = -dy / length, ny = dx / length;
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    const offset = index === 0 || index === count ? 0 : (index % 2 ? amplitude : -amplitude);
    return `${x1 + dx * t + nx * offset},${y1 + dy * t + ny * offset}`;
  }).join(' ');
};

const quadraticZigzag = (p0, p1, p2, count = 48, amplitude = 5) => Array.from({ length: count + 1 }, (_, index) => {
  const t = index / count, mt = 1 - t;
  const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
  const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
  const tx = 2 * mt * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
  const ty = 2 * mt * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
  const length = Math.max(1, Math.hypot(tx, ty));
  const offset = index === 0 || index === count ? 0 : (index % 2 ? amplitude : -amplitude);
  return `${x - ty / length * offset},${y + tx / length * offset}`;
}).join(' ');

export function syntheticTechnicalFlatSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="900" viewBox="0 0 1000 900">
    <rect width="1000" height="900" fill="white"/>
    <g fill="none" stroke="#151515" stroke-width="3">
      <path d="M155 85 L250 55 L285 330 Q220 460 155 610 Q150 760 205 835 Q500 870 795 835 Q850 760 845 610 Q780 460 715 330 L750 55 L845 85"/>
      <path d="M285 330 Q500 520 715 330"/>
      <path d="M285 55 L285 330 M715 55 L715 330"/>
      <polyline points="${zigzag(250,72,255,340,38,6)}"/>
      <polyline points="${zigzag(750,72,745,340,38,6)}"/>
      <!-- Neckline zigzag ~22 px inside the neckline outline (2.7% of box
           height). The original fixture drew it ~40 px inside (4.9%), twice
           the 1.8–2.5% measured on the three real flats and past the 5.5%
           edge band the detector reads; a stitch that far from its edge is
           not what a real flat looks like. -->
      <polyline points="${quadraticZigzag([285,352],[392,494],[500,447],52,6)}"/>
      <polyline points="${quadraticZigzag([500,447],[608,494],[715,352],52,6)}"/>
      <polyline points="${quadraticZigzag([245,340],[178,462],[150,585],48,6)}"/>
      <polyline points="${quadraticZigzag([755,340],[822,462],[850,585],48,6)}"/>
      <polyline points="${quadraticZigzag([205,821],[500,856],[795,821],96,6)}"/>
      <!-- Plain cup-edge seams. -->
      <path d="M297 464 Q276 632 346 784"/>
      <path d="M703 464 Q724 632 654 784"/>
      <!-- Single dashed cup seams. -->
      <path d="M304 456 Q416 544 472 768" stroke-dasharray="14 10"/>
      <path d="M696 456 Q584 544 528 768" stroke-dasharray="14 10"/>
      <!-- Parallel dashed side seams. The pair is visual evidence only: the
           detector must keep Double Needle vs Cover Stitch unresolved. -->
      <path d="M150 576 Q164 680 206 824" stroke-dasharray="14 10"/>
      <path d="M158 575 Q172 679 214 823" stroke-dasharray="14 10"/>
      <path d="M850 576 Q836 680 794 824" stroke-dasharray="14 10"/>
      <path d="M842 575 Q828 679 786 823" stroke-dasharray="14 10"/>
    </g>
  </svg>`;
}

export function syntheticTechnicalFlatDataUrl() {
  return `data:image/svg+xml;base64,${Buffer.from(syntheticTechnicalFlatSvg()).toString('base64')}`;
}

// Every zigzag the synthetic draws, as the zone/side candidates the lane must
// report for it (straps are template-seeded and not asserted).
export const SYNTHETIC_EXPECTED_ZONES = ['neckline/bilateral', 'armhole/left', 'armhole/right', 'underbust_band/left', 'underbust_band/right'];

export const SYNTHETIC_EXPECTED_APPEARANCES = {
  'cup_edge/left': 'solid_plain',
  'cup_edge/right': 'solid_plain',
  'cup_seam/left': 'single_dashed',
  'cup_seam/right': 'single_dashed',
  'side_seam/left': 'parallel_dashed',
  'side_seam/right': 'parallel_dashed',
};
