import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { parse as parseHtml } from "node-html-parser";

import {
  iterCourseRefs,
  normalizeCourseCode,
  parseCoursePage,
  parseRequirement,
  parseSubjectIndex,
} from "../tools/build-catalog.mjs";

const YEAR = "2026-27";

function subjectIndexHtml() {
  return `<!doctype html><html><head><title>Program &amp; Course Catalog</title></head><body>
    <h1 class="page-title">Undergraduate Courses ${YEAR}</h1>
    <ul class="subject-list">
      <li class="subject"><a href="/ugcourse/${YEAR}/COMP/"></a>
        <div class="subject-code">COMP</div><div class="subject-name">Computer Science and Engineering</div></li>
      <li class="subject"><a href="/ugcourse/${YEAR}/MATH/"></a>
        <div class="subject-code">MATH</div><div class="subject-name">Mathematics</div></li>
    </ul>
  </body></html>`;
}

function coursePageHtml() {
  return `<!doctype html><html><body>
    <h1 class="page-title">Computer Science and Engineering (${YEAR})</h1>
    <div class="subject-name"><span class="subject-code">COMP</span></div>
    <ul class="crse-list">
      <li class="crse accordion-item">
        <div class="crse-header accordion-item-header">
          <div class="crse-code">COMP 4211</div>
          <div class="crse-title">Machine Learning</div>
          <div class="crse-unit">3</div>
        </div>
        <div class="crse-detail">
          <div class="data-row"><div class="header">Prerequisite(s)</div>
            <div class="data">COMP 2011 AND (COMP 2711 OR MATH 2111)</div></div>
          <div class="data-row"><div class="header">Exclusion(s)</div>
            <div class="data">COMP 5211</div></div>
          <div class="data-row data-row-long"><div class="header">Description</div>
            <div class="data">An introduction to machine learning.</div></div>
        </div>
      </li>
      <li class="crse accordion-item">
        <div class="crse-header accordion-item-header">
          <div class="crse-code">COMP 2011</div>
          <div class="crse-title">Programming with Data Structures</div>
          <div class="crse-unit">4</div>
        </div>
        <div class="crse-detail">
          <div class="data-row"><div class="header">Corequisite(s)</div>
            <div class="data">MATH 1013</div></div>
        </div>
      </li>
    </ul>
  </body></html>`;
}

test("normalizeCourseCode normalizes spacing and case", () => {
  assert.equal(normalizeCourseCode("comp4211"), "COMP 4211");
  assert.equal(normalizeCourseCode("  COMP-4211  "), "COMP 4211");
  assert.equal(normalizeCourseCode("not a code"), null);
});

test("parseSubjectIndex extracts subjects", () => {
  const subjects = parseSubjectIndex(subjectIndexHtml(), YEAR, parseHtml);
  assert.deepEqual(
    subjects.map((subject) => subject.code),
    ["COMP", "MATH"]
  );
  assert.equal(subjects[0].name, "Computer Science and Engineering");
});

test("parseCoursePage extracts courses and requirements", () => {
  const courses = parseCoursePage(
    coursePageHtml(),
    YEAR,
    "COMP",
    `https://prog-crs.hkust.edu.hk/ugcourse/${YEAR}/COMP/`,
    parseHtml
  );
  assert.equal(courses.length, 2);
  const ml = courses.find((course) => course.code === "COMP 4211");
  assert.equal(ml.title, "Machine Learning");
  assert.equal(ml.credits, "3");
  assert.equal(ml.requirements.prerequisite.raw, "COMP 2011 AND (COMP 2711 OR MATH 2111)");
  assert.deepEqual(
    [...iterCourseRefs(ml.requirements.prerequisite.expression)],
    ["COMP 2011", "COMP 2711", "MATH 2111"]
  );
  assert.equal(ml.requirements.exclusion.raw, "COMP 5211");
});

test("parseRequirement flags partial parses with warnings", () => {
  const parsed = parseRequirement("COMP 1011 OR (COMP 1021 AND", "prerequisite");
  assert.equal(parsed.relation, "prerequisite");
  assert.ok(["parsed", "partial"].includes(parsed.status));
  assert.ok(Array.isArray(parsed.warnings));
});

function loadCatalogClient(catalog) {
  const source = readFileSync(new URL("../static/catalog-client.js", import.meta.url), "utf8");
  const sandbox = {
    fetch: () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(catalog)
      })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.HKUSTCatalog;
}

function requirement(relation, raw, expression) {
  return { relation, raw, status: "parsed", warnings: [], expression };
}

function courseRecord(code, subject, number, title, requirements) {
  return {
    year: YEAR,
    code,
    subject,
    number,
    title,
    credits: "3",
    description: "",
    source_url: `https://prog-crs.hkust.edu.hk/ugcourse/${YEAR}/${subject}/`,
    requirements: requirements || {}
  };
}

function syntheticCatalog() {
  return {
    year: YEAR,
    generatedAt: "2026-10-05T00:00:00Z",
    source: "test",
    sourceHash: "test",
    subjects: [{ code: "COMP", name: "Computer Science", source_url: "", fetched: true }],
    courses: {
      "COMP 2011": courseRecord("COMP 2011", "COMP", "2011", "Data Structures", {}),
      "COMP 4211": courseRecord("COMP 4211", "COMP", "4211", "Machine Learning", {
        prerequisite: requirement("prerequisite", "COMP 2011", {
          type: "course",
          code: "COMP 2011",
          qualifier: null
        })
      })
    }
  };
}

test("catalog client searches and reads courses", async () => {
  const client = loadCatalogClient(syntheticCatalog());
  const results = await client.search(YEAR, "4211", 10);
  assert.deepEqual(
    Array.from(results, (course) => course.code),
    ["COMP 4211"]
  );
  const detail = await client.course(YEAR, "comp 4211");
  assert.equal(detail.title, "Machine Learning");
  assert.equal(detail.requirements.prerequisite.raw, "COMP 2011");
  assert.equal(detail.requirements.corequisite, null);
});

test("catalog client builds a prerequisite graph", async () => {
  const client = loadCatalogClient(syntheticCatalog());
  const graph = await client.graph({
    year: YEAR,
    code: "COMP 4211",
    depth: "all",
    relations: ["prerequisite"],
    direction: "backward"
  });
  assert.equal(graph.root, "COMP 4211");
  const codes = Array.from(graph.nodes)
    .filter((node) => node.type === "course")
    .map((node) => node.code)
    .sort();
  assert.deepEqual(codes, ["COMP 2011", "COMP 4211"]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].relation, "prerequisite");
});

test("catalog client rejects unknown courses", async () => {
  const client = loadCatalogClient(syntheticCatalog());
  await assert.rejects(
    () => client.graph({ year: YEAR, code: "NOPE 0000", depth: 2 }),
    (error) => error.code === "course_not_found"
  );
});

test("committed catalog.json is loadable and covers COMP", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("../static/data/catalog.json", import.meta.url), "utf8")
  );
  assert.equal(catalog.year, YEAR);
  assert.ok(catalog.courses["COMP 4211"], "COMP 4211 should be present in the shipped catalog");
  assert.ok(Object.keys(catalog.courses).length > 1000);
});
