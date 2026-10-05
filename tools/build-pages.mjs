#!/usr/bin/env node
/**
 * Build the shared-shell static pages.
 *
 * `/ustree` is the same application as `/`, but `app.js` switches into USTree
 * mode when the URL is `/ustree`. Shipping a real `ustree.html` (instead of
 * relying on a host-specific rewrite) keeps that deep link working on Vercel,
 * the local dev server, and any plain static host. It is generated from
 * `index.html` so the two files can never drift apart.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const staticDir = new URL("../static/", import.meta.url);
const sourcePath = new URL("index.html", staticDir);
const targetPath = new URL("ustree.html", staticDir);

const source = readFileSync(sourcePath, "utf8");
let existing = null;
try {
  existing = readFileSync(targetPath, "utf8");
} catch {
  existing = null;
}

if (existing === source) {
  process.stdout.write("ustree.html is up to date\n");
} else {
  writeFileSync(targetPath, source);
  process.stdout.write(`Wrote ${fileURLToPath(targetPath)}\n`);
}
