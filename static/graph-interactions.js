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

  // A course node paints its completion checkbox as a node background image
  // sized CHECKBOX_SIZE and anchored to the node's visual top-left corner plus
  // CHECKBOX_INSET. The node's bounding box is padded by half its border width,
  // so hit-testing from the bounding box corner drifts up/left of the drawn
  // control (badly when zoomed in). These helpers derive the hit region from the
  // node's rendered centre/size instead, so it stays aligned with the render.
  var CHECKBOX_SIZE = 16;
  var CHECKBOX_INSET = 7;

  function checkboxHitRect(node) {
    if (!node) return null;
    var zoom = node.cy().zoom();
    var center = node.renderedPosition();
    var x1 = center.x - node.renderedWidth() / 2 + CHECKBOX_INSET * zoom;
    var y1 = center.y - node.renderedHeight() / 2 + CHECKBOX_INSET * zoom;
    return {
      x1: x1,
      y1: y1,
      x2: x1 + CHECKBOX_SIZE * zoom,
      y2: y1 + CHECKBOX_SIZE * zoom
    };
  }

  function hitCheckbox(node, renderedPosition) {
    if (!renderedPosition) return false;
    var rect = checkboxHitRect(node);
    if (!rect) return false;
    return renderedPosition.x >= rect.x1 &&
      renderedPosition.x <= rect.x2 &&
      renderedPosition.y >= rect.y1 &&
      renderedPosition.y <= rect.y2;
  }

  // Cytoscape paints nodes onto the stage canvas, which inherits the stage's
  // grab cursor, so without this the pan cursor covers interactive node content.
  // Track the hovered node and swap the cursor: the plain arrow over a node and
  // a pointer over its clickable control (e.g. the completion checkbox).
  function bindNodeCursor(stage, cy, isControlHit) {
    if (!stage || !cy) return;
    var applied = "";

    function setCursor(value) {
      if (applied === value) return;
      applied = value;
      stage.style.cursor = value;
    }

    cy.on("mousemove", "node", function (event) {
      var overControl = isControlHit && isControlHit(event.target, event.renderedPosition);
      setCursor(overControl ? "pointer" : "default");
    });
    cy.on("mouseout", "node", function () {
      setCursor("");
    });
  }

  global.GraphInteractionSupport = {
    bindRightDragPan: bindRightDragPan,
    bindNodeCursor: bindNodeCursor,
    CHECKBOX_SIZE: CHECKBOX_SIZE,
    CHECKBOX_INSET: CHECKBOX_INSET,
    checkboxHitRect: checkboxHitRect,
    hitCheckbox: hitCheckbox,
    fitToMinimum: fitToMinimum,
    updateFitMinimum: updateFitMinimum
  };
}(window));
