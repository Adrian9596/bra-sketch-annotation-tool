# Vendored third-party builds

## opencv-4.x-20260603.js

The official OpenCV.js WASM build now loaded by `index.html` from `vendor/`
instead of the live `https://docs.opencv.org/4.x/opencv.js` alias (~11 MB, WASM
embedded as a `data:` URI — no `.wasm` sidecar). It is vendored so that:

- **Offline is genuinely offline** — detection quality no longer depends on a
  network connection; without it an offline TD silently got the lower-quality
  `FreeOpenCVAPI` fallback.
- **The version is pinned** — `docs.opencv.org/4.x/` is a moving alias
  (it redirected to 4.13.0 in July 2026), which quietly threatened the
  determinism invariant (`npm run golden`).

Provenance:

- Source URL: `https://docs.opencv.org/4.x/opencv.js`
- Byte-exact copy of the 2026-06-03 snapshot
  (`web.archive.org/web/20260603151639id_/https://docs.opencv.org/4.x/opencv.js`;
  fetched via Wayback because docs.opencv.org sits behind a Cloudflare
  browser challenge)
- SHA-256: `5d9eb15f90feecf1c500a9985f746cb3f0ce13e41be164433685c04452ccdd78`
- Size: 11,032,007 bytes

Replacing this file is a **deliberate act**: re-run `npm run golden` and
`npm run accuracy` before and after, and update the filename + this note.
See the runtime load-order notes in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## mindmap.html

"Atlas — Mind Map", a fully self-contained mind-mapping tool (inline
CSS + one inline `<script>`, no external requests, own `localStorage`
namespace `atlas.mindmap.*`). Embedded byte-for-byte, unmodified, and loaded
in an `<iframe>` from the Manual-mode "Mind Map" toolbar button — see
`src/manual/mindmap-mode.js`. It shares no code and no state with the rest of
this app; the two happen to sit in the same repo for offline distribution
only.

Provenance:

- Source: provided directly by the project owner (not fetched from a public
  URL), copied in unchanged on 2026-09-03.
- SHA-256: `29427ac06ca7cf0b2ae984b3d1e602d034a21d8fc0e721e99c0eb07d35e54c4c`
- Size: 272,770 bytes

Replacing this file is a **deliberate act** the same way the OpenCV build
above is: swap the file, verify it is still self-contained (no new external
requests), and update this note.
