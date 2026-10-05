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

  // -------------------------------------------------------------------------
  // Hide fulfilled prereqs
  // -------------------------------------------------------------------------
  // When a course's prerequisite or corequisite requirement is already
  // satisfied by the finished courses, the branches that did not contribute to
  // that satisfaction are redundant. With "COMP 1023 OR COMP 1028" and
  // COMP 1023 done, COMP 1028 (and anything shown only because of it) can be
  // hidden. Starred/in-plan courses (`planned`) are treated as complete for
  // this purpose too, so a planned course can fulfil a requirement and hide
  // its alternatives. Returns the node ids to hide. Roots/targets, the courses
  // shown as dependents, and finished/planned courses are never hidden, and a
  // course that some remaining course still needs survives -- so the answer is
  // conservative: grade-qualified branches are left alone because a
  // completion alone does not prove the grade was met.
  function hiddenFulfilledPrereqNodes(graph, completed, planned) {
    var nodes = (graph && graph.nodes) || [];
    var edges = (graph && graph.edges) || [];
    var nodesById = new Map();
    nodes.forEach(function (node) {
      if (node && node.id) nodesById.set(String(node.id), node);
    });

    // Prerequisite and corequisite edges point from a requirement course to
    // the course that needs it. Keep each edge's relation so a prerequisite
    // branch and a corequisite branch are never mistaken for alternatives, and
    // its qualifier ("Grade A or above", ...) because that decides whether a
    // finished course really satisfies the branch.
    var requirementRelations = { prerequisite: true, corequisite: true };
    var incoming = new Map();
    var outgoing = new Map();
    edges.forEach(function (edge) {
      if (!edge) return;
      var relation = edge.relation || edge.kind || "prerequisite";
      if (!requirementRelations[relation]) return;
      var source = String(edge.source);
      var target = String(edge.target);
      if (!incoming.has(target)) incoming.set(target, []);
      incoming.get(target).push({
        source: source,
        qualifier: edge.qualifier || "",
        relation: relation
      });
      if (!outgoing.has(source)) outgoing.set(source, []);
      outgoing.get(source).push(target);
    });

    var finished = toCompletionSet(completed);
    // Finished and starred/in-plan courses both count as "done" when deciding
    // whether a prerequisite branch is already satisfied.
    var credited = toCompletionSet(planned);
    finished.forEach(function (code) { credited.add(code); });

    function childEdges(nodeId) {
      return incoming.get(nodeId) || [];
    }

    function isCompletedCourse(nodeId) {
      var node = nodesById.get(nodeId);
      return Boolean(node) && node.type === "course" && credited.has(normalizeCode(node.code));
    }

    // Verdict for one branch, given the qualifier on the edge that links it to
    // the requirement it belongs to. This mirrors requirementStatus, but a
    // course only counts as met when it is not grade-qualified: finishing a
    // course does not tell us whether the required grade was earned.
    var statusCache = new Map();
    var evaluating = new Set();
    function evalBranch(nodeId, qualifier) {
      var cacheKey = nodeId + "\u0000" + (qualifier || "");
      if (statusCache.has(cacheKey)) return statusCache.get(cacheKey);
      // A requirement cycle would otherwise recurse forever; treat the
      // in-progress branch as unknown.
      if (evaluating.has(cacheKey)) return REQUIREMENT_UNKNOWN;
      evaluating.add(cacheKey);
      var node = nodesById.get(nodeId);
      var result;
      if (!node) {
        result = REQUIREMENT_UNKNOWN;
      } else if (node.type === "course") {
        var met = credited.has(normalizeCode(node.code));
        result = met ? (qualifier ? REQUIREMENT_UNKNOWN : REQUIREMENT_MET) : REQUIREMENT_UNMET;
      } else if (node.type === "coursePattern") {
        var pattern = patternStatus(node, credited);
        result = pattern === REQUIREMENT_MET && qualifier ? REQUIREMENT_UNKNOWN : pattern;
      } else if (node.type === "all" || node.type === "any") {
        var children = childEdges(nodeId);
        if (!children.length) {
          result = REQUIREMENT_UNKNOWN;
        } else {
          var results = children.map(function (child) {
            return evalBranch(child.source, child.qualifier);
          });
          if (node.type === "any") {
            if (results.indexOf(REQUIREMENT_MET) !== -1) result = REQUIREMENT_MET;
            else if (results.every(function (state) { return state === REQUIREMENT_UNMET; })) result = REQUIREMENT_UNMET;
            else result = REQUIREMENT_UNKNOWN;
          } else if (results.indexOf(REQUIREMENT_UNMET) !== -1) {
            result = REQUIREMENT_UNMET;
          } else if (results.every(function (state) { return state === REQUIREMENT_MET; })) {
            result = REQUIREMENT_MET;
          } else {
            result = REQUIREMENT_UNKNOWN;
          }
        }
      } else {
        result = REQUIREMENT_UNKNOWN;
      }
      evaluating.delete(cacheKey);
      statusCache.set(cacheKey, result);
      return result;
    }

    // Does this branch still hold a finished course beneath its boolean
    // junctions? Course nodes are leaves here, so a finished course sitting
    // behind an unfinished course never rescues that unfinished course.
    function hasCompletedInSubtree(nodeId, trail) {
      var seen = trail || new Set();
      if (seen.has(nodeId)) return false;
      seen.add(nodeId);
      if (isCompletedCourse(nodeId)) return true;
      var node = nodesById.get(nodeId);
      if (!node || node.type === "course") return false;
      return childEdges(nodeId).some(function (edge) {
        return hasCompletedInSubtree(edge.source, seen);
      });
    }

    var keep = new Set();
    var redundant = new Set();
    var considered = new Set();
    var needed = new Set();
    var satisfied = new Set();

    // Keep a branch. A nested boolean requirement that is already satisfied
    // does not need every one of its alternatives: keep only the parts that
    // fulfil it. Without this an unmet ancestor would drag a finished course's
    // unused alternatives back in (e.g. MATH 4427's unmet AND requirement
    // re-keeping "MATH 2011 OR MATH 2023 OR MATH 2024" even though MATH 2011
    // is done). Everything else is kept whole, which is what lets unmet or
    // unclear requirements -- and any subtree still holding a finished course
    // -- survive.
    function needSubtree(nodeId) {
      if (needed.has(nodeId)) return;
      var node = nodesById.get(nodeId);
      if (node && (node.type === "any" || node.type === "all") &&
          evalBranch(nodeId, "") === REQUIREMENT_MET) {
        keepSatisfied(nodeId);
        return;
      }
      needed.add(nodeId);
      keep.add(nodeId);
      if (!node) return;
      if (node.type === "course") {
        considerCourse(nodeId);
        return;
      }
      childEdges(nodeId).forEach(function (edge) { needSubtree(edge.source); });
    }

    // A redundant branch may still hold a finished course. Keep just the
    // minimum structure needed to show it -- the boolean junctions on the
    // paths down to finished courses and the finished courses themselves --
    // and drop every unused alternative. This is what stops one finished
    // course buried in a redundant branch from dragging that branch's whole
    // sibling subtree (e.g. MATH 1020/MATH 1024) back into the tree.
    function keepCompletedPaths(nodeId) {
      if (keep.has(nodeId) || needed.has(nodeId)) return;
      if (isCompletedCourse(nodeId)) {
        keep.add(nodeId);
        considerCourse(nodeId);
        return;
      }
      var node = nodesById.get(nodeId);
      if (!node || node.type === "course") {
        redundant.add(nodeId);
        return;
      }
      keep.add(nodeId);
      childEdges(nodeId).forEach(function (edge) {
        if (hasCompletedInSubtree(edge.source)) keepCompletedPaths(edge.source);
        else dropBranch(edge.source);
      });
    }

    // Drop a redundant alternative: mark its whole subtree hideable, except
    // for the finished courses it contains and the junctions that connect
    // them. Nodes kept elsewhere (or finished) are filtered out before
    // returning.
    function dropBranch(nodeId) {
      if (redundant.has(nodeId)) return;
      if (hasCompletedInSubtree(nodeId)) {
        keepCompletedPaths(nodeId);
        return;
      }
      redundant.add(nodeId);
      childEdges(nodeId).forEach(function (edge) { dropBranch(edge.source); });
    }

    // Keep only the parts of a satisfied requirement that actually satisfy it.
    function keepSatisfied(nodeId) {
      if (satisfied.has(nodeId)) return;
      satisfied.add(nodeId);
      keep.add(nodeId);
      var node = nodesById.get(nodeId);
      if (!node) return;
      if (node.type === "course") {
        considerCourse(nodeId);
        return;
      }
      if (node.type !== "all" && node.type !== "any") return;
      var children = childEdges(nodeId);
      if (node.type === "all") {
        children.forEach(function (edge) {
          if (evalBranch(edge.source, edge.qualifier) === REQUIREMENT_MET) keepSatisfied(edge.source);
          else needSubtree(edge.source);
        });
        return;
      }
      children.forEach(function (edge) {
        if (evalBranch(edge.source, edge.qualifier) === REQUIREMENT_MET) keepSatisfied(edge.source);
        else dropBranch(edge.source);
      });
    }

    // Decide which branches of one requirement group (a single relation) are
    // redundant. When a course lists several independent top-level branches of
    // the same relation, a satisfied one makes the others redundant.
    function considerRequirementGroup(tops) {
      if (tops.length > 1) {
        var anyMet = tops.some(function (edge) {
          return evalBranch(edge.source, edge.qualifier) === REQUIREMENT_MET;
        });
        tops.forEach(function (edge) {
          var state = evalBranch(edge.source, edge.qualifier);
          if (state === REQUIREMENT_MET) keepSatisfied(edge.source);
          else if (anyMet) dropBranch(edge.source);
          else needSubtree(edge.source);
        });
        return;
      }
      if (evalBranch(tops[0].source, tops[0].qualifier) === REQUIREMENT_MET) keepSatisfied(tops[0].source);
      else needSubtree(tops[0].source);
    }

    function considerCourse(courseId) {
      if (considered.has(courseId)) return;
      considered.add(courseId);
      keep.add(courseId);
      var tops = childEdges(courseId);
      if (!tops.length) return;
      // Prerequisites and corequisites are independent requirements, so group
      // them before pruning: a satisfied prerequisite never makes a corequisite
      // (or vice versa) redundant.
      var groups = new Map();
      tops.forEach(function (edge) {
        var relation = edge.relation || "prerequisite";
        if (!groups.has(relation)) groups.set(relation, []);
        groups.get(relation).push(edge);
      });
      groups.forEach(considerRequirementGroup);
    }

    // Seeds: the roots/targets plus every course that depends on one of them
    // (the forward direction). Dependents sit behind boolean junctions, so the
    // walk follows requirement edges across junctions rather than stopping at
    // them. Every other course is kept only if some processed requirement
    // still needs it, which is what lets a redundant requirement disappear.
    var seeds = [];
    var seenSeed = new Set();
    normalizeTargets(graph && (graph.roots || graph.targets || [graph && graph.root])).forEach(function (code) {
      var id = "course:" + code;
      if (nodesById.has(id) && !seenSeed.has(id)) {
        seenSeed.add(id);
        seeds.push(id);
      }
    });
    var queue = seeds.slice();
    var visited = new Set();
    while (queue.length) {
      var current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      (outgoing.get(current) || []).forEach(function (next) {
        if (visited.has(next)) return;
        var node = nodesById.get(next);
        if (node && node.type === "course" && !seenSeed.has(next)) {
          seenSeed.add(next);
          seeds.push(next);
        }
        // Keep walking even through boolean junctions and detail nodes.
        queue.push(next);
      });
    }
    seeds.forEach(considerCourse);

    var hidden = [];
    redundant.forEach(function (nodeId) {
      if (keep.has(nodeId) || isCompletedCourse(nodeId)) return;
      hidden.push(nodeId);
    });
    return hidden.sort();
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
    hiddenFulfilledPrereqNodes: hiddenFulfilledPrereqNodes,
    REQUIREMENT_STATES: {
      COMPLETED: REQUIREMENT_COMPLETED,
      MET: REQUIREMENT_MET,
      UNMET: REQUIREMENT_UNMET,
      UNKNOWN: REQUIREMENT_UNKNOWN
    }
  };
}(typeof window !== "undefined" ? window : this));
