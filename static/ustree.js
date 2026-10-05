(function (global) {
  "use strict";

  var STORAGE_PREFIX = "hkust-course-tree";

  // Requirement verdicts shared with the USTree view so a starred target can
  // show whether its finished courses already cover the prerequisites.
  var REQUIREMENT_COMPLETED = "completed";
  var REQUIREMENT_MET = "met";
  var REQUIREMENT_UNMET = "unmet";
  var REQUIREMENT_UNKNOWN = "unknown";

  function normalizeCode(value) {
    var text = String(value || "").trim().toUpperCase();
    var match = text.match(/^([A-Z]{2,5})\s*([0-9]{4}[A-Z]?)$/);
    return match ? match[1] + " " + match[2] : text;
  }

  function normalizeTargets(values) {
    var seen = new Set();
    (Array.isArray(values) ? values : []).forEach(function (value) {
      var code = normalizeCode(value);
      if (/^[A-Z]{2,5} \d{4}[A-Z]?$/.test(code)) seen.add(code);
    });
    return Array.from(seen).sort();
  }

  function codeLevel(code) {
    var parts = normalizeCode(code).split(" ");
    var level = Number((parts[1] || "").charAt(0));
    return Number.isFinite(level) ? level : null;
  }

  function patternStatus(pattern, completed) {
    var subject = String((pattern && pattern.subject) || "").toUpperCase();
    var minimumLevel = Number(pattern && pattern.minimumLevel);
    if (!/^[A-Z]{4}$/.test(subject) || !Number.isFinite(minimumLevel)) return REQUIREMENT_UNKNOWN;
    var met = false;
    completed.forEach(function (code) {
      var parts = normalizeCode(code).split(" ");
      if (parts[0] !== subject) return;
      var level = codeLevel(code);
      if (level != null && level >= minimumLevel) met = true;
    });
    return met ? REQUIREMENT_MET : REQUIREMENT_UNMET;
  }

  // Evaluate a parsed requirement expression against a set of finished codes.
  // Course leaves are settled by completion; Boolean junctions combine their
  // children; prose conditions (and malformed nodes) stay unknown so the view
  // never claims a requirement is met when it cannot be sure.
  function evaluateExpression(expression, completed) {
    if (!expression) return REQUIREMENT_UNKNOWN;
    var nodeType = expression.type;
    if (nodeType === "course") {
      var code = normalizeCode(expression.code);
      return /^[A-Z]{2,5} \d{4}[A-Z]?$/.test(code) && completed.has(code)
        ? REQUIREMENT_MET
        : REQUIREMENT_UNMET;
    }
    if (nodeType === "coursePattern") return patternStatus(expression, completed);
    if (nodeType === "all" || nodeType === "any") {
      var items = expression.items || [];
      if (!items.length) return REQUIREMENT_UNKNOWN;
      var results = items.map(function (item) { return evaluateExpression(item, completed); });
      if (nodeType === "any") {
        if (results.indexOf(REQUIREMENT_MET) !== -1) return REQUIREMENT_MET;
        return results.every(function (state) { return state === REQUIREMENT_UNMET; })
          ? REQUIREMENT_UNMET
          : REQUIREMENT_UNKNOWN;
      }
      if (results.indexOf(REQUIREMENT_UNMET) !== -1) return REQUIREMENT_UNMET;
      return results.every(function (state) { return state === REQUIREMENT_MET; })
        ? REQUIREMENT_MET
        : REQUIREMENT_UNKNOWN;
    }
    return REQUIREMENT_UNKNOWN;
  }

  function toCompletionSet(completed) {
    var set = new Set();
    if (!completed) return set;
    // Duck-type rather than `instanceof Set` so a Set created in another realm
    // (or a plain array of codes) is still understood.
    if (typeof completed.forEach === "function") {
      completed.forEach(function (value) {
        var code = normalizeCode(value);
        if (/^[A-Z]{2,5} \d{4}[A-Z]?$/.test(code)) set.add(code);
      });
      return set;
    }
    normalizeTargets(completed).forEach(function (code) { set.add(code); });
    return set;
  }

  // The prerequisite verdict for one course record, given the finished courses.
  function requirementStatus(course, completed) {
    var finished = toCompletionSet(completed);
    var code = normalizeCode(course && course.code);
    if (code && finished.has(code)) return REQUIREMENT_COMPLETED;
    var requirement = course && course.requirements && course.requirements.prerequisite;
    if (!requirement || !requirement.expression) return REQUIREMENT_MET;
    return evaluateExpression(requirement.expression, finished);
  }

  function requirementStatusLabel(status) {
    var labels = {};
    labels[REQUIREMENT_COMPLETED] = "Completed";
    labels[REQUIREMENT_MET] = "Prereqs met";
    labels[REQUIREMENT_UNMET] = "Prereqs not met";
    labels[REQUIREMENT_UNKNOWN] = "Prereqs unclear";
    return labels[status] || "Prereqs unknown";
  }

  function requirementStatusMarker(status) {
    if (status === REQUIREMENT_COMPLETED || status === REQUIREMENT_MET) return "\u2713";
    if (status === REQUIREMENT_UNMET) return "\u2717";
    return "?";
  }

  function storageKey(year) {
    return STORAGE_PREFIX + ":ustree:" + year;
  }

  function legacyTargetKey(year) {
    return STORAGE_PREFIX + ":target:" + year;
  }

  function loadTargets(storage, year) {
    try {
      var stored = storage.getItem(storageKey(year));
      if (stored !== null) return normalizeTargets(JSON.parse(stored));

      var legacy = normalizeCode(storage.getItem(legacyTargetKey(year)) || "");
      return normalizeTargets([legacy]);
    } catch (_error) {
      return [];
    }
  }

  function saveTargets(storage, year, targets) {
    var normalized = normalizeTargets(targets);
    storage.setItem(storageKey(year), JSON.stringify(normalized));
    return normalized;
  }

  function nodeScore(node) {
    var score = node && node.placeholder ? 0 : 8;
    if (node && node.level != null) score += 4;
    if (node && node.title && node.title !== "Course details unavailable") score += 2;
    if (node && node.source_url) score += 1;
    return score;
  }

  function edgeKey(edge) {
    var source = String(edge.source || "");
    var target = String(edge.target || "");
    var relation = String(edge.relation || edge.kind || "prerequisite");
    if (edge.symmetric && source.indexOf("course:") === 0 && target.indexOf("course:") === 0) {
      var endpoints = [source, target].sort();
      source = endpoints[0];
      target = endpoints[1];
    }
    return [relation, source, target, edge.qualifier || edge.label || "", edge.symmetric ? "1" : "0"].join("|");
  }

  function diagnosticKey(item) {
    return [
      item && item.type || "",
      item && item.message || "",
      JSON.stringify(item && item.courses || []),
      JSON.stringify(item && item.path || [])
    ].join("|");
  }

  function mergeGraphs(year, targets, graphEntries) {
    var roots = normalizeTargets(targets);
    var entries = (Array.isArray(graphEntries) ? graphEntries : []).slice().sort(function (left, right) {
      return normalizeCode(left.target).localeCompare(normalizeCode(right.target));
    });
    var nodesById = new Map();
    var edgesByKey = new Map();
    var diagnosticsByKey = new Map();
    var relations = new Set();
    var truncated = false;
    var depth = null;

    entries.forEach(function (entry) {
      var graph = entry.graph || {};
      if (depth == null && graph.depth != null) depth = graph.depth;
      truncated = truncated || Boolean(graph.truncated);
      (graph.relations || []).forEach(function (relation) { relations.add(relation); });
      (graph.nodes || []).forEach(function (node) {
        if (!node || !node.id) return;
        var existing = nodesById.get(node.id);
        if (!existing || nodeScore(node) > nodeScore(existing)) {
          nodesById.set(node.id, Object.assign({}, existing || {}, node));
        }
      });
      (graph.edges || []).forEach(function (edge) {
        if (!edge || !edge.source || !edge.target) return;
        var key = edgeKey(edge);
        if (!edgesByKey.has(key)) edgesByKey.set(key, Object.assign({}, edge));
      });
      (graph.diagnostics || []).forEach(function (item) {
        var key = diagnosticKey(item);
        if (!diagnosticsByKey.has(key)) diagnosticsByKey.set(key, Object.assign({}, item));
      });
    });

    var nodes = Array.from(nodesById.values()).sort(function (left, right) {
      return String(left.id).localeCompare(String(right.id));
    });
    var nodeIds = new Set(nodes.map(function (node) { return node.id; }));
    var edges = Array.from(edgesByKey.entries()).filter(function (entry) {
      return nodeIds.has(entry[1].source) && nodeIds.has(entry[1].target);
    }).sort(function (left, right) {
      return left[0].localeCompare(right[0]);
    }).map(function (entry, index) {
      return Object.assign({}, entry[1], { id: "edge:merged:" + (index + 1) });
    });

    return {
      year: year,
      root: roots[0] || null,
      roots: roots,
      targets: roots,
      depth: depth,
      relations: Array.from(relations).sort(),
      nodes: nodes,
      edges: edges,
      diagnostics: Array.from(diagnosticsByKey.entries()).sort(function (left, right) {
        return left[0].localeCompare(right[0]);
      }).map(function (entry) { return entry[1]; }),
      truncated: truncated
    };
  }

  global.USTreeSupport = {
    normalizeTargets: normalizeTargets,
    storageKey: storageKey,
    loadTargets: loadTargets,
    saveTargets: saveTargets,
    mergeGraphs: mergeGraphs,
    requirementStatus: requirementStatus,
    requirementStatusLabel: requirementStatusLabel,
    requirementStatusMarker: requirementStatusMarker,
    REQUIREMENT_STATES: {
      COMPLETED: REQUIREMENT_COMPLETED,
      MET: REQUIREMENT_MET,
      UNMET: REQUIREMENT_UNMET,
      UNKNOWN: REQUIREMENT_UNKNOWN
    }
  };
}(typeof window !== "undefined" ? window : this));
