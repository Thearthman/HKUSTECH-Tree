#!/usr/bin/env node
/**
 * Build and refresh the major-requirement database consumed by the browser-only
 * app.
 *
 * The committed layout is a small manifest plus one JSON document per program:
 *
 *   static/data/major-requirements.json          manifest (schemaVersion 2)
 *   static/data/majors/<CODE>-<intake>.json       one program's requirement map
 *
 * Every program is rebuilt from its official program-catalog PDF published by
 * HKUST for a given intake year. Two kinds of facts are captured:
 *
 *   1. Core requirement sections - the "Engineering Fundamental Course(s)",
 *      "Required Course(s)", "Major Pre-requisite course(s)" and similar blocks
 *      that list mandatory courses. Elective blocks are intentionally ignored.
 *   2. Branches / areas - the choice tables that follow the core (options,
 *      tracks, streams, specialization/concentration areas and the listed
 *      course groups). These are captured verbatim as data so the UI can show
 *      the available branches for programs such as CPEG, AI or MECH.
 *
 * Prerequisite / corequisite / exclusion edges are always re-derived from the
 * committed course catalog, so the major map can never disagree with the course
 * database. When a program references a course the catalog does not ship yet,
 * that reference is skipped with a warning instead of failing the refresh.
 *
 * Usage:
 *   node tools/build-major.mjs                       # refresh every program
 *   node tools/build-major.mjs --program CPEG,COMP   # only these programs
 *   node tools/build-major.mjs --intake 2025-26      # target a different intake
 *   node tools/build-major.mjs --check               # exit 1 if anything is stale
 *   node tools/build-major.mjs --offline             # rebuild from committed JSON
 *   node tools/build-major.mjs --dry-run             # print the manifest only
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  RELATIONS,
  cleanText,
  iterCourseRefs,
  normalizeCourseCode,
} from "./build-catalog.mjs";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_ROOT = path.join(REPO_ROOT, "static");
const MAJOR_DIR = path.join(STATIC_ROOT, "data", "majors");
const DEFAULT_MANIFEST = path.join(STATIC_ROOT, "data", "major-requirements.json");
// Backwards-compatible alias: the manifest now lives at this path.
const DEFAULT_DB = DEFAULT_MANIFEST;
const DEFAULT_CATALOG = path.join(STATIC_ROOT, "data", "catalog.json");
const PROGRAM_URL_BASE = "https://prog-crs.hkust.edu.hk/ugprog";
const DEFAULT_INTAKE = "2025-26";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 HKUSTECH-Tree/1.0";

// ---------------------------------------------------------------------------
// Requirement PDF grammar
// ---------------------------------------------------------------------------

const COURSE_CODE_RE =
  /(?<![A-Za-z0-9])([A-Za-z]{4})\s*[-_]?\s*(\d{4}[A-Za-z]?)(?![A-Za-z0-9])/g;
// A requirement-table row: subject (possibly cross-listed), an optional course
// number, prose, and a trailing credit range. Single spaces are allowed between
// the subject and number (CHEM), and numbers may carry a letter suffix and
// deletion marks (COMP 4901B, COMP 3xxx**).
const PDF_ROW_RE =
  /^([ ]*)([A-Z]{4}(?:\s*\/\s*[A-Z]{4})*\s*\/?)[ ]+(?:(\d{4}[A-Za-z]*\*{0,3}(?:\s*-\s*\d{4}[A-Za-z]*\*{0,3})?)[ ]{2,})?(.*?)[ ]{2,}(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\*{0,3})\s*$/;
const SECTION_HEADING_RE = /^([A-Za-z][A-Za-z0-9 ,/&()'’.:-]*?)$/;
const SECTION_SUFFIX_RE = /(course\(s\)|elective\(s\)|elective course\(s\))$/i;
const CREDIT_HEADER_RE = /^\s*(credit\(s\)|minimum|required|attained)\s*$/i;
const PAGE_FOOTER_RE = /page\s+\d+\s*$/i;
// Everything after this line is boilerplate, never requirements.
const REMARKS_RE = /^\s*\*{0,3}remarks on course\(s\)/i;
// The first elective/option/stream heading ends the "core" region and begins
// the branch tables.
const CORE_STOP_RE =
  /^\s*(?:major\s+)?(?:elective(?:s|\(s\)|\s+courses?)?|restricted electives?|list of electives?|option\(s\)|track study|stream\(s\))\s*$/i;
const BRANCH_SUFFIX_RE =
  /(area|track|stream|option|speciali[sz]ation|concentration|courses|others)\s*$/i;
const CONTAINER_RE =
  /^(option\(s\)|track study|stream\(s\)|speciali[sz]ation\(s\)|concentration\(s\)|area courses|study scheme|elective course\(s\)|elective\(s\))$/i;
const NON_BRANCH_HEAD_RE =
  /^(required course\(s\)|elective course\(s\)|elective\(s\)|major pre-requisite course\(s\)|engineering fundamental course\(s\)|fundamental course\(s\)|required courses?)$/i;
const ELECTIVE_HEAD_RE = /^(.*\belective\(s\)|\s*elective course\(s\))$/i;

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;/g, "\u2019");
}

function stripMarks(value) {
  return String(value || "").replace(/\*+$/g, "").trim();
}

function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

function stripSubjectLead(text) {
  return text.replace(/^[A-Z]{4}\s+/, "");
}

/** Turn a subject (possibly cross-listed) plus number into a catalog code. */
function codeOf(subject, number) {
  const primary = String(subject).split("/")[0].trim();
  const first = stripMarks(number).split("-")[0].trim();
  return normalizeCourseCode(`${primary} ${first}`);
}

function findCourseCodes(text) {
  const codes = [];
  COURSE_CODE_RE.lastIndex = 0;
  let match;
  while ((match = COURSE_CODE_RE.exec(text)) !== null) {
    const code = normalizeCourseCode(`${match[1]} ${match[2]}`);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function parseCredits(value) {
  const match = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(String(value || "").trim());
  if (!match) return null;
  const min = Number(match[1]);
  const max = match[2] ? Number(match[2]) : min;
  return { min, max };
}

function formatRange(min, max) {
  return min === max ? String(min) : `${min}-${max}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(fn, { attempts = 3, log } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        if (log) log(`Retrying after error: ${error.message}`);
        await sleep(400 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

export async function fetchText(url, { fetchImpl = fetch, timeout = 30000, log } = {}) {
  return withRetries(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
          signal: controller.signal,
          redirect: "follow",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
        const text = await response.text();
        if (text.length < 200) throw new Error(`Incomplete response from ${url}`);
        return text;
      } finally {
        clearTimeout(timer);
      }
    },
    { log }
  );
}

export async function fetchBytes(url, { fetchImpl = fetch, timeout = 60000, log } = {}) {
  return withRetries(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*" },
          signal: controller.signal,
          redirect: "follow",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 1000) throw new Error(`Incomplete PDF response from ${url}`);
        return bytes;
      } finally {
        clearTimeout(timer);
      }
    },
    { log }
  );
}

// ---------------------------------------------------------------------------
// Program page discovery
// ---------------------------------------------------------------------------

/** List every undergraduate program code advertised for an intake year. */
export async function discoverPrograms({ intake = DEFAULT_INTAKE, fetchImpl = fetch, log } = {}) {
  const url = `${PROGRAM_URL_BASE}/${intake}`;
  const html = await fetchText(url, { fetchImpl, log });
  const codes = new Set();
  const pattern = new RegExp(`/ugprog/${intake}/([A-Z]{2,6})["/]`, "g");
  let match;
  while ((match = pattern.exec(html)) !== null) codes.add(match[1]);
  return [...codes].sort();
}

/**
 * Read a program page and locate the authoritative "Major Requirements" PDF
 * plus the current program title. Pages can link several PDFs (for example a
 * normative pathway example); the anchored "Major Requirements:" link wins.
 */
export async function discoverProgramSource(program, { fetchImpl = fetch, log } = {}) {
  const { programCode, intake } = program;
  const url = `${PROGRAM_URL_BASE}/${intake}/${programCode}`;
  const html = await fetchText(url, { fetchImpl, log });
  const titleMatch = /<div class="program-title">([^<]+)<\/div>/i.exec(html);
  const intakeMatch = /<div class="pg-wording">\s*For students admitted in ([\d]{4}-\d{2})\s*<\/div>/i.exec(html);
  const anchored =
    /<a\s[^>]*href="(https?:\/\/ugadmin\.hkust\.edu\.hk\/prog_crs\/ug\/[^"]+\.pdf)"[^>]*>\s*Major Requirements:/i.exec(html);
  const generic = /https?:\/\/ugadmin\.hkust\.edu\.hk\/prog_crs\/ug\/[^"'\s]+\.pdf/i.exec(html);
  const pdfUrl = anchored ? anchored[1] : generic ? generic[0] : null;
  if (!pdfUrl) throw new Error(`No program requirement PDF was linked from ${url}`);
  return {
    url,
    programCode,
    programTitle: titleMatch ? cleanText(decodeEntities(titleMatch[1])) : programCode,
    intake: intakeMatch ? cleanText(intakeMatch[1]) : intake,
    pdfUrl,
  };
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

/** Convert a PDF to layout-preserving plain text using poppler's pdftotext. */
export async function pdfToText(pdfPath) {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
      maxBuffer: 96 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error && (error.code === "ENOENT" || /ENOENT/.test(String(error.message)))) {
      throw new Error(
        "pdftotext was not found. Install poppler-utils (e.g. `apt-get install -y poppler-utils`) " +
          "or run with --offline."
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Requirement PDF parsing
// ---------------------------------------------------------------------------

/** Parse the mandatory core sections that appear before the first elective. */
function parseCoreSections(lines, from, to) {
  const sections = [];
  let section = null;
  let row = null;
  let skip = false;
  let baseIndent = null;
  for (let index = from; index < to; index += 1) {
    const line = lines[index].replace(/\s+$/g, "");
    if (PAGE_FOOTER_RE.test(line)) {
      skip = true;
      row = null;
      continue;
    }
    if (!line.trim()) {
      row = null;
      continue;
    }
    if (skip) {
      // The running page header always follows the page-number footer.
      skip = false;
      continue;
    }
    if (CREDIT_HEADER_RE.test(line)) {
      row = null;
      continue;
    }
    const heading = SECTION_HEADING_RE.exec(line.trim());
    if (heading && SECTION_SUFFIX_RE.test(heading[1])) {
      section = { title: cleanText(heading[1]), rows: [] };
      sections.push(section);
      row = null;
      baseIndent = null;
      continue;
    }
    const match = PDF_ROW_RE.exec(line);
    if (match && section) {
      const indent = match[1].length;
      if (baseIndent === null) baseIndent = indent;
      row = {
        indent,
        subject: match[2].replace(/\s+/g, ""),
        number: match[3] ? match[3].replace(/\s+/g, "") : null,
        note: /^note:/i.test(cleanText(match[4])),
        text: cleanText(match[4]),
        credits: stripMarks(match[5]),
      };
      row.child = indent > baseIndent;
      section.rows.push(row);
      continue;
    }
    if (row) row.text = cleanText(`${row.text} ${line.trim()}`);
  }
  return sections.map(finalizeCoreSection);
}

function finalizeCoreSection(section) {
  const codes = [];
  const courses = [];
  const add = (code, title, credits) => {
    if (!code || codes.includes(code)) return;
    codes.push(code);
    courses.push({ code, title: title || "", credits: credits || "" });
  };
  for (const row of section.rows) {
    if (!row.child && row.number) add(codeOf(row.subject, row.number), row.text, row.credits);
    if (row.note) findCourseCodes(row.text).forEach((code) => add(code, "", ""));
  }
  let min = 0;
  let max = 0;
  let counted = false;
  for (const row of section.rows) {
    if (row.child) continue; // Alternatives are already covered by their note row.
    const range = parseCredits(row.credits);
    if (!range) continue;
    min += range.min;
    max += range.max;
    counted = true;
  }
  return {
    title: section.title,
    codes,
    courses,
    credits: counted ? formatRange(min, max) : null,
  };
}

function branchKind(title) {
  const text = title.toLowerCase();
  if (/option/.test(text)) return "option";
  if (/track/.test(text)) return "track";
  if (/stream/.test(text)) return "stream";
  if (/speciali[sz]ation/.test(text)) return "specialization";
  if (/concentration/.test(text)) return "concentration";
  if (/area/.test(text)) return "area";
  if (/courses/.test(text)) return "courses";
  return "other";
}

function isBranchHeading(line) {
  const title = line.trim();
  if (!title) return null;
  if (indentOf(line) > 3) return null;
  if (NON_BRANCH_HEAD_RE.test(title)) return null;
  if (ELECTIVE_HEAD_RE.test(title)) return null;
  if (!BRANCH_SUFFIX_RE.test(title)) return null;
  if (title.length > 95) return null;
  if (/[.;:]$/.test(title)) return null;
  if (/[\[\]\d]/.test(title)) return null;
  const words = title.split(/\s+/);
  if (words.length > 9) return null;
  if (words.slice(1).filter((word) => /^[a-z]/.test(word)).length >= 4) return null;
  return title;
}

function containerTitle(line) {
  const title = line.trim();
  if (indentOf(line) > 3) return null;
  return CONTAINER_RE.test(title) ? title : null;
}

/**
 * Parse the branch/area tables that follow the core requirements. A rule row
 * (a row with prose but no course number) never changes the current branch, so
 * courses listed beneath it still attach to the branch above.
 */
function parseBranches(lines, from, to) {
  const branches = [];
  const stack = [];
  let container = null;
  let lastEntity = null;
  let current = null;
  let lastRow = null;
  let pendingRule = "";
  let skip = false;

  const add = (level, title, kind, rule, credits) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].id : null;
    const id = `branch:${String(branches.length + 1).padStart(2, "0")}:${kind}`;
    const branch = {
      id,
      kind,
      title,
      parent,
      group: container,
      rule: rule || "",
      credits: credits || null,
      courses: [],
    };
    branches.push(branch);
    stack.push({ level, id });
    return branch;
  };

  for (let index = from; index < to; index += 1) {
    const line = lines[index].replace(/\s+$/g, "");
    if (PAGE_FOOTER_RE.test(line)) {
      skip = true;
      continue;
    }
    if (!line.trim()) continue;
    if (skip) {
      skip = false;
      continue;
    }
    if (REMARKS_RE.test(line.trim())) break;
    if (CREDIT_HEADER_RE.test(line)) continue;
    const lineIndent = indentOf(line);
    const match = PDF_ROW_RE.exec(line);
    if (match) {
      const number = match[3] ? match[3].replace(/\s+/g, "") : null;
      const text = cleanText(match[4]);
      const credits = stripMarks(match[5]);
      if (number) {
        const course = { code: codeOf(match[2], number), title: text, credits };
        lastRow = { ...course, indent: lineIndent };
        if (current) current.courses.push(course);
        continue;
      }
      const head = text.split("[")[0].trim();
      const bracket = /\[([^\]]*)\]*$/.exec(text);
      if (/^(area courses|stream\(s\)|speciali[sz]ation\(s\)|concentration\(s\)|study scheme)$/i.test(head)) {
        const branch = add(0, head, "group", bracket ? cleanText(bracket[1]) : "", credits);
        container = head;
        lastEntity = null;
        current = branch;
        pendingRule = branch.rule;
        lastRow = null;
        continue;
      }
      if (current) {
        // A rule row inside a branch: following courses still belong here.
        lastRow = { code: null, title: text, credits, indent: lineIndent, parent: true };
        continue;
      }
      pendingRule = /area|track/i.test(text) ? text : "";
      lastRow = { code: null, title: text, credits, indent: lineIndent, parent: true };
      continue;
    }
    if (SECTION_SUFFIX_RE.test(line.trim())) {
      lastRow = null;
      continue;
    }
    const containerMatch = containerTitle(line);
    if (containerMatch) {
      container = containerMatch;
      lastEntity = null;
      current = null;
      pendingRule = "";
      lastRow = null;
      continue;
    }
    const heading = isBranchHeading(line);
    if (heading) {
      const kind = branchKind(heading);
      const isEntity = kind !== "area" && kind !== "courses" && kind !== "other";
      const level = isEntity ? 1 : 2;
      let rule = "";
      if (level === 2 && pendingRule && container !== "Area Courses") rule = pendingRule;
      const branch = add(level, heading, kind, rule, "");
      if (level === 2 && lastEntity) {
        branch.parent = lastEntity;
        stack[stack.length - 1].id = branch.id;
      }
      if (isEntity) {
        lastEntity = branch.id;
        pendingRule = "";
      }
      current = branch;
      lastRow = null;
      continue;
    }
    if (lastRow && lineIndent >= lastRow.indent) {
      if (lastRow.code) lastRow.title = cleanText(`${lastRow.title} ${line.trim()}`);
      else lastRow.title = cleanText(`${lastRow.title} ${stripSubjectLead(line.trim())}`);
      continue;
    }
    if (current && /^[A-Z]/.test(line.trim()) && line.trim().length > 10) {
      current.rule = cleanText(`${current.rule} ${stripSubjectLead(line.trim())}`);
      if (current.kind === "group") pendingRule = current.rule;
    }
  }
  return branches;
}

/**
 * Parse the "Major Requirements" region of an HKUST program catalog PDF into
 * the mandatory core sections and the branch/area tables. Elective blocks are
 * deliberately not modelled.
 */
export function parseMajorPdf(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^\s*Major Requirements\s*$/.test(line));
  if (start < 0) throw new Error("PDF text does not contain a 'Major Requirements' heading");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (REMARKS_RE.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  let stop = -1;
  for (let index = start + 1; index < end; index += 1) {
    if (CORE_STOP_RE.test(lines[index])) {
      stop = index;
      break;
    }
  }
  const sections = parseCoreSections(lines, start + 1, stop < 0 ? end : stop);
  const branches = stop < 0 ? [] : parseBranches(lines, stop, end);
  return { sections, branches };
}

/** Reconstruct the parsed shape from a committed program document. */
export function parsedFromDb(db) {
  const sections = (db.sections || []).map((section) => {
    const members = (db.courses || []).filter((course) => course.section === section.id);
    return {
      title: section.pdfSection || section.id,
      codes: members.map((course) => course.code),
      courses: members.map((course) => ({
        code: course.code,
        title: course.title,
        credits: course.credits,
      })),
      credits: String(section.credits || "").replace(/\s*credits?$/i, ""),
    };
  });
  const branches = (db.branches || []).map((branch) => ({
    ...branch,
    courses: (branch.courses || []).map((course) => ({ ...course })),
  }));
  return { sections, branches };
}

// ---------------------------------------------------------------------------
// Relation graph and database synchronization
// ---------------------------------------------------------------------------

/**
 * Group the course references of a requirement the way the UI expects: each
 * top-level AND arm becomes one selectable group, while exclusions and pure OR
 * rules stay a single flat group.
 */
function relationGroups(relation, expression) {
  if (!expression) return [];
  const all = [...iterCourseRefs(expression)];
  if (!all.length) return [];
  if (relation !== "exclusion" && expression.type === "all") {
    return expression.items.map((item) => [...iterCourseRefs(item)]).filter((group) => group.length);
  }
  return [all];
}

/**
 * Rebuild every major-map relation straight from the course catalog. Courses
 * missing from the shipped catalog are skipped via `onMissing` (or rejected
 * when no handler is supplied).
 */
export function buildMajorRelations(courseCodes, catalog, { onMissing } = {}) {
  const relations = [];
  for (const code of courseCodes) {
    const record = catalog.courses[code];
    if (!record) {
      if (onMissing) {
        onMissing(code);
        continue;
      }
      throw new Error(`Major course ${code} is not present in catalog ${catalog.year}`);
    }
    for (const relation of RELATIONS) {
      const requirement = record.requirements[relation];
      if (!requirement) continue;
      relationGroups(relation, requirement.expression).forEach((refs, index) => {
        refs.forEach((source) => {
          relations.push({
            source,
            target: code,
            relation,
            group: index + 1,
            raw: requirement.raw,
          });
        });
      });
    }
  }
  return relations;
}

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\(s\)/g, "s")
    .replace(/[^a-z0-9]+/g, "");
}

function slugify(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function sectionIdFromTitle(title) {
  return slugify(String(title || "").replace(/\(s\)/gi, "s"));
}

function uniqueSectionId(base, used) {
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  return id;
}

function humanizeTitle(title) {
  return String(title || "")
    .replace(/\(s\)/gi, "s")
    .replace(/\s+/g, " ")
    .trim();
}

function catalogCourse(catalog, code) {
  const record = catalog.courses[code];
  if (!record) return null;
  const credits = String(record.credits || "")
    .replace(/\s*credits?\(s\)\s*$/i, "")
    .trim();
  return { title: record.title, credits };
}

/** Place an auto-added course beside the section's existing nodes. */
function autoPosition(section, placedCourses) {
  const members = placedCourses.filter((course) => course.section === section.id && course.position);
  if (!members.length) return [130, 150];
  const maxX = Math.max(...members.map((course) => course.position[0]));
  const minY = Math.min(...members.map((course) => course.position[1]));
  return [maxX + 220, minY];
}

// ---------------------------------------------------------------------------
// Automatic layout
// ---------------------------------------------------------------------------

/** Bump when {@link layoutMajorProgram} changes so documents are re-flowed. */
export const LAYOUT_VERSION = 3;

/**
 * Layout standard for generated programs, learned from the hand-curated CPEG
 * seed. Each requirement section becomes its own horizontal band stacked top
 * to bottom -- major fundamentals first, then program-specific requirements --
 * so the compound panels can never overlap no matter how many sections or
 * courses a program has. Inside a band, courses flow left to right and wrap
 * into a handful of columns chosen so the panel reads as a long, wide
 * rectangle instead of a tall single file (which crowds the requirement
 * arrows). Nested option groups are placed to the right of the courses they
 * belong to, and shared context courses are parked in short columns off to the
 * right of the whole map.
 */
const LAYOUT = {
  columnPitch: 220,
  rowPitch: 100,
  // Aim for panels about this many times wider than they are tall. For n
  // courses wrapped into c columns, aspect ~= c^2 * columnPitch / (n * rowPitch),
  // so c ~= sqrt(n * targetAspect * rowPitch / columnPitch). Cap the width so a
  // big program cannot sprawl off the page.
  targetAspect: 2.2,
  maxColumns: 7,
  siblingGap: 60,
  sectionGap: 220,
  contextGap: 260,
  contextRows: 8,
};

/** Number of columns that keeps a group's panel a long, wide rectangle. */
function panelColumns(count) {
  if (count <= 1) return count;
  const ideal = Math.sqrt((count * LAYOUT.targetAspect * LAYOUT.rowPitch) / LAYOUT.columnPitch);
  return Math.max(1, Math.min(LAYOUT.maxColumns, Math.ceil(ideal)));
}

export function layoutMajorProgram(data) {
  const groups = data.groups || [];
  const courses = data.courses || [];
  const childrenOf = new Map();
  const coursesOf = new Map();
  const bucket = (map, id) => {
    if (!map.has(id)) map.set(id, []);
    return map.get(id);
  };
  for (const group of groups) bucket(childrenOf, group.id);
  for (const group of groups) bucket(childrenOf, group.parent || null).push(group.id);
  for (const course of courses) bucket(coursesOf, course.parent || null).push(course);

  let furthestRight = 0;

  // Place a group's own courses, then its child panels to the right. Returns
  // the right edge and the height of the placed block.
  const place = (groupId, x, yTop, visiting) => {
    if (visiting.has(groupId)) return { right: x, height: 0 };
    visiting.add(groupId);
    const members = coursesOf.get(groupId) || [];
    // Fill the panel row by row (left to right, then wrap) so it grows wide.
    const columns = panelColumns(members.length);
    const rows = columns ? Math.ceil(members.length / columns) : 0;
    members.forEach((course, index) => {
      course.position = [
        x + (index % columns) * LAYOUT.columnPitch,
        yTop + Math.floor(index / columns) * LAYOUT.rowPitch,
      ];
    });
    let cursor = x + columns * LAYOUT.columnPitch;
    let height = rows * LAYOUT.rowPitch;
    for (const childId of childrenOf.get(groupId) || []) {
      if (cursor > x) cursor += LAYOUT.siblingGap;
      const child = place(childId, cursor, yTop, visiting);
      height = Math.max(height, child.height);
      cursor = child.right;
    }
    furthestRight = Math.max(furthestRight, cursor);
    return { right: cursor, height: Math.max(height, LAYOUT.rowPitch) };
  };

  let y = 0;
  for (const section of data.sections || []) {
    if (!section.rootGroup) continue;
    const block = place(section.rootGroup, 0, y, new Set());
    y += block.height + LAYOUT.sectionGap;
  }

  // Defensive: a course that is not reachable from any section root still gets
  // a deterministic slot instead of inheriting a stale coordinate.
  const placedCodes = new Set(courses.filter((course) => course.position).map((course) => course.code));
  const orphans = courses.filter((course) => !placedCodes.has(course.code));
  const orphanColumns = panelColumns(orphans.length) || 1;
  orphans.forEach((course, index) => {
    course.position = [
      (index % orphanColumns) * LAYOUT.columnPitch,
      y + Math.floor(index / orphanColumns) * LAYOUT.rowPitch,
    ];
  });
  if (orphans.length) furthestRight = Math.max(furthestRight, orphanColumns * LAYOUT.columnPitch);

  const contextX = Math.max(furthestRight, 0) + LAYOUT.contextGap;
  (data.contextCourses || []).forEach((course, index) => {
    course.position = [
      contextX + Math.floor(index / LAYOUT.contextRows) * LAYOUT.columnPitch,
      (index % LAYOUT.contextRows) * LAYOUT.rowPitch,
    ];
  });

  data.layout = "auto";
  data.layoutVersion = LAYOUT_VERSION;
  return data;
}

/**
 * Merge live program facts into a program document. Curated structure (section
 * labels, groups, coordinates, prose) is preserved; only genuine catalog drift
 * moves. When `db` is null a fresh document is created from the parsed PDF.
 */
export function synchronizeMajor(db, { catalog, parsed, meta = {}, now = new Date(), programCode, intake } = {}) {
  if (!catalog) throw new Error("synchronizeMajor requires a catalog");
  const changes = [];
  const previous = db || null;
  // Curated programs (the CPEG seed) keep their hand-placed coordinates and
  // are only ever given a slot for a brand-new course. Everything else is
  // re-flowed by the shared layout below. An explicit `layout` field wins so a
  // future generated program with nested groups is not mistaken for curated.
  const presetLayout = previous
    ? previous.layout
      ? previous.layout === "preset"
      : (previous.groups || []).some((group) => group.parent)
    : false;
  const parsedSections = parsed.sections || [];
  const parsedBranches = parsed.branches != null ? parsed.branches : previous ? previous.branches || [] : [];

  const previousSections = previous ? previous.sections || [] : [];
  const previousByLabel = new Map(
    previousSections.map((section) => [normalizeLabel(section.pdfSection || section.id), section])
  );
  const usedIds = new Set(previousSections.map((section) => section.id));
  const sections = [];
  const groups = previous ? (previous.groups || []).map((group) => ({ ...group })) : [];
  const groupIds = new Set(groups.map((group) => group.id));

  for (const parsedSection of parsedSections) {
    const match = previousByLabel.get(normalizeLabel(parsedSection.title)) || null;
    const id = match ? match.id : uniqueSectionId(sectionIdFromTitle(parsedSection.title), usedIds);
    usedIds.add(id);
    const rootGroup = match ? match.rootGroup : `group:${id}`;
    const credits = parsedSection.credits
      ? `${parsedSection.credits} credits`
      : match
        ? match.credits
        : "";
    if (match && String(match.credits || "") !== credits) {
      changes.push(`section ${id} credits ${match.credits} -> ${credits}`);
    }
    sections.push({
      id,
      pdfSection: parsedSection.title,
      eyebrow: match ? match.eyebrow : humanizeTitle(parsedSection.title),
      title: match ? match.title : humanizeTitle(parsedSection.title),
      rootGroup,
      ...(match && match.copy ? { copy: match.copy } : {}),
      ...(match && match.sourceLink ? { sourceLink: match.sourceLink } : {}),
      credits,
    });
    if (!groupIds.has(rootGroup)) {
      groups.push({ id: rootGroup, label: `${humanizeTitle(parsedSection.title)} | AND`, kind: "and", parent: null });
      groupIds.add(rootGroup);
    }
  }

  const parsedCourseByCode = new Map();
  for (const parsedSection of parsedSections) {
    for (const entry of parsedSection.courses || []) {
      if (!parsedCourseByCode.has(entry.code)) parsedCourseByCode.set(entry.code, entry);
    }
  }

  const previousCourses = previous ? previous.courses || [] : [];
  const previousCourseByCode = new Map(previousCourses.map((course) => [course.code, course]));
  const courses = [];
  const membership = new Set();

  for (const section of sections) {
    const parsedSection = parsedSections.find(
      (candidate) => normalizeLabel(candidate.title) === normalizeLabel(section.pdfSection)
    );
    const codes = parsedSection ? parsedSection.codes : [];
    const sectionCourses = [];
    for (const code of codes) {
      if (membership.has(code)) continue;
      membership.add(code);
      const existing = previousCourseByCode.get(code);
      if (existing) {
        const next = { ...existing };
        if (next.section !== section.id) {
          changes.push(`course ${code} moved to ${section.id}`);
          next.section = section.id;
          next.parent = section.rootGroup;
        }
        const catalogEntry = catalogCourse(catalog, code);
        if (catalogEntry) {
          if (catalogEntry.title && catalogEntry.title !== next.title) {
            changes.push(`course ${code} title updated from catalog`);
            next.title = catalogEntry.title;
          }
          if (catalogEntry.credits && catalogEntry.credits !== next.credits) {
            next.credits = catalogEntry.credits;
          }
        }
        sectionCourses.push(next);
      } else {
        const parsedEntry = parsedCourseByCode.get(code) || {};
        const catalogEntry = catalogCourse(catalog, code);
        changes.push(`course ${code} added to ${section.id}`);
        // The course catalog is authoritative for titles and credits, so a
        // brand-new program document converges in a single refresh instead of
        // picking up the PDF spelling now and the catalog spelling next run.
        sectionCourses.push({
          code,
          title: (catalogEntry && catalogEntry.title) || parsedEntry.title || code,
          credits: (catalogEntry && catalogEntry.credits) || parsedEntry.credits || "",
          parent: section.rootGroup,
          position: null,
          major: true,
          graph: true,
          section: section.id,
          auto: true,
        });
      }
    }
    if (presetLayout) {
      // Curated programs keep their hand-placed coordinates; a brand-new course
      // just needs a slot beside its own section.
      const pool = courses.concat(sectionCourses);
      for (const course of sectionCourses) {
        if (!course.position) course.position = autoPosition(section, pool);
      }
    }
    courses.push(...sectionCourses);
  }
  for (const course of previousCourses) {
    if (!membership.has(course.code)) changes.push(`course ${course.code} removed (no longer required)`);
  }

  const courseCodes = courses.map((course) => course.code);
  const relations = buildMajorRelations(courseCodes, catalog, {
    onMissing: (code) => changes.push(`warning: major course ${code} is not present in catalog ${catalog.year}`),
  });

  // Context courses are exactly the non-major courses referenced by relations.
  const majorSet = new Set(courseCodes);
  const referenced = new Set();
  for (const relation of relations) {
    if (!majorSet.has(relation.source)) referenced.add(relation.source);
  }
  const previousContext = previous ? previous.contextCourses || [] : [];
  const previousContextByCode = new Map(previousContext.map((course) => [course.code, course]));
  const orderedContext = [];
  const seenContext = new Set();
  for (const course of previousContext) {
    if (referenced.has(course.code)) {
      orderedContext.push(course);
      seenContext.add(course.code);
    } else {
      changes.push(`context course ${course.code} removed`);
    }
  }
  [...referenced].filter((code) => !seenContext.has(code)).sort().forEach((code) => {
    changes.push(`context course ${code} added`);
    const base = previousContext.length + orderedContext.length;
    orderedContext.push({
      code,
      title: (catalogCourse(catalog, code) || { title: code }).title,
      credits: "",
      parent: null,
      major: false,
      graph: true,
      position: [1780 + (base % 2) * 220, 110 + Math.floor(base / 2) * 108],
    });
  });
  const contextCourses = orderedContext.map((course) => {
    const existing = previousContextByCode.get(course.code);
    return existing ? { ...course, position: existing.position, title: course.title } : course;
  });

  const total = sections.reduce(
    (accumulator, section) => {
      const value = String(section.credits || "").replace(/\s*credits$/i, "");
      if (!value) return accumulator;
      const [min, max = min] = value.split("-");
      return { min: accumulator.min + Number(min), max: accumulator.max + Number(max) };
    },
    { min: 0, max: 0 }
  );
  const totalCredits = formatRange(total.min, total.max);
  if (previous && totalCredits !== previous.totalCredits) {
    changes.push(`total credits ${previous.totalCredits} -> ${totalCredits}`);
  }

  const programCodeValue = (previous && previous.programCode) || meta.programCode || programCode;
  const intakeValue = (previous && previous.intake) || meta.intake || intake || DEFAULT_INTAKE;
  const id = (previous && previous.id) || `${programCodeValue}-${intakeValue}`;
  const program = meta.programTitle || (previous && previous.program) || programCodeValue;
  const sourceUrl = meta.pdfUrl || (previous && previous.sourceUrl) || "";
  const sourceHash = meta.sourceHash || (previous && previous.sourceHash) || "";
  const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  const data = {
    schemaVersion: 2,
    id,
    programCode: programCodeValue,
    program,
    intake: intakeValue,
    catalogYear: catalog.year,
    totalCredits,
    sourceUrl,
    sourceHash,
    generatedAt,
    outline: {
      eyebrow: `${intakeValue} intake`,
      title: program,
      credits: `${totalCredits} credits`,
    },
    sections,
    groups,
    courses,
    branches: parsedBranches.map((branch) => ({
      ...branch,
      courses: (branch.courses || []).map((course) => ({ ...course })),
    })),
    contextCourses,
    relations,
    layout: presetLayout ? "preset" : "auto",
    layoutVersion: LAYOUT_VERSION,
  };
  if (!presetLayout) layoutMajorProgram(data);
  return { data, changes };
}

// ---------------------------------------------------------------------------
// Comparison, fingerprints and I/O
// ---------------------------------------------------------------------------

/** Deterministic serialization used to decide whether a document changed. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => key !== "generatedAt").sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashText(text) {
  return createHash("sha256").update(String(text).replace(/\s+/g, " ").trim()).digest("hex");
}

/**
 * Fingerprint of the *parsed requirements*. Hashing the parsed structure
 * (instead of the raw extracted text) keeps `--check` stable across poppler
 * versions while still detecting real requirement changes.
 */
export function requirementFingerprint(parsed) {
  return hashText(canonical({ sections: parsed.sections || [], branches: parsed.branches || [] }));
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function programFilePath(id, majorDir = MAJOR_DIR) {
  return path.join(majorDir, `${id}.json`);
}

async function resolveCommittedDb(id, manifestEntry, majorDir) {
  if (manifestEntry && manifestEntry.file) {
    const fromManifest = path.join(STATIC_ROOT, manifestEntry.file.replace(/^\//, ""));
    if (existsSync(fromManifest)) {
      const data = await readJsonOrNull(fromManifest);
      if (data) return { data, file: fromManifest };
    }
  }
  const direct = programFilePath(id, majorDir);
  if (existsSync(direct)) {
    const data = await readJsonOrNull(direct);
    if (data) return { data, file: direct };
  }
  return { data: null, file: null };
}

// ---------------------------------------------------------------------------
// Program and manifest refresh
// ---------------------------------------------------------------------------

/**
 * Refresh every program's requirement document plus the manifest. Files are
 * written only when their canonical content (ignoring `generatedAt`) changed.
 */
export async function updateAllMajors({
  catalog,
  intake = DEFAULT_INTAKE,
  offline = false,
  write = true,
  now = new Date(),
  fetchImpl = fetch,
  log = () => {},
  pdfToTextImpl = pdfToText,
  programCodes = null,
  manifestPath = DEFAULT_MANIFEST,
  majorDir = MAJOR_DIR,
} = {}) {
  if (!catalog) throw new Error("updateAllMajors requires a catalog");

  const previousManifest = await readJsonOrNull(manifestPath);
  const previousEntries = new Map();
  if (previousManifest && Array.isArray(previousManifest.programs)) {
    for (const entry of previousManifest.programs) previousEntries.set(entry.id, entry);
  }

  let codes;
  if (programCodes && programCodes.length) {
    codes = [...new Set(programCodes.map((code) => String(code).toUpperCase()))].sort();
  } else if (offline) {
    const fromDir = existsSync(majorDir)
      ? (await readdir(majorDir))
          .filter((name) => name.endsWith(`-${intake}.json`))
          .map((name) => name.slice(0, -`.json`.length - `-${intake}`.length))
      : [];
    const fromManifest = [...previousEntries.values()]
      .filter((entry) => entry.intake === intake || entry.id.endsWith(`-${intake}`))
      .map((entry) => entry.programCode);
    codes = [...new Set([...fromManifest, ...fromDir])].sort();
  } else {
    codes = await discoverPrograms({ intake, fetchImpl, log });
  }

  const programs = [];
  const skipped = [];
  const written = [];
  let programChanged = false;
  const generatedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  for (const code of codes) {
    const id = `${code}-${intake}`;
    const previousEntry = previousEntries.get(id) || null;
    const committed = await resolveCommittedDb(id, previousEntry, majorDir);
    const previousDb = committed.data;

    let parsed;
    let meta;
    try {
      if (offline) {
        if (!previousDb) throw new Error("no committed program data");
        parsed = parsedFromDb(previousDb);
        meta = {
          programCode: previousDb.programCode,
          intake: previousDb.intake,
          programTitle: previousDb.program,
          pdfUrl: previousDb.sourceUrl,
          sourceHash: previousDb.sourceHash,
        };
      } else {
        const source = await discoverProgramSource(
          { programCode: code, intake },
          { fetchImpl, log }
        );
        log(`Downloading ${source.pdfUrl}`);
        const bytes = await fetchBytes(source.pdfUrl, { fetchImpl, log });
        const tempPath = path.join(os.tmpdir(), `hkust-major-${process.pid}-${code}.pdf`);
        await writeFile(tempPath, bytes);
        let text;
        try {
          text = await pdfToTextImpl(tempPath);
        } finally {
          await rm(tempPath, { force: true });
        }
        parsed = parseMajorPdf(text);
        meta = {
          programCode: code,
          intake: source.intake || intake,
          programTitle: source.programTitle,
          pdfUrl: source.pdfUrl,
          sourceHash: requirementFingerprint(parsed),
        };
      }
    } catch (error) {
      if (previousDb) {
        log(`warning: ${code}: ${error.message}; keeping committed data`);
        programs.push(previousEntry || describeProgram(previousDb, id));
        skipped.push({ code, reason: error.message, kept: true });
        continue;
      }
      log(`warning: ${code}: ${error.message}; skipped`);
      skipped.push({ code, reason: error.message, kept: false });
      continue;
    }

    const { data } = synchronizeMajor(previousDb, {
      catalog,
      parsed,
      meta,
      now,
      programCode: code,
      intake,
    });

    const file = `/data/majors/${id}.json`;
    const absolute = programFilePath(id, majorDir);
    const changed = !previousDb || canonical(data) !== canonical(previousDb);
    if (changed) programChanged = true;
    if (write && changed) {
      await mkdir(majorDir, { recursive: true });
      await writeFile(absolute, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      written.push(absolute);
    }
    programs.push(describeProgram(data, id, file));
    if (changed) log(`Updated ${code} (${data.courses.length} core courses, ${data.branches.length} branches)`);
  }

  // A scoped refresh (`--program`) must not drop the programs it did not touch:
  // carry their existing manifest entries forward.
  const refreshed = new Set(codes);
  for (const entry of previousEntries.values()) {
    if (!refreshed.has(entry.programCode)) programs.push(entry);
  }
  programs.sort((a, b) => a.programCode.localeCompare(b.programCode));
  const manifest = {
    schemaVersion: 2,
    catalogYear: catalog.year,
    intake,
    generatedAt,
    programs,
  };
  const manifestChanged = !previousManifest || canonical(manifest) !== canonical(previousManifest);
  if (write && manifestChanged) {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    written.push(manifestPath);
  }

  return {
    changed: manifestChanged || programChanged,
    manifestChanged,
    files: written,
    manifest,
    programs,
    skipped,
  };
}

function describeProgram(data, id, file = `/data/majors/${id}.json`) {
  return {
    id,
    programCode: data.programCode,
    program: data.program,
    intake: data.intake,
    totalCredits: data.totalCredits,
    file,
    sourceUrl: data.sourceUrl,
    sourceHash: data.sourceHash,
    sections: (data.sections || []).length,
    branches: (data.branches || []).length,
    courses: (data.courses || []).length,
    relations: (data.relations || []).length,
  };
}

/**
 * Backwards-compatible wrapper around {@link updateAllMajors} for callers that
 * only ever refreshed a single program.
 */
export async function updateMajorRequirements(options = {}) {
  const result = await updateAllMajors(options);
  return {
    dbPath: options.manifestPath || DEFAULT_MANIFEST,
    pdfPath: null,
    pdfChanged: false,
    dbChanged: result.changed,
    changed: result.changed,
    changes: [],
    files: result.files,
    summary: {
      programs: result.programs.length,
      courses: result.programs.reduce((total, program) => total + program.courses, 0),
      relations: result.programs.reduce((total, program) => total + program.relations, 0),
      skipped: result.skipped.length,
    },
    data: result.manifest,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    intake: DEFAULT_INTAKE,
    program: null,
    catalog: null,
    check: false,
    offline: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--intake") options.intake = argv[++index];
    else if (arg === "--program") options.program = argv[++index].split(",").map((code) => code.trim()).filter(Boolean);
    else if (arg === "--catalog") options.catalog = path.resolve(argv[++index]);
    else if (arg === "--check") options.check = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node tools/build-major.mjs [--intake YYYY-YY] [--program CODE,...]\n" +
        "                               [--catalog FILE] [--check] [--offline] [--dry-run]\n"
    );
    return;
  }
  const catalogPath = options.catalog || DEFAULT_CATALOG;
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const result = await updateAllMajors({
    catalog,
    intake: options.intake,
    offline: options.offline,
    write: !options.check && !options.dryRun,
    programCodes: options.program,
    log: (message) => process.stderr.write(`${message}\n`),
  });

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`);
    return;
  }

  const detail =
    `${result.programs.length} programs, ` +
    `${result.programs.reduce((total, program) => total + program.courses, 0)} core courses, ` +
    `${result.programs.reduce((total, program) => total + program.relations, 0)} relations, ` +
    `${result.programs.reduce((total, program) => total + program.branches, 0)} branches` +
    (result.skipped.length ? `, ${result.skipped.length} skipped` : "");

  if (options.check) {
    process.stdout.write(
      result.changed
        ? `Major requirement database is stale (${detail}).\n`
        : `Major requirement database is up to date (${detail}).\n`
    );
    if (result.changed) process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.changed ? "Updated" : "Unchanged"} major requirement database (${detail}).\n`);
  if (result.skipped.length) {
    process.stdout.write(`  skipped: ${result.skipped.map((entry) => entry.code).join(", ")}\n`);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

export {
  DEFAULT_CATALOG,
  DEFAULT_DB,
  DEFAULT_INTAKE,
  DEFAULT_MANIFEST,
  MAJOR_DIR,
  PROGRAM_URL_BASE,
  REPO_ROOT,
  STATIC_ROOT,
};
