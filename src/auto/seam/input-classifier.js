// Deterministic, offline input classification for Auto Detect Seam.
// It routes source pixels; it does not ask the TD to confirm or override.

  function autoSeamInputClassification(model) {
    const total = model.width * model.height;
    const histogram = new Uint32Array(32);
    let nearWhite = 0;
    let strongEdge = 0;
    let darkInk = 0;
    for (let index = 0; index < total; index += 1) {
      const luma = model.luma[index];
      histogram[Math.max(0, Math.min(31, Math.floor(luma / 8)))] += 1;
      if (luma >= 242) nearWhite += 1;
      if (luma <= 215) darkInk += 1;
      if (model.gradient[index] >= 60) strongEdge += 1;
    }
    let entropy = 0;
    for (const count of histogram) {
      if (!count) continue;
      const probability = count / total;
      entropy -= probability * Math.log2(probability);
    }
    const features = {
      lumaEntropy32: Number(entropy.toFixed(6)),
      nearWhiteShare: Number((nearWhite / total).toFixed(6)),
      darkInkShare: Number((darkInk / total).toFixed(6)),
      strongEdgeShare: Number((strongEdge / total).toFixed(6)),
      foregroundCoverage: Number((model.maskCount / total).toFixed(6)),
      dominantForegroundColourShare: Number((model.dominantForegroundColourShare || 0).toFixed(6)),
    };
    // Thresholds live in thresholds.js (AUTO_SEAM_THRESHOLDS.classifier) with
    // the corpus measurements that set them. They are routing parameters, not
    // a claim that the garment or seam has been validated.
    const rules = AUTO_SEAM_THRESHOLDS.classifier;
    // A technical flat is sparse high-contrast ink on a white field. Product
    // photos may also be monochrome, so the rule requires both low tonal
    // entropy and a material density of crisp edges.
    if (features.nearWhiteShare >= rules.sparseInk.nearWhiteMin
        && features.lumaEntropy32 <= rules.sparseInk.lumaEntropyMax
        && features.strongEdgeShare >= rules.sparseInk.strongEdgeMin
        && features.darkInkShare >= rules.sparseInk.darkInkMin
        && features.darkInkShare <= rules.sparseInk.darkInkMax) {
      return { value: 'technical_flat', ruleId: 'sparse-high-contrast-ink/v1', features };
    }
    // A colour-filled technical flat (vector fill + crisp black outlines on a
    // white field) fails the sparse-ink rule because the fill is neither white
    // nor sparse, but a vector fill is one exact colour, so one quantized
    // foreground colour dominates; crisp-edge density is the secondary guard.
    if (features.nearWhiteShare >= rules.flatFill.nearWhiteMin
        && features.dominantForegroundColourShare >= rules.flatFill.dominantColourMin
        && features.strongEdgeShare >= rules.flatFill.strongEdgeMin) {
      return { value: 'technical_flat', ruleId: 'flat-fill-with-crisp-outline/v1', features };
    }
    if (features.foregroundCoverage >= rules.productPhoto.foregroundMin
        && features.foregroundCoverage <= rules.productPhoto.foregroundMax) {
      return { value: 'product_photo', ruleId: 'continuous-tone-or-low-edge/v1', features };
    }
    return { value: 'unknown', ruleId: 'abstain-outside-supported-image-rules/v1', features };
  }
