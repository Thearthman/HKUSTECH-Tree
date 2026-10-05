#!/usr/bin/env node
/**
 * One-time bootstrap for the major-requirement database.
 *
 * `static/major-requirements.js` used to carry the CPEG requirement map as a
 * hardcoded JavaScript table. That data now lives in
 * `static/data/majors/CPEG-2025-26.json` (referenced by the
 * `static/data/major-requirements.json` manifest) and is refreshed from the
 * live catalog by `tools/build-major.mjs`. This script exists so the seed JSON
 * can be regenerated deterministically from that legacy table instead of being
 * hand-edited. With no `--from`, it walks git history for the most recent
 * revision of `static/major-requirements.js` that still held the table.
 *
 * Every prerequisite/corequisite/exclusion edge is re-derived from the
 * committed course catalog, and the result is checked against the edges the
 * legacy table declared - if they no longer agree the import fails loudly.
 *
 * Usage:
 *   node tools/import-major.mjs                       # import from git history
 *   node tools/import-major.mjs --from FILE           # import from a file
 *   node tools/import-major.mjs --from REF:PATH       # import from a git blob
 *   node tools/import-major.mjs --dry-run             # print, write nothing
 *   node tools/import-major.mjs --check               # exit 1 if seed is stale
 *   node tools/import-major.mjs --catalog FILE --out FILE
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildMajorRelations,
  canonical,
  parseMajorPdf,
  pdfToText,
  requirementFingerprint,
  synchronizeMajor,
} from "./build-major.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_ROOT = path.join(REPO_ROOT, "static");
const DEFAULT_SOURCE = "static/major-requirements.js";
const DEFAULT_CATALOG = path.join(STATIC_ROOT, "data", "catalog.json");
const DEFAULT_OUT = path.join(STATIC_ROOT, "data", "majors", "CPEG-2025-26.json");

// Curated presentation facts that are not encoded in the legacy table.
const SECTIONS = [
  {
    id: "engineering-fundamentals",
    pdfSection: "Engineering Fundamental Course(s)",
    eyebrow: "Engineering fundamentals",
    title: "Foundational courses",
    rootGroup: "group:fundamentals",
    credits: "19-21 credits",
    copy:
      "Calculus: [(MATH 1013 or MATH 1023) and (MATH 1014 or MATH 1024)] or MATH 1020. " +
      "Choose one Physics I and one Physics II course.",
  },
  {
    id: "required-courses",
    pdfSection: "Required Course(s)",
    eyebrow: "Required courses",
    title: "CPEG core",
    rootGroup: "group:required",
    credits: "42-45 credits",
    copy:
      "Complete the standard C++ sequence or COMP 2012H; choose one organization course and one " +
      "discrete mathematics course. Complete CPEG 1971 with a project/thesis, or CPEG 4910. " +
      "Students taking the Research Option must take CPEG 4902 or CPEG 4912.",
    sourceLink: "Open official program catalog",
  },
];

const COURSE_RE =
  /course\("([^"]+)",\s*"((?:[^"\\]|\\.)*)",\s*([\d.]+),\s*(null|"[^"]*")(?:,\s*(\[[^\]]*\]))?\)/g;
const RELATION_RE =
  /addRelation\("([^"]+)",\s*"(prerequisite|corequisite|exclusion)",\s*(\[\[[\s\S]*?\]\]),\s*"((?:[^"\\]|\\.)*)"\);/g;

function matchJson(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match) throw new Error(`Could not find ${label} in legacy major table`);
  return match[1];
}

/**
 * Turn the legacy hardcoded table into the JSON database shape. Exported so the
 * behaviour can be unit-tested without touching git history.
 */
export function parseLegacyMajor(legacySource, { catalog } = {}) {
  if (!catalog) throw new Error("parseLegacyMajor requires a catalog");

  const major = [];
  for (const match of legacySource.matchAll(COURSE_RE)) {
    major.push({
      code: match[1],
      title: match[2],
      credits: String(match[3]),
      parent: match[4] === "null" ? null : JSON.parse(match[4]),
      position: match[5] ? JSON.parse(match[5]) : null,
    });
  }
  if (!major.length) throw new Error("No course() entries found in legacy major table");

  const groupNodes = JSON.parse(
    matchJson(legacySource, /var groupNodes = (\[[\s\S]*?\]);/, "groupNodes")
  );
  const contextOrder = JSON.parse(
    matchJson(legacySource, /var contextRows = (\[[\s\S]*?\]);/, "contextRows")
  ).map((row) => row[0]);

  const legacyRelations = [];
  for (const match of legacySource.matchAll(RELATION_RE)) {
    legacyRelations.push({
      target: match[1],
      relation: match[2],
      groups: JSON.parse(match[3]),
      raw: match[4],
    });
  }

  const meta = {
    id: matchJson(legacySource, /id: "([^"]+)"/, "id"),
    program: matchJson(legacySource, /program: "([^"]+)"/, "program"),
    intake: matchJson(legacySource, /intake: "([^"]+)"/, "intake"),
    totalCredits: matchJson(legacySource, /totalCredits: "([^"]+)"/, "totalCredits"),
  };

  // Relations are authoritative only if they come from the course catalog.
  const relations = buildMajorRelations(
    major.map((course) => course.code),
    catalog
  );
  assertRelationsMatch(legacyRelations, relations);

  // Context courses are exactly the relation endpoints that are not major
  // courses, in the curated order the legacy table presented them.
  const majorCodes = new Set(major.map((course) => course.code));
  const derivedContext = [];
  const seen = new Set();
  for (const relation of relations) {
    if (majorCodes.has(relation.source) || seen.has(relation.source)) continue;
    seen.add(relation.source);
    derivedContext.push(relation.source);
  }
  const missing = derivedContext.filter((code) => !contextOrder.includes(code));
  if (missing.length || derivedContext.length !== contextOrder.length) {
    throw new Error(
      `Legacy contextRows no longer match the derived context set ` +
        `(derived ${derivedContext.length}, curated ${contextOrder.length})`
    );
  }

  const groupById = new Map(groupNodes.map((node) => [node[0], node]));
  function ancestors(code) {
    const course = major.find((item) => item.code === code);
    const chain = [];
    let group = course && course.parent;
    while (group) {
      chain.push(group);
      const node = groupById.get(group);
      group = node ? node[3] : null;
    }
    return chain;
  }
  for (const course of major) {
    course.section = ancestors(course.code).includes("group:fundamentals")
      ? "engineering-fundamentals"
      : "required-courses";
  }

  return {
    schemaVersion: 1,
    id: meta.id,
    programCode: meta.id.split("-")[0],
    program: meta.program,
    intake: meta.intake,
    catalogYear: catalog.year,
    totalCredits: meta.totalCredits,
    source: "/data/cpeg-2025-26.pdf",
    sourceUrl: "https://ugadmin.hkust.edu.hk/prog_crs/ug/202627/pdf/25-26cpeg.pdf",
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    outline: { eyebrow: `${meta.intake} intake`, title: meta.program, credits: `${meta.totalCredits} credits` },
    sections: SECTIONS.map((section) => ({ ...section })),
    groups: groupNodes.map((node) => ({ id: node[0], label: node[1], kind: node[2], parent: node[3] })),
    courses: major.map((course) => ({
      code: course.code,
      title: course.title,
      credits: course.credits,
      parent: course.parent,
      position: course.position,
      major: true,
      graph: true,
      section: course.section,
    })),
    contextCourses: contextOrder.map((code, index) => ({
      code,
      title: (catalog.courses[code] && catalog.courses[code].title) || "",
      credits: "",
      parent: null,
      major: false,
      graph: true,
      position: [1780 + (index % 2) * 220, 110 + Math.floor(index / 2) * 108],
    })),
    relations,
  };
}

function assertRelationsMatch(legacyRelations, derivedRelations) {
  for (const legacy of legacyRelations) {
    const groups = [];
    derivedRelations
      .filter((relation) => relation.target === legacy.target && relation.relation === legacy.relation)
      .forEach((relation) => {
        groups[relation.group - 1] = groups[relation.group - 1] || [];
        groups[relation.group - 1].push(relation.source);
      });
    if (JSON.stringify(groups) !== JSON.stringify(legacy.groups)) {
      throw new Error(
        `Derived ${legacy.relation} for ${legacy.target} (${JSON.stringify(groups)}) ` +
          `no longer matches the legacy table (${JSON.stringify(legacy.groups)})`
      );
    }
  }
}

/**
 * Reconcile the legacy-derived seed against the committed program PDF so it is
 * byte-identical (modulo `generatedAt`) to what `build-major.mjs` produces. This
 * refreshes course membership/order, credits, the branch/area tables, and the
 * source fingerprint from the authoritative PDF while keeping the curated
 * presentation from the legacy table.
 */
export async function reconcileSeed(
  legacyData,
  { catalog, pdfPath, now = new Date(), log = () => {}, pdfToTextImpl = pdfToText } = {}
) {
  const relative = path.relative(REPO_ROOT, pdfPath);
  try {
    const text = await pdfToTextImpl(pdfPath);
    const parsed = parseMajorPdf(text);
    const meta = {
      programTitle: legacyData.program,
      intake: legacyData.intake,
      pdfUrl: legacyData.sourceUrl,
      sourceHash: requirementFingerprint(parsed),
    };
    const { data } = synchronizeMajor(legacyData, { catalog, parsed, meta, now });
    return data;
  } catch (error) {
    log(`warning: could not reconcile seed against ${relative} (${error.message}); using legacy order`);
    return legacyData;
  }
}

function isLegacyTable(source) {
  return source.includes("course(") && source.includes("var courses");
}

async function gitShow(spec) {
  const { stdout } = await execFileAsync("git", ["show", spec], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Walk HEAD history for the newest revision of the legacy hardcoded table. */
async function findLegacyRevision() {
  const { stdout } = await execFileAsync("git", ["rev-list", "HEAD", "--", DEFAULT_SOURCE], { cwd: REPO_ROOT });
  const revisions = stdout.trim().split("\n").filter(Boolean);
  for (const revision of revisions) {
    const source = await gitShow(`${revision}:${DEFAULT_SOURCE}`);
    if (isLegacyTable(source)) return source;
  }
  throw new Error(
    `No revision of ${DEFAULT_SOURCE} in git history still holds the hardcoded table; ` +
      "pass --from FILE or --from REF:PATH"
  );
}

async function readLegacySource(from) {
  if (!from) return findLegacyRevision();
  if (existsSync(from)) return readFile(from, "utf8");
  if (from.includes(":")) return gitShow(from);
  return readFile(path.resolve(from), "utf8");
}

function parseArgs(argv) {
  const options = {
    from: null,
    catalog: DEFAULT_CATALOG,
    out: DEFAULT_OUT,
    pdf: true,
    dryRun: false,
    check: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") options.from = argv[++index];
    else if (arg === "--catalog") options.catalog = path.resolve(argv[++index]);
    else if (arg === "--out") options.out = path.resolve(argv[++index]);
    else if (arg === "--no-pdf") options.pdf = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node tools/import-major.mjs [--from FILE|REF:PATH] [--catalog FILE] [--out FILE]\n" +
        "                              [--no-pdf] [--dry-run] [--check]\n" +
        "\n" +
        "  Walks git history for the legacy hardcoded table when --from is omitted.\n"
    );
    return;
  }
  const log = (message) => process.stderr.write(`${message}\n`);
  const catalog = JSON.parse(await readFile(options.catalog, "utf8"));
  const legacy = await readLegacySource(options.from);
  let data = parseLegacyMajor(legacy, { catalog });
  if (options.pdf) {
    const pdfPath = path.join(STATIC_ROOT, data.source.replace(/^\//, ""));
    data = await reconcileSeed(data, { catalog, pdfPath, log });
  }

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  const summary =
    `${data.courses.length} courses, ${data.contextCourses.length} context, ` +
    `${data.relations.length} relations, ${data.totalCredits} credits`;

  if (options.check) {
    let previous = null;
    try {
      previous = JSON.parse(await readFile(options.out, "utf8"));
    } catch {
      previous = null;
    }
    if (!previous || canonical(previous) !== canonical(data)) {
      process.stdout.write(`Major requirement seed is stale or missing (${summary}).\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Major requirement seed is up to date (${summary}).\n`);
    return;
  }

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  process.stdout.write(`Imported major requirements (${summary}) -> ${options.out}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

export { main, parseArgs, readLegacySource };
