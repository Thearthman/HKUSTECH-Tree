(function (global) {
  "use strict";

  var ABSOLUTE_MIN_ZOOM = 0.01;

  function updateFitMinimum(cy, elements, padding) {
    if (!cy || !elements || !elements.length) return null;
    cy.minZoom(ABSOLUTE_MIN_ZOOM);
    var viewport = cy.getFitViewport(elements, padding);
    if (!viewport || !Number.isFinite(viewport.zoom)) return null;
    viewport.zoom = Math.max(ABSOLUTE_MIN_ZOOM, Math.min(cy.maxZoom(), viewport.zoom));
    cy.minZoom(viewport.zoom);
    return viewport;
  }

  function fitToMinimum(cy, elements, padding, duration) {
    var viewport = updateFitMinimum(cy, elements, padding);
    if (!viewport) return null;
    if (duration) {
      cy.animate({ zoom: viewport.zoom, pan: viewport.pan, duration: duration });
    } else {
      cy.zoom(viewport.zoom);
      cy.pan(viewport.pan);
    }
    return viewport;
  }

  function bindRightDragPan(container, getCy) {
    var drag = null;

    function finishDrag() {
      if (!drag) return;
      drag = null;
      container.classList.remove("is-right-panning");
    }

    container.addEventListener("mousedown", function (event) {
      if (event.button !== 2) return;
      var cy = getCy();
      if (!cy) return;
      drag = {
        cy: cy,
        x: event.clientX,
        y: event.clientY,
        pan: { x: cy.pan("x"), y: cy.pan("y") }
      };
      container.classList.add("is-right-panning");
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    container.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    global.addEventListener("mousemove", function (event) {
      if (!drag) return;
      drag.cy.pan({
        x: drag.pan.x + event.clientX - drag.x,
        y: drag.pan.y + event.clientY - drag.y
      });
      event.preventDefault();
    }, true);
    global.addEventListener("mouseup", function (event) {
      if (event.button === 2) finishDrag();
    }, true);
    global.addEventListener("blur", finishDrag);
  }

  global.GraphInteractionSupport = {
    bindRightDragPan: bindRightDragPan,
    fitToMinimum: fitToMinimum,
    updateFitMinimum: updateFitMinimum
  };
}(window));
