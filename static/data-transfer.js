(function (global) {
  "use strict";

  // Export/import for the browser-only page state. Everything the app keeps is
  // already in localStorage, so a transfer is a JSON snapshot of the keys we
  // own plus a small set of preferences:
  //   - USTree targets                hkust-course-tree:ustree:<year>
  //   - Finished courses              hkust-course-tree:completed:<year>
  //   - Last focused course           hkust-course-tree:focus:<year>
  //   - Selected major requirement    hkust-course-tree:major
  //   - Hide fulfilled prereqs        hkust-course-tree:hide-fulfilled-prereq
  //   - Theme                         hkust-course-tree:theme
  // Imports merge into the existing state (nothing is dropped) and report what
  // changed so the calling page can re-render from the updated storage.
  var PREFIX = "hkust-course-tree";
  var FORMAT = "hkust-course-tree";
  var VERSION = 1;
  var IDB_NAME = "hkust-course-tree";
  var MAJOR_KEY = PREFIX + ":major";
  var HIDE_FULFILLED_KEY = PREFIX + ":hide-fulfilled-prereq";
  var THEME_KEY = PREFIX + ":theme";
  var KEYS = {
    ustree: PREFIX + ":ustree:",
    completed: PREFIX + ":completed:",
    focus: PREFIX + ":focus:",
    legacyTarget: PREFIX + ":target:"
  };
  var COURSE_CODE = /^[A-Z]{2,5} \d{4}[A-Z]?$/;

  function normalizeCode(value) {
    var match = String(value || "").trim().toUpperCase().match(/^([A-Z]{2,5})\s*([0-9]{4}[A-Z]?)$/);
    return match ? match[1] + " " + match[2] : String(value || "").trim().toUpperCase();
  }

  function courseCode(value) {
    var code = normalizeCode(value);
    return COURSE_CODE.test(code) ? code : "";
  }

  function normalizeCourseList(values) {
    var seen = new Set();
    (Array.isArray(values) ? values : []).forEach(function (value) {
      var code = courseCode(value);
      if (code) seen.add(code);
    });
    return Array.from(seen).sort();
  }

  function safeGet(storage, key) {
    try {
      return storage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function safeSet(storage, key, value) {
    try {
      storage.setItem(key, value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function parseJson(raw, fallback) {
    try {
      return JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  function storageLength(storage) {
    try {
      return Number(storage.length) || 0;
    } catch (_error) {
      return 0;
    }
  }

  function storageKey(storage, index) {
    try {
      var key = storage.key(index);
      return typeof key === "string" ? key : null;
    } catch (_error) {
      return null;
    }
  }

  // A per-year key ("hkust-course-tree:ustree:2026-27") yields "2026-27";
  // anything that does not start with the base prefix yields null.
  function yearForKey(key, base) {
    if (key.indexOf(base) !== 0) return null;
    var year = key.slice(base.length);
    return year ? year : null;
  }

  function normalizeMajor(value) {
    if (!value) return null;
    if (typeof value === "string") {
      var plain = value.trim();
      return plain ? { id: plain, programCode: null, intake: null, catalogYear: null } : null;
    }
    if (typeof value !== "object") return null;
    var id = String(value.id || value.programId || "").trim();
    if (!id) return null;
    return {
      id: id,
      programCode: String(value.programCode || "").trim() || null,
      intake: String(value.intake || "").trim() || null,
      catalogYear: String(value.catalogYear || "").trim() || null
    };
  }

  function loadSelectedMajor(storage) {
    var raw = safeGet(storage || global.localStorage, MAJOR_KEY);
    if (!raw) return null;
    var trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (trimmed.charAt(0) === "{") return normalizeMajor(parseJson(trimmed, null));
    return normalizeMajor(trimmed);
  }

  function saveSelectedMajor(storage, major) {
    var target = storage || global.localStorage;
    var normalized = normalizeMajor(major);
    if (!normalized) {
      try {
        target.removeItem(MAJOR_KEY);
      } catch (_error) {
        // The selection simply does not persist when storage is unavailable.
      }
      return null;
    }
    safeSet(target, MAJOR_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function loadHideFulfilled(storage) {
    var raw = safeGet(storage || global.localStorage, HIDE_FULFILLED_KEY);
    if (raw === null || raw === undefined) return null;
    return raw === "1";
  }

  function loadTheme(storage) {
    var raw = safeGet(storage || global.localStorage, THEME_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  }

  function emptyBucket() {
    return { targets: [], completed: [] };
  }

  function bucketFor(years, year) {
    if (!years[year]) years[year] = emptyBucket();
    return years[year];
  }

  // Snapshot everything the site stores locally. The shape is stable and
  // versioned so a future release can migrate an older export.
  function collect(storage) {
    var source = storage || global.localStorage;
    var years = {};
    var count = storageLength(source);
    for (var index = 0; index < count; index += 1) {
      var key = storageKey(source, index);
      if (!key) continue;
      var year = yearForKey(key, KEYS.ustree);
      if (year) {
        bucketFor(years, year).targets = normalizeCourseList(parseJson(safeGet(source, key), []));
        continue;
      }
      year = yearForKey(key, KEYS.completed);
      if (year) {
        bucketFor(years, year).completed = normalizeCourseList(parseJson(safeGet(source, key), []));
        continue;
      }
      year = yearForKey(key, KEYS.focus);
      if (year) {
        var focus = courseCode(safeGet(source, key) || "");
        if (focus) bucketFor(years, year).focus = focus;
        continue;
      }
      year = yearForKey(key, KEYS.legacyTarget);
      if (year) {
        var legacy = courseCode(safeGet(source, key) || "");
        var legacyBucket = bucketFor(years, year);
        // The legacy single-target key only matters when no modern USTree list
        // was found for that year (loadTargets prefers the modern key).
        if (legacy && !legacyBucket.targets.length) legacyBucket.targets = [legacy];
      }
    }
    return {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      years: years,
      major: loadSelectedMajor(source),
      preferences: {
        hideFulfilledPrereq: loadHideFulfilled(source),
        theme: loadTheme(source)
      }
    };
  }

  function serialize(payload) {
    return JSON.stringify(payload, null, 2) + "\n";
  }

  // Accept the versioned shape and a few forgiving variants (flat targets /
  // completed, a bare major id) so imports keep working as the format grows.
  function validate(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("This file does not look like a HKUST Course Tree export.");
    }
    if (data.format && data.format !== FORMAT) {
      throw new Error('This file was exported by "' + data.format + '", not HKUST Course Tree.');
    }

    var years = {};
    var sourceYears = data.years && typeof data.years === "object" ? data.years : {};
    Object.keys(sourceYears).forEach(function (year) {
      var entry = sourceYears[year];
      if (!entry || typeof entry !== "object") return;
      var bucket = emptyBucket();
      bucket.targets = normalizeCourseList(entry.targets);
      bucket.completed = normalizeCourseList(entry.completed);
      var focus = courseCode(entry.focus || "");
      if (focus) bucket.focus = focus;
      years[String(year)] = bucket;
    });

    if (!Object.keys(years).length) {
      var flatTargets = normalizeCourseList(data.targets);
      var flatCompleted = normalizeCourseList(data.completed || data.completions);
      var flatFocus = courseCode(data.focus || "");
      if (flatTargets.length || flatCompleted.length || flatFocus) {
        var flatYear = String(data.year || data.catalogYear || "").trim();
        var flatBucket = emptyBucket();
        flatBucket.targets = flatTargets;
        flatBucket.completed = flatCompleted;
        if (flatFocus) flatBucket.focus = flatFocus;
        years[flatYear] = flatBucket;
      }
    }

    var preferences = {};
    if (data.preferences && typeof data.preferences === "object") {
      if (typeof data.preferences.hideFulfilledPrereq === "boolean") {
        preferences.hideFulfilledPrereq = data.preferences.hideFulfilledPrereq;
      }
      if (data.preferences.theme === "light" || data.preferences.theme === "dark") {
        preferences.theme = data.preferences.theme;
      }
    }

    var major = normalizeMajor(data.major);
    var hasData = Object.keys(years).length || major || Object.keys(preferences).length;
    // A file we stamped ourselves is always accepted (an empty snapshot is a
    // valid no-op import); anything else must actually contain our data.
    if (!hasData && data.format !== FORMAT) {
      throw new Error("This file does not contain any HKUST Course Tree data.");
    }

    return {
      format: FORMAT,
      version: Number(data.version) || VERSION,
      exportedAt: data.exportedAt || null,
      years: years,
      major: major,
      preferences: preferences
    };
  }

  function parse(text) {
    var data;
    try {
      data = JSON.parse(String(text || ""));
    } catch (_error) {
      throw new Error("That file is not valid JSON.");
    }
    return validate(data);
  }

  function existingList(storage, key) {
    return normalizeCourseList(parseJson(safeGet(storage, key), []));
  }

  function mergeList(storage, key, additions) {
    var existing = existingList(storage, key);
    var merged = normalizeCourseList(existing.concat(additions));
    safeSet(storage, key, JSON.stringify(merged));
    return { total: merged.length, added: merged.length - existing.length };
  }

  // Merge a validated payload into storage. Courses are keyed by catalog year,
  // so each year bucket is written independently; an empty year (from a legacy
  // flat file) falls back to the caller's current year.
  function apply(storage, payload, options) {
    var target = storage || global.localStorage;
    var settings = options || {};
    var data = validate(payload);
    var fallbackYear = String(settings.year || "").trim();
    var summary = {
      years: [],
      targets: 0,
      targetsAdded: 0,
      completed: 0,
      completedAdded: 0,
      major: null,
      preferences: [],
      skippedYears: []
    };

    Object.keys(data.years).forEach(function (year) {
      var resolved = year || fallbackYear;
      if (!resolved) {
        summary.skippedYears.push(year);
        return;
      }
      var entry = data.years[year];
      if (entry.targets.length) {
        var targets = mergeList(target, KEYS.ustree + resolved, entry.targets);
        summary.targets += targets.total;
        summary.targetsAdded += targets.added;
      }
      if (entry.completed.length) {
        var completed = mergeList(target, KEYS.completed + resolved, entry.completed);
        summary.completed += completed.total;
        summary.completedAdded += completed.added;
      }
      if (entry.focus) safeSet(target, KEYS.focus + resolved, entry.focus);
      if (summary.years.indexOf(resolved) === -1) summary.years.push(resolved);
    });

    if (data.major) summary.major = saveSelectedMajor(target, data.major);
    if (typeof data.preferences.hideFulfilledPrereq === "boolean") {
      safeSet(target, HIDE_FULFILLED_KEY, data.preferences.hideFulfilledPrereq ? "1" : "0");
      summary.preferences.push("hide-fulfilled");
    }
    if (data.preferences.theme) {
      safeSet(target, THEME_KEY, data.preferences.theme);
      summary.preferences.push("theme");
    }
    return summary;
  }

  // ---------------------------------------------------------------- resetting

  // Every key the site owns lives under the `hkust-course-tree` namespace, so a
  // prefix match is enough to find them all. The list is collected before any
  // removal because removing shifts the indices `storage.key` walks.
  function ownedKeys(storage) {
    var target = storage || global.localStorage;
    var found = [];
    var count = storageLength(target);
    for (var index = 0; index < count; index += 1) {
      var key = storageKey(target, index);
      if (key && key.indexOf(PREFIX) === 0) found.push(key);
    }
    return found;
  }

  // Delete the cached catalog. The catalog client owns the open IndexedDB
  // connection, so we ask it to close and drop the database; if it is not
  // loaded (or IndexedDB is unavailable) this is a best-effort no-op.
  function clearCatalogCache() {
    if (global.HKUSTCatalog && typeof global.HKUSTCatalog.clearCache === "function") {
      return Promise.resolve(global.HKUSTCatalog.clearCache()).catch(function () { return false; });
    }
    if (!global.indexedDB || typeof global.indexedDB.deleteDatabase !== "function") {
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      var request = global.indexedDB.deleteDatabase(IDB_NAME);
      request.onsuccess = function () { resolve(true); };
      request.onerror = function () { resolve(false); };
      request.onblocked = function () { resolve(false); };
    }).catch(function () { return false; });
  }

  // Erase every trace the site left in this browser: the localStorage keys it
  // owns (USTree targets, finished courses, focused course, selected major and
  // preferences) plus the IndexedDB catalog cache. Returns a promise so the
  // caller can reload only once the (async) database delete has settled.
  function clearAll(storage, options) {
    var settings = options || {};
    var target = storage || global.localStorage;
    var keys = ownedKeys(target);
    var removed = [];
    keys.forEach(function (key) {
      try {
        target.removeItem(key);
        removed.push(key);
      } catch (_error) {
        // Keep going: one stubborn key should not block the rest.
      }
    });
    var cache = settings.keepCatalogCache ? Promise.resolve(false) : clearCatalogCache();
    return cache.then(function (deleted) {
      return { keys: removed, databaseDeleted: Boolean(deleted) };
    });
  }

  function plural(count, singular) {
    return count + " " + singular + (count === 1 ? "" : "s");
  }

  function describe(summary) {
    var parts = [
      plural(summary.targetsAdded || 0, "USTree target"),
      plural(summary.completedAdded || 0, "completed course")
    ];
    if (summary.major && summary.major.id) parts.push("major " + summary.major.id);
    if (summary.preferences && summary.preferences.length) parts.push("settings");
    return "Imported " + parts.join(", ") + ".";
  }

  function defaultFilename() {
    var date = new Date();
    function pad(value) {
      return value < 10 ? "0" + value : String(value);
    }
    return "hkust-course-tree-" + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + ".json";
  }

  function download(payload, filename) {
    var text = serialize(payload);
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename || defaultFilename();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    global.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 0);
    return text;
  }

  var toastTimer = null;
  function toast(message, type) {
    if (!global.document || !document.body) return;
    var node = document.getElementById("dataTransferToast");
    if (!node) {
      node = document.createElement("div");
      node.id = "dataTransferToast";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.className = "data-toast is-visible" + (type ? " is-" + type : "");
    if (toastTimer) global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () {
      node.className = "data-toast";
    }, 4200);
  }

  // Wire the toolbar buttons. The caller supplies `year` (the catalog year to
  // use when an import omits one) and an `onApplied` callback so the page can
  // re-read storage and re-render; `onNotice` is optional when a host page
  // would rather route messages through its own notice bar.
  function bind(options) {
    var settings = options || {};
    var storage = settings.storage || global.localStorage;
    var exportButton = settings.exportButton || document.getElementById("exportData");
    var importButton = settings.importButton || document.getElementById("importData");
    var importInput = settings.importInput || document.getElementById("importDataInput");
    var notify = typeof settings.onNotice === "function"
      ? settings.onNotice
      : function (message, type) { toast(message, type); };

    function report(message, type) {
      try {
        notify(message, type);
      } catch (_error) {
        toast(message, type);
      }
    }

    if (exportButton) {
      exportButton.addEventListener("click", function () {
        var payload = collect(storage);
        var targets = 0;
        var completed = 0;
        Object.keys(payload.years).forEach(function (year) {
          targets += (payload.years[year].targets || []).length;
          completed += (payload.years[year].completed || []).length;
        });
        download(payload);
        report("Exported " + plural(targets, "USTree target") + " and " + plural(completed, "completed course") + ".", "success");
      });
    }

    if (importButton && importInput) {
      importButton.addEventListener("click", function () {
        importInput.value = "";
        importInput.click();
      });
      importInput.addEventListener("change", function () {
        var file = importInput.files && importInput.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var payload = parse(reader.result);
            var year = typeof settings.year === "function" ? settings.year() : settings.year;
            var summary = apply(storage, payload, { year: year });
            report(describe(summary), "success");
            if (typeof settings.onApplied === "function") settings.onApplied(summary);
          } catch (error) {
            report(error && error.message ? error.message : String(error), "error");
            if (typeof settings.onError === "function") settings.onError(error);
          } finally {
            importInput.value = "";
          }
        };
        reader.onerror = function () {
          report("That file could not be read.", "error");
          importInput.value = "";
        };
        reader.readAsText(file);
      });
    }

    // Destructive reset. It takes two clicks ("double affirmation"): the first
    // arms the button and reveals a Cancel escape hatch, the second erases
    // everything. Arming also lapses on its own so the button cannot be left
    // hot indefinitely.
    var resetButton = settings.resetButton || document.getElementById("resetData");
    var resetCancel = settings.resetCancel || document.getElementById("resetDataCancel");
    var resetTimeout = Number(settings.resetTimeout) > 0 ? Number(settings.resetTimeout) : 6000;
    var resetHint = settings.resetHint || "Erase all saved data from this browser";
    var resetArmedHint = "Click again to erase everything. This cannot be undone.";
    var resetArmed = false;
    var resetTimer = null;

    function setResetLabel(text) {
      if (!resetButton) return;
      var label = resetButton.querySelector ? resetButton.querySelector(".data-transfer-label") : null;
      if (label) label.textContent = text;
      else resetButton.textContent = text;
    }

    function disarmReset() {
      resetArmed = false;
      if (resetTimer) {
        global.clearTimeout(resetTimer);
        resetTimer = null;
      }
      if (resetButton) {
        resetButton.classList.remove("is-armed");
        resetButton.removeAttribute("aria-pressed");
        resetButton.title = resetHint;
        setResetLabel("Reset");
      }
      if (resetCancel) resetCancel.hidden = true;
    }

    function armReset() {
      resetArmed = true;
      if (resetTimer) global.clearTimeout(resetTimer);
      if (resetButton) {
        resetButton.classList.add("is-armed");
        resetButton.setAttribute("aria-pressed", "true");
        resetButton.title = resetArmedHint;
        setResetLabel("Confirm reset");
      }
      if (resetCancel) resetCancel.hidden = false;
      resetTimer = global.setTimeout(disarmReset, resetTimeout);
    }

    function performReset() {
      if (resetTimer) {
        global.clearTimeout(resetTimer);
        resetTimer = null;
      }
      if (resetButton) resetButton.disabled = true;
      if (resetCancel) resetCancel.hidden = true;
      clearAll(storage).then(function () {
        if (typeof settings.onReset === "function") settings.onReset();
        report("Erased all saved data from this browser. Reloading\u2026", "success");
        if (global.location && typeof global.location.reload === "function") {
          global.setTimeout(function () { global.location.reload(); }, 350);
        } else {
          resetArmed = false;
          if (resetButton) {
            resetButton.disabled = false;
            resetButton.classList.remove("is-armed");
            resetButton.title = resetHint;
            setResetLabel("Reset");
          }
        }
      });
    }

    if (resetButton) {
      resetButton.addEventListener("click", function () {
        if (!resetArmed) {
          armReset();
          return;
        }
        performReset();
      });
    }
    if (resetCancel) {
      resetCancel.addEventListener("click", function () {
        disarmReset();
        report("Reset cancelled.", null);
      });
    }
  }

  global.HKUSTDataTransfer = {
    FORMAT: FORMAT,
    VERSION: VERSION,
    IDB_NAME: IDB_NAME,
    MAJOR_KEY: MAJOR_KEY,
    collect: collect,
    serialize: serialize,
    parse: parse,
    validate: validate,
    apply: apply,
    clearAll: clearAll,
    ownedKeys: ownedKeys,
    clearCatalogCache: clearCatalogCache,
    download: download,
    defaultFilename: defaultFilename,
    describe: describe,
    loadSelectedMajor: loadSelectedMajor,
    saveSelectedMajor: saveSelectedMajor,
    loadTheme: loadTheme,
    loadHideFulfilled: loadHideFulfilled,
    bind: bind,
    toast: toast
  };
}(typeof window !== "undefined" ? window : this));
