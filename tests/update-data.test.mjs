import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { REPO_ROOT, filesToStage } from "../tools/update-data.mjs";

const catalogFile = path.join(REPO_ROOT, "static", "data", "catalog.json");
const majorFile = path.join(REPO_ROOT, "static", "data", "major-requirements.json");
const pdfFile = path.join(REPO_ROOT, "static", "data", "cpeg-2025-26.pdf");

test("filesToStage ignores unchanged datasets", () => {
  assert.deepEqual(
    filesToStage([
      { name: "course catalog", path: catalogFile, files: [catalogFile], changed: false },
      { name: "major requirements", path: majorFile, files: [majorFile], changed: false },
    ]),
    []
  );
});

test("filesToStage stages the source PDF only when it changed", () => {
  const major = { name: "major requirements", path: majorFile, files: [majorFile], changed: true };
  assert.deepEqual(filesToStage([major]), ["static/data/major-requirements.json"]);

  const majorWithPdf = { ...major, files: [majorFile, pdfFile] };
  assert.deepEqual(filesToStage([majorWithPdf]), [
    "static/data/major-requirements.json",
    "static/data/cpeg-2025-26.pdf",
  ]);
});

test("filesToStage deduplicates across datasets", () => {
  const catalog = { name: "course catalog", path: catalogFile, files: [catalogFile], changed: true };
  const major = { name: "major requirements", path: catalogFile, files: [catalogFile], changed: true };
  assert.deepEqual(filesToStage([catalog, major]), ["static/data/catalog.json"]);
});
