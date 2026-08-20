// Auto Mode view-role resolution: which detected view box a POM renders in.
// Source part for app.js. Run `npm run build` after editing.
//
// effectivePomViewRole picks the view box each POM renders in, so a 3-view
// sketch can place front-outer-only POMs in the outer column without
// disturbing the back view. These helpers are consumed by the fixture
// builder (pom-fixture-builder.js), the draft record builder
// (build-draft-annotation.js), the fixture validator (validate-fixture.js)
// and the apply pipeline (apply-drafts.js), so this part loads first in the
// drafts cluster.

  function findDetectedViewForRole(detection, role) {
    const views = Array.isArray(detection && detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection && detection.viewBoxes) ? detection.viewBoxes : []);
    return views.find(v => v && (v.viewRole === role || v.role === role || (role === 'front_outer' && v.role === 'front'))) || null;
  }

  function hasDetectedViewRole(role) {
    const det = state.autoMode && state.autoMode.detection;
    return !!findDetectedViewForRole(det, role);
  }

  function defaultPomViewRole(pom) {
    const entry = POM_TEMPLATE[String(pom)];
    return entry && entry.viewRole ? entry.viewRole : 'front_outer';
  }

  function effectivePomViewRole(pom) {
    const role = defaultPomViewRole(pom);
    if (role === 'front_inner' && !hasDetectedViewRole('front_inner')) return 'front_outer';
    return role;
  }
