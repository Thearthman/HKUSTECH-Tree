import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(name) {
  return readFileSync(new URL(`../static/${name}`, import.meta.url), "utf8");
}

test("ustree.html mirrors index.html", () => {
  assert.equal(
    read("ustree.html"),
    read("index.html"),
    "static/ustree.html drifted from static/index.html; regenerate with `npm run build:pages`"
  );
});

test("the shell includes the USTree workspace markup", () => {
  const html = read("index.html");
  for (const id of ["ustreeManager", "ustreeButton", "ustreeTargets", "ustreeEmpty"]) {
    assert.ok(
      html.includes(`id="${id}"`),
      `the shared shell should include the USTree element #${id}`
    );
  }
  assert.ok(
    html.includes('href="/ustree"'),
    "the shared shell should link to the dedicated /ustree page"
  );
});

test("app.js switches into USTree mode from the /ustree URL", () => {
  const app = read("app.js");
  assert.ok(
    app.includes('=== "/ustree"'),
    "app.js should detect the USTree page from the URL path"
  );
  assert.ok(
    app.includes('IS_USTREE_PAGE ? "ustree" : "course"'),
    "app.js should mark the body as the ustree page"
  );
  assert.ok(
    app.includes("elements.ustreeManager.hidden = !IS_USTREE_PAGE"),
    "app.js should reveal the USTree manager only on /ustree"
  );
});

test("the shared shell loads the browser-only client", () => {
  const html = read("index.html");
  for (const asset of ["/catalog-client.js", "/ustree.js", "/app.js"]) {
    assert.ok(html.includes(asset), `${asset} should be loaded by the shared shell`);
  }
  assert.ok(!html.includes("/api/"), "the static shell must not call the Flask API");
});

test("major-requirement.html loads the browser-only client", () => {
  const html = read("major-requirement.html");
  assert.ok(html.includes("/catalog-client.js"));
  assert.ok(!html.includes("/api/"));
});

test("the major-requirement map defines its completion controls", () => {
  const major = read("major-requirements.js");
  // These back the clickable checkbox on every course node (including the
  // "Standard sequence" node). Dropping any of them throws on load and the
  // whole map, checkbox included, stops rendering.
  for (const identifier of [
    "COMPLETION_HIT_SIZE",
    "CHECKBOX_EMPTY_IMAGE",
    "CHECKBOX_COMPLETE_IMAGE",
    "MOBILE_QUERY",
    "STORAGE_PREFIX"
  ]) {
    assert.ok(
      major.includes(`var ${identifier}`),
      `major-requirements.js should declare ${identifier} for its completion checkbox`
    );
  }
});

test("client code has no server API calls", () => {
  for (const name of ["app.js", "catalog-client.js", "major-requirements.js", "ustree.js"]) {
    assert.ok(!read(name).includes('"/api/'), `${name} still calls /api/`);
    assert.ok(!read(name).includes("'/api/"), `${name} still calls /api/`);
  }
});

test("user data is persisted in the browser", () => {
  const app = read("app.js");
  assert.ok(app.includes("localStorage"), "completions, targets, and focus use localStorage");
  for (const key of [":completed:", ":ustree:", ":focus:"]) {
    assert.ok(app.includes(key), `app.js should persist the ${key} key locally`);
  }
  assert.ok(read("ustree.js").includes("storageKey"), "USTree targets use localStorage");
  assert.ok(read("catalog-client.js").includes("indexedDB"), "the catalog is cached in IndexedDB");
});
