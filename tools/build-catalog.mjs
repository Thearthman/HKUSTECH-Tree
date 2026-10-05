#!/usr/bin/env node
/**
 * Build the static HKUST course catalog consumed by the browser-only app.
 *
 * This is a JavaScript port of the original Python catalog builder (preserved
 * on the `local` branch). It fetches the public
 * HKUST undergraduate catalog, parses each subject page with the same lossless
 * Boolean-requirement rules, and writes a single JSON document that the frontend
 * downloads and caches. No server-side storage is involved at runtime.
 *
 * Usage:
 *   node tools/build-catalog.mjs                 # regenerate static/data/catalog.json
 *   node tools/build-catalog.mjs --if-missing     # no-op when the file already exists
 *   node tools/build-catalog.mjs --max-subjects 40 --year 2026-27
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE_URL = "https://prog-crs.hkust.edu.hk";
const DEFAULT_SUBJECTS = ["COMP", "MATH", "ELEC"];
const RELATIONS = ["prerequisite", "corequisite", "exclusion"];
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 HKUSTECH-Tree/1.0";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "static", "data", "catalog.json");

// ---------------------------------------------------------------------------
// Text and requirement parsing (port of the original Python implementation)
// ---------------------------------------------------------------------------

const SPACE_RE = /\s+/g;
const HTML_DASH_RE = /[\u2010-\u2015\u2212]/g;

function cleanText(value) {
  return String(value == null ? "" : value)
    .replace(/\u00a0/g, " ")
    .replace(HTML_DASH_RE, "-")
    .replace(SPACE_RE, " ")
    .trim();
}

function courseRegex() {
  return /(?<![A-Za-z0-9])([A-Za-z]{4})\s*[-_]?\s*(\d{4}[A-Za-z]?)(?![A-Za-z0-9])/g;
}

const COURSE_FULL_RE = /^\s*([A-Za-z]{4})\s*[-_]?\s*(\d{4}[A-Za-z]?)\s*$/;
const PATTERN_RE =
  /^any\s+([A-Za-z]{4})\s+courses?\s+of\s+([1-9])000[\s\-\u2010-\u2015]*level\s+or\s+above$/i;
const TEMPORAL_RE = /^\s*\(((?:prior|before|from|since|in)\b[^()]*)\)/i;

function normalizeCourseCode(value) {
  if (typeof value !== "string") return null;
  const match = COURSE_FULL_RE.exec(cleanText(value).toUpperCase());
  if (!match) return null;
  return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
}

function courseMatches(text) {
  const matches = [];
  const regex = courseRegex();
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({
      index: match.index,
      end: match.index + match[0].length,
      code: `${match[1].toUpperCase()} ${match[2].toUpperCase()}`,
    });
  }
  return matches;
}

function courseNode(code, qualifier) {
  const node = { type: "course", code };
  if (qualifier) node.qualifier = qualifier;
  return node;
}

function balancedOuterGroup(text) {
  if (text.length < 2 || !"([".includes(text[0]) || !")]".includes(text[text.length - 1])) {
    return false;
  }
  const expected = text[0] === "(" ? ")" : "]";
  if (text[text.length - 1] !== expected) return false;
  const stack = [];
  const pairs = { ")": "(", "]": "[" };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "[") stack.push(char);
    else if (char === ")" || char === "]") {
      if (!stack.length || stack.pop() !== pairs[char]) return false;
      if (!stack.length && index !== text.length - 1) return false;
    }
  }
  return stack.length === 0;
}

function groupingWarnings(text) {
  const stack = [];
  const pairs = { ")": "(", "]": "[" };
  for (const char of text) {
    if (char === "(" || char === "[") stack.push(char);
    else if (char === ")" || char === "]") {
      if (!stack.length || stack.pop() !== pairs[char]) {
        return ["Unbalanced requirement grouping"];
      }
    }
  }
  return stack.length ? ["Unbalanced requirement grouping"] : [];
}

function splitTopLevelWord(text, operator) {
  const pieces = [];
  let start = 0;
  const pairs = { ")": "(", "]": "[" };
  const word = new RegExp(`(?<![A-Za-z0-9])${operator}(?![A-Za-z0-9])`, "gi");
  let match;
  while ((match = word.exec(text)) !== null) {
    // Reconstruct grouping depth at this match. Requirements are short and this
    // stays robust in the presence of malformed closing marks.
    const stack = [];
    for (const char of text.slice(0, match.index)) {
      if (char === "(" || char === "[") stack.push(char);
      else if ((char === ")" || char === "]") && stack.length && stack[stack.length - 1] === pairs[char]) {
        stack.pop();
      }
    }
    if (stack.length) continue;
    if (operator.toUpperCase() === "OR") {
      const following = text.slice(match.index + match[0].length).replace(/^\s+/, "").toLowerCase();
      if (/^(?:above|higher|better)\b/.test(following)) continue;
    }
    const left = text.slice(start, match.index).replace(/^[ ;,]+|[ ;,]+$/g, "");
    if (left) pieces.push(left);
    start = match.index + match[0].length;
  }
  if (!pieces.length) return [text.trim()];
  const tail = text.slice(start).replace(/^[ ;,]+|[ ;,]+$/g, "");
  if (tail) pieces.push(tail);
  return pieces;
}

function trimSeparators(value, separators) {
  const chars = separators.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`^[ ${chars}]+|[ ${chars}]+$`, "g"), "");
}

function splitTopLevelChars(text, separators) {
  const pieces = [];
  let start = 0;
  const stack = [];
  const pairs = { ")": "(", "]": "[" };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(" || char === "[") stack.push(char);
    else if ((char === ")" || char === "]") && stack.length && stack[stack.length - 1] === pairs[char]) {
      stack.pop();
    } else if (separators.includes(char) && !stack.length) {
      const item = trimSeparators(text.slice(start, index), ";,");
      if (item) pieces.push(item);
      start = index + 1;
    }
  }
  if (!pieces.length) return [text.trim()];
  const tail = trimSeparators(text.slice(start), ";,");
  if (tail) pieces.push(tail);
  return pieces;
}

function splitSlashAlternatives(text) {
  const pieces = splitTopLevelChars(text, "/");
  if (pieces.length < 2) return [text];
  // Slash is a Boolean alternative only when every side contains a course. This
  // avoids corrupting HKDSE M1/M2, P/F, and ordinary prose.
  if (pieces.every((piece) => courseMatches(piece).length > 0)) return pieces;
  return [text];
}

function combine(kind, items) {
  const flattened = [];
  for (const item of items) {
    if (item && item.type === kind) flattened.push(...(item.items || []));
    else flattened.push(item);
  }
  if (flattened.length === 1) return flattened[0];
  return { type: kind, items: flattened };
}

function qualifierForSingleCourse(text, match) {
  const before = text.slice(0, match.index).replace(/^[ ,;:-]+|[ ,;:-]+$/g, "");
  let after = text.slice(match.end);
  const qualifiers = [];
  const temporal = TEMPORAL_RE.exec(after);
  if (temporal) {
    qualifiers.push(temporal[1].trim());
    after = after.slice(temporal[0].length);
  }
  const trimmedBefore = before.replace(/\bin\s*$/i, "").replace(/^[ ,;:-]+|[ ,;:-]+$/g, "");
  const remainder = [trimmedBefore, after.replace(/^[ ,;:-]+|[ ,;:-]+$/g, "")]
    .filter(Boolean)
    .join(" ");
  if (remainder) qualifiers.unshift(cleanText(remainder));
  return qualifiers.join("; ") || null;
}

function parseExpression(text, warnings) {
  let value = text.replace(/^[ ;,]+|[ ;,]+$/g, "");
  if (!value) {
    warnings.push("Empty requirement expression");
    return { type: "condition", text: "Unspecified requirement" };
  }

  while (balancedOuterGroup(value)) value = value.slice(1, -1).trim();

  // AND binds tighter than OR, so split OR before recursively parsing each arm.
  let parts = splitTopLevelWord(value, "OR");
  if (parts.length > 1) return combine("any", parts.map((part) => parseExpression(part, warnings)));

  parts = splitTopLevelWord(value, "AND");
  if (parts.length > 1) return combine("all", parts.map((part) => parseExpression(part, warnings)));

  parts = splitSlashAlternatives(value);
  if (parts.length > 1) return combine("any", parts.map((part) => parseExpression(part, warnings)));

  // Catalog lists use commas and, less often, semicolons as conjunctions.
  parts = splitTopLevelChars(value, ",;");
  if (parts.length > 1) return combine("all", parts.map((part) => parseExpression(part, warnings)));

  const pattern = PATTERN_RE.exec(value);
  if (pattern) {
    return {
      type: "coursePattern",
      subject: pattern[1].toUpperCase(),
      minimumLevel: Number(pattern[2]),
      text: value,
    };
  }

  const matches = courseMatches(value);
  if (matches.length === 1) {
    return courseNode(matches[0].code, qualifierForSingleCourse(value, matches[0]));
  }
  if (matches.length > 1) {
    warnings.push("Course references lacked an explicit Boolean connector; treated as AND");
    return combine("all", matches.map((match) => courseNode(match.code)));
  }
  return { type: "condition", text: value };
}

function parseRequirement(rawText, relation = "prerequisite") {
  if (!RELATIONS.includes(relation)) throw new Error(`Unsupported relation: ${relation}`);
  const raw = cleanText(rawText || "");
  const warnings = groupingWarnings(raw);
  const expression = parseExpression(raw, warnings);
  return {
    relation,
    raw,
    status: warnings.length ? "partial" : "parsed",
    warnings: [...new Set(warnings)],
    expression,
  };
}

function* iterCourseRefs(expression) {
  if (!expression) return;
  const nodeType = expression.type;
  if (nodeType === "course") {
    const code = normalizeCourseCode(String(expression.code || ""));
    if (code) yield code;
  } else if (nodeType === "all" || nodeType === "any") {
    for (const item of expression.items || []) yield* iterCourseRefs(item);
  }
}

function* iterSubjectRefs(expression) {
  if (!expression) return;
  const nodeType = expression.type;
  if (nodeType === "coursePattern") {
    const subject = String(expression.subject || "").toUpperCase();
    if (/^[A-Z]{4}$/.test(subject)) yield subject;
  } else if (nodeType === "course") {
    const code = normalizeCourseCode(String(expression.code || ""));
    if (code) yield code.split(" ")[0];
  } else if (nodeType === "all" || nodeType === "any") {
    for (const item of expression.items || []) yield* iterSubjectRefs(item);
  }
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

function isElement(node) {
  return node && node.nodeType === 1;
}

function getText(element, separator = " ") {
  if (!element) return "";
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      // `text` is entity-decoded (matching BeautifulSoup), unlike `rawText`.
      parts.push(node.text != null ? node.text : node.rawText);
      return;
    }
    for (const child of node.childNodes || []) walk(child);
  };
  walk(element);
  return parts
    .map((part) => String(part == null ? "" : part).trim())
    .join(separator);
}

function directChildren(element, tagName, className) {
  return (element.childNodes || []).filter(
    (node) => isElement(node) && node.tagName === tagName && node.classList.contains(className)
  );
}

function selectOne(root, selector) {
  return root.querySelector(selector);
}

const HEADER_RELATION = {
  "prerequisite(s)": "prerequisite",
  "corequisite(s)": "corequisite",
  "exclusion(s)": "exclusion",
};

function parseSubjectIndex(html, requestedYear, parse) {
  const root = parse(html);
  const title = selectOne(root, "h1.page-title");
  if (!title || !getText(title).includes(requestedYear)) {
    throw new Error(`Response is not the HKUST undergraduate subject index for ${requestedYear}`);
  }
  const subjectList = selectOne(root, "ul.subject-list");
  if (!subjectList) throw new Error("HKUST subject index contains no subject list");
  const subjects = [];
  for (const item of subjectList.querySelectorAll("li.subject")) {
    const codeElement = selectOne(item, ".subject-code");
    const nameElement = selectOne(item, ".subject-name");
    const link = selectOne(item, "a[href]");
    if (!codeElement || !nameElement || !link) continue;
    const code = getText(codeElement).toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) continue;
    const href = String(link.getAttribute("href") || "");
    const sourceUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    subjects.push({ code, name: cleanText(getText(nameElement)), source_url: sourceUrl });
  }
  if (!subjects.length) throw new Error("HKUST subject index contains no valid subjects");
  return subjects;
}

function parseCoursePage(html, requestedYear, requestedSubject, sourceUrl, parse) {
  const subject = requestedSubject.toUpperCase();
  const root = parse(html);
  const title = selectOne(root, "h1.page-title");
  const nameElement = selectOne(root, ".subject-name");
  const pageSubject = nameElement ? nameElement.querySelector(".subject-code") : null;
  const courseList = selectOne(root, "ul.crse-list");
  if (!title || !getText(title).includes(requestedYear)) {
    throw new Error(`Response is not an HKUST course page for ${requestedYear}`);
  }
  if (!pageSubject || getText(pageSubject).toUpperCase() !== subject) {
    throw new Error(`Response is not the HKUST ${subject} course page`);
  }
  if (!courseList) throw new Error(`HKUST ${subject} page contains no course list`);

  const pageUrl = sourceUrl || `${BASE_URL}/ugcourse/${requestedYear}/${subject}/`;
  const courses = [];
  for (const item of courseList.querySelectorAll("li.crse")) {
    const header = directChildren(item, "DIV", "crse-header")[0];
    const detail = directChildren(item, "DIV", "crse-detail")[0];
    if (!header || !detail) continue;
    const codeElement = selectOne(header, ".crse-code");
    const titleElement = selectOne(header, ".crse-title");
    const unitElement = selectOne(header, ".crse-unit");
    const code = normalizeCourseCode(codeElement ? getText(codeElement) : "");
    if (!code || !code.startsWith(`${subject} `) || !titleElement) continue;
    let description = "";
    const requirements = {};
    for (const row of detail.querySelectorAll(".data-row")) {
      const labelElement = directChildren(row, "DIV", "header")[0];
      const dataElement = directChildren(row, "DIV", "data")[0];
      if (!labelElement || !dataElement) continue;
      const label = cleanText(getText(labelElement));
      const value = cleanText(getText(dataElement));
      if (label.toLowerCase() === "description") description = value;
      const relation = HEADER_RELATION[label.toLowerCase()];
      if (relation && value) requirements[relation] = parseRequirement(value, relation);
    }
    courses.push({
      year: requestedYear,
      code,
      subject,
      number: code.split(" ")[1],
      title: cleanText(getText(titleElement)),
      credits: unitElement ? cleanText(getText(unitElement)) : "",
      description,
      source_url: pageUrl,
      requirements,
    });
  }
  if (!courses.length) throw new Error(`HKUST ${subject} page contains no valid courses`);
  return courses;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, { attempts = 3, timeout = 30000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      const text = await response.text();
      if (text.length < 500) throw new Error(`Incomplete HTML response from ${url}`);
      return text;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(400 * 2 ** attempt);
    }
  }
  throw new Error(`Could not fetch ${url}: ${lastError && lastError.message}`);
}

async function buildCatalog({ year, maxSubjects, log = () => {}, fetchImpl = fetchText }) {
  const { parse } = await import("node-html-parser");
  const indexUrl = `${BASE_URL}/ugcourse/${year}`;
  log(`Fetching subjects for ${year} from ${indexUrl}`);
  const indexHtml = await fetchImpl(indexUrl);
  const subjects = parseSubjectIndex(indexHtml, year, parse);
  const subjectMap = new Map(subjects.map((item) => [item.code, item]));

  const queue = DEFAULT_SUBJECTS.filter((code) => subjectMap.has(code));
  const queued = new Set(queue);
  const fetched = new Set();
  const courses = new Map();

  while (queue.length && (maxSubjects == null || fetched.size < maxSubjects)) {
    const subject = queue.shift();
    const url = subjectMap.get(subject).source_url;
    log(`[${fetched.size + 1}] Fetching ${subject} (${queue.length} queued)`);
    const html = await fetchImpl(url);
    const parsed = parseCoursePage(html, year, subject, url, parse);
    for (const course of parsed) {
      for (const requirement of Object.values(course.requirements)) {
        for (const referencedSubject of iterSubjectRefs(requirement.expression)) {
          if (subjectMap.has(referencedSubject) && !queued.has(referencedSubject)) {
            queued.add(referencedSubject);
            queue.push(referencedSubject);
          }
        }
      }
      courses.set(course.code, course);
    }
    fetched.add(subject);
  }

  const sortedCourses = {};
  for (const code of [...courses.keys()].sort()) {
    const course = courses.get(code);
    const requirements = {};
    for (const relation of RELATIONS) {
      requirements[relation] = course.requirements[relation] || null;
    }
    sortedCourses[code] = {
      year: course.year,
      code: course.code,
      subject: course.subject,
      number: course.number,
      title: course.title,
      credits: course.credits,
      description: course.description,
      source_url: course.source_url,
      requirements,
    };
  }

  const subjectRecords = subjects.map((item) => ({ ...item, fetched: fetched.has(item.code) }));
  // Hash the parsed content, not the raw HTML: HKUST stamps a per-request
  // cache-buster (`?t=...`) into every page, which would otherwise change the
  // hash on every crawl and make an autonomous refresh churn forever.
  const sourceHash = sha256(JSON.stringify({ year, subjects: subjectRecords, courses: sortedCourses }));
  return {
    year,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source: indexUrl,
    sourceHash,
    subjects: subjectRecords,
    courses: sortedCourses,
  };
}

function parseArgs(argv) {
  const options = { year: "2026-27", out: DEFAULT_OUT, ifMissing: false, maxSubjects: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--if-missing") options.ifMissing = true;
    else if (arg === "--year") options.year = argv[++index];
    else if (arg === "--out") options.out = path.resolve(argv[++index]);
    else if (arg === "--max-subjects") options.maxSubjects = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}$/.test(options.year)) {
    throw new Error("Academic year must look like 2026-27");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: node tools/build-catalog.mjs [--year YYYY-YY] [--out FILE] [--if-missing] [--max-subjects N]\n");
    return;
  }
  if (options.ifMissing) {
    try {
      const existing = JSON.parse(await readFile(options.out, "utf8"));
      process.stdout.write(
        `Catalog for ${existing.year} already present at ${options.out} (generated ${existing.generatedAt}); skipping build.\n`
      );
      return;
    } catch {
      // Fall through and build it.
    }
  }
  const startedAt = Date.now();
  const catalog = await buildCatalog({
    year: options.year,
    maxSubjects: options.maxSubjects,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify(catalog)}\n`, "utf8");
  const courseCount = Object.keys(catalog.courses).length;
  const fetchedCount = catalog.subjects.filter((item) => item.fetched).length;
  process.stdout.write(
    `Wrote ${options.out}\n` +
      `  year: ${catalog.year}\n` +
      `  subjects: ${fetchedCount} fetched / ${catalog.subjects.length} available\n` +
      `  courses: ${courseCount}\n` +
      `  generatedAt: ${catalog.generatedAt}\n` +
      `  elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

export {
  BASE_URL,
  DEFAULT_SUBJECTS,
  RELATIONS,
  buildCatalog,
  cleanText,
  iterCourseRefs,
  iterSubjectRefs,
  normalizeCourseCode,
  parseCoursePage,
  parseRequirement,
  parseSubjectIndex,
};
