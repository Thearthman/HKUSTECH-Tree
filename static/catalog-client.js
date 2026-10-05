/**
 * Browser-only HKUST catalog client.
 *
 * This is the JavaScript port of the original Python query layer (preserved on
 * the `local` branch). It loads the prebuilt `static/data/catalog.json` once,
 * mirrors it into IndexedDB for offline reuse, and answers the same
 * course/search/graph queries the old Flask `/api/*` endpoints used to serve.
 * No server-side state is involved.
 */
(function (global) {
  "use strict";

  var DEFAULT_YEAR = "2026-27";
  var CATALOG_URL = "/data/catalog.json";
  var RELATIONS = ["prerequisite", "corequisite", "exclusion"];
  var RELATION_ALIASES = {
    prerequisites: "prerequisite",
    prereqs: "prerequisite",
    corequisites: "corequisite",
    coreqs: "corequisite",
    exclusions: "exclusion"
  };
  var IDB_NAME = "hkust-course-tree";
  var IDB_VERSION = 1;
  var IDB_STORE = "catalogs";

  var FULL_CODE_RE = /^\s*([A-Za-z]{4})\s*[-_]?\s*(\d{4}[A-Za-z]?)\s*$/;
  var COURSE_RE = /(?<![A-Za-z0-9])([A-Za-z]{4})\s*[-_]?\s*(\d{4}[A-Za-z]?)(?![A-Za-z0-9])/g;

  var state = {
    data: null,
    pending: null,
    levels: {}
  };

  function cleanText(value) {
    return String(value == null ? "" : value)
      .replace(/\u00a0/g, " ")
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeCourseCode(value) {
    if (typeof value !== "string") return null;
    var match = FULL_CODE_RE.exec(cleanText(value).toUpperCase());
    if (!match) return null;
    return match[1].toUpperCase() + " " + match[2].toUpperCase();
  }

  function abortError() {
    if (typeof global.DOMException === "function") {
      return new global.DOMException("The operation was aborted.", "AbortError");
    }
    var error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function catalogError(message, code) {
    var error = new Error(message);
    if (code) error.code = code;
    return error;
  }

  // -------------------------------------------------------------------------
  // Expression helpers (port of iter_course_refs / _mandatory_course_refs)
  // -------------------------------------------------------------------------

  function iterCourseRefs(expression) {
    var codes = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === "course") {
        var code = normalizeCourseCode(String(node.code || ""));
        if (code) codes.push(code);
      } else if (node.type === "all" || node.type === "any") {
        (node.items || []).forEach(walk);
      }
    }(expression));
    return codes;
  }

  function mandatoryCourseRefs(expression) {
    var codes = [];
    (function walk(node) {
      if (!node) return;
      if (node.type === "course") {
        var code = normalizeCourseCode(String(node.code || ""));
        if (code) codes.push(code);
      } else if (node.type === "all") {
        // No individual child of ANY is mandatory, so alternatives never become
        // a single corequisite component.
        (node.items || []).forEach(walk);
      }
    }(expression));
    return codes;
  }

  function normalizeRelations(relations) {
    if (relations == null) return RELATIONS.slice();
    var values = typeof relations === "string"
      ? relations.split(",")
      : (Array.isArray(relations) ? relations.slice() : [relations]);
    var selected = [];
    values.forEach(function (value) {
      var key = String(value).trim().toLowerCase();
      var normalized = RELATION_ALIASES[key] || key;
      if (RELATIONS.indexOf(normalized) === -1) {
        throw catalogError("Unsupported relation: " + value, "invalid_relations");
      }
      if (selected.indexOf(normalized) === -1) selected.push(normalized);
    });
    if (!selected.length) {
      throw catalogError("Relations must include prerequisite, corequisite, or exclusion", "invalid_relations");
    }
    return selected;
  }

  function requirementsOf(record) {
    return (record && record.requirements) || {};
  }

  // -------------------------------------------------------------------------
  // Level calculation (port of _UnionFind / _calculate_levels)
  // -------------------------------------------------------------------------

  function UnionFind(items) {
    this.parent = Object.create(null);
    var self = this;
    items.forEach(function (item) { self.parent[item] = item; });
  }
  UnionFind.prototype.find = function (item) {
    var parent = this.parent[item];
    if (parent !== item) this.parent[item] = this.find(parent);
    return this.parent[item];
  };
  UnionFind.prototype.union = function (left, right) {
    var leftRoot = this.find(left);
    var rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  };

  function calculateLevels(courses) {
    var codes = Object.keys(courses);
    var unionFind = new UnionFind(codes);
    codes.forEach(function (courseCode) {
      var requirement = requirementsOf(courses[courseCode]).corequisite;
      if (!requirement) return;
      mandatoryCourseRefs(requirement.expression).forEach(function (reference) {
        if (courses[reference]) unionFind.union(courseCode, reference);
      });
    });

    var components = Object.create(null);
    codes.forEach(function (courseCode) {
      var root = unionFind.find(courseCode);
      (components[root] || (components[root] = [])).push(courseCode);
    });

    var cache = Object.create(null);
    var visiting = [];
    var cycleKeys = Object.create(null);

    function expressionLevel(expression) {
      if (!expression) return null;
      var nodeType = expression.type;
      if (nodeType === "course") {
        var reference = normalizeCourseCode(String(expression.code || ""));
        if (!reference || !courses[reference]) return null;
        return componentLevel(unionFind.find(reference));
      }
      if (nodeType === "all") {
        var allChildren = (expression.items || []).map(expressionLevel);
        if (!allChildren.length || allChildren.some(function (value) { return value === null; })) {
          return null;
        }
        return Math.max.apply(null, allChildren);
      }
      if (nodeType === "any") {
        var known = (expression.items || []).map(expressionLevel).filter(function (value) {
          return value !== null;
        });
        return known.length ? Math.max.apply(null, known) : null;
      }
      // Prose conditions and broad patterns do not add dependency bands.
      return 0;
    }

    function componentLevel(component) {
      if (Object.prototype.hasOwnProperty.call(cache, component)) return cache[component];
      if (visiting.indexOf(component) !== -1) {
        var cycleComponents = visiting.slice(visiting.indexOf(component)).concat([component]);
        var cycleCourses = Object.create(null);
        for (var index = 0; index < cycleComponents.length - 1; index += 1) {
          var sourceComponent = cycleComponents[index];
          var targetComponent = cycleComponents[index + 1];
          (components[sourceComponent] || []).forEach(function (member) {
            var requirement = requirementsOf(courses[member]).prerequisite;
            if (!requirement) return;
            iterCourseRefs(requirement.expression).forEach(function (reference) {
              if (courses[reference] && unionFind.find(reference) === targetComponent) {
                cycleCourses[member] = true;
                cycleCourses[reference] = true;
              }
            });
          });
        }
        cycleKeys[Object.keys(cycleCourses).sort().join("\u0000")] = Object.keys(cycleCourses).sort();
        cycleComponents.forEach(function (memberComponent) {
          cache[memberComponent] = null;
        });
        return null;
      }

      visiting.push(component);
      var memberResults = [];
      var hasRequirement = false;
      (components[component] || []).forEach(function (member) {
        var requirement = requirementsOf(courses[member]).prerequisite;
        if (!requirement) {
          memberResults.push(1);
          return;
        }
        hasRequirement = true;
        var dependencyRank = expressionLevel(requirement.expression);
        memberResults.push(dependencyRank === null ? null : 1 + dependencyRank);
      });

      var result;
      if (!hasRequirement) result = 1;
      else if (memberResults.some(function (value) { return value === null; })) result = null;
      else result = Math.max.apply(null, memberResults);
      visiting.pop();
      if (!Object.prototype.hasOwnProperty.call(cache, component)) cache[component] = result;
      return cache[component];
    }

    Object.keys(components).forEach(componentLevel);

    var courseLevels = Object.create(null);
    codes.forEach(function (courseCode) {
      var value = cache[unionFind.find(courseCode)];
      courseLevels[courseCode] = value === undefined ? null : value;
    });

    var diagnostics = Object.keys(cycleKeys).sort().map(function (key) {
      var coursesInCycle = cycleKeys[key];
      return {
        type: "cycle",
        relation: "prerequisite",
        message: "Prerequisite cycle prevents authoritative level calculation",
        courses: coursesInCycle.slice()
      };
    });
    return { levels: courseLevels, diagnostics: diagnostics };
  }

  // -------------------------------------------------------------------------
  // Graph construction (port of CatalogStore.build_graph)
  // -------------------------------------------------------------------------

  function buildGraph(courses, options) {
    var opts = options || {};
    var year = opts.year;
    var root = normalizeCourseCode(opts.code);
    if (!root) throw catalogError("Invalid course code", "invalid_course_code");
    if (!courses[root]) {
      throw catalogError(root + " is not in the " + year + " catalog", "course_not_found");
    }
    var depth = opts.depth == null || opts.depth === "all" ? null : Math.max(0, parseInt(opts.depth, 10) || 0);
    var maxNodes = opts.maxNodes == null ? 250 : Math.max(1, Math.min(parseInt(opts.maxNodes, 10) || 250, 2000));
    var selectedRelations = normalizeRelations(opts.relations);
    var direction = String(opts.direction == null ? "backward" : opts.direction).trim().toLowerCase();
    if (["backward", "forward", "both"].indexOf(direction) === -1) {
      throw catalogError("Unsupported graph direction: " + direction, "invalid_direction");
    }

    var levelInfo = getLevels(courses, year);
    var levelMap = levelInfo.levels;
    var diagnostics = [];

    var nodes = [];
    var nodeIds = Object.create(null);
    var edges = [];
    var edgeKeys = Object.create(null);
    var expandedBackward = Object.create(null);
    var expandedForward = Object.create(null);
    var unresolved = Object.create(null);
    var truncated = false;

    var dependentsByPrerequisite = Object.create(null);
    if ((direction === "forward" || direction === "both") && selectedRelations.indexOf("prerequisite") !== -1) {
      Object.keys(courses).forEach(function (dependentCode) {
        var requirement = requirementsOf(courses[dependentCode]).prerequisite;
        if (!requirement) return;
        var seen = Object.create(null);
        iterCourseRefs(requirement.expression).forEach(function (reference) {
          if (seen[reference]) return;
          seen[reference] = true;
          (dependentsByPrerequisite[reference] || (dependentsByPrerequisite[reference] = [])).push(dependentCode);
        });
      });
      Object.keys(dependentsByPrerequisite).forEach(function (reference) {
        dependentsByPrerequisite[reference] = Array.from(new Set(dependentsByPrerequisite[reference])).sort();
      });
    }

    function addNode(node) {
      var nodeId = String(node.id);
      if (nodeIds[nodeId]) return true;
      if (nodes.length >= maxNodes) {
        truncated = true;
        return false;
      }
      nodeIds[nodeId] = true;
      nodes.push(node);
      return true;
    }

    function addCourseNode(courseCode) {
      var record = courses[courseCode];
      if (record) {
        return addNode({
          id: "course:" + courseCode,
          type: "course",
          code: courseCode,
          subject: record.subject,
          title: record.title,
          credits: record.credits,
          source_url: record.source_url,
          level: levelMap[courseCode] == null ? null : levelMap[courseCode],
          placeholder: false
        });
      }
      unresolved[courseCode] = true;
      return addNode({
        id: "course:" + courseCode,
        type: "course",
        code: courseCode,
        subject: courseCode.split(" ")[0],
        title: "Course details unavailable",
        credits: "",
        source_url: null,
        level: null,
        placeholder: true
      });
    }

    function addEdge(source, target, relation, config) {
      var settings = config || {};
      var qualifier = settings.qualifier;
      var symmetric = Boolean(settings.symmetric);
      var key;
      if (symmetric && source.indexOf("course:") === 0 && target.indexOf("course:") === 0) {
        key = relation + "\u0000" + [source, target].sort().join("\u0000");
      } else {
        key = relation + "\u0000" + source + "\u0000" + target + "\u0000" + (qualifier || "");
      }
      if (edgeKeys[key] || !nodeIds[source] || !nodeIds[target]) return;
      edgeKeys[key] = true;
      var edge = {
        id: "edge:" + (edges.length + 1),
        source: source,
        target: target,
        relation: relation
      };
      if (qualifier) edge.qualifier = qualifier;
      if (symmetric) edge.symmetric = true;
      edges.push(edge);
    }

    function emitExpression(expression, ownerCode, relation, targetId, path, distance, expandReferences) {
      var nodeType = expression.type;
      var reverse = relation === "exclusion";
      if (nodeType === "course") {
        var referenced = normalizeCourseCode(String(expression.code || ""));
        if (!referenced || !addCourseNode(referenced)) return;
        var courseId = "course:" + referenced;
        if (reverse) {
          addEdge(targetId, courseId, relation, { qualifier: expression.qualifier, symmetric: true });
        } else {
          addEdge(courseId, targetId, relation, {
            qualifier: expression.qualifier,
            symmetric: relation === "corequisite"
          });
        }
        if (expandReferences && courses[referenced]) expandBackward(referenced, distance + 1);
        return;
      }
      if (nodeType === "all" || nodeType === "any") {
        var junctionId = "bool:" + ownerCode + ":" + relation + ":" + path;
        if (!addNode({
          id: junctionId,
          type: nodeType,
          label: nodeType.toUpperCase(),
          relation: relation,
          level: levelMap[ownerCode] == null ? null : levelMap[ownerCode]
        })) {
          return;
        }
        if (reverse) addEdge(targetId, junctionId, relation, { symmetric: true });
        else addEdge(junctionId, targetId, relation, { symmetric: relation === "corequisite" });
        (expression.items || []).forEach(function (item, index) {
          emitExpression(item, ownerCode, relation, junctionId, path + "." + index, distance, expandReferences);
        });
        return;
      }
      var detailId = (nodeType || "condition") + ":" + ownerCode + ":" + relation + ":" + path;
      var detailNode = {
        id: detailId,
        type: nodeType || "condition",
        relation: relation,
        level: levelMap[ownerCode] == null ? null : levelMap[ownerCode],
        text: expression.text || "Requirement condition"
      };
      if (nodeType === "coursePattern") {
        detailNode.subject = expression.subject;
        detailNode.minimumLevel = expression.minimumLevel;
      }
      if (addNode(detailNode)) {
        if (reverse) addEdge(targetId, detailId, relation, { symmetric: true });
        else addEdge(detailId, targetId, relation, { symmetric: relation === "corequisite" });
      }
    }

    function expandBackward(courseCode, distance) {
      if (expandedBackward[courseCode]) return;
      expandedBackward[courseCode] = true;
      if (depth !== null && distance >= depth) return;
      var record = courses[courseCode];
      selectedRelations.forEach(function (relation) {
        var requirement = requirementsOf(record)[relation];
        if (!requirement) return;
        emitExpression(requirement.expression, courseCode, relation, "course:" + courseCode, "0", distance, true);
      });
    }

    function expandForward(courseCode, distance) {
      if (expandedForward[courseCode]) return;
      expandedForward[courseCode] = true;
      if (depth !== null && distance >= depth) return;
      (dependentsByPrerequisite[courseCode] || []).forEach(function (dependentCode) {
        if (!addCourseNode(dependentCode)) return;
        var requirement = requirementsOf(courses[dependentCode]).prerequisite;
        emitExpression(requirement.expression, dependentCode, "prerequisite", "course:" + dependentCode, "0", distance, false);
        expandForward(dependentCode, distance + 1);
      });
    }

    addCourseNode(root);
    if (direction === "backward" || direction === "both") expandBackward(root, 0);
    if (direction === "forward" || direction === "both") expandForward(root, 0);

    var includedCourses = {};
    nodes.forEach(function (node) {
      if (node.type === "course" && node.code) includedCourses[node.code] = true;
    });
    levelInfo.diagnostics.forEach(function (diagnostic) {
      if (diagnostic.type !== "cycle" || (diagnostic.courses || []).some(function (code) {
        return includedCourses[code];
      })) {
        diagnostics.push(diagnostic);
      }
    });
    var unresolvedCodes = Object.keys(unresolved).sort();
    if (unresolvedCodes.length) {
      diagnostics.push({
        type: "unresolved",
        message: "Some referenced courses are not present in the cached catalog",
        courses: unresolvedCodes
      });
    }
    if (truncated) {
      diagnostics.push({
        type: "truncated",
        message: "Graph reached the " + maxNodes + "-node safety limit"
      });
    }
    return {
      year: year,
      root: root,
      relations: selectedRelations.slice(),
      direction: direction,
      depth: depth,
      nodes: nodes,
      edges: edges,
      diagnostics: diagnostics,
      truncated: truncated
    };
  }

  // -------------------------------------------------------------------------
  // Catalog loading and caching
  // -------------------------------------------------------------------------

  function getLevels(courses, year) {
    if (!state.levels[year]) state.levels[year] = calculateLevels(courses);
    return state.levels[year];
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        resolve(null);
        return;
      }
      var request = global.indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var transaction = db.transaction(IDB_STORE, "readonly");
        var request = transaction.objectStore(IDB_STORE).get(key);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function idbPut(key, value) {
    return idbOpen().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        var transaction = db.transaction(IDB_STORE, "readwrite");
        transaction.objectStore(IDB_STORE).put(value, key);
        transaction.oncomplete = function () { resolve(); };
        transaction.onerror = function () { resolve(); };
      });
    }).catch(function () { /* Caching is best-effort. */ });
  }

  function acceptCatalog(data) {
    if (!data || typeof data !== "object" || !data.courses || typeof data.courses !== "object") {
      throw catalogError("The catalog data is missing or malformed.", "invalid_catalog");
    }
    state.data = data;
    state.levels = {};
    return data;
  }

  function fetchCatalog(force) {
    var options = force ? { cache: "no-store" } : {};
    return global.fetch(CATALOG_URL, options).then(function (response) {
      if (!response.ok) {
        throw catalogError("Catalog could not be loaded (status " + response.status + ").", "catalog_unavailable");
      }
      return response.json();
    });
  }

  function load() {
    if (state.data) return Promise.resolve(state.data);
    if (state.pending) return state.pending;
    state.pending = fetchCatalog(false)
      .then(function (data) {
        var accepted = acceptCatalog(data);
        idbPut("catalog", { generatedAt: accepted.generatedAt, data: accepted });
        return accepted;
      })
      .catch(function (networkError) {
        return idbGet("catalog").then(function (cached) {
          if (cached && cached.data) return acceptCatalog(cached.data);
          throw catalogError(
            "The course catalog could not be loaded from the network or browser cache.",
            "catalog_unavailable"
          );
        });
      })
      .then(function (data) {
        state.pending = null;
        return data;
      }, function (error) {
        state.pending = null;
        throw error;
      });
    return state.pending;
  }

  function reload() {
    var previous = state.data && state.data.generatedAt;
    return fetchCatalog(true).then(function (data) {
      var accepted = acceptCatalog(data);
      idbPut("catalog", { generatedAt: accepted.generatedAt, data: accepted });
      return {
        changed: Boolean(previous && previous !== accepted.generatedAt),
        generatedAt: accepted.generatedAt,
        year: accepted.year,
        courseCount: Object.keys(accepted.courses).length
      };
    });
  }

  function meta() {
    var data = state.data;
    if (!data) return null;
    return {
      year: data.year,
      generatedAt: data.generatedAt,
      source: data.source,
      sourceHash: data.sourceHash,
      subjectCount: (data.subjects || []).filter(function (subject) { return subject.fetched; }).length,
      courseCount: Object.keys(data.courses).length
    };
  }

  function catalogs() {
    return load().then(function (data) {
      var counts = meta() || {};
      return [{
        year: data.year,
        source_url: data.source,
        source_hash: data.sourceHash,
        last_synced: data.generatedAt,
        subject_count: counts.subjectCount || 0,
        course_count: counts.courseCount || 0,
        status: "ready"
      }];
    });
  }

  function search(year, query, limit, options) {
    var settings = options || {};
    return load().then(function (data) {
      throwIfAborted(settings.signal);
      var normalized = cleanText(query || "").toUpperCase();
      normalized = normalizeCourseCode(normalized) || normalized;
      var capped = Math.max(1, Math.min(parseInt(limit == null ? 30 : limit, 10) || 30, 100));
      var courses = data.courses;
      var matches = Object.keys(courses).filter(function (code) {
        var record = courses[code];
        return code.toUpperCase().indexOf(normalized) !== -1 ||
          String(record.title || "").toUpperCase().indexOf(normalized) !== -1;
      });
      matches.sort(function (left, right) {
        var leftRank = left === normalized ? 0 : (left.indexOf(normalized) === 0 ? 1 : 2);
        var rightRank = right === normalized ? 0 : (right.indexOf(normalized) === 0 ? 1 : 2);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return left < right ? -1 : (left > right ? 1 : 0);
      });
      return matches.slice(0, capped).map(function (code) {
        var record = courses[code];
        return {
          code: record.code,
          subject: record.subject,
          number: record.number,
          title: record.title,
          credits: record.credits,
          source_url: record.source_url
        };
      });
    });
  }

  function course(year, code, options) {
    var settings = options || {};
    return load().then(function (data) {
      throwIfAborted(settings.signal);
      var normalized = normalizeCourseCode(code);
      if (!normalized) return null;
      var record = data.courses[normalized];
      if (!record) return null;
      var requirements = {};
      RELATIONS.forEach(function (relation) {
        var requirement = requirementsOf(record)[relation];
        requirements[relation] = requirement
          ? {
              relation: requirement.relation || relation,
              raw: requirement.raw,
              status: requirement.status,
              warnings: requirement.warnings || [],
              expression: requirement.expression
            }
          : null;
      });
      return {
        year: record.year || data.year,
        code: record.code,
        subject: record.subject,
        number: record.number,
        title: record.title,
        credits: record.credits,
        description: record.description,
        source_url: record.source_url,
        requirements: requirements
      };
    });
  }

  function graph(options) {
    var settings = options || {};
    return load().then(function (data) {
      throwIfAborted(settings.signal);
      return buildGraph(data.courses, {
        year: data.year,
        code: settings.code,
        depth: settings.depth,
        relations: settings.relations,
        direction: settings.direction,
        maxNodes: settings.maxNodes
      });
    }).then(function (result) {
      throwIfAborted(settings.signal);
      return result;
    });
  }

  global.HKUSTCatalog = {
    DEFAULT_YEAR: DEFAULT_YEAR,
    RELATIONS: RELATIONS.slice(),
    CATALOG_URL: CATALOG_URL,
    load: load,
    reload: reload,
    meta: meta,
    catalogs: catalogs,
    search: search,
    course: course,
    graph: graph,
    normalizeCourseCode: normalizeCourseCode
  };
}(typeof window !== "undefined" ? window : this));
