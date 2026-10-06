(function () {
  "use strict";

  var DEFAULT_YEAR = "2026-27";
  var DEFAULT_RELATIONS = ["prerequisite", "corequisite", "exclusion"];
  var STORAGE_PREFIX = "hkust-course-tree";
  var HIDE_FULFILLED_KEY = STORAGE_PREFIX + ":hide-fulfilled-prereq";
  var DEPT_STACK_KEY = STORAGE_PREFIX + ":dept-stack";
  var SEARCH_DELAY = 180;
  var HOVER_GROUP_COUNT = 5;
  // Department borders use a fixed 10-colour categorical palette. A department
  // owns a slot in the persistent department stack (see syncDepartments) and
  // the slot index picks the colour; slots never move or get recalculated, so a
  // colour is only shared once more than ten departments are in the stack. This
  // palette is the ONLY thing a course node's border encodes -- see AGENTS.md.
  var DEPT_COLOR_COUNT = 10;
  var DEPT_FALLBACK_COLORS = [
    "#2b6cb0", "#c05621", "#2f855a", "#c53030", "#6b46c1",
    "#8c5a3c", "#b83280", "#2c7a7b", "#8a7000", "#4a5568"
  ];
  // Completion-checkbox geometry is shared with the hit test so the clickable
  // area can never drift from the painted control (see graph-interactions.js).
  var SUPPORT = window.GraphInteractionSupport || {};
  var CHECKBOX_SIZE = SUPPORT.CHECKBOX_SIZE || 16;
  var CHECKBOX_INSET = SUPPORT.CHECKBOX_INSET || 7;
  // Accept "/ustree", "/ustree/", and "/ustree.html" so the page keeps working
  // whether the host uses clean URLs or serves the .html asset directly.
  var PAGE_PATH = window.location.pathname.replace(/\/+$/, "").replace(/\.html$/i, "");
  var IS_USTREE_PAGE = PAGE_PATH === "/ustree";

  // Design choice: the USTree is a study plan, so it only ever loads the
  // backward prerequisite/corequisite pathway. The Course page additionally
  // shows the courses that directly use the selected course as a prerequisite.
  var GRAPH_DIRECTION = IS_USTREE_PAGE ? "backward" : "both";

  // Graph colors are read from CSS custom properties so the canvas follows the
  // active light/dark theme. geometry()/graphStyles() are rebuilt on theme
  // changes, which also regenerates the embedded checkbox/star data URIs.
  function graphTheme() {
    return window.HKUSTTheme ? window.HKUSTTheme.colors() : {};
  }

  // Tick authored for a checkbox rect whose top-left is (1,1). Every checkbox
  // image reuses it (translating as needed) so the tick can never drift out of
  // its box -- e.g. the target image paints the box at CHECKBOX_INSET.
  function checkboxCheckMark(palette) {
    return '<path d="M4 8.2 6.8 11 12.5 5" fill="none" stroke="' + (palette["checkbox-check"] || "#fff") + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function checkboxSvg(completed) {
    var palette = graphTheme();
    var fill = completed ? (palette.accent || "#176b4b") : (palette["checkbox-bg"] || "rgba(255,255,255,0.9)");
    var stroke = completed ? (palette.accent || "#176b4b") : (palette["checkbox-border"] || "#59665e");
    var check = completed ? checkboxCheckMark(palette) : "";
    return '<rect x="1" y="1" width="14" height="14" rx="2" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>' + check;
  }

  function checkboxImage(completed) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
      checkboxSvg(completed) + "</svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function targetImage(completed) {
    var palette = graphTheme();
    var starFill = palette["star-fill"] || "#c18720";
    var starStroke = palette["star-stroke"] || "#805a12";
    // The box is painted at CHECKBOX_INSET, so shift the shared tick to match
    // (the small checkbox keeps it at (1,1) instead).
    var check = completed
      ? '<g transform="translate(' + (CHECKBOX_INSET - 1) + ' ' + (CHECKBOX_INSET - 1) + ')">' + checkboxCheckMark(palette) + "</g>"
      : "";
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="184" height="66" viewBox="0 0 184 66">' +
      '<rect x="' + CHECKBOX_INSET + '" y="' + CHECKBOX_INSET + '" width="' + (CHECKBOX_SIZE - 2) + '" height="' + (CHECKBOX_SIZE - 2) + '" rx="2" fill="' + (completed ? (palette.accent || "#176b4b") : (palette["checkbox-bg"] || "rgba(255,255,255,0.9)")) + '" stroke="' + (completed ? (palette.accent || "#176b4b") : (palette["checkbox-border"] || "#59665e")) + '" stroke-width="1.5"/>' +
      check +
      // Nudge the star down so it rides the same row as the checkbox instead of
      // hugging the node's top edge.
      '<polygon points="161,2.5 163.6,6.8 168.6,7.7 164.8,11.1 165.8,16.1 161,13.8 156.2,16.1 157.2,11.1 153.4,7.7 158.4,6.8" transform="translate(0 4.5)" fill="' + starFill + '" stroke="' + starStroke + '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>' +
      '</svg>';
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  var elements = {
    catalogMeta: document.getElementById("catalogMeta"),
    yearSelect: document.getElementById("yearSelect"),
    syncButton: document.getElementById("syncButton"),
    courseSearch: document.getElementById("courseSearch"),
    searchResults: document.getElementById("searchResults"),
    coursePageLink: document.getElementById("coursePageLink"),
    ustreePageLink: document.getElementById("ustreePageLink"),
    relationInputs: Array.prototype.slice.call(document.querySelectorAll(".relations input")),
    depthSelect: document.getElementById("depthSelect"),
    highlightDepthSelect: document.getElementById("highlightDepthSelect"),
    hideFulfilledToggle: document.getElementById("hideFulfilledToggle"),
    graphTab: document.getElementById("graphTab"),
    outlineTab: document.getElementById("outlineTab"),
    graphPanel: document.getElementById("graphPanel"),
    outlinePanel: document.getElementById("outlinePanel"),
    graphStage: document.getElementById("graphStage"),
    graphCanvas: document.getElementById("graphCanvas"),
    graphLoading: document.getElementById("graphLoading"),
    graphEmpty: document.getElementById("graphEmpty"),
    emptyTitle: document.getElementById("emptyTitle"),
    emptyText: document.getElementById("emptyText"),
    emptyAction: document.getElementById("emptyAction"),
    zoomOut: document.getElementById("zoomOut"),
    zoomIn: document.getElementById("zoomIn"),
    fitGraph: document.getElementById("fitGraph"),
    refocusGraph: document.getElementById("refocusGraph"),
    ustreeLink: document.getElementById("ustreeLink"),
    ustreeLinkCount: document.getElementById("ustreeLinkCount"),
    ustreeManager: document.getElementById("ustreeManager"),
    ustreeButton: document.getElementById("ustreeButton"),
    ustreeCount: document.getElementById("ustreeCount"),
    ustreeMenu: document.getElementById("ustreeMenu"),
    ustreeMenuSummary: document.getElementById("ustreeMenuSummary"),
    ustreeTargets: document.getElementById("ustreeTargets"),
    ustreeEmpty: document.getElementById("ustreeEmpty"),
    notice: document.getElementById("appNotice"),
    noticeText: document.getElementById("noticeText"),
    noticeAction: document.getElementById("noticeAction"),
    dismissNotice: document.getElementById("dismissNotice"),
    outlineEyebrow: document.getElementById("outlineEyebrow"),
    outlineTitle: document.getElementById("outlineTitle"),
    outlineSummary: document.getElementById("outlineSummary"),
    outlineContent: document.getElementById("outlineContent"),
    detailsDrawer: document.getElementById("detailsDrawer"),
    detailsSubject: document.getElementById("detailsSubject"),
    detailsCode: document.getElementById("detailsCode"),
    detailsContent: document.getElementById("detailsContent"),
    closeDrawer: document.getElementById("closeDrawer"),
    drawerScrim: document.getElementById("drawerScrim")
  };

  function createHoverState() {
    var support = window.GraphInteractionSupport;
    if (support && support.createHoverState) return support.createHoverState();
    // Minimal fallback so the page keeps working if the helper module is
    // missing; it mirrors static/graph-interactions.js createHoverState().
    var pinned = null;
    var hovered = null;
    function decision(apply, id) { return { apply: apply, id: id }; }
    return {
      pinnedId: function () { return pinned; },
      activeId: function () { return pinned || hovered; },
      isPinned: function () { return pinned != null; },
      enter: function (id) {
        if (pinned != null) return decision(false, pinned);
        hovered = id == null ? null : String(id);
        return decision(true, hovered);
      },
      leave: function () {
        if (pinned != null) return decision(false, pinned);
        hovered = null;
        return decision(true, null);
      },
      pin: function (id) {
        pinned = id == null ? null : String(id);
        hovered = pinned;
        return decision(true, pinned);
      },
      release: function () {
        if (pinned == null && hovered == null) return decision(false, null);
        pinned = null;
        hovered = null;
        return decision(true, null);
      },
      reset: function () { pinned = null; hovered = null; }
    };
  }

  var state = {
    catalogs: [],
    year: DEFAULT_YEAR,
    target: null,
    targets: [],
    graph: null,
    cy: null,
    selectedId: null,
    completions: new Set(),
    detailCache: new Map(),
    searchItems: [],
    searchIndex: -1,
    searchTimer: null,
    searchController: null,
    graphController: null,
    detailsController: null,
    syncing: false,
    noticeAction: null,
    initializedTarget: false,
    graphErrors: [],
    hover: createHoverState(),
    // Set when a mobile long press has already handled a node so the trailing
    // tap does not also run (cytoscape fires taphold and then tap on release).
    suppressNodeTap: false,
    requirementStatus: new Map(),
    // Persistent course-department -> palette-slot stack. A removed slot is a
    // `null` hole so every other department keeps its index (and colour). See
    // syncDepartments/AGENTS.md; never rebuild or re-sort it.
    deptStack: [],
    hideFulfilledPrereq: true,
    mobileLayout: window.matchMedia("(max-width: 620px)").matches
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeCode(value) {
    var match = String(value || "").trim().toUpperCase().match(/^([A-Z]{2,5})\s*([0-9]{4}[A-Z]?)$/);
    return match ? match[1] + " " + match[2] : String(value || "").trim().toUpperCase();
  }

  function trimText(value, length) {
    var text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > length ? text.slice(0, Math.max(1, length - 3)).trim() + "..." : text;
  }

  function numericLevel(value) {
    if (value == null || value === "") return null;
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function creditLabel(value) {
    var text = String(value == null ? "" : value).trim();
    if (!text) return "";
    return /\bcredits?\b/i.test(text) ? text : text + " credits";
  }

  function catalogClient() {
    if (!window.HKUSTCatalog) {
      throw new Error("The catalog client failed to load. Reload the page and try again.");
    }
    return window.HKUSTCatalog;
  }

  function catalogYear(catalog) {
    return String(catalog.year || catalog.academic_year || catalog.academicYear || "");
  }

  function catalogCount(catalog) {
    var value = catalog.courseCount;
    if (value == null) value = catalog.course_count;
    if (value == null) value = catalog.courses;
    return Number(value || 0);
  }

  function currentCatalog() {
    return state.catalogs.find(function (catalog) {
      return catalogYear(catalog) === state.year;
    }) || null;
  }

  function formatDate(value) {
    if (!value) return null;
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function updateCatalogMeta() {
    var catalog = currentCatalog();
    if (!catalog || !catalogCount(catalog)) {
      elements.catalogMeta.textContent = state.year + " catalog unavailable";
      return;
    }
    var count = catalogCount(catalog).toLocaleString();
    var timestamp = catalog.lastSuccessfulSync || catalog.last_successful_sync || catalog.last_synced || catalog.refreshed_at || catalog.updated_at;
    var formatted = formatDate(timestamp);
    elements.catalogMeta.textContent = count + " courses" + (formatted ? " | Updated " + formatted : "");
  }

  function setNotice(message, type, actionLabel, action) {
    if (!message) {
      elements.notice.hidden = true;
      state.noticeAction = null;
      return;
    }
    elements.notice.className = "notice" + (type ? " is-" + type : "");
    elements.noticeText.textContent = message;
    elements.noticeAction.hidden = !actionLabel;
    elements.noticeAction.textContent = actionLabel || "";
    state.noticeAction = typeof action === "function" ? action : null;
    elements.notice.hidden = false;
  }

  function setGraphState(kind, title, text, actionLabel, action) {
    elements.graphLoading.hidden = kind !== "loading";
    elements.graphEmpty.hidden = kind !== "empty" && kind !== "error";
    elements.graphCanvas.hidden = kind === "loading" || kind === "empty" || kind === "error";
    if (kind === "empty" || kind === "error") {
      elements.emptyTitle.textContent = title || "No course selected";
      elements.emptyText.textContent = text || "Search for a course to build its tree.";
      elements.emptyAction.hidden = !actionLabel;
      elements.emptyAction.textContent = actionLabel || "";
      elements.emptyAction.onclick = typeof action === "function" ? action : null;
    }
  }

  function selectedRelations() {
    return elements.relationInputs.filter(function (input) {
      return input.checked;
    }).map(function (input) {
      return input.value;
    });
  }

  function selectedPrerequisiteDepth() {
    var value = elements.highlightDepthSelect && elements.highlightDepthSelect.value;
    if (value === "all") return Infinity;
    var depth = Number(value);
    return Number.isFinite(depth) ? Math.max(1, depth) : 1;
  }

  function completionKey() {
    return STORAGE_PREFIX + ":completed:" + state.year;
  }

  function targetKey() {
    return STORAGE_PREFIX + ":target:" + state.year;
  }

  function focusedCourseKey() {
    return STORAGE_PREFIX + ":focus:" + state.year;
  }

  function loadFocusedCourse() {
    try {
      return normalizeCode(localStorage.getItem(focusedCourseKey()) || "");
    } catch (_error) {
      return "";
    }
  }

  function saveFocusedCourse(code) {
    try {
      localStorage.setItem(focusedCourseKey(), normalizeCode(code));
    } catch (_error) {
      setNotice("The selected course could not be saved in this browser.", "error");
    }
  }

  function normalizeTargets(values) {
    if (window.USTreeSupport && typeof window.USTreeSupport.normalizeTargets === "function") {
      return window.USTreeSupport.normalizeTargets(values);
    }
    var seen = new Set();
    (Array.isArray(values) ? values : []).forEach(function (value) {
      var code = normalizeCode(value);
      if (/^[A-Z]{2,5} \d{4}[A-Z]?$/.test(code)) seen.add(code);
    });
    return Array.from(seen).sort();
  }

  function loadTargets() {
    if (window.USTreeSupport && typeof window.USTreeSupport.loadTargets === "function") {
      state.targets = normalizeTargets(window.USTreeSupport.loadTargets(localStorage, state.year));
      return state.targets;
    }
    var values = [];
    try {
      var stored = localStorage.getItem(STORAGE_PREFIX + ":ustree:" + state.year);
      if (stored !== null) values = JSON.parse(stored);
      else values = [localStorage.getItem(targetKey()) || ""];
    } catch (_error) {
      values = [];
    }
    state.targets = normalizeTargets(values);
    return state.targets;
  }

  function saveTargets() {
    state.targets = normalizeTargets(state.targets);
    try {
      if (window.USTreeSupport && typeof window.USTreeSupport.saveTargets === "function") {
        state.targets = window.USTreeSupport.saveTargets(localStorage, state.year, state.targets);
      } else {
        localStorage.setItem(STORAGE_PREFIX + ":ustree:" + state.year, JSON.stringify(state.targets));
      }
    } catch (_error) {
      setNotice("Your USTree could not be saved in this browser.", "error");
    }
    renderUstreeMenu();
  }

  function hasTarget(code) {
    return state.targets.indexOf(normalizeCode(code)) !== -1;
  }

  function addTarget(code) {
    var normalized = normalizeCode(code);
    if (!/^[A-Z]{2,5} \d{4}[A-Z]?$/.test(normalized)) return false;
    if (hasTarget(normalized)) return false;
    state.targets = normalizeTargets(state.targets.concat([normalized]));
    saveTargets();
    if (IS_USTREE_PAGE) loadGraph();
    else if (state.hideFulfilledPrereq) renderGraph();
    renderDetailsTargetAction(normalized);
    return true;
  }

  function removeTarget(code) {
    var normalized = normalizeCode(code);
    if (!hasTarget(normalized)) return false;
    state.targets = state.targets.filter(function (target) { return target !== normalized; });
    saveTargets();
    if (IS_USTREE_PAGE) loadGraph();
    else if (state.hideFulfilledPrereq) renderGraph();
    renderDetailsTargetAction(normalized);
    return true;
  }

  function renderUstreeMenu() {
    var targets = normalizeTargets(state.targets);
    elements.ustreeCount.textContent = String(targets.length);
    elements.ustreeLinkCount.textContent = String(targets.length);
    elements.ustreeMenuSummary.textContent = targets.length + (targets.length === 1 ? " target" : " targets");
    elements.ustreeEmpty.hidden = targets.length !== 0;
    elements.ustreeTargets.innerHTML = targets.map(function (code) {
      var status = requirementStatusFor(code);
      var badge = status
        ? '<span class="ustree-target-status is-' + escapeHtml(status) + '" title="' + escapeHtml(requirementStatusLabel(status)) + '">' + escapeHtml(requirementStatusLabel(status)) + '</span>'
        : '<span class="ustree-target-status is-pending" title="Complete some courses to check this target\'s prerequisites">Checking...</span>';
      return '<div class="ustree-target"><button class="ustree-target-course" type="button" data-ustree-code="' + escapeHtml(code) + '">' + escapeHtml(code) + '</button>' + badge + '<button class="ustree-target-remove" type="button" data-remove-ustree="' + escapeHtml(code) + '" aria-label="Remove ' + escapeHtml(code) + ' from USTree" title="Remove from USTree">&times;</button></div>';
    }).join("");
  }

  function toggleUstreeMenu(force) {
    if (!elements.ustreeMenu) return;
    var open = force == null ? elements.ustreeMenu.hidden : Boolean(force);
    elements.ustreeMenu.hidden = !open;
    elements.ustreeButton.setAttribute("aria-expanded", String(open));
  }

  function loadCompletions() {
    var values = [];
    try {
      values = JSON.parse(localStorage.getItem(completionKey()) || "[]");
    } catch (_error) {
      values = [];
    }
    state.completions = new Set(Array.isArray(values) ? values.map(normalizeCode) : []);
  }

  function saveCompletions() {
    try {
      localStorage.setItem(completionKey(), JSON.stringify(Array.from(state.completions).sort()));
    } catch (_error) {
      setNotice("Completed courses could not be saved in this browser.", "error");
    }
  }

  // Hiding fulfilled prerequisites/corequisites is on by default; the
  // control-bar toggle remembers an explicit opt-out across sessions.
  function loadHideFulfilled() {
    try {
      var stored = localStorage.getItem(HIDE_FULFILLED_KEY);
      return stored === null ? true : stored === "1";
    } catch (_error) {
      return true;
    }
  }

  function saveHideFulfilled(value) {
    try {
      localStorage.setItem(HIDE_FULFILLED_KEY, value ? "1" : "0");
    } catch (_error) {
      // The preference simply does not persist when storage is unavailable.
    }
  }

  // Re-read every imported value from localStorage so the visible page reflects
  // the file immediately (the transfer module merges into storage first).
  function applyImportedData(summary) {
    state.hideFulfilledPrereq = loadHideFulfilled();
    if (elements.hideFulfilledToggle) elements.hideFulfilledToggle.checked = state.hideFulfilledPrereq;
    loadCompletions();
    loadTargets();
    refreshRequirementStatuses();
    renderUstreeMenu();
    if (summary && summary.preferences && summary.preferences.indexOf("theme") !== -1 &&
        window.HKUSTTheme && window.HKUSTDataTransfer && window.HKUSTDataTransfer.loadTheme) {
      var theme = window.HKUSTDataTransfer.loadTheme(localStorage);
      if (theme) window.HKUSTTheme.set(theme);
    }
    if (IS_USTREE_PAGE || state.target) loadGraph();
    else renderOutline();
  }

  function bindDataTransfer() {
    if (!window.HKUSTDataTransfer || typeof window.HKUSTDataTransfer.bind !== "function") return;
    window.HKUSTDataTransfer.bind({
      // Read the year lazily so an import after a catalog-year switch still
      // lands a year-less (legacy) file on the right catalog.
      year: function () { return state.year; },
      onApplied: applyImportedData
    });
  }

  // The graph with redundant prerequisite/corequisite branches removed, or the
  // raw graph when the toggle is off. Computed on demand so ticking a
  // completion or flipping the toggle is reflected immediately.
  function activeGraph() {
    if (!state.hideFulfilledPrereq || !state.graph) return state.graph;
    var support = window.USTreeSupport;
    if (!support || typeof support.hiddenFulfilledPrereqNodes !== "function") return state.graph;
    // Starred USTree targets count as complete, so a planned course can fulfil
    // a requirement (prerequisite or corequisite) and hide its redundant
    // alternatives.
    var planned = normalizeTargets(state.targets);
    var hidden = support.hiddenFulfilledPrereqNodes(state.graph, state.completions, planned);
    if (!hidden || !hidden.length) return state.graph;
    var hiddenIds = new Set(hidden);
    return {
      nodes: state.graph.nodes.filter(function (node) { return !hiddenIds.has(node.id); }),
      edges: state.graph.edges.filter(function (edge) {
        return !hiddenIds.has(edge.source) && !hiddenIds.has(edge.target);
      })
    };
  }

  // -------------------------------------------------------------------------
  // USTree prerequisite check
  // -------------------------------------------------------------------------
  // Each starred target carries a verdict describing whether its finished
  // courses already cover its prerequisites. The verdicts are derived from the
  // target's parsed requirement expression (not the depth-limited graph), so a
  // shallow tree cannot hide a missing prerequisite.
  function requirementSupport() {
    return window.USTreeSupport && typeof window.USTreeSupport.requirementStatus === "function"
      ? window.USTreeSupport
      : null;
  }

  function requirementStatusFor(code) {
    var status = state.requirementStatus.get(normalizeCode(code));
    return status || null;
  }

  function requirementStatusLabel(status) {
    var support = requirementSupport();
    if (support) return support.requirementStatusLabel(status);
    return status === "unmet" ? "Prereqs not met" : status === "unknown" ? "Prereqs unclear" : "Prereqs met";
  }

  function requirementStatusMarker(status) {
    var support = requirementSupport();
    if (support) return support.requirementStatusMarker(status);
    return status === "unmet" ? "\u2717" : "?";
  }

  function refreshRequirementStatuses() {
    state.requirementStatus = new Map();
    if (!IS_USTREE_PAGE) return;
    var client = window.HKUSTCatalog;
    var support = requirementSupport();
    if (!client || typeof client.record !== "function" || !support) return;
    normalizeTargets(state.targets).forEach(function (code) {
      var course = client.record(code);
      if (!course) return;
      state.requirementStatus.set(code, support.requirementStatus(course, state.completions));
    });
  }

  // Re-apply the verdict to already rendered nodes without rebuilding the
  // graph, so ticking a checkbox updates the starred targets in place.
  function applyRequirementStatuses() {
    if (!state.cy) return;
    state.cy.nodes().filter(function (node) {
      return node.data("type") === "course" && requirementStatusFor(node.data("code"));
    }).forEach(function (node) {
      var status = requirementStatusFor(node.data("code"));
      node.removeClass("is-prereq-met is-prereq-unmet is-prereq-unknown is-prereq-completed");
      node.addClass("is-prereq-" + status);
      node.data("displayLabel", nodeDisplayLabel(node.data()));
    });
  }

  function refreshDetailsPrereqStatus() {
    var chip = document.getElementById("detailsPrereqStatus");
    if (!chip) return;
    var status = requirementStatusFor(elements.detailsCode.textContent);
    if (!status) {
      chip.remove();
      return;
    }
    chip.className = "meta-chip is-prereq-" + status;
    chip.textContent = requirementStatusLabel(status);
  }

  function storedTarget() {
    return state.targets[0] || "";
  }

  function configurePage() {
    document.body.dataset.page = IS_USTREE_PAGE ? "ustree" : "course";
    document.title = IS_USTREE_PAGE ? "USTree | HKUST Course Tree" : "Course | HKUST Course Tree";
    elements.coursePageLink.setAttribute("aria-current", IS_USTREE_PAGE ? "false" : "page");
    elements.ustreePageLink.setAttribute("aria-current", IS_USTREE_PAGE ? "page" : "false");
    elements.ustreeLink.hidden = IS_USTREE_PAGE;
    elements.ustreeManager.hidden = !IS_USTREE_PAGE;
    elements.outlineEyebrow.textContent = IS_USTREE_PAGE ? "USTree pathway" : "Course pathway";
    elements.courseSearch.placeholder = IS_USTREE_PAGE
      ? "Find a course to add to USTree"
      : "View a course by code or title";
    if (elements.hideFulfilledToggle) elements.hideFulfilledToggle.checked = state.hideFulfilledPrereq;
  }

  async function loadCatalogs(options) {
    var settings = options || {};
    try {
      var client = catalogClient();
      var catalogs = await client.catalogs();
      state.catalogs = Array.isArray(catalogs) ? catalogs : [];
      var serverDefault = client.DEFAULT_YEAR || DEFAULT_YEAR;
      var availableYears = state.catalogs.map(catalogYear).filter(Boolean);
      var years = Array.from(new Set(availableYears.concat([serverDefault, state.year || DEFAULT_YEAR])));
      years.sort().reverse();
      elements.yearSelect.innerHTML = years.map(function (year) {
        return '<option value="' + escapeHtml(year) + '">' + escapeHtml(year) + "</option>";
      }).join("");
      if (!years.includes(state.year)) state.year = serverDefault;
      elements.yearSelect.value = state.year;
      updateCatalogMeta();

      if (!settings.preserveNotice) setNotice(null);
      return state.catalogs;
    } catch (error) {
      updateCatalogMeta();
      setNotice(error.message, "error", "Retry", loadCatalogs);
      return [];
    }
  }

  function renderSearchResults(items, message) {
    state.searchItems = items || [];
    state.searchIndex = state.searchItems.length ? 0 : -1;
    if (message || !state.searchItems.length) {
      elements.searchResults.innerHTML = '<div class="search-message">' + escapeHtml(message || "No matching courses") + "</div>";
    } else {
      elements.searchResults.innerHTML = state.searchItems.map(function (course, index) {
        var code = course.code || course.id || "";
        var title = course.title || course.name || "Untitled course";
        return '<button class="search-option' + (index === state.searchIndex ? " is-active" : "") + '" type="button" role="option" aria-selected="' + (index === state.searchIndex ? "true" : "false") + '" data-index="' + index + '">' +
          "<strong>" + escapeHtml(code) + "</strong><span>" + escapeHtml(title) + "</span></button>";
      }).join("");
    }
    elements.searchResults.hidden = false;
    elements.courseSearch.setAttribute("aria-expanded", "true");
  }

  function hideSearchResults() {
    elements.searchResults.hidden = true;
    elements.courseSearch.setAttribute("aria-expanded", "false");
    state.searchIndex = -1;
  }

  async function queryCourses(query, options) {
    var settings = options || {};
    if (state.searchController) state.searchController.abort();
    state.searchController = new AbortController();
    if (!settings.silent) renderSearchResults([], "Searching...");
    try {
      var courses = await catalogClient().search(state.year, query, 30, {
        signal: state.searchController.signal
      });
      return Array.isArray(courses) ? courses : [];
    } catch (error) {
      if (error.name === "AbortError") return [];
      if (!settings.silent) renderSearchResults([], error.message);
      return [];
    }
  }

  async function handleSearchInput() {
    var query = elements.courseSearch.value.trim();
    window.clearTimeout(state.searchTimer);
    if (query.length < 2) {
      hideSearchResults();
      return;
    }
    state.searchTimer = window.setTimeout(async function () {
      var courses = await queryCourses(query);
      renderSearchResults(courses);
    }, SEARCH_DELAY);
  }

  function updateSearchActive() {
    var options = elements.searchResults.querySelectorAll(".search-option");
    options.forEach(function (option, index) {
      var active = index === state.searchIndex;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", String(active));
      if (active) option.scrollIntoView({ block: "nearest" });
    });
  }

  function selectCourse(course, options) {
    var settings = options || {};
    var code = normalizeCode(course && (course.code || course.id || course));
    if (!code) return;
    state.target = code;
    elements.courseSearch.value = code;
    hideSearchResults();
    if (!IS_USTREE_PAGE || settings.loadGraph) {
      if (!IS_USTREE_PAGE) saveFocusedCourse(code);
      closeDrawer();
      loadGraph();
      return;
    }
    inspectGraphNode({
      id: "course:" + code,
      type: "course",
      code: code,
      subject: code.split(" ")[0],
      title: course && course.title || "Course",
      placeholder: false,
      level: null
    });
  }

  async function chooseInitialCourse() {
    if (state.initializedTarget) return;
    state.initializedTarget = true;
    var catalog = currentCatalog();
    if (!catalog || catalogCount(catalog) === 0) {
      setGraphState("empty", "Catalog unavailable", "The " + state.year + " catalog could not be loaded from the server or browser cache.", "Retry", checkCatalog);
      renderOutline();
      return;
    }
    var previous = IS_USTREE_PAGE ? storedTarget() : loadFocusedCourse();
    if (previous) {
      selectCourse(previous, { loadGraph: true });
      return;
    }
    if (IS_USTREE_PAGE) {
      setGraphState("empty", "Your USTree is empty", "Add a course from its details or search for one to inspect it.");
      renderOutline();
      renderUstreeMenu();
      return;
    }
    setGraphState("empty", "No course selected", "Search for a course to build its tree.");
    renderOutline();
  }

  async function loadGraph() {
    var targets = IS_USTREE_PAGE ? normalizeTargets(state.targets) : normalizeTargets([state.target]);
    if (!targets.length) {
      state.graph = null;
      destroyGraph();
      setGraphState(
        "empty",
        IS_USTREE_PAGE ? "Your USTree is empty" : "No course selected",
        IS_USTREE_PAGE ? "Search for a course, then add it from course details." : "Search for a course to build its tree."
      );
      renderOutline();
      return;
    }
    var relations = selectedRelations();
    if (!relations.length) {
      setGraphState("empty", "No relationships shown", "Enable at least one relationship filter.");
      state.graph = null;
      destroyGraph();
      renderOutline();
      return;
    }
    if (state.graphController) state.graphController.abort();
    state.graphController = new AbortController();
    var controller = state.graphController;
    setGraphState("loading");
    var depth = elements.depthSelect.value;
    var requests = targets.map(async function (target) {
      var graph = await catalogClient().graph({
        year: state.year,
        code: target,
        depth: depth,
        relations: relations,
        direction: GRAPH_DIRECTION,
        signal: controller.signal
      });
      graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      graph.edges = Array.isArray(graph.edges) ? graph.edges : [];
      graph.root = graph.root || graph.target || target;
      return { target: target, graph: graph };
    });
    var results = await Promise.allSettled(requests);
    if (controller !== state.graphController || controller.signal.aborted) return;
    var successful = [];
    var failures = [];
    results.forEach(function (result, index) {
      if (result.status === "fulfilled") successful.push(result.value);
      else failures.push({ target: targets[index], error: result.reason });
    });
    state.graphErrors = failures;
    if (!successful.length) {
      state.graph = null;
      destroyGraph();
      renderOutline();
      var firstError = failures[0] && failures[0].error;
      setGraphState(
        "error",
        IS_USTREE_PAGE ? "USTree unavailable" : "Course tree unavailable",
        firstError && firstError.message || (IS_USTREE_PAGE ? "No target pathways could be loaded." : "The selected course could not be loaded."),
        "Retry",
        loadGraph
      );
      return;
    }
    if (IS_USTREE_PAGE && window.USTreeSupport && typeof window.USTreeSupport.mergeGraphs === "function") {
      state.graph = window.USTreeSupport.mergeGraphs(state.year, targets, successful);
    } else {
      state.graph = successful[0].graph;
      state.graph.roots = targets;
    }
    var selectedCode = state.target && state.graph.nodes.some(function (node) {
      return node.id === "course:" + state.target;
    }) ? state.target : state.graph.roots[0];
    state.selectedId = selectedCode ? "course:" + selectedCode : null;
    refreshRequirementStatuses();
    setGraphState("ready");
    renderGraph();
    renderOutline();
    renderUstreeMenu();

    var diagnostics = Array.isArray(state.graph.diagnostics) ? state.graph.diagnostics : [];
    if (!IS_USTREE_PAGE) {
      var visibleCourses = new Set(projectGraphData().nodes.filter(function (node) {
        return node.type === "course";
      }).map(function (node) {
        return normalizeCode(node.code);
      }));
      diagnostics = diagnostics.filter(function (item) {
        return !Array.isArray(item.courses) || item.courses.some(function (code) {
          return visibleCourses.has(normalizeCode(code));
        });
      });
    }
    var messages = diagnostics.map(function (item) { return item.message; }).filter(Boolean);
    if (state.graph.truncated && !messages.length) messages.push("A target pathway was truncated at the node safety limit.");
    if (IS_USTREE_PAGE && failures.length) {
      messages.unshift("Loaded " + successful.length + " of " + targets.length + " USTree pathways. " + failures.map(function (failure) { return failure.target; }).join(", ") + " could not be loaded.");
    }
    if (messages.length) setNotice(messages.join(" "), state.graph.truncated ? "error" : "", failures.length ? "Retry" : null, failures.length ? loadGraph : null);
    else setNotice(null);
  }

  function destroyGraph() {
    state.hover.reset();
    state.suppressNodeTap = false;
    if (state.cy) {
      state.cy.destroy();
      state.cy = null;
    }
    elements.graphCanvas.innerHTML = "";
  }

  function nodeSubject(node) {
    return String(node.subject || (node.code ? node.code.split(/\s+/)[0] : "other")).toLowerCase();
  }

  // Course department (subject) upper-cased so "comp" and "COMP" share one
  // palette slot.
  function departmentKey(node) {
    return String(node.subject || (node.code ? node.code.split(/\s+/)[0] : "OTHER")).toUpperCase();
  }

  function departmentPalette() {
    var palette = graphTheme();
    var colors = [];
    for (var index = 0; index < DEPT_COLOR_COUNT; index += 1) {
      colors.push(palette["dept-" + index] || DEPT_FALLBACK_COLORS[index]);
    }
    return colors;
  }

  // The department -> palette-slot map is a persistent stack with tombstones:
  // `state.deptStack` holds department codes and a removed slot is left as
  // `null` so every OTHER department keeps its index (and therefore its
  // colour). The stack only ever changes through add/remove below; it is never
  // rebuilt or re-sorted, and reset (which wipes every `hkust-course-tree:*`
  // key) is the only thing that clears it. See AGENTS.md.
  function loadDeptStack() {
    try {
      var parsed = JSON.parse(localStorage.getItem(DEPT_STACK_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.map(function (entry) {
        return entry == null ? null : String(entry);
      });
    } catch (_error) {
      return [];
    }
  }

  function saveDeptStack() {
    try {
      localStorage.setItem(DEPT_STACK_KEY, JSON.stringify(state.deptStack));
    } catch (_error) {
      // The stack simply does not persist when storage is unavailable.
    }
  }

  // add(): reuse the smallest hole left by a removal, else append.
  function deptStackAdd(code) {
    if (!code || state.deptStack.indexOf(code) !== -1) return;
    var hole = state.deptStack.indexOf(null);
    if (hole === -1) state.deptStack.push(code);
    else state.deptStack[hole] = code;
  }

  // A slot at/after DEPT_COLOR_COUNT is "overflown": `slot % 10` reuses a
  // colour that an earlier slot already owns. When a removal frees a slot below
  // the palette, pull the lowest-indexed overflown department down into it so it
  // reclaims a unique colour. Only overflown departments ever move; every other
  // index (and therefore colour) is left exactly where it was. The early return
  // means this never runs when the smallest free slot is itself overflown.
  function compactOverflowedDepartments() {
    for (;;) {
      var hole = state.deptStack.indexOf(null);
      if (hole === -1 || hole >= DEPT_COLOR_COUNT) return;
      var overflown = -1;
      for (var cursor = DEPT_COLOR_COUNT; cursor < state.deptStack.length; cursor += 1) {
        if (state.deptStack[cursor] != null) {
          overflown = cursor;
          break;
        }
      }
      if (overflown === -1) return;
      state.deptStack[hole] = state.deptStack[overflown];
      state.deptStack[overflown] = null;
    }
  }

  // remove(): tombstone the code at its index, leave every other index put, and
  // hand the freed slot to the lowest overflown department when possible.
  function deptStackRemove(code) {
    var index = state.deptStack.indexOf(code);
    if (index === -1) return;
    state.deptStack[index] = null;
    compactOverflowedDepartments();
  }

  function departmentSlot(code) {
    return state.deptStack.indexOf(code);
  }

  // Reconcile the persistent stack with the departments that exist in the FULL
  // loaded graph. `fullNodes` must be the unprojected `state.graph.nodes`, so a
  // department whose courses are hidden by the fulfilled-prereq filter is still
  // counted. Departments are added the first time they are seen and their slot
  // never moves; conversely a department is removed only when no course of it
  // exists in the graph (the USTree view). The Course page passes
  // `{ remove: false }` -- looking up a course must not evict a plan colour.
  function syncDepartments(fullNodes, options) {
    var remove = !options || options.remove !== false;
    var present = [];
    (fullNodes || []).forEach(function (node) {
      if (node.type !== "course") return;
      var code = departmentKey(node);
      if (code && present.indexOf(code) === -1) present.push(code);
    });
    var before = JSON.stringify(state.deptStack);
    if (remove) {
      // Snapshot first: deptStackRemove may move an overflown department into a
      // freed slot, so iterating the live array here would be unsafe.
      state.deptStack.filter(function (code) {
        return code && present.indexOf(code) === -1;
      }).forEach(deptStackRemove);
    }
    // Departments first met together are queued biggest-first (Python-style
    // string compare) so their slot order is deterministic, not draw-order.
    var fresh = [];
    present.forEach(function (code) {
      if (state.deptStack.indexOf(code) === -1 && fresh.indexOf(code) === -1) fresh.push(code);
    });
    fresh.sort(function (left, right) {
      return left < right ? 1 : left > right ? -1 : 0;
    });
    fresh.forEach(deptStackAdd);
    if (JSON.stringify(state.deptStack) !== before) saveDeptStack();
  }

  function departmentClass(subject) {
    var index = departmentSlot(subject);
    return index === -1 ? "" : "dept-" + (index % DEPT_COLOR_COUNT);
  }

  function relationForNode(node) {
    if (node.relation) return node.relation;
    if (!state.graph) return "";
    var edge = state.graph.edges.find(function (candidate) {
      return candidate.source === node.id || candidate.target === node.id;
    });
    return edge ? (edge.relation || edge.kind || "") : "";
  }

  function nodeDisplayLabel(node) {
    if (node.type === "course") {
      var label = (node.code || node.label || node.id) + "\n" +
        trimText(node.title || "Course details unavailable", 28);
      var status = requirementStatusFor(node.code);
      if (status) {
        label += "\n" + requirementStatusMarker(status) + " " + requirementStatusLabel(status);
      }
      return label;
    }
    if (node.type === "all") return "ALL\nEvery rule";
    if (node.type === "any") return "ANY\nAny rule";
    if (node.type === "coursePattern") {
      return trimText(node.subject + " " + (node.minimumLevel ? node.minimumLevel + "000+" : "courses"), 28);
    }
    return trimText(node.text || node.label || "Requirement", 36);
  }

  function directLogicChildren(nodeId) {
    if (!state.graph) return [];
    var inbound = state.graph.edges.filter(function (edge) { return edge.target === nodeId; }).map(function (edge) { return edge.source; });
    if (inbound.length) return inbound;
    return state.graph.edges.filter(function (edge) { return edge.source === nodeId; }).map(function (edge) { return edge.target; });
  }

  function graphRoots() {
    if (!state.graph) {
      return IS_USTREE_PAGE ? normalizeTargets(state.targets) : normalizeTargets([state.target]);
    }
    return normalizeTargets(state.graph.roots || state.graph.targets || [state.graph.root]);
  }

  function graphRootIds() {
    return new Set(graphRoots().map(function (code) { return "course:" + code; }));
  }

  function ustreeTargetIds() {
    if (!IS_USTREE_PAGE) return new Set();
    return new Set(normalizeTargets(state.targets).map(function (code) {
      return "course:" + code;
    }));
  }

  function logicSatisfied(nodeId, trail) {
    if (!state.graph) return false;
    var visited = trail || new Set();
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    var node = state.graph.nodes.find(function (item) { return item.id === nodeId; });
    if (!node) return false;
    if (node.type === "course") return state.completions.has(normalizeCode(node.code));
    if (node.type !== "all" && node.type !== "any") return false;
    var roots = graphRootIds();
    var children = directLogicChildren(nodeId).filter(function (id) {
      return !roots.has(id);
    });
    if (!children.length) return false;
    var outcomes = children.map(function (child) {
      return logicSatisfied(child, new Set(visited));
    });
    return node.type === "any" ? outcomes.some(Boolean) : outcomes.every(Boolean);
  }

  function prerequisiteGroupsFor(dependentId) {
    if (!state.graph) return [];
    var nodesById = new Map(state.graph.nodes.map(function (node) {
      return [node.id, node];
    }));
    var inbound = new Map();
    state.graph.edges.forEach(function (edge) {
      var relation = edge.relation || edge.kind;
      if (relation !== "prerequisite") return;
      if (!inbound.has(edge.target)) inbound.set(edge.target, []);
      inbound.get(edge.target).push(edge.source);
    });

    var roots = inbound.get(dependentId) || [];
    if (!roots.length) return [];
    var topNode = roots.length === 1 ? nodesById.get(roots[0]) : null;
    var groupedRoots = topNode && topNode.type === "all"
      ? (inbound.get(topNode.id) || []).map(function (rootId) { return [rootId]; })
      : [roots];

    var maxDepth = selectedPrerequisiteDepth();

    function coursesUnder(rootId, visited, courseDepth) {
      if (visited.has(rootId)) return [];
      visited.add(rootId);
      var node = nodesById.get(rootId);
      if (!node) return [];
      var courseIds = [];
      if (node.type === "course") {
        courseIds.push(node.id);
        if (courseDepth + 1 >= maxDepth) return courseIds;
        courseDepth += 1;
      }
      return (inbound.get(rootId) || []).reduce(function (courseIds, childId) {
        return courseIds.concat(coursesUnder(childId, visited, courseDepth));
      }, courseIds);
    }

    return groupedRoots.map(function (rootIds) {
      var courseIds = rootIds.reduce(function (result, rootId) {
        return result.concat(coursesUnder(rootId, new Set(), 0));
      }, []);
      return Array.from(new Set(courseIds));
    }).filter(function (courseIds) {
      return courseIds.length > 0;
    });
  }

  function clearHoverGrouping() {
    if (!state.cy) return;
    var classes = [];
    for (var index = 1; index <= HOVER_GROUP_COUNT; index += 1) {
      classes.push("hover-group-" + index);
    }
    state.cy.elements().removeClass(classes.join(" "));
    delete elements.graphCanvas.dataset.hoverGroupCount;
    delete elements.graphCanvas.dataset.hoverDepth;
    delete elements.graphCanvas.dataset.hoverGroups;
  }

  function applyPrerequisiteHoverGroups(dependentNode) {
    clearHoverGrouping();
    if (!state.cy || dependentNode.data("type") !== "course") return;
    var groups = prerequisiteGroupsFor(dependentNode.id());
    elements.graphCanvas.dataset.hoverGroupCount = String(groups.length);
    var depth = selectedPrerequisiteDepth();
    elements.graphCanvas.dataset.hoverDepth = Number.isFinite(depth) ? String(depth) : "all";
    elements.graphCanvas.dataset.hoverGroups = groups.map(function (courseIds) {
      return courseIds.join(",");
    }).join("|");
    groups.forEach(function (courseIds, index) {
      var className = "hover-group-" + ((index % HOVER_GROUP_COUNT) + 1);
      var groupedIds = new Set(courseIds);
      courseIds.forEach(function (courseId) {
        var prerequisite = state.cy.getElementById(courseId);
        if (!prerequisite.length) return;
        prerequisite.addClass(className);
      });
      state.cy.edges(".prerequisite").filter(function (edge) {
        return groupedIds.has(edge.source().id()) &&
          (groupedIds.has(edge.target().id()) || edge.target().id() === dependentNode.id());
      }).addClass(className);
    });
  }

  function applyHoverEmphasis(dependentNode) {
    applyPrerequisiteHoverGroups(dependentNode);
    if (!state.cy) return;
    var prominent = dependentNode.closedNeighborhood();
    for (var index = 1; index <= HOVER_GROUP_COUNT; index += 1) {
      prominent = prominent.union(state.cy.elements(".hover-group-" + index));
    }
    state.cy.elements().removeClass("faded");
    state.cy.elements().not(prominent).addClass("faded");
  }

  function clearHoverEmphasis() {
    if (!state.cy) return;
    clearHoverGrouping();
    state.cy.elements().removeClass("faded hover-pinned");
    delete elements.graphCanvas.dataset.hoverPinned;
  }

  // A click pins the highlight that a hover would show, so it survives the
  // pointer leaving (and so touch devices, which have no hover, can reveal it).
  function pinHover(node) {
    if (!state.cy || !node || !node.length) return;
    state.hover.pin(node.id());
    state.cy.elements().removeClass("hover-pinned");
    node.addClass("hover-pinned");
    elements.graphCanvas.dataset.hoverPinned = node.id();
    applyHoverEmphasis(node);
  }

  function releasePinnedHover() {
    if (!state.cy) return;
    if (state.hover.release().apply) clearHoverEmphasis();
  }

  // The completion checkbox stays a normal tap control on every device.
  // Otherwise, desktop maps hover -> preview and click -> details; touch has no
  // hover, so on mobile a tap takes the hover role (preview only) and a long
  // press takes the click role (details).
  function activateNode(node, renderedPosition, longPress) {
    if (completionHit(node, renderedPosition)) {
      if (longPress) return;
      var code = normalizeCode(node.data("code"));
      setCourseCompletion(code, !state.completions.has(code));
      node.unselect();
      return;
    }
    state.selectedId = node.id();
    pinHover(node);
    if (!state.mobileLayout || longPress) inspectGraphNode(node.data());
  }

  function completionHit(node, renderedPosition) {
    if (!node || node.data("type") !== "course") return false;
    return !!(window.GraphInteractionSupport &&
      window.GraphInteractionSupport.hitCheckbox(node, renderedPosition));
  }

  function setCourseCompletion(code, completed) {
    var normalized = normalizeCode(code);
    if (completed) state.completions.add(normalized);
    else state.completions.delete(normalized);
    saveCompletions();

    if (state.hideFulfilledPrereq) {
      // The set of hidden prerequisite branches depends on the finished
      // courses, so a tick can add or remove nodes: rebuild the view.
      renderGraph();
    } else if (state.cy) {
      state.cy.nodes().filter(function (node) {
        return node.data("type") === "course" && normalizeCode(node.data("code")) === normalized;
      }).toggleClass("is-completed", completed);
    }
    var detailsToggle = document.getElementById("completedToggle");
    if (detailsToggle && normalizeCode(elements.detailsCode.textContent) === normalized) {
      detailsToggle.checked = completed;
    }
    if (IS_USTREE_PAGE) {
      refreshRequirementStatuses();
      applyRequirementStatuses();
      renderUstreeMenu();
      refreshDetailsPrereqStatus();
    }
    renderOutline();
  }

  function projectGraphData() {
    var graph = activeGraph() || state.graph;
    var nodes = graph.nodes.filter(function (node) {
      return node.type !== "all" && node.type !== "any";
    });
    var nodeIds = new Set(nodes.map(function (node) { return node.id; }));
    var outgoing = new Map();
    graph.edges.forEach(function (edge) {
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source).push(edge);
    });

    var projected = [];
    var projectedKeys = new Set();
    nodeIds.forEach(function (sourceId) {
      var pending = (outgoing.get(sourceId) || []).map(function (edge) {
        return {
          edge: edge,
          qualifier: edge.qualifier || edge.label || "",
          symmetric: Boolean(edge.symmetric)
        };
      });
      var visited = new Set();
      while (pending.length) {
        var current = pending.shift();
        var edge = current.edge;
        var relation = edge.relation || edge.kind || "prerequisite";
        var visitKey = edge.target + "|" + relation + "|" + current.qualifier;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);
        if (nodeIds.has(edge.target)) {
          var key = [sourceId, edge.target, relation, current.qualifier].join("|");
          if (sourceId !== edge.target && !projectedKeys.has(key)) {
            projectedKeys.add(key);
            projected.push({
              source: sourceId,
              target: edge.target,
              relation: relation,
              qualifier: current.qualifier,
              symmetric: current.symmetric || Boolean(edge.symmetric)
            });
          }
          continue;
        }
        (outgoing.get(edge.target) || []).forEach(function (nextEdge) {
          var nextRelation = nextEdge.relation || nextEdge.kind || "prerequisite";
          if (nextRelation !== relation) return;
          pending.push({
            edge: nextEdge,
            qualifier: current.qualifier || nextEdge.qualifier || nextEdge.label || "",
            symmetric: current.symmetric || Boolean(nextEdge.symmetric)
          });
        });
      }
    });

    if (!IS_USTREE_PAGE) {
      var rootIds = graphRootIds();
      var incoming = new Map();
      projected.forEach(function (edge) {
        if (!incoming.has(edge.target)) incoming.set(edge.target, []);
        incoming.get(edge.target).push(edge);
      });
      var visibleIds = new Set(rootIds);
      var pendingRoots = Array.from(rootIds);
      while (pendingRoots.length) {
        var targetId = pendingRoots.shift();
        (incoming.get(targetId) || []).forEach(function (edge) {
          if (visibleIds.has(edge.source)) return;
          visibleIds.add(edge.source);
          pendingRoots.push(edge.source);
        });
      }
      projected.forEach(function (edge) {
        if (edge.relation === "prerequisite" && rootIds.has(edge.source) && edge.target.indexOf("course:") === 0) {
          visibleIds.add(edge.target);
        }
      });
      nodes = nodes.filter(function (node) { return visibleIds.has(node.id); });
      projected = projected.filter(function (edge) {
        return visibleIds.has(edge.source) && visibleIds.has(edge.target);
      });
    }

    return { nodes: nodes, edges: projected };
  }

  function directDependentIds(projected) {
    if (IS_USTREE_PAGE) return new Set();
    var rootIds = graphRootIds();
    return new Set(projected.edges.filter(function (edge) {
      return edge.relation === "prerequisite" && rootIds.has(edge.source) && edge.target.indexOf("course:") === 0;
    }).map(function (edge) {
      return edge.target;
    }));
  }

  function graphElements() {
    var projected = projectGraphData();
    var rootIds = graphRootIds();
    var targetIds = ustreeTargetIds();
    var dependentIds = directDependentIds(projected);
    // Reconcile palette slots from the FULL graph (hidden courses included)
    // before styling. Only the USTree view removes a department that is gone;
    // the Course page just adds colours for the departments it is showing.
    syncDepartments(state.graph && state.graph.nodes, { remove: IS_USTREE_PAGE });
    var nodes = projected.nodes.map(function (node) {
      var classes = [node.type || "condition"];
      var isDependent = dependentIds.has(node.id);
      if (node.type === "course") {
        var deptClass = departmentClass(departmentKey(node));
        if (deptClass) classes.push(deptClass);
      }
      if (node.placeholder || node.status === "unresolved") classes.push("is-unresolved");
      if (targetIds.has(node.id)) classes.push("is-target");
      else if (rootIds.has(node.id)) classes.push("is-focus");
      if (isDependent) classes.push("is-dependent");
      if (node.type === "course" && state.completions.has(normalizeCode(node.code))) classes.push("is-completed");
      var requirementStatus = node.type === "course" ? requirementStatusFor(node.code) : null;
      if (requirementStatus) classes.push("is-prereq-" + requirementStatus);
      return {
        group: "nodes",
        data: Object.assign({}, node, {
          displayLabel: nodeDisplayLabel(node),
          relation: relationForNode(node),
          normalizedLevel: numericLevel(node.level),
          directDependent: isDependent
        }),
        classes: classes.join(" ")
      };
    });
    var edges = projected.edges.map(function (edge, index) {
      var relation = edge.relation;
      return {
        group: "edges",
        data: Object.assign({}, edge, {
          id: "projected-edge:" + index,
          relation: relation,
          displayLabel: edge.qualifier || edge.label || ""
        }),
        classes: relation + (edge.symmetric ? " is-symmetric" : "")
      };
    });
    return nodes.concat(edges);
  }

  function graphStyles() {
    var C = graphTheme();
    var styles = [
      {
        selector: "node",
        style: {
          "width": 184,
          "height": 66,
          "shape": "round-rectangle",
          "background-color": C["node-bg"] || "#ffffff",
          "border-color": C["node-border"] || "#b9c2bc",
          "border-width": 1.5,
          "label": "data(displayLabel)",
          "font-family": "Inter, system-ui, sans-serif",
          "font-size": 10,
          "font-weight": 600,
          "color": C["node-text"] || "#1d2420",
          "text-wrap": "wrap",
          "text-max-width": 160,
          "text-valign": "center",
          "text-halign": "center",
          "line-height": 1.35,
          "overlay-opacity": 0
        }
      },
      {
        selector: "node.course",
        style: {
          "background-image": checkboxImage(false),
          "background-fit": "none",
          "background-repeat": "no-repeat",
          "background-width": CHECKBOX_SIZE,
          "background-height": CHECKBOX_SIZE,
          "background-position-x": "0%",
          "background-position-y": "0%",
          "background-offset-x": CHECKBOX_INSET,
          "background-offset-y": CHECKBOX_INSET,
          "background-image-opacity": 1
        }
      }
    ];

    // The ONLY border a course node may carry is its department colour, drawn
    // from the fixed palette at the department's persistent stack slot (see
    // syncDepartments). Focus, target, completion, verdict and selection must
    // never repaint it -- see the graph colour rules in AGENTS.md.
    departmentPalette().forEach(function (color, index) {
      styles.push({
        selector: "node.dept-" + index,
        style: { "border-color": color, "border-width": 3, "border-style": "solid" }
      });
    });

    return styles.concat([
      // Completion shows through the tick image only; the fill stays plain.
      { selector: "node.is-completed", style: { "background-image": checkboxImage(true) } },
      {
        selector: "node.is-target",
        style: {
          "background-image": targetImage(false),
          "background-fit": "none",
          "background-width": 184,
          "background-height": 66,
          "background-position-x": "50%",
          "background-position-y": "50%",
          // The target image is node-sized and paints its checkbox at the same
          // CHECKBOX_INSET, so it must not inherit the course node's offset.
          "background-offset-x": 0,
          "background-offset-y": 0,
          "background-image-opacity": 1
        }
      },
      { selector: "node.is-target.is-completed", style: { "background-image": targetImage(true) } },
      {
        selector: "node.all, node.any",
        style: {
          "width": 74,
          "height": 48,
          "shape": "diamond",
          "font-size": 9,
          "text-max-width": 58,
          "background-color": C["logic-bg"] || "#f2f4f2",
          "border-color": C["logic-stroke"] || "#87938b"
        }
      },
      { selector: "node.any", style: { "background-color": C["any-bg"] || "#edf3f8", "border-color": C["any-stroke"] || "#6686a0" } },
      // Special conditional nodes keep their own background and border.
      {
        selector: "node.condition, node.coursePattern",
        style: {
          "width": 168,
          "height": 54,
          "background-color": C["condition-bg"] || "#fffaf0",
          "border-color": C["condition-border"] || "#bda36e",
          "border-style": "dashed",
          "font-size": 9,
          "color": C["condition-text"] || "#655839"
        }
      },
      {
        selector: "edge",
        style: {
          "width": 2,
          "line-color": C["edge"] || "#3d4b43",
          "target-arrow-color": C["edge"] || "#3d4b43",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "label": "data(displayLabel)",
          "font-size": 8,
          "color": C["node-muted"] || "#657069",
          "text-background-color": C["edge-label-bg"] || "#f5f7f4",
          "text-background-opacity": 0.92,
          "text-background-padding": 2,
          "overlay-opacity": 0
        }
      },
      {
        selector: "edge.corequisite",
        style: {
          "line-color": C["coreq"] || "#2673a8",
          "target-arrow-shape": "none",
          "line-style": "dashed"
        }
      },
      {
        selector: "edge.exclusion",
        style: {
          "line-color": C["exclusion"] || "#b14c45",
          "target-arrow-shape": "none",
          "line-style": "dotted",
          "width": 2.5
        }
      },
      { selector: "node.hover-group-1", style: { "background-color": C["hover1-bg"] || "#c6def2" } },
      { selector: "edge.hover-group-1", style: { "line-color": C["hover1-line"] || "#3e718f", "target-arrow-color": C["hover1-line"] || "#3e718f", "width": 4, "opacity": 1 } },
      { selector: "node.hover-group-2", style: { "background-color": C["hover2-bg"] || "#fff1c9" } },
      { selector: "edge.hover-group-2", style: { "line-color": C["hover2-line"] || "#8a6918", "target-arrow-color": C["hover2-line"] || "#8a6918", "width": 4, "opacity": 1 } },
      { selector: "node.hover-group-3", style: { "background-color": C["hover3-bg"] || "#c5e4cf" } },
      { selector: "edge.hover-group-3", style: { "line-color": C["hover3-line"] || "#387354", "target-arrow-color": C["hover3-line"] || "#387354", "width": 4, "opacity": 1 } },
      { selector: "node.hover-group-4", style: { "background-color": C["hover4-bg"] || "#f6e6eb" } },
      { selector: "edge.hover-group-4", style: { "line-color": C["hover4-line"] || "#945469", "target-arrow-color": C["hover4-line"] || "#945469", "width": 4, "opacity": 1 } },
      { selector: "node.hover-group-5", style: { "background-color": C["hover5-bg"] || "#eee9f6" } },
      { selector: "edge.hover-group-5", style: { "line-color": C["hover5-line"] || "#705b91", "target-arrow-color": C["hover5-line"] || "#705b91", "width": 4, "opacity": 1 } },
      // The clicked node gets a soft halo; highlighting is click/pin only.
      { selector: "node.hover-pinned", style: { "overlay-color": C["accent"] || "#176b4b", "overlay-opacity": 0.14, "overlay-padding": 7 } },
      { selector: ".faded", style: { "opacity": 0.16 } }
    ]);
  }

  // Re-skin the canvas in place when the theme changes; rebuilding the style
  // list also refreshes the palette-dependent checkbox/target images.
  function refreshGraphTheme() {
    if (!state.cy) return;
    state.cy.style().fromJson(graphStyles()).update();
  }

  window.addEventListener("hkust-theme-change", refreshGraphTheme);

  function positionGraphByLevel(cy) {
    var courseLevels = cy.nodes().filter(function (node) {
      return node.data("type") === "course" && node.data("normalizedLevel") != null;
    }).map(function (node) { return node.data("normalizedLevel"); });
    var uniqueLevels = Array.from(new Set(courseLevels)).sort(function (a, b) { return a - b; });
    if (!uniqueLevels.length) uniqueLevels = [1];
    var levelOrder = new Map(uniqueLevels.map(function (level, index) { return [level, index]; }));
    var unknownIndex = uniqueLevels.length;
    var groups = new Map();

    cy.nodes().forEach(function (node) {
      var level = node.data("normalizedLevel");
      var key = levelOrder.has(level) ? levelOrder.get(level) : unknownIndex;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    });

    var cursor = 0;
    Array.from(groups.keys()).sort(function (left, right) { return left - right; }).forEach(function (column) {
      var nodes = groups.get(column);
      nodes.sort(function (left, right) {
        var typeWeight = { condition: 0, coursePattern: 0, any: 1, all: 1, course: 2 };
        var difference = (typeWeight[left.data("type")] || 0) - (typeWeight[right.data("type")] || 0);
        return difference || String(left.data("code") || left.id()).localeCompare(String(right.data("code") || right.id()));
      });
      var primarySpacing = state.mobileLayout ? 112 : 216;
      var secondarySpacing = state.mobileLayout ? 216 : 94;
      var secondaryLimit = state.mobileLayout ? 2 : 7;
      var primaryCount = Math.ceil(nodes.length / secondaryLimit);
      nodes.forEach(function (node, index) {
        var level = node.data("normalizedLevel");
        var primaryIndex = Math.floor(index / secondaryLimit);
        var secondaryIndex = index % secondaryLimit;
        if (state.mobileLayout) {
          node.position({
            x: 112 + secondaryIndex * secondarySpacing,
            y: cursor + 78 + primaryIndex * primarySpacing
          });
        } else {
          node.position({
            x: cursor + 112 + primaryIndex * primarySpacing,
            y: 82 + secondaryIndex * secondarySpacing
          });
        }
        node.data("levelLabel", level == null ? "Unknown" : "Level " + level);
      });
      cursor += state.mobileLayout
        ? Math.max(1, primaryCount) * primarySpacing + 100
        : Math.max(1, primaryCount) * primarySpacing + 82;
    });
  }

  function setReadableInitialViewport() {
    if (!state.cy || !state.graph) return;
    var minimumZoom = state.mobileLayout ? 0.68 : 0.52;
    if (state.cy.zoom() >= minimumZoom) return;
    var target = state.cy.collection();
    graphRoots().forEach(function (code) {
      target = target.union(state.cy.getElementById("course:" + code));
    });
    if (!target.length) return;
    state.cy.zoom(minimumZoom);
    state.cy.center(target);
  }

  function graphFitPadding() {
    return state.mobileLayout ? 36 : 70;
  }

  function updateGraphFitMinimum() {
    if (!state.cy || !state.cy.elements().length) return null;
    if (window.GraphInteractionSupport) {
      return window.GraphInteractionSupport.updateFitMinimum(
        state.cy,
        state.cy.elements(),
        graphFitPadding()
      );
    }
    state.cy.fit(state.cy.elements(), graphFitPadding());
    state.cy.minZoom(state.cy.zoom());
    return { zoom: state.cy.zoom(), pan: state.cy.pan() };
  }

  function renderGraph() {
    destroyGraph();
    if (!state.graph || !state.graph.nodes.length) {
      setGraphState(
        "empty",
        "No relationships found",
        IS_USTREE_PAGE
          ? "The USTree targets have no relationships for the current filters."
          : "The selected course has no relationships for the current filters."
      );
      return;
    }
    if (typeof window.cytoscape !== "function") {
      setGraphState("error", "Graph renderer unavailable", "The local Cytoscape asset could not be loaded.");
      return;
    }

    state.cy = window.cytoscape({
      container: elements.graphCanvas,
      elements: graphElements(),
      style: graphStyles(),
      layout: { name: "preset" },
      minZoom: 0.01,
      maxZoom: 2.5,
      wheelSensitivity: 0.18,
      boxSelectionEnabled: false,
      autounselectify: false,
      userPanningEnabled: true,
      userZoomingEnabled: true
    });

    positionGraphByLevel(state.cy);
    elements.graphCanvas.dataset.visibleBooleanNodes = String(state.cy.nodes(".all, .any").length);
    elements.graphCanvas.dataset.visibleCourseNodes = String(state.cy.nodes(".course").length);
    if (window.GraphInteractionSupport) {
      window.GraphInteractionSupport.fitToMinimum(
        state.cy,
        state.cy.elements(),
        graphFitPadding(),
        0
      );
    } else {
      updateGraphFitMinimum();
    }
    setReadableInitialViewport();
    state.cy.nodes().ungrabify();
    if (window.GraphInteractionSupport) {
      window.GraphInteractionSupport.bindNodeCursor(elements.graphStage, state.cy, completionHit);
    }

    state.cy.on("tap", "node", function (event) {
      if (state.suppressNodeTap) {
        state.suppressNodeTap = false;
        return;
      }
      if (completionHit(event.target, event.renderedPosition)) event.stopPropagation();
      activateNode(event.target, event.renderedPosition, false);
    });
    // On mobile, holding a node is the "click": it opens the details drawer.
    // This runs before the trailing tap on release, which is then suppressed.
    state.cy.on("taphold", "node", function (event) {
      if (!state.mobileLayout) return;
      if (completionHit(event.target, event.renderedPosition)) return;
      state.suppressNodeTap = true;
      event.stopPropagation();
      activateNode(event.target, event.renderedPosition, true);
    });
    // Clicking empty canvas releases a pinned highlight ("click elsewhere").
    state.cy.on("tap", function (event) {
      if (event.target !== state.cy) return;
      releasePinnedHover();
    });
    window.requestAnimationFrame(refocusGraph);
  }

  function fitGraph() {
    if (!state.cy || !state.cy.elements().length) return;
    if (window.GraphInteractionSupport) {
      window.GraphInteractionSupport.fitToMinimum(
        state.cy,
        state.cy.elements(),
        graphFitPadding(),
        180
      );
    } else {
      updateGraphFitMinimum();
    }
  }

  function refocusGraph() {
    if (!state.cy) return;
    var target = state.cy.collection();
    graphRoots().forEach(function (code) {
      target = target.union(state.cy.getElementById("course:" + code));
    });
    if (!target.length) return;
    state.cy.animate({
      center: { eles: target },
      zoom: Math.max(state.cy.minZoom(), Math.max(0.75, Math.min(1.15, state.cy.zoom()))),
      duration: 180
    });
    state.cy.nodes().unselect();
    target.select();
    updateGraphFitMinimum();
  }

  function renderOutline() {
    if (!state.graph || !state.graph.nodes.length) {
      elements.outlineTitle.textContent = IS_USTREE_PAGE
        ? (state.targets.length ? state.targets.join(", ") : "USTree is empty")
        : (state.target || "No course selected");
      elements.outlineSummary.textContent = "0 courses";
      elements.outlineContent.innerHTML = '<div class="search-message">No pathway data</div>';
      return;
    }
    var nodes = projectGraphData().nodes.filter(function (node) {
      return node.type === "course";
    });
    var courseCount = nodes.length;
    var roots = graphRoots();
    elements.outlineTitle.textContent = roots.length === 1 ? roots[0] : roots.length + " USTree targets";
    elements.outlineSummary.textContent = courseCount + (courseCount === 1 ? " course" : " courses");

    var grouped = new Map();
    var rootIds = graphRootIds();
    var targetIds = ustreeTargetIds();
    var dependentIds = directDependentIds(projectGraphData());
    nodes.forEach(function (node) {
      var level = numericLevel(node.level);
      if (level == null) level = "unknown";
      if (!grouped.has(level)) grouped.set(level, []);
      grouped.get(level).push(node);
    });
    var keys = Array.from(grouped.keys()).sort(function (left, right) {
      if (left === "unknown") return 1;
      if (right === "unknown") return -1;
      return left - right;
    });
    elements.outlineContent.innerHTML = keys.map(function (level) {
      var levelNodes = grouped.get(level).sort(function (left, right) {
        return String(left.code || left.label || left.text || "").localeCompare(String(right.code || right.label || right.text || ""));
      });
      var items = levelNodes.map(function (node) {
        var subject = nodeSubject(node);
        var relation = relationForNode(node);
        var target = targetIds.has(node.id);
        var focused = !IS_USTREE_PAGE && rootIds.has(node.id);
        var dependent = dependentIds.has(node.id);
        var heading = node.code || node.id;
        if (target) heading = "\u2605 " + heading;
        var description = node.title || "Course details unavailable";
        var complete = state.completions.has(normalizeCode(node.code));
        var kind = target ? "Target" : dependent ? "Uses course" : focused ? "Selected" : relationLabel(relation);
        var status = target ? requirementStatusFor(node.code) : null;
        var statusChip = status
          ? '<span class="outline-status is-' + escapeHtml(status) + '">' + escapeHtml(requirementStatusLabel(status)) + "</span>"
          : "";
        return '<li class="outline-item subject-' + escapeHtml(subject) + (target ? " is-target" : "") + (dependent ? " is-dependent" : "") + '"><button type="button" data-node-id="' + escapeHtml(node.id) + '">' +
          '<span class="outline-accent"></span><span class="outline-course"><strong>' + escapeHtml(heading) + (complete ? " (Completed)" : "") + '</strong><span>' + escapeHtml(description) + '</span></span>' +
          '<span class="outline-tags"><span class="outline-kind">' + escapeHtml(kind) + "</span>" + statusChip + "</span></button></li>";
      }).join("");
      return '<section class="outline-level"><h3>' + (level === "unknown" ? "Level unknown" : "Level " + level) + '</h3><ul class="outline-list">' + items + "</ul></section>";
    }).join("");
  }

  function openDrawer() {
    elements.detailsDrawer.classList.add("is-open");
    elements.detailsDrawer.setAttribute("aria-hidden", "false");
    elements.drawerScrim.hidden = !window.matchMedia("(max-width: 620px)").matches;
  }

  function closeDrawer() {
    elements.detailsDrawer.classList.remove("is-open");
    elements.detailsDrawer.setAttribute("aria-hidden", "true");
    elements.drawerScrim.hidden = true;
  }

  function inspectGraphNode(node) {
    openDrawer();
    if (node.type === "course") {
      loadCourseDetails(node);
    } else {
      renderRuleDetails(node);
    }
  }

  function renderRuleDetails(node) {
    var isLogic = node.type === "all" || node.type === "any";
    var title = isLogic ? node.type.toUpperCase() + " requirement" : "Catalog condition";
    var text = node.text || (node.type === "all" ? "Every connected requirement must be satisfied." : "Any connected requirement satisfies this catalog rule.");
    if (node.type === "coursePattern") {
      text = "Any " + (node.subject || "matching") + " course" + (node.minimumLevel ? " at " + node.minimumLevel + "000-level or above" : "") + ".";
    }
    elements.detailsSubject.textContent = relationLabel(relationForNode(node));
    elements.detailsCode.textContent = title;
    elements.detailsContent.innerHTML =
      '<p class="details-description">' + escapeHtml(text) + "</p>" +
      (isLogic ? '<div class="details-meta"><span class="meta-chip">' + (logicSatisfied(node.id) ? "Satisfied" : "Not yet satisfied") + "</span></div>" : "");
  }

  function relationLabel(value) {
    var labels = {
      prerequisite: "Prerequisite",
      corequisite: "Corequisite",
      exclusion: "Exclusion"
    };
    return labels[value] || "Requirement";
  }

  function requirementBlock(requirements, relation) {
    var item = requirements && requirements[relation];
    var raw = item && (item.raw || item.raw_text || item.text);
    var empty = !raw;
    return '<section class="requirement-section' + (empty ? " is-empty" : "") + '"><h3><span class="requirement-indicator ' + relation + '"></span>' +
      escapeHtml(relationLabel(relation)) + '</h3><p>' + escapeHtml(raw || "None listed") + "</p></section>";
  }

  function detailWarnings(requirements) {
    var warnings = [];
    DEFAULT_RELATIONS.forEach(function (relation) {
      var item = requirements && requirements[relation];
      if (!item) return;
      if (Array.isArray(item.warnings)) warnings = warnings.concat(item.warnings);
      if (item.status === "partial") warnings.push(relationLabel(relation) + " was only partially parsed.");
    });
    return Array.from(new Set(warnings.filter(Boolean)));
  }

  function renderDetailsTargetAction(code) {
    var button = document.getElementById("ustreeTargetAction");
    if (!button || normalizeCode(button.dataset.code) !== normalizeCode(code)) return;
    var added = hasTarget(code);
    button.textContent = added ? "Remove from USTree" : "Add to USTree";
    button.classList.toggle("button-primary", !added);
    button.setAttribute("aria-pressed", String(added));
    button.title = added
      ? (IS_USTREE_PAGE ? "Remove this target from the combined tree" : "Remove this course from your USTree")
      : (IS_USTREE_PAGE ? "Add this course to the combined tree" : "Add this course to your USTree");
  }

  function bindDetailsTargetAction(code) {
    var targetAction = document.getElementById("ustreeTargetAction");
    if (!targetAction) return;
    targetAction.addEventListener("click", function () {
      if (hasTarget(code)) removeTarget(code);
      else addTarget(code);
    });
  }

  function renderCourseDetails(course, fallbackNode) {
    var code = normalizeCode(course.code || fallbackNode.code);
    var requirements = course.requirements || {};
    var warnings = detailWarnings(requirements);
    var completed = state.completions.has(code);
    var status = requirementStatusFor(code);
    var subject = course.subject || fallbackNode.subject || code.split(" ")[0];
    var sourceUrl = course.source_url || course.sourceUrl || fallbackNode.source_url;
    elements.detailsSubject.textContent = subject;
    elements.detailsCode.textContent = code;
    elements.detailsContent.innerHTML =
      '<h3 class="details-title">' + escapeHtml(course.title || fallbackNode.title || "Course details unavailable") + "</h3>" +
      '<div class="details-meta">' +
        (creditLabel(course.credits) ? '<span class="meta-chip">' + escapeHtml(creditLabel(course.credits)) + "</span>" : "") +
        (fallbackNode.level != null ? '<span class="meta-chip">Level ' + escapeHtml(fallbackNode.level) + "</span>" : "") +
        (status ? '<span id="detailsPrereqStatus" class="meta-chip is-prereq-' + escapeHtml(status) + '" title="Checked against your completed courses">' + escapeHtml(requirementStatusLabel(status)) + "</span>" : "") +
      "</div>" +
      '<div class="details-actions"><button id="ustreeTargetAction" class="button" type="button" data-code="' + escapeHtml(code) + '" aria-pressed="false"></button></div>' +
      '<label class="complete-control"><span>Completed</span><span class="switch"><input id="completedToggle" type="checkbox" ' + (completed ? "checked" : "") + '><span></span></span></label>' +
      (course.description ? '<p class="details-description">' + escapeHtml(course.description) + "</p>" : "") +
      requirementBlock(requirements, "prerequisite") +
      requirementBlock(requirements, "corequisite") +
      requirementBlock(requirements, "exclusion") +
      (warnings.length ? '<p class="parser-warning">' + escapeHtml(warnings.join(" ")) + "</p>" : "") +
      (sourceUrl ? '<a class="source-link" href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">Open official HKUST course page</a>' : "");
    renderDetailsTargetAction(code);
    bindDetailsTargetAction(code);
    var toggle = document.getElementById("completedToggle");
    if (toggle) {
      toggle.addEventListener("change", function () {
        setCourseCompletion(code, toggle.checked);
      });
    }
  }

  async function loadCourseDetails(node) {
    var code = normalizeCode(node.code);
    elements.detailsSubject.textContent = node.subject || "Course";
    elements.detailsCode.textContent = code;
    if (node.placeholder) {
      elements.detailsContent.innerHTML = '<p class="details-description">Course details are not present in the cached ' + escapeHtml(state.year) + " catalog.</p>";
      return;
    }
    var cacheKey = state.year + ":" + code;
    if (state.detailCache.has(cacheKey)) {
      renderCourseDetails(state.detailCache.get(cacheKey), node);
      return;
    }
    elements.detailsContent.innerHTML = '<div class="search-message">Loading course details...</div>';
    if (state.detailsController) state.detailsController.abort();
    state.detailsController = new AbortController();
    try {
      var course = await catalogClient().course(state.year, code, {
        signal: state.detailsController.signal
      });
      if (!course) throw new Error(code + " is not in the " + state.year + " catalog.");
      state.detailCache.set(cacheKey, course);
      renderCourseDetails(course, node);
    } catch (error) {
      if (error.name === "AbortError") return;
      elements.detailsContent.innerHTML = '<p class="parser-warning">' + escapeHtml(error.message) + "</p>";
    }
  }

  async function checkCatalog() {
    if (state.syncing) return;
    state.syncing = true;
    elements.syncButton.disabled = true;
    elements.syncButton.classList.add("is-syncing");
    setNotice("Checking for an updated " + state.year + " catalog...", "");
    try {
      var result = await catalogClient().reload();
      if (result.year && result.year !== state.year) {
        state.year = result.year;
        elements.yearSelect.value = state.year;
        state.detailCache.clear();
      }
      await loadCatalogs({ preserveNotice: true });
      if (result.changed) {
        state.detailCache.clear();
        setNotice(
          "Catalog updated to the " + result.year + " release (" + Number(result.courseCount || 0).toLocaleString() + " courses).",
          "success"
        );
        if (state.target || (IS_USTREE_PAGE && state.targets.length)) {
          loadGraph();
        } else {
          state.initializedTarget = false;
          chooseInitialCourse();
        }
      } else {
        var generated = formatDate(result.generatedAt);
        setNotice(
          "Catalog is up to date (" + Number(result.courseCount || 0).toLocaleString() + " courses" +
            (generated ? ", generated " + generated : "") + ").",
          "success"
        );
      }
    } catch (error) {
      setNotice(error.message, "error", "Retry", checkCatalog);
    } finally {
      state.syncing = false;
      elements.syncButton.disabled = false;
      elements.syncButton.classList.remove("is-syncing");
    }
  }

  function setActiveView(view) {
    var graphActive = view === "graph";
    elements.graphTab.classList.toggle("is-active", graphActive);
    elements.graphTab.setAttribute("aria-selected", String(graphActive));
    elements.outlineTab.classList.toggle("is-active", !graphActive);
    elements.outlineTab.setAttribute("aria-selected", String(!graphActive));
    elements.graphPanel.hidden = !graphActive;
    elements.outlinePanel.hidden = graphActive;
    if (graphActive && state.cy) {
      window.requestAnimationFrame(function () {
        state.cy.resize();
        updateGraphFitMinimum();
      });
    }
  }

  function bindEvents() {
    if (window.GraphInteractionSupport) {
      window.GraphInteractionSupport.bindRightDragPan(elements.graphCanvas, function () {
        return state.cy;
      });
    }
    elements.courseSearch.addEventListener("input", handleSearchInput);
    elements.courseSearch.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" && state.searchItems.length) {
        event.preventDefault();
        state.searchIndex = (state.searchIndex + 1) % state.searchItems.length;
        updateSearchActive();
      } else if (event.key === "ArrowUp" && state.searchItems.length) {
        event.preventDefault();
        state.searchIndex = (state.searchIndex - 1 + state.searchItems.length) % state.searchItems.length;
        updateSearchActive();
      } else if (event.key === "Enter") {
        if (state.searchItems[state.searchIndex]) {
          event.preventDefault();
          selectCourse(state.searchItems[state.searchIndex]);
        } else {
          var code = normalizeCode(elements.courseSearch.value);
          if (/^[A-Z]{2,5} \d{4}[A-Z]?$/.test(code)) selectCourse(code);
        }
      } else if (event.key === "Escape") {
        hideSearchResults();
      }
    });
    elements.searchResults.addEventListener("mousedown", function (event) {
      var option = event.target.closest(".search-option");
      if (!option) return;
      event.preventDefault();
      selectCourse(state.searchItems[Number(option.dataset.index)]);
    });
    document.addEventListener("click", function (event) {
      if (!event.target.closest(".search-wrap")) hideSearchResults();
      if (!event.target.closest(".ustree-wrap")) toggleUstreeMenu(false);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        event.preventDefault();
        elements.courseSearch.focus();
      }
      if (event.key === "Escape") {
        closeDrawer();
        releasePinnedHover();
      }
    });

    elements.yearSelect.addEventListener("change", async function () {
      state.year = elements.yearSelect.value;
      state.target = null;
      state.targets = [];
      state.graph = null;
      state.selectedId = null;
      state.initializedTarget = false;
      loadCompletions();
      loadTargets();
      refreshRequirementStatuses();
      renderUstreeMenu();
      closeDrawer();
      destroyGraph();
      updateCatalogMeta();
      await chooseInitialCourse();
    });
    elements.syncButton.addEventListener("click", checkCatalog);
    elements.relationInputs.forEach(function (input) { input.addEventListener("change", loadGraph); });
    elements.depthSelect.addEventListener("change", loadGraph);
    if (elements.hideFulfilledToggle) {
      elements.hideFulfilledToggle.addEventListener("change", function () {
        state.hideFulfilledPrereq = elements.hideFulfilledToggle.checked;
        saveHideFulfilled(state.hideFulfilledPrereq);
        if (state.graph) renderGraph();
        renderOutline();
      });
    }
    elements.highlightDepthSelect.addEventListener("change", function () {
      if (!state.cy) return;
      var activeId = state.hover.activeId();
      if (!activeId) return;
      var activeNode = state.cy.getElementById(activeId);
      if (activeNode.length) applyHoverEmphasis(activeNode);
    });
    elements.graphTab.addEventListener("click", function () { setActiveView("graph"); });
    elements.outlineTab.addEventListener("click", function () { setActiveView("outline"); });
    elements.zoomIn.addEventListener("click", function () {
      if (state.cy) state.cy.animate({ zoom: Math.min(state.cy.maxZoom(), state.cy.zoom() * 1.2), duration: 120 });
    });
    elements.zoomOut.addEventListener("click", function () {
      if (state.cy) state.cy.animate({ zoom: Math.max(state.cy.minZoom(), state.cy.zoom() / 1.2), duration: 120 });
    });
    elements.fitGraph.addEventListener("click", fitGraph);
    elements.refocusGraph.addEventListener("click", refocusGraph);
    elements.ustreeButton.addEventListener("click", function () { toggleUstreeMenu(); });
    elements.ustreeTargets.addEventListener("click", function (event) {
      var remove = event.target.closest("[data-remove-ustree]");
      if (remove) {
        removeTarget(remove.dataset.removeUstree);
        return;
      }
      var course = event.target.closest("[data-ustree-code]");
      if (!course) return;
      state.target = normalizeCode(course.dataset.ustreeCode);
      elements.courseSearch.value = state.target;
      toggleUstreeMenu(false);
      loadCourseDetails({
        id: "course:" + state.target,
        type: "course",
        code: state.target,
        subject: state.target.split(" ")[0]
      });
    });
    elements.noticeAction.addEventListener("click", function () {
      if (state.noticeAction) state.noticeAction();
    });
    elements.dismissNotice.addEventListener("click", function () { setNotice(null); });
    elements.closeDrawer.addEventListener("click", closeDrawer);
    elements.drawerScrim.addEventListener("click", closeDrawer);
    elements.outlineContent.addEventListener("click", function (event) {
      var button = event.target.closest("[data-node-id]");
      if (!button || !state.graph) return;
      var node = state.graph.nodes.find(function (item) { return item.id === button.dataset.nodeId; });
      if (node) inspectGraphNode(node);
    });
    // Completion checkboxes are shared with the Major requirement page through
    // localStorage; pick up changes made in another open tab.
    window.addEventListener("storage", function (event) {
      if (event.key !== completionKey()) return;
      loadCompletions();
      if (IS_USTREE_PAGE) refreshRequirementStatuses();
      if (state.graph) renderGraph();
      renderOutline();
      renderUstreeMenu();
      var detailsToggle = document.getElementById("completedToggle");
      if (detailsToggle) {
        detailsToggle.checked = state.completions.has(normalizeCode(elements.detailsCode.textContent));
      }
    });

    var mobileQuery = window.matchMedia("(max-width: 620px)");
    mobileQuery.addEventListener("change", function (event) {
      state.mobileLayout = event.matches;
      if (state.graph) renderGraph();
      if (!event.matches) elements.drawerScrim.hidden = true;
    });
    window.addEventListener("resize", function () {
      state.mobileLayout = mobileQuery.matches;
      if (state.cy) {
        state.cy.resize();
        updateGraphFitMinimum();
        window.requestAnimationFrame(function () {
          if (!state.cy) return;
          state.cy.resize();
          updateGraphFitMinimum();
        });
      }
    });
    // Zen mode hides the chrome, so the canvas must grow to the new viewport
    // and re-fit (toggling the body class never fires a window resize).
    window.addEventListener("hkust-zen-change", function () {
      if (!state.cy) return;
      state.cy.resize();
      window.requestAnimationFrame(function () {
        if (!state.cy) return;
        state.cy.resize();
        updateGraphFitMinimum();
        fitGraph();
      });
    });
  }

  async function init() {
    state.hideFulfilledPrereq = loadHideFulfilled();
    state.deptStack = loadDeptStack();
    configurePage();
    bindEvents();
    bindDataTransfer();
    loadCompletions();
    loadTargets();
    renderUstreeMenu();
    setGraphState("loading");
    await loadCatalogs();
    refreshRequirementStatuses();
    renderUstreeMenu();
    await chooseInitialCourse();
  }

  init();
}());
