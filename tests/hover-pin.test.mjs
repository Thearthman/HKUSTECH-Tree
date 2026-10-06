import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function loadSupport() {
  const source = readFileSync(new URL("../static/graph-interactions.js", import.meta.url), "utf8");
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.GraphInteractionSupport;
}

function read(name) {
  return readFileSync(new URL(`../static/${name}`, import.meta.url), "utf8");
}

test("hover state follows the pointer when nothing is pinned", () => {
  const support = loadSupport();
  const hover = support.createHoverState();

  assert.equal(hover.isPinned(), false);
  assert.equal(hover.activeId(), null);

  let decision = hover.enter("course:COMP 1023");
  assert.deepEqual({ apply: decision.apply, id: decision.id }, { apply: true, id: "course:COMP 1023" });
  assert.equal(hover.activeId(), "course:COMP 1023");

  decision = hover.leave();
  assert.deepEqual({ apply: decision.apply, id: decision.id }, { apply: true, id: null });
  assert.equal(hover.activeId(), null);
});

test("a pinned node keeps the highlight and ignores later hovers", () => {
  const support = loadSupport();
  const hover = support.createHoverState();

  hover.pin("course:COMP 2011");
  assert.equal(hover.isPinned(), true);
  assert.equal(hover.activeId(), "course:COMP 2011");

  // Hovering another node must not steal the highlight...
  let decision = hover.enter("course:COMP 2711");
  assert.equal(decision.apply, false, "a hover while pinned should not repaint");
  assert.equal(decision.id, "course:COMP 2011");
  assert.equal(hover.activeId(), "course:COMP 2011");

  // ...and leaving a node must not clear it either.
  decision = hover.leave();
  assert.equal(decision.apply, false, "a mouseout while pinned should not clear");
  assert.equal(hover.activeId(), "course:COMP 2011");
});

test("clicking another node moves the pin and repaints", () => {
  const support = loadSupport();
  const hover = support.createHoverState();

  hover.pin("course:COMP 2011");
  const decision = hover.pin("course:COMP 2711");

  assert.equal(decision.apply, true);
  assert.equal(hover.pinnedId(), "course:COMP 2711");
  assert.equal(hover.activeId(), "course:COMP 2711");
});

test("clicking empty space or pressing Escape releases the pin", () => {
  const support = loadSupport();
  const hover = support.createHoverState();

  hover.pin("course:COMP 2011");
  let decision = hover.release();
  assert.equal(decision.apply, true);
  assert.equal(hover.isPinned(), false);
  assert.equal(hover.activeId(), null);

  // Releasing again is a no-op so the caller does not needlessy repaint.
  decision = hover.release();
  assert.equal(decision.apply, false);
});

test("a release also clears a transient hover", () => {
  const support = loadSupport();
  const hover = support.createHoverState();

  hover.enter("course:COMP 3111");
  const decision = hover.release();
  assert.equal(decision.apply, true);
  assert.equal(hover.activeId(), null);
});

test("reset drops both the pin and the hover", () => {
  const support = loadSupport();
  const hover = support.createHoverState();

  hover.pin("course:COMP 2011");
  hover.reset();
  assert.equal(hover.isPinned(), false);
  assert.equal(hover.activeId(), null);
});

test("both graph pages wire a click, empty-space and Escape release", () => {
  for (const name of ["app.js", "major-requirements.js"]) {
    const source = read(name);
    assert.ok(source.includes("releasePinnedHover"), `${name} should clear a pinned highlight`);
    assert.ok(source.includes("pinHover("), `${name} should pin the highlight on a node click`);
    assert.ok(
      /state\.cy\.on\("tap", function \(event\) \{\s*\n\s*if \(event\.target !== state\.cy\) return;\s*\n\s*releasePinnedHover\(\)/.test(source),
      `${name} should release the pin when empty canvas is clicked`
    );
    assert.ok(
      source.includes('if (event.key !== "Escape") return;') ||
        /if \(event\.key === "Escape"\) \{\s*\n\s*closeDrawer\(\);\s*\n\s*releasePinnedHover\(\)/.test(source),
      `${name} should release the pin on Escape`
    );
  }
});

test("mobile maps a tap to the hover preview and a long press to the click", () => {
  const pages = [
    { name: "app.js", source: read("app.js"), mobile: "state.mobileLayout", open: "inspectGraphNode" },
    { name: "major-requirements.js", source: read("major-requirements.js"), mobile: "state.mobile", open: "openCourse" }
  ];
  for (const page of pages) {
    assert.ok(
      page.source.includes(`if (!${page.mobile} || longPress) ${page.open}(`),
      `${page.name} should only open details on a long press while mobile`
    );
    assert.ok(
      page.source.includes('state.cy.on("taphold", "node'),
      `${page.name} should listen for a long press`
    );
    assert.ok(
      page.source.includes(`if (!${page.mobile}) return;`),
      `${page.name} should ignore a long press on desktop`
    );
    assert.ok(
      page.source.includes("state.tapSuppressor.suppress(event.target.id())") &&
        page.source.includes("state.tapSuppressor.consumesTap(event.target.id())"),
      `${page.name} should suppress the tap that trails a long press`
    );
    assert.ok(
      /state\.cy\.on\("tapstart", function \(\) \{\s*\n\s*state\.tapSuppressor\.beginGesture\(\)/.test(page.source),
      `${page.name} should re-arm the suppression when a fresh gesture starts`
    );
  }
});

test("a tap suppressor only ever swallows the long press's own trailing tap", () => {
  const support = loadSupport();
  const suppressor = support.createTapSuppressor();

  // A long press on a node suppresses the trailing tap that follows it...
  suppressor.suppress("course:COMP 2011");
  assert.equal(suppressor.consumesTap("course:COMP 2011"), true, "the trailing tap is swallowed");
  // ...exactly once, so a second tap on the node runs normally.
  assert.equal(suppressor.consumesTap("course:COMP 2011"), false, "suppression is single use");
  // ...and never swallows a tap on a different node.
  suppressor.suppress("course:COMP 2011");
  assert.equal(suppressor.consumesTap("course:COMP 2711"), false, "another node's tap is untouched");
});

test("a long press that turns into a pan does not swallow the next tap", () => {
  const support = loadSupport();
  const suppressor = support.createTapSuppressor();

  // The finger drifts past the tap tolerance, so Cytoscape emits `taphold`
  // (which arms the suppressor) but no trailing `tap` and no pan-end reset.
  suppressor.suppress("course:MATH 1024");

  // The user's next gesture begins; the stale arms must be dropped, not saved
  // up to eat the tap that follows.
  suppressor.beginGesture();
  assert.equal(suppressor.consumesTap("course:MATH 1024"), false, "the next tap on the same node runs");
  assert.equal(suppressor.consumesTap("course:MATH 2111"), false, "the next tap on any node runs");

  // `reset` (graph teardown) drops a pending suppression just as safely.
  suppressor.suppress("course:MATH 1024");
  suppressor.reset();
  assert.equal(suppressor.consumesTap("course:MATH 1024"), false, "a re-render clears the suppression");
});
