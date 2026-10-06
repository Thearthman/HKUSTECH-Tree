(function () {
  "use strict";

  // Shared light/dark controller. Loaded synchronously from <head> so the
  // resolved theme is decided before first paint (no flash of the wrong theme).
  // Preference order: explicit localStorage choice, then the OS setting.
  var STORAGE_KEY = "hkust-course-tree:theme";
  var VALID = { light: true, dark: true };
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var wired = false;

  // Kebab names of every --cy-* token the graph renderers read. Kept in one
  // place so app.js and major-requirements.js stay in sync with the CSS.
  var GRAPH_TOKENS = [
    "node-bg", "node-border", "node-text", "node-muted", "accent", "completed-bg",
    "focus-bg",
    "context-bg", "context-border", "context-text", "group-bg", "group-border",
    "logic-and-bg", "logic-or-bg", "summary-bg", "summary-border",
    "edge", "coreq", "exclusion", "selected",
    "unresolved-bg", "unresolved-text", "logic-bg", "logic-stroke",
    "any-bg", "any-stroke", "condition-bg", "condition-border", "condition-text",
    "edge-label-bg", "checkbox-bg", "checkbox-border", "checkbox-check",
    "star-fill", "star-stroke",
    "dept-0", "dept-1", "dept-2", "dept-3", "dept-4",
    "dept-5", "dept-6", "dept-7", "dept-8", "dept-9",
    "hover1-bg", "hover1-line", "hover2-bg", "hover2-line", "hover3-bg",
    "hover3-line", "hover4-bg", "hover4-line", "hover5-bg", "hover5-line"
  ];

  function readStored() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      return VALID[value] ? value : null;
    } catch (error) {
      return null;
    }
  }

  function systemTheme() {
    return media && media.matches ? "dark" : "light";
  }

  function resolvedTheme() {
    return readStored() || systemTheme();
  }

  function cssVar(name) {
    return getComputedStyle(root).getPropertyValue(name).trim();
  }

  function colors() {
    var palette = {};
    for (var index = 0; index < GRAPH_TOKENS.length; index += 1) {
      var token = GRAPH_TOKENS[index];
      palette[token] = cssVar("--cy-" + token);
    }
    return palette;
  }

  function updateMeta() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var background = cssVar("--bg");
    if (background) meta.setAttribute("content", background);
  }

  function updateButtons(theme) {
    var stored = readStored();
    var nodes = document.querySelectorAll("[data-theme-toggle]");
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      var next = theme === "dark" ? "light" : "dark";
      var label = "Switch to " + next + " mode";
      node.setAttribute("aria-label", label);
      node.setAttribute("title", label);
      node.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
      node.dataset.themePreference = stored || "system";
    }
  }

  function apply(theme, explicit) {
    root.dataset.theme = theme;
    updateMeta();
    if (wired) updateButtons(theme);
    window.dispatchEvent(new CustomEvent("hkust-theme-change", {
      detail: { theme: theme, preference: explicit || readStored() || "system" }
    }));
  }

  function setTheme(theme, persist) {
    if (!VALID[theme]) return;
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch (error) {
        // Private mode / storage disabled: fall back to a session-only theme.
      }
    }
    apply(theme, persist ? theme : null);
  }

  function toggle() {
    setTheme(resolvedTheme() === "dark" ? "light" : "dark", true);
  }

  function onSystemChange() {
    if (!readStored()) apply(systemTheme(), null);
  }

  function wire() {
    wired = true;
    var nodes = document.querySelectorAll("[data-theme-toggle]");
    for (var index = 0; index < nodes.length; index += 1) {
      nodes[index].addEventListener("click", toggle);
    }
    updateButtons(root.dataset.theme === "dark" ? "dark" : "light");
  }

  // Decide the theme before first paint.
  apply(resolvedTheme(), null);

  if (media) {
    if (media.addEventListener) media.addEventListener("change", onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  window.HKUSTTheme = {
    get: function () { return root.dataset.theme === "dark" ? "dark" : "light"; },
    preference: function () { return readStored() || "system"; },
    set: function (theme) { setTheme(theme, true); },
    toggle: toggle,
    cssVar: cssVar,
    colors: colors
  };
})();
