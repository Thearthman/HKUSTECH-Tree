(function (global) {
  "use strict";

  var STORAGE_PREFIX = "hkust-course-tree";
  var DEFAULT_TARGET = "COMP 4211";

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
      return normalizeTargets([legacy || DEFAULT_TARGET]);
    } catch (_error) {
      return [DEFAULT_TARGET];
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
    mergeGraphs: mergeGraphs
  };
}(window));
