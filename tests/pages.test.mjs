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

test("client code has no server API calls", () => {
  for (const name of ["app.js", "catalog-client.js", "major-requirements.js", "ustree.js"]) {
    assert.ok(!read(name).includes('"/api/'), `${name} still calls /api/`);
    assert.ok(!read(name).includes("'/api/"), `${name} still calls /api/`);
  }
});

test("user data is persisted in the browser", () => {
  assert.ok(read("app.js").includes("localStorage"), "completions, targets, and focus use localStorage");
  assert.ok(read("ustree.js").includes("storageKey"), "USTree targets use localStorage");
  assert.ok(read("catalog-client.js").includes("indexedDB"), "the catalog is cached in IndexedDB");
});
