// US-109 Auto Seam — lane router: coarse 640 px model -> eligibility ->
// deterministic input classification -> one lane, or an explicit `unknown`
// abstention. Pure. Source part for app.js.

  function analyzeAutoSeamSource(sourceImage) {
    const coarseModel = autoSeamPixelModel(sourceImage, 640);
    const coarseEligibility = autoSeamEligibility(coarseModel);
    const inputClass = autoSeamInputClassification(coarseModel);
    if (inputClass.value === 'technical_flat') {
      return analyzeAutoSeamTechnicalFlat(sourceImage, coarseModel, coarseEligibility, inputClass);
    }
    if (inputClass.value === 'product_photo') {
      return analyzeAutoSeamProductPhoto(sourceImage, coarseModel, coarseEligibility, inputClass);
    }
    const result = autoSeamBaseResult(inputClass, coarseEligibility, 'unknown', 'auto-seam-classifier/1');
    result.inputEligible = false;
    result.abstentions.push(autoSeamImageAbstention(AUTO_SEAM_ABSTENTIONS.unknownInputClass,
      'deterministic input rules could not safely select a seam-analysis lane'));
    return result;
  }
