(function (global) {
  "use strict";

  // Distraction-free "zen" view. A single body class strips the page chrome
  // (top bar, control bars, legend, notices) so the workspace can use the whole
  // viewport. The graph pages listen for `hkust-zen-change` to grow and re-fit
  // their canvas, since toggling a class never fires a window resize.
  var BODY_CLASS = "is-zen";

  function body() {
    return global.document ? global.document.body : null;
  }

  function isActive() {
    var element = body();
    return Boolean(element && element.classList.contains(BODY_CLASS));
  }

  function labelButton(node, active) {
    if (!node) return;
    node.setAttribute("aria-pressed", active ? "true" : "false");
    node.setAttribute("aria-label", active ? "Exit zen mode" : "Enter zen mode");
    node.setAttribute("title", active ? "Exit zen mode (Esc)" : "Enter zen mode");
  }

  function apply(active) {
    var element = body();
    if (!element) return active;
    if (active) element.classList.add(BODY_CLASS);
    else element.classList.remove(BODY_CLASS);
    // The enter button sits in the (now hidden) top bar; the floating exit
    // button is the only control left on screen, so only it changes visibility.
    var exit = global.document.getElementById("zenExit");
    if (exit) exit.hidden = !active;
    labelButton(global.document.getElementById("zenToggle"), active);
    if (typeof global.CustomEvent === "function") {
      global.dispatchEvent(new global.CustomEvent("hkust-zen-change", {
        detail: { active: active }
      }));
    }
    return active;
  }

  function enable() { return apply(true); }
  function disable() { return apply(false); }
  function toggle() { return apply(!isActive()); }

  function bind() {
    if (!global.document) return;
    var toggleButton = global.document.getElementById("zenToggle");
    var exitButton = global.document.getElementById("zenExit");
    if (toggleButton) toggleButton.addEventListener("click", toggle);
    if (exitButton) exitButton.addEventListener("click", toggle);
    global.document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && isActive()) disable();
    });
    // Sync the controls with the body class (also covers a bfcache restore).
    apply(isActive());
  }

  global.HKUSTZen = {
    BODY_CLASS: BODY_CLASS,
    isActive: isActive,
    enable: enable,
    disable: disable,
    toggle: toggle,
    bind: bind
  };

  // The page loads this with `defer`, so the DOM is parsed by the time it runs.
  if (global.document) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", bind);
    } else {
      bind();
    }
  }
}(typeof window !== "undefined" ? window : this));
