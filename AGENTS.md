<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-10-06 | Last verified: 2026-10-06 -->

# AGENTS.md

**Precedence:** the closest `AGENTS.md` to the files you're changing wins. There is only this root `AGENTS.md` (no scoped files), so it always wins.

## What this is
Browser-only HKUST course-prerequisite tree. `static/` is the whole deployed site (no server, no DB); the original Flask/SQLite backend lives on the `local` branch for reference only. `tools/` are ESM Node scripts that build/refresh the committed datasets; `tests/` are `node:test` suites.

## Commands (verified)
> Source: `package.json`. Node 20+ (CI uses `node-version: 20`). There is **no** lint, typecheck, format, or bundler step — do not invent `tsc`/`eslint`/`prettier` commands.

| Task | Command | ~Time |
|------|---------|-------|
| Install (tooling/tests only) | `npm install` | ~5s |
| Test (all) | `npm test` (`node --test tests/*.test.mjs`) | ~2s |
| Serve locally | `npm run serve` (http://localhost:4173) | — |
| Build site | `npm run build` (catalog if missing → pages) | ~10s |
| Regenerate catalog | `npm run build:catalog` | ~2m (network) |
| Regenerate major DB | `npm run build:major` | ~5m (network) |
| Regenerate pages | `npm run build:pages` | <1s |
| Refresh both datasets | `npm run update:data` | minutes |
| Offline consistency check | `npm run check:data` | ~2s |

The site itself needs no install: `npm install` is only for regenerating data or running tests.

## Workflow
1. **Before coding**: read this file, then the relevant file(s) under `tools/` or `static/`.
2. **After each change**: run the smallest check — `npm test` is fast enough to run for almost any change.
3. **Data changes**: use `npm run update:data` (or the sub-builds); never hand-edit committed JSON.
4. **Before claiming done**: paste real command output as evidence — never assert "should work", "tested", or "all green" without it.

## File Map
```
static/                      deployed site root (Vercel outputDirectory)
  index.html                 Course page shell; also the SPA entry for /ustree
  ustree.html                GENERATED from index.html by tools/build-pages.mjs — do not hand-edit
  major-requirement.html     Major requirement map shell
  app.js                     Course + USTree graph page controller (largest module)
  ustree.js                  USTree target/merge/requirement-verdict logic (window.USTreeSupport)
  major-requirements.js      Major requirement map renderer
  catalog-client.js          Catalog load/search/graph API + IndexedDB cache (window.HKUSTCatalog)
  data-transfer.js           Export/import/reset of localStorage state (window.HKUSTDataTransfer)
  graph-interactions.js      Shared Cytoscape fit/hover/checkbox geometry (window.GraphInteractionSupport)
  theme.js                   Sync light/dark controller (decides before first paint)
  zen.js                     Distraction-free body-class toggle (window.HKUSTZen)
  styles.css                 All site styling + --cy-* graph theme tokens
  data/                      COMMITTED generated datasets (catalog.json, major-requirements.json, majors/*.json)
  vendor/                    Vendored Cytoscape/Dagre + licenses — never edit
tools/                       ESM build/refresh scripts (see docstrings; heavy exports are unit-tested)
  build-catalog.mjs          Scrape + losslessly parse catalog → static/data/catalog.json
  build-major.mjs            Parse requirement PDFs → per-program docs; re-derive relations from catalog
  update-data.mjs            Single entry point: catalog first, then majors; --check/--offline/--commit
  build-pages.mjs            Generate ustree.html from index.html
  import-major.mjs           One-time bootstrap of the CPEG seed from git history
  serve.mjs                  Local static server mirroring Vercel (port 4173, pretty URLs)
tests/                       node:test suites; inline HTML/JSON fixtures, no network
.github/workflows/update-data.yml  Weekly autonomous refresh (uses poppler-utils for PDFs)
```

## Golden Samples (follow these patterns)
| For | Reference | Key patterns |
|-----|-----------|--------------|
| Boolean requirement parsing | `tools/build-catalog.mjs` `parseRequirement` | Nested AND/OR expression tree; preserve raw catalog wording; lossless |
| Browser module shape | `static/ustree.js` | IIFE wrapping `(typeof window !== "undefined" ? window : this)`; expose one `window.*` API; testable via `vm` sandbox |
| Multi-step orchestration | `tools/update-data.mjs` | Catalog rebuilt before majors; write only on real change; `--check` exits non-zero |
| Test style | `tests/catalog.test.mjs` | `node:test` + `node:assert/strict`, inline fixture strings, import real functions from `tools/` |

## Utilities (check before creating new)
| Need | Use | Location |
|------|-----|----------|
| Normalize a course code | `normalizeCourseCode` | `tools/build-catalog.mjs`, `static/catalog-client.js` |
| Canonical/hash JSON for change detection | `canonical`, `hashText`, `requirementFingerprint` | `tools/build-major.mjs` |
| Re-flow a generated program | `layoutMajorProgram` (+ `LAYOUT_VERSION`) | `tools/build-major.mjs` |
| Read/write browser state safely | `HKUSTDataTransfer.collect/apply/clearAll`, storage keys | `static/data-transfer.js` |
| Hover/pin/checkbox behavior | `GraphInteractionSupport` | `static/graph-interactions.js` |

## Heuristics (quick decisions)
| When | Do |
|------|-----|
| Committed data looks stale | `npm run update:data`, not manual JSON edits |
| Changing course/major parsing | Run `npm test`; parsing is covered by inline fixtures |
| Adding a shared page | Generate via `tools/build-pages.mjs`; don't edit `static/ustree.html` |
| Adding browser state | Route through `data-transfer.js` keys so export/import/reset stay complete — **except** the department stack, which is reset-only on purpose (see Graph node colors) |
| Changing graph layout for generated programs | Bump `LAYOUT_VERSION` in `tools/build-major.mjs` to force a re-flow |
| Touching `static/vendor/` | Don't — vendored libs are pinned; ask first |
| Styling a graph node's border or background | Border = course **department** only (fixed `dept-N` palette via the persistent stack — never recalculate/re-sort it); background = plain fill or the hovered/clicked node's prereq pattern. Never add status/focus/selection colors — see Graph node colors below. |

## Key Decisions / Codebase State
- **Two committed datasets, one direction of truth.** `catalog.json` is the course source; every major-requirement relation is re-derived from it so the two can never drift.
- **Catalog schema:** `{ year, generatedAt, source, sourceHash, subjects[58], courses{ "<CODE> <NUMBER>": {...} } }` (1410 courses). Each course carries `requirements` keyed by `prerequisite`/`corequisite`/`exclusion`.
- **Manifest schema v2:** `major-requirements.json` lists programs; each points at `data/majors/<CODE>-<intake>.json`. `CPEG-2025-26.json` is `layout: "preset"` (hand-placed, preserved); all others are `layout: "auto"` and re-flowed.
- **Defaults:** catalog year `2026-27`, major intake `2025-26`. `vercel.json` serves `static/` with clean URLs.
- **Script load order matters:** `theme.js` is synchronous in `<head>` (no theme flash); graph vendors load before page modules (all `defer`).

### Graph node colors (Course + USTree) — do not extend
The Course page (`/`) and the USTree page (`/ustree`) render through `static/app.js` `graphStyles()`. Their **background and border are deliberately minimal**; treat this as a closed spec and do not add new background/border channels.

- **Background has exactly two states for a normal course node:**
  1. the plain fill (`--cy-node-bg`), and
  2. the **prereq pattern** — when a node is **hovered** (transient) or **clicked/pinned** (persistent), its prerequisite courses take the five alternating `hover-group-1…5` fills (`--cy-hoverN-bg`).
  The fill encodes the relationship highlight only. Completion, target, focus, dependent, unresolved and prereq-verdict states must **not** repaint it (completion shows via the tick image, targets via the star, verdicts via label text + detail/outline chips).
- **Border encodes exactly one thing: the course department.** Departments map to the fixed 10-colour palette (`--cy-dept-0…9`, light + dark, same order) through a persistent **stack** (`state.deptStack`, stored at `hkust-course-tree:dept-stack`) that has exactly two mutators and no others:
  - `add()` (`deptStackAdd`) places a department code at the **smallest empty index** — reusing the lowest hole left by a removal — or appends when there are no holes.
  - `remove()` (`deptStackRemove`) tombstones the department's index to a `null` hole and leaves every other index exactly where it was, so **no other department's colour moves**. It then runs `compactOverflowedDepartments()`, which is the **one** allowed relocation: a department sitting in an *overflown* slot (index ≥ 10, i.e. its `% 10` colour is shared) is pulled down into a freed slot below the palette so it regains a unique colour. This moves only overflown departments; a department that already had a unique colour (slots 0–9) is never moved, so its colour never changes.
  - The stack is **never recalculated or re-sorted**. The only ordering rule is that departments first seen together are queued **biggest-first** (Python-style string compare, descending) before their adds, so a simultaneous first appearance is deterministic rather than draw-order-dependent.
  - A department's slot index is taken modulo 10 to pick the colour, so colours only repeat once more than ten departments are in the stack, and the same department always keeps the same colour across renders, page loads, and the Course↔USTree↔major-requirement navigation.
  - `syncDepartments()` in `app.js` reconciles the stack against the loaded graph: it reads the **full** `state.graph.nodes` (never the projected/visible subset) so courses hidden by the fulfilled-prereq filter still count. A department is added when a course of it is rendered, and **removed only on the USTree page** when no course of it exists in the full USTree graph. The Course page passes `{ remove: false }` — a lookup must not evict a plan colour.
  - The stack is **cleared only by the system reset** (which sweeps every `hkust-course-tree:*` key, `dept-stack` included). It is deliberately **not** exported/imported: import must not be another way to alter it. Do not add a "recalculate"/"reassign"/"compact the holes" step — the holes are the whole point.
- Course nodes carry a `dept-N` class; **never** style their border from status/focus/target/selection/verdict (the old `subject-comp/math/elec` borders, `node:selected`, `is-prereq-*`, `is-focus`, `is-target` borders were removed for this reason).
- **Special conditional nodes are exempt:** `all`, `any`, `condition` and `coursePattern` (e.g. "achieve an A in A-Level Mathematics") keep their existing background **and** border. Only *normal course* nodes follow the two background states and the department-only border.
- The `major-requirements.js` map is a separate renderer and is **out of scope** for these rules.

## Boundaries

### Always Do
- Run `npm test` before committing; paste output as evidence.
- Keep generated files generated: rebuild via `tools/`, don't hand-edit `static/ustree.html` or `static/data/*.json`.
- Use conventional commits, e.g. `feat(ui): …`, `fix(prereqs): …` (see `git log`).
- Check `npm run check:data` when data changed; commit data and code together when they move as one.

### Ask First
- Adding dependencies (runtime deps today: only `node-html-parser`, used by tools/tests).
- Changing CI/CD (`.github/workflows/update-data.yml`) or `vercel.json`.
- Repo-wide refactors, or changing the committed data schema.

### Never Do
- Edit `static/vendor/**` (vendored Cytoscape/Dagre) or `node_modules/**`.
- Commit secrets or the downloaded requirement PDFs (`static/data/*.pdf` is ignored except the committed CPEG source).
- Hand-edit generated program docs under `static/data/majors/` — regenerate them.
- Fabricate commands/tools that don't exist here (no lint/typecheck/format).

## Terminology
| Term | Means |
|------|-------|
| Subject / Course | Catalog grouping (`COMP`) / a course record (`"COMP 4211"`) |
| Relation | One of `prerequisite`, `corequisite`, `exclusion` |
| Expression | Nested AND/OR requirement tree parsed from catalog wording (`raw` kept for exact text) |
| Manifest / program doc | `major-requirements.json` index / one `data/majors/<CODE>-<intake>.json` |
| Intake | Program entry year for a major map (e.g. `2025-26`) |
| USTree target | A starred long-term course the user is planning toward |
| Finished course | A course the user has marked completed; feeds requirement verdicts |

## Scoped AGENTS.md (MUST read when working in these directories)
<!-- AGENTS-GENERATED:START scope-index -->
_No scoped `AGENTS.md` files exist yet. If you add a new top-level subsystem, create one there and register it in the File Map above._
<!-- AGENTS-GENERATED:END scope-index -->

> **Agents**: when a directory gains its own `AGENTS.md`, load it first — it overrides this root file.
