import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildMajorRelations,
  canonical,
  discoverProgramSource,
  parseMajorPdf,
  parsedFromDb,
  synchronizeMajor,
} from "../tools/build-major.mjs";
import { parseLegacyMajor } from "../tools/import-major.mjs";

function readJson(name) {
  return JSON.parse(readFileSync(new URL(`../static/data/${name}`, import.meta.url), "utf8"));
}

function programPath(file) {
  return new URL(`../static${file}`, import.meta.url);
}

function readProgram(file) {
  return JSON.parse(readFileSync(programPath(file), "utf8"));
}

const catalog = readJson("catalog.json");
const manifest = readJson("major-requirements.json");
const cpegEntry = manifest.programs.find((program) => program.programCode === "CPEG");
const db = readProgram(cpegEntry.file);

test("the major-requirement manifest lists every fetched program", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.intake, "2025-26");
  assert.equal(manifest.catalogYear, catalog.year);
  assert.ok(manifest.programs.length >= 44, "every program with published requirements should be present");
  const codes = new Set(manifest.programs.map((program) => program.programCode));
  for (const code of [
    "CPEG", "AI", "COMP", "MECH", "ELEC", "DASC", "DSCT", "PHYS", "CHEM", "MATH", "MEIC", "BMH",
  ]) {
    assert.ok(codes.has(code), `${code} should be in the manifest`);
  }
  for (const program of manifest.programs) {
    assert.ok(program.file && program.file.startsWith("/data/majors/"), `${program.id} needs a file path`);
    assert.ok(existsSync(programPath(program.file)), `${program.id} file ${program.file} must exist`);
  }
});

test("program source discovery follows http and https requirement PDFs", async () => {
  const html =
    '<div class="program-title">BEng in Microelectronics and Integrated Circuits</div>' +
    '<div class="pg-wording">For students admitted in 2025-26</div>' +
    '<a href="https://ugadmin.hkust.edu.hk/prog_crs/ug/202627/pdf/25-26ssci_requirements.pdf">School Requirements: School of Science</a>' +
    '<a href="http://ugadmin.hkust.edu.hk/prog_crs/ug/202627/pdf/25-26meic.pdf" target="_blank">Major Requirements: BEng in Microelectronics</a>' +
    "<!-- padding to satisfy the minimum response length check ".repeat(4) + "-->";
  const source = await discoverProgramSource(
    { programCode: "MEIC", intake: "2025-26" },
    { fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) }
  );
  assert.equal(source.pdfUrl, "http://ugadmin.hkust.edu.hk/prog_crs/ug/202627/pdf/25-26meic.pdf");
  assert.equal(source.programTitle, "BEng in Microelectronics and Integrated Circuits");
  assert.equal(source.intake, "2025-26");
});

test("the CPEG program document has the expected shape", () => {
  assert.equal(db.schemaVersion, 2);
  assert.equal(db.programCode, "CPEG");
  assert.equal(db.catalogYear, catalog.year);
  assert.equal(db.sections.length, 2);
  assert.equal(db.courses.length, 34);
  assert.equal(db.contextCourses.length, 23);
  assert.equal(db.relations.length, 121);
  assert.equal(db.branches.length, 11);
  assert.equal(db.outline.credits, `${db.totalCredits} credits`);
  assert.equal(cpegEntry.sourceHash, db.sourceHash);
});

test("branch and area tables are captured for option programs", () => {
  const cpegBranches = db.branches.map((branch) => branch.title);
  for (const title of [
    "Artificial Intelligence / Theory Area",
    "Semiconductor / VLSI Area",
    "Embedded System / Robotics Area",
    "Systems / Networking Area",
    "Research Option",
  ]) {
    assert.ok(cpegBranches.includes(title), `CPEG should expose the ${title}`);
  }
  const ai = readProgram(manifest.programs.find((program) => program.programCode === "AI").file);
  assert.ok(ai.branches.some((branch) => /Artificial Intelligence Area/.test(branch.title)));
  const comp = readProgram(manifest.programs.find((program) => program.programCode === "COMP").file);
  assert.ok(comp.branches.some((branch) => /Artificial Intelligence/.test(branch.title)));
  assert.ok(comp.branches.some((branch) => branch.courses.length > 0));
});

test("every major course and relation endpoint resolves", () => {
  const groupIds = new Set(db.groups.map((group) => group.id));
  const sectionIds = new Set(db.sections.map((section) => section.id));
  for (const course of db.courses) {
    assert.ok(catalog.courses[course.code], `major course ${course.code} missing from catalog`);
    assert.ok(sectionIds.has(course.section), `${course.code} has unknown section ${course.section}`);
    assert.ok(
      course.parent === null || groupIds.has(course.parent),
      `${course.code} has unknown parent group ${course.parent}`
    );
  }
  for (const group of db.groups) {
    assert.ok(group.parent === null || groupIds.has(group.parent), `group ${group.id} has unknown parent`);
  }
  const branchIds = new Set(db.branches.map((branch) => branch.id));
  for (const branch of db.branches) {
    assert.ok(branch.parent === null || branchIds.has(branch.parent), `branch ${branch.id} has unknown parent`);
  }
  const contextCodes = new Set(db.contextCourses.map((course) => course.code));
  for (const relation of db.relations) {
    // Targets must be real catalog courses; sources may be historical courses
    // (e.g. COMP 1022P) that only appear as context nodes.
    assert.ok(catalog.courses[relation.target], `relation target ${relation.target} missing from catalog`);
    assert.ok(
      catalog.courses[relation.source] || contextCodes.has(relation.source),
      `relation source ${relation.source} is neither a catalog course nor a context node`
    );
  }
});

test("relations are exactly what the course catalog encodes", () => {
  const derived = buildMajorRelations(
    db.courses.map((course) => course.code),
    catalog
  );
  assert.equal(canonical(derived), canonical(db.relations));
});

test("synchronizing against an unchanged program is a no-op", () => {
  const { data, changes } = synchronizeMajor(db, {
    catalog,
    parsed: parsedFromDb(db),
    meta: {
      programTitle: db.program,
      intake: db.intake,
      pdfUrl: db.sourceUrl,
      sourceHash: db.sourceHash,
    },
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.deepEqual(changes, []);
  assert.equal(canonical(data), canonical(db));
});

function syntheticPdf() {
  const pad = (left, right) => `${left}${" ".repeat(Math.max(2, 60 - left.length))}${right}`;
  return [
    " 2022-23 and thereafter, courses that have been counted towards Major Requirements",
    "",
    " Major Requirements",
    "",
    " Engineering Fundamental Course(s)",
    "",
    pad(" MATH                          Note: [MATH 1013 OR MATH 1023]", "3-6"),
    pad("    MATH       1013            Calculus I", "3"),
    pad("    MATH       1023            Honors Calculus I", "3"),
    "",
    " Required Course(s)",
    "",
    pad(" COMP                          Note: (COMP 1001 AND COMP 1002)", "6"),
    pad("    COMP       1001            Introduction to Programming", "3"),
    pad("    COMP       1002            Advanced Programming", "3"),
    "",
    " Elective(s)",
    "",
    pad(" COMP          4000            Free Elective", "3"),
    "",
    " Computer Systems / Networking Area",
    "",
    pad(" COMP          4001            Computer Networks", "3"),
    pad(" COMP          4002            Advanced Networks", "3"),
    "",
    " Track Study",
    "",
    " Embedded Systems Track",
    "",
    pad(" COMP          4003            Embedded Systems", "3"),
    "",
    " Remarks on course(s)",
    "",
  ].join("\n");
}

test("parseMajorPdf reads the core sections and branch tables, not electives", () => {
  const { sections, branches } = parseMajorPdf(syntheticPdf());
  assert.equal(sections.length, 2, "electives must be ignored");
  assert.deepEqual(
    sections.map((section) => section.title),
    ["Engineering Fundamental Course(s)", "Required Course(s)"]
  );
  assert.deepEqual(sections[0].codes, ["MATH 1013", "MATH 1023"]);
  assert.deepEqual(sections[1].codes, ["COMP 1001", "COMP 1002"]);
  assert.equal(sections[1].credits, "6");
  assert.deepEqual(
    branches.map((branch) => [branch.kind, branch.title]),
    [
      ["area", "Computer Systems / Networking Area"],
      ["track", "Embedded Systems Track"],
    ]
  );
  assert.deepEqual(
    branches[0].courses.map((course) => course.code),
    ["COMP 4001", "COMP 4002"]
  );
  assert.deepEqual(branches[1].courses.map((course) => course.code), ["COMP 4003"]);
});

test("parseLegacyMajor rebuilds the seed from the hardcoded table", () => {
  const legacy = [
    "  var groupNodes = [",
    '    ["group:fundamentals", "Fundamentals | AND", "and", null],',
    '    ["group:required", "Required | AND", "and", null]',
    "  ];",
    "  var contextRows = [",
    '    ["COMP 1001", "Introduction to Programming"]',
    "  ];",
    "  var relations = [];",
    "  function addRelation(target, relation, groups, raw) {}",
    '  addRelation("COMP 2001", "prerequisite", [["COMP 1001"]], "COMP 1001");',
    '  addRelation("COMP 2002", "prerequisite", [["COMP 2001"]], "COMP 2001");',
    "  var courses = [",
    '    course("COMP 2001", "Data Structures", 3, "group:fundamentals", [10, 20]),',
    '    course("COMP 2002", "Algorithms", 3, "group:required")',
    "  ];",
    '    id: "CPEG-2025-26",',
    '    program: "BEng in Computer Engineering",',
    '    intake: "2025-26",',
    '    totalCredits: "6",',
  ].join("\n");

  const course = (requirements) => ({ title: "x", credits: "3", requirements });
  const syntheticCatalog = {
    year: "2026-27",
    courses: {
      "COMP 1001": course({ prerequisite: null, corequisite: null, exclusion: null }),
      "COMP 2001": course({
        prerequisite: { raw: "COMP 1001", expression: { type: "course", code: "COMP 1001" } },
        corequisite: null,
        exclusion: null,
      }),
      "COMP 2002": course({
        prerequisite: { raw: "COMP 2001", expression: { type: "course", code: "COMP 2001" } },
        corequisite: null,
        exclusion: null,
      }),
    },
  };

  const data = parseLegacyMajor(legacy, { catalog: syntheticCatalog });
  assert.equal(data.programCode, "CPEG");
  assert.equal(data.totalCredits, "6");
  assert.equal(data.courses.length, 2);
  assert.deepEqual(
    data.courses.map((entry) => entry.section),
    ["engineering-fundamentals", "required-courses"]
  );
  assert.deepEqual(data.relations.map((relation) => [relation.source, relation.target]), [
    ["COMP 1001", "COMP 2001"],
    ["COMP 2001", "COMP 2002"],
  ]);
  assert.deepEqual(data.contextCourses.map((entry) => entry.code), ["COMP 1001"]);
});
