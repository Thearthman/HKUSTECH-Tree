import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  LAYOUT_VERSION,
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

test("every program's requirement panels are stacked without overlapping", () => {
  // Mirrors the graph's course node size (see tools/build-major.mjs LAYOUT).
  const NODE_WIDTH = 184;
  const NODE_HEIGHT = 66;
  const bounds = (items) => ({
    x1: Math.min(...items.map((item) => item.position[0])),
    y1: Math.min(...items.map((item) => item.position[1])),
    x2: Math.max(...items.map((item) => item.position[0])) + NODE_WIDTH,
    y2: Math.max(...items.map((item) => item.position[1])) + NODE_HEIGHT,
  });

  for (const program of manifest.programs) {
    const data = readProgram(program.file);
    assert.equal(
      data.layoutVersion,
      LAYOUT_VERSION,
      `${program.id} should carry the current layout version`
    );
    assert.ok(
      data.layout === "auto" || data.layout === "preset",
      `${program.id} should declare its layout mode`
    );

    for (const course of [...(data.courses || []), ...(data.contextCourses || [])]) {
      assert.ok(
        Array.isArray(course.position) && course.position.length === 2,
        `${program.id} course ${course.code} needs a coordinate`
      );
    }

    // Each requirement section is rendered as one compound panel, so two
    // sections whose course bounding boxes intersect would visibly overlap.
    const panels = (data.sections || [])
      .map((section) => (data.courses || []).filter((course) => course.section === section.id))
      .filter((courses) => courses.length)
      .map(bounds);
    // Generated programs should read as long, wide bands rather than tall
    // single files that crowd the requirement arrows.
    if (data.layout === "auto") {
      panels.forEach((panel, index) => {
        assert.ok(
          panel.x2 - panel.x1 > panel.y2 - panel.y1,
          `${program.id} requirement panel ${index} should be a long rectangle, not a tall one`
        );
      });
    }
    for (let i = 0; i < panels.length; i += 1) {
      for (let j = i + 1; j < panels.length; j += 1) {
        const a = panels[i];
        const b = panels[j];
        const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        assert.ok(
          overlapX <= 0 || overlapY <= 0,
          `${program.id} requirement panels ${i} and ${j} overlap`
        );
      }
    }
  }
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

test("every program's requirement groups, sections and parents resolve", () => {
  for (const program of manifest.programs) {
    const data = readProgram(program.file);
    const groupIds = new Set(data.groups.map((group) => group.id));
    const sectionIds = new Set(data.sections.map((section) => section.id));
    for (const section of data.sections) {
      assert.ok(groupIds.has(section.rootGroup), `${program.id} section ${section.id} has no root group`);
    }
    for (const group of data.groups) {
      assert.ok(
        group.parent === null || groupIds.has(group.parent),
        `${program.id} group ${group.id} has unknown parent ${group.parent}`
      );
      assert.ok(["and", "or"].includes(group.kind), `${program.id} group ${group.id} has kind ${group.kind}`);
    }
    for (const course of data.courses) {
      assert.ok(sectionIds.has(course.section), `${program.id} ${course.code} has unknown section`);
      assert.ok(
        course.parent === null || groupIds.has(course.parent),
        `${program.id} ${course.code} has unknown parent group ${course.parent}`
      );
    }
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
  // A Note: row's boolean shape must survive into the explicit tree instead of
  // collapsing into the surrounding section AND.
  assert.deepEqual(sections[0].tree, {
    kind: "and",
    items: [
      {
        kind: "or",
        note: "Note: [MATH 1013 OR MATH 1023]",
        items: [
          { kind: "course", code: "MATH 1013" },
          { kind: "course", code: "MATH 1023" },
        ],
      },
    ],
  });
  // A top-level AND note flattens into the section, so both courses stay
  // mandatory rather than gaining a redundant nested panel.
  assert.deepEqual(sections[1].tree, {
    kind: "and",
    items: [
      { kind: "course", code: "COMP 1001" },
      { kind: "course", code: "COMP 1002" },
    ],
  });
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

test("a Note: OR row becomes a choose-one panel, not a flat AND (BIBU regression)", () => {
  const entry = manifest.programs.find((program) => program.programCode === "BIBU");
  const bibu = readProgram(entry.file);
  const section = bibu.sections[0];
  const mathAlternatives = ["MATH 1003", "MATH 1005", "MATH 1006", "MATH 1013", "MATH 1020", "MATH 1023"];
  const group = bibu.groups.find((candidate) => {
    if (candidate.kind !== "or") return false;
    const members = bibu.courses.filter((course) => course.parent === candidate.id).map((course) => course.code);
    return members.includes("MATH 1003");
  });
  assert.ok(group, "the MATH alternatives should be grouped as one OR panel");
  const members = bibu.courses
    .filter((course) => course.parent === group.id)
    .map((course) => course.code)
    .sort();
  assert.deepEqual(members, mathAlternatives);
  // And they must not sit directly under the section as mandatory courses.
  const direct = bibu.courses
    .filter((course) => course.parent === section.rootGroup)
    .map((course) => course.code);
  for (const code of mathAlternatives) {
    assert.ok(!direct.includes(code), `${code} must not be a flat mandatory course`);
  }
});

test("synchronizing every unchanged program round-trips its requirement tree", () => {
  for (const program of manifest.programs) {
    const previous = readProgram(program.file);
    const { data } = synchronizeMajor(previous, {
      catalog,
      parsed: parsedFromDb(previous),
      meta: {
        programTitle: previous.program,
        intake: previous.intake,
        pdfUrl: previous.sourceUrl,
        sourceHash: previous.sourceHash,
      },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    assert.equal(canonical(data), canonical(previous), `${program.id} should round-trip unchanged`);
  }
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
