// US-109 + US-118 Auto Seam — result records shared by every lane: the
// base result, the evidence-pass identities and the abstention builders, so
// both lanes emit identical shapes and tests filter on constants, not strings.
// Source part for app.js.

  // Evidence-pass identities recorded on every candidate (provenance). Each is
  // a deterministic source-pixel pass; the version suffix changes when the
  // pass's definition changes, never silently.
  const AUTO_SEAM_PASSES = {
    nativeRoiSobel: 'native-roi-sobel/v1',
    shortDiagonalAlternation: 'short-diagonal-alternation/v1',
    pathContinuity: 'path-continuity/v1',
    centerFrontContinuity: 'center-front-path-continuity/v1',
    edgeBandTriangleWave: 'edge-band-triangle-wave/v1',
    sourceBackgroundMask: 'source-background-mask/v1',
    adaptiveContinuity: 'adaptive-continuity/v1',
    zigzagPeriodicity: 'zigzag-periodicity/v1',
    pairedSideCorroboration: 'paired-side-corroboration/v1',
    technicalFlatPattern: 'technical-flat-pattern/v1',
  };

  // Abstention codes: the stable identity tests filter on. The `reason` next
  // to a code is prose a TD can read and says WHICH test failed.
  const AUTO_SEAM_ABSTENTIONS = {
    ineligibleView: 'ineligible_view',
    unknownInputClass: 'unknown_input_class',
    insufficientEvidence: 'insufficient_evidence',
    asymmetricEvidence: 'asymmetric_evidence',
    insufficientZigzagTopology: 'insufficient_zigzag_topology',
  };

  function autoSeamPass(passId, status) {
    return { passId, source: 'source_pixels', status };
  }

  function autoSeamImageAbstention(code, reason) {
    return { scope: 'image', code, reason };
  }

  function autoSeamZoneAbstention(zone, side, code, reason, evidence) {
    return { scope: 'zone', zone, side, code, reason, evidence };
  }

  function autoSeamBaseResult(inputClass, eligibility, lane, pipelineVersion, contractVersion = 'photo-stitch-candidate/2') {
    return {
      contractVersion,
      pipelineVersion,
      inputClass,
      analysisLane: lane,
      inputEligible: eligibility.eligible,
      view: {
        role: eligibility.eligible ? 'front_outer' : 'unknown',
        centerAxis: eligibility.eligible ? { status: 'trusted', xTop: eligibility.centerAxisX, xBottom: eligibility.centerAxisX } : { status: 'unavailable', xTop: null, xBottom: null },
      },
      automaticRois: [],
      candidates: [],
      abstentions: [],
      diagnostics: { coverage: eligibility.coverage, symmetryRatio: eligibility.symmetryRatio ?? null },
    };
  }
