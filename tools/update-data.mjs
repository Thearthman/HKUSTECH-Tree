#!/usr/bin/env node
/**
 * Autonomous refresh for every committed HKUST dataset.
 *
 * One command keeps the two databases the browser-only app ships with in sync
 * with the live HKUST catalog:
 *
 *   1. `static/data/catalog.json`      - the course database (subjects, courses,
 *                                        prerequisites/corequisites/exclusions).
 *   2. `static/data/major-requirements.json` (manifest) plus one
 *      `static/data/majors/<CODE>-<intake>.json` per undergraduate program -
 *      the major requirement database.
 *
 * The major database is always rebuilt on top of the freshly fetched course
 * database, so the two can never drift apart. The script is safe to run on a
 * schedule: it writes only when the canonical content actually changed, and
 * `--check` turns drift detection into a non-zero exit code for CI.
 *
 * Usage:
 *   node tools/update-data.mjs                 # refresh both databases
 *   node tools/update-data.mjs --check         # exit 1 when either is stale
 *   node tools/update-data.mjs --offline       # skip network, reuse local PDF
 *   node tools/update-data.mjs --commit        # git commit refresh (and push)
 *   node tools/update-data.mjs --year 2026-27 --max-subjects 40
 *   node tools/update-data.mjs --intake 2025-26 --program CPEG,COMP
 */

import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCatalog } from "./build-catalog.mjs";
import {
  DEFAULT_INTAKE,
  DEFAULT_MANIFEST,
  canonical,
  updateAllMajors,
} from "./build-major.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CATALOG = path.join(REPO_ROOT, "static", "data", "catalog.json");
const DEFAULT_YEAR = "2026-27";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Resolve the academic year to fetch. An explicit `--year` always wins;
 * otherwise we roll forward with whatever year the committed catalog already
 * targets, falling back to the current intake year.
 */
async function resolveYear(explicitYear) {
  if (explicitYear) return explicitYear;
  try {
    const existing = await readJson(DEFAULT_CATALOG);
    if (existing && /^\d{4}-\d{2}$/.test(existing.year)) return existing.year;
  } catch {
    // No catalog yet; fall through to the default.
  }
  return DEFAULT_YEAR;
}

async function writeJsonIfChanged(file, data) {
  let previous = null;
  try {
    previous = await readJson(file);
  } catch {
    previous = null;
  }
  if (previous && canonical(previous) === canonical(data)) return { changed: false, previous };
  await writeFile(file, `${JSON.stringify(data)}\n`, "utf8");
  return { changed: true, previous };
}

/**
 * Repo-relative paths to stage for a refresh: every changed dataset, including
 * the source PDF when the major database was rebuilt from a new download.
 */
export function filesToStage(results) {
  return [...new Set(results.filter((result) => result.changed).flatMap((result) => result.files || [result.path]))].map(
    (file) => path.relative(REPO_ROOT, file)
  );
}

/**
 * Rebuild the course database. `catalog.json` is written compactly (it is large
 * and machine-consumed), and only when its content changed. `write:false` (or
 * `check`) compares without touching the committed file.
 */
async function updateCatalog({ year, maxSubjects, check, write = true, log }) {
  log(`Refreshing course catalog${year ? ` for ${year}` : ""}...`);
  const data = await buildCatalog({ year, maxSubjects, log });
  let changed = true;
  if (check || !write) {
    try {
      const previous = await readJson(DEFAULT_CATALOG);
      changed = canonical(previous) !== canonical(data);
    } catch {
      changed = true;
    }
  } else {
    const result = await writeJsonIfChanged(DEFAULT_CATALOG, data);
    changed = result.changed;
  }
  return {
    name: "course catalog",
    path: DEFAULT_CATALOG,
    files: [DEFAULT_CATALOG],
    changed,
    courseCount: Object.keys(data.courses).length,
    fetchedSubjects: data.subjects.filter((subject) => subject.fetched).length,
    totalSubjects: data.subjects.length,
    year: data.year,
    sourceHash: data.sourceHash,
    data,
  };
}

async function git(command, args) {
  const { stdout } = await execFileAsync("git", [command, ...args], { cwd: REPO_ROOT });
  return stdout.trim();
}

async function commitAndPush(files, message, { push = true, log = () => {} } = {}) {
  await git("add", files);
  const staged = await git("diff", ["--cached", "--name-only"]);
  if (!staged) {
    log("Nothing staged; skipping commit.");
    return false;
  }
  await git("commit", ["-m", message]);
  log(`Committed: ${await git("rev-parse", "--short", "HEAD")}`);
  if (push) {
    try {
      await git("push");
      log("Pushed to origin.");
    } catch (error) {
      log(`Push skipped: ${error.message}`);
    }
  }
  return true;
}

function parseArgs(argv) {
  const options = {
    year: undefined,
    intake: null,
    programs: null,
    maxSubjects: null,
    check: false,
    offline: false,
    commit: false,
    push: true,
    catalog: true,
    major: true,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--year") options.year = argv[++index];
    else if (arg === "--intake") options.intake = argv[++index];
    else if (arg === "--program") options.programs = argv[++index].split(",").map((code) => code.trim()).filter(Boolean);
    else if (arg === "--max-subjects") options.maxSubjects = Number(argv[++index]);
    else if (arg === "--check") options.check = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--commit") options.commit = true;
    else if (arg === "--no-push") options.push = false;
    else if (arg === "--no-catalog") options.catalog = false;
    else if (arg === "--no-major") options.major = false;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node tools/update-data.mjs [--check] [--offline] [--commit] [--no-push]\n" +
        "                          [--year YYYY-YY] [--max-subjects N] [--no-catalog] [--no-major]\n" +
        "                          [--intake YYYY-YY] [--program CODE,...]\n" +
        "\n" +
        "  --check         exit 1 when either database is stale (writes nothing)\n" +
        "  --offline       reuse the committed catalog and PDF (no network)\n" +
        "  --commit        git commit (and push) any refreshed files\n" +
        "  --no-catalog    refresh only the major database\n" +
        "  --no-major      refresh only the course catalog\n" +
        "  --intake        program intake year to fetch (default 2025-26)\n" +
        "  --program       limit the major refresh to these program codes\n" +
        "  --max-subjects  read-only preview of the first N subjects\n"
    );
    return;
  }

  const log = (message) => process.stderr.write(`${message}\n`);
  const results = [];

  // `--max-subjects` truncates the crawl, so it is a read-only preview: the
  // committed catalog is never overwritten and the major database (which needs
  // the full course set) is skipped.
  const preview = options.maxSubjects != null;
  if (preview && options.major) {
    log("Preview mode (--max-subjects): skipping major database (needs a full catalog).");
  }

  // The major database depends on the course catalog, so the catalog is loaded
  // first. `--offline` and `--no-catalog` both reuse the committed catalog
  // (the former also avoids the network for the major database).
  let catalog = null;
  if (options.offline || !options.catalog) {
    catalog = await readJson(DEFAULT_CATALOG);
    results.push({
      name: "course catalog",
      path: DEFAULT_CATALOG,
      files: [],
      changed: false,
      courseCount: Object.keys(catalog.courses).length,
      fetchedSubjects: catalog.subjects.filter((subject) => subject.fetched).length,
      totalSubjects: catalog.subjects.length,
      year: catalog.year,
      data: catalog,
    });
  } else {
    const year = await resolveYear(options.year);
    const catalogResult = await updateCatalog({
      year,
      maxSubjects: options.maxSubjects,
      check: options.check,
      write: !preview,
      log,
    });
    catalog = catalogResult.data;
    results.push(catalogResult);
  }

  if (options.major && !preview) {
    const intake = options.intake || DEFAULT_INTAKE;
    log(`Refreshing major requirement database (${intake} intake)...`);
    const majorResult = await updateAllMajors({
      catalog,
      intake,
      offline: options.offline,
      write: !options.check,
      programCodes: options.programs,
      log,
    });
    results.push({
      name: "major requirements",
      path: DEFAULT_MANIFEST,
      // `files` already lists every changed program document plus the manifest.
      files: majorResult.files,
      changed: majorResult.changed,
      programs: majorResult.programs.length,
      skipped: majorResult.skipped,
      courses: majorResult.programs.reduce((total, program) => total + program.courses, 0),
      relations: majorResult.programs.reduce((total, program) => total + program.relations, 0),
      branches: majorResult.programs.reduce((total, program) => total + program.branches, 0),
    });
  }

  const changed = results.filter((result) => result.changed);
  const lines = [
    `${changed.length ? "Stale" : "Up to date"}: ${results.map((result) => result.name).join(" + ")}`,
    ...results.map((result) => {
      const detail = result.name === "course catalog"
        ? `${result.courseCount} courses, ${result.fetchedSubjects}/${result.totalSubjects} subjects`
        : `${result.programs} programs, ${result.courses} core courses, ${result.relations} relations, ` +
          `${result.branches} branches` +
          (result.skipped && result.skipped.length ? `, ${result.skipped.length} skipped` : "");
      return `  - ${result.name}: ${result.changed ? "changed" : "unchanged"} (${detail})`;
    }),
  ];
  const majorSummary = results.find((result) => result.name === "major requirements");
  if (majorSummary && majorSummary.skipped && majorSummary.skipped.length) {
    lines.push(`    skipped (no fetchable requirements): ${majorSummary.skipped.map((entry) => entry.code).join(", ")}`);
  }

  const summary = `${lines.join("\n")}\n`;
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## HKUST data refresh\n\n\`\`\`\n${summary}\`\`\`\n`);
  }

  if (options.check) {
    if (changed.length) process.exitCode = 1;
    return;
  }

  if (options.commit && changed.length && !preview) {
    const files = filesToStage(results);
    const names = changed.map((result) => result.name).join(" and ");
    await commitAndPush(files, `chore(data): refresh ${names}`, { push: options.push, log });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

export { REPO_ROOT, parseArgs };
