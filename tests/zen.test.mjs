import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function classList() {
  const set = new Set();
  return {
    add: (name) => set.add(name),
    remove: (name) => set.delete(name),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const want = force === undefined ? !set.has(name) : Boolean(force);
      if (want) set.add(name);
      else set.delete(name);
      return want;
    },
    _set: set
  };
}

function fakeButton(id) {
  const listeners = {};
  const attrs = {};
  return {
    id,
    hidden: false,
    addEventListener(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    click() {
      (listeners.click || []).forEach((handler) => handler());
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return name in attrs ? attrs[name] : null;
    }
  };
}

// A tiny DOM stand-in: enough for zen.js to auto-bind its two buttons and its
// document keydown listener without pulling in a full document implementation.
function loadZen() {
  const source = readFileSync(new URL("../static/zen.js", import.meta.url), "utf8");
  const body = { classList: classList() };
  const toggleButton = fakeButton("zenToggle");
  const exitButton = fakeButton("zenExit");
  const docListeners = {};
  const events = [];
  class FakeCustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    }
  }
  const sandbox = {
    document: {
      body,
      readyState: "interactive",
      getElementById: (id) => ({ zenToggle: toggleButton, zenExit: exitButton }[id] || null),
      addEventListener: (type, handler) => {
        (docListeners[type] = docListeners[type] || []).push(handler);
      }
    },
    CustomEvent: FakeCustomEvent,
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { zen: sandbox.HKUSTZen, body, toggleButton, exitButton, docListeners, events };
}

test("zen mode toggles a body class and syncs its controls", () => {
  const { zen, body, toggleButton, exitButton, events } = loadZen();
  assert.equal(zen.isActive(), false, "zen starts off");
  assert.equal(exitButton.hidden, true, "the floating exit control starts hidden");

  zen.enable();
  assert.equal(zen.isActive(), true);
  assert.ok(body.classList.contains("is-zen"), "enabling adds the is-zen body class");
  assert.equal(exitButton.hidden, false, "the floating exit control appears");
  assert.equal(toggleButton.getAttribute("aria-pressed"), "true");
  assert.equal(toggleButton.getAttribute("aria-label"), "Exit zen mode");

  const last = events[events.length - 1];
  assert.equal(last.type, "hkust-zen-change", "toggles broadcast a zen change event");
  assert.equal(last.detail.active, true);

  zen.toggle();
  assert.equal(zen.isActive(), false);
  assert.ok(!body.classList.contains("is-zen"));
  assert.equal(exitButton.hidden, true);
  assert.equal(toggleButton.getAttribute("aria-pressed"), "false");
});

test("the zen buttons and Escape key drive the mode", () => {
  const { zen, toggleButton, exitButton, docListeners } = loadZen();

  toggleButton.click();
  assert.equal(zen.isActive(), true, "the top-bar button enters zen");

  exitButton.click();
  assert.equal(zen.isActive(), false, "the floating button exits zen");

  toggleButton.click();
  assert.equal(zen.isActive(), true);
  (docListeners.keydown || []).forEach((handler) => handler({ key: "a" }));
  assert.equal(zen.isActive(), true, "other keys do not exit zen");
  (docListeners.keydown || []).forEach((handler) => handler({ key: "Escape" }));
  assert.equal(zen.isActive(), false, "Escape exits zen");
});
