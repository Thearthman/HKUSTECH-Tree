# HKUST Course Tree

A local course-selection helper that turns the HKUST undergraduate catalog into
an explorable prerequisite tech tree. It preserves nested `AND`/`OR` rules,
corequisites, exclusions, catalog conditions, and the original HKUST wording.

A prebuilt copy of the catalog ships with the site, so the whole application can
run as a **browser-only static app**: no server, no database, and no
user data stored off-device (the only outbound request is Vercel Web Analytics,
see [Data and privacy](#data-and-privacy)). The original Flask/SQLite
implementation is preserved on the `local` branch for reference.

## Static build (browser-only, Vercel)

`static/` is the site root. It contains the prebuilt `data/catalog.json` plus all
HTML, CSS, JS, and vendored libraries. At runtime the browser loads that JSON
once, mirrors it into IndexedDB as an offline fallback, and answers every search,
course lookup, and graph query locally.

```bash
npm install          # only needed to regenerate the catalog or run tests
npm run serve        # http://localhost:4173
npm test
```

The site ships two committed datasets, both regenerated from live HKUST sources
and checked in so deploys are deterministic and hermetic:

- `static/data/catalog.json` — the course database (subjects, courses,
  prerequisites/corequisites/exclusions).
- `static/data/major-requirements.json` — the major-requirement manifest
  (schema version 2). It lists every fetched undergraduate program, and each
  entry points at its own document under `static/data/majors/<CODE>-<intake>.json`.
  Each program document records the mandatory core sections, the branch/area
  tables (options, tracks, streams and specialization areas such as CPEG's AI,
  robotics and VLSI areas), and every prerequisite/corequisite/exclusion edge
  re-derived from `catalog.json`.

Generated program documents carry `layout: "auto"` and are re-flowed by
`layoutMajorProgram` whenever the database is refreshed. It follows the standard
set by the hand-curated CPEG seed: each requirement section becomes its own
horizontal band, stacked top to bottom (major fundamentals first, then
program-specific requirements) so the compound panels never overlap, courses
flow left to right and wrap into just enough columns to keep each panel a long,
wide rectangle rather than a tall single file, and shared context courses are
parked in short columns off to the right. The CPEG document is marked
`layout: "preset"` so its hand-placed coordinates are preserved. Bump
`LAYOUT_VERSION` to force every generated program to be re-flowed.

`npm run build` regenerates `static/data/catalog.json` from the live HKUST
catalog when it is missing (`npm run build:catalog` always regenerates).

To deploy on Vercel, create a project from this repository with the repository
root as the project root. `vercel.json` sets `static/` as the output directory,
enables clean URLs, and rewrites `/ustree` to the single-page entry point. The
only runtime requirement is that `data/catalog.json` is served from the same
origin as the pages.

## Pages

Everything is served from `static/`:

- `/` — the default **Course** page focuses on one selected course, showing its
  prerequisite pathway and the courses that directly use it as a prerequisite.
- `/ustree` — the dedicated multi-target **USTree** workspace. It is a real
  `static/ustree.html` asset generated from `index.html` by
  `tools/build-pages.mjs` (`npm run build:pages`); `app.js` switches into USTree
  mode from the `/ustree` URL, so no host-specific rewrite is required.
- `/major-requirement` — the **Major requirement** map for the 2025-26 intake.
  A program selector switches between every fetched major; each view shows the
  nested `AND`/`OR` core rules, the available branch/area tables, and catalog
  relationship context.

The page reads the committed `static/data/catalog.json`; its **Check for
updates** button re-fetches that file from the host and falls back to the
browser's IndexedDB copy when offline.

## Export and import

Every page's top bar carries **Export** and **Import** buttons (the download /
upload arrows beside the theme toggle). **Export** downloads a single JSON file
named `hkust-course-tree-YYYYMMDD.json` that snapshots everything the site keeps
locally: the **USTree** targets, the **finished courses**, each page's **last
focused course**, the **selected major requirement**, and the small display
preferences (`hideFulfilledPrereq`, theme). Data is grouped by catalog year, so
an export taken across several years restores them all.

**Import** reads one of those files back. It validates the file first (rejecting
non-JSON, exports from other apps, and empty snapshots) and then **merges** the
contents into the current browser rather than replacing it: USTree targets and
finished courses are unioned per year, and the selected major and preferences
are applied. The page then re-reads its state and re-renders, and a short toast
reports how many targets and courses were added.

**Reset** (the ✕ button) erases everything the site stored in this browser —
every `hkust-course-tree` value in `localStorage` plus the cached catalog in
IndexedDB — and then reloads the page. Because it is destructive it uses a
double affirmation: the first click only arms the button (**Confirm reset**,
with a **Cancel** escape hatch and an automatic timeout) and the second click
actually wipes the browser.

## Zen mode

The **Zen** button (the ⛶ glyph beside the theme toggle) hides all of the page
chrome — the top bar, the graph/relationship controls, the legend, and notices —
so the graph or outline fills the whole viewport on either the shared or the
Major requirement shell. The graph pages re-fit their canvas as it grows.

While zen mode is on, a floating **Exit zen** button stays in the top-right
corner and `Esc` also leaves the mode. It is a transient view toggle: it is not
stored, so a reload returns to the normal layout.

## Persistent highlight

Hovering a course highlights its relationships, but that highlight normally
disappears as soon as the pointer moves. Clicking a course instead **pins** the
highlight, so it stays on screen while the pointer wanders off and after the
details drawer closes. A pinned node carries a soft halo to show it is held
rather than a passing hover.

The pin is released by clicking empty canvas, by clicking a different course
(which moves the pin), or by pressing `Esc`. It is not stored, so reloading
returns to transient hover.

Touch devices never fire a hover, so the mobile layout maps the two desktop
gestures onto touch: a **tap** takes the hover role and only previews the
relationships, while a **long press** takes the click role and opens the course
details. This keeps a single tap from covering the graph with the drawer when
the user only wanted to inspect the connections. The completion checkbox stays a
normal tap target on every device.

## Refreshing the data (autonomous)

`tools/update-data.mjs` is the single entry point that keeps both databases in
sync with the live HKUST catalog. It rebuilds the course database first, then
reconciles the major-requirement database on top of it (re-reading the program
page, downloading the current requirement PDF, and re-deriving every
prerequisite/corequisite/exclusion edge from the fresh catalog), so the two can
never drift apart. Files are written only when the canonical content actually
changed.

```bash
npm run update:data            # refresh both databases in place
npm run check:data             # hermetic consistency check (no network)
node tools/update-data.mjs --check         # CI mode: exit 1 when stale
node tools/update-data.mjs --offline       # rebuild from the committed program JSON
node tools/update-data.mjs --commit        # commit (and push) any changes
node tools/update-data.mjs --year 2026-27 --max-subjects 40
node tools/update-data.mjs --program CPEG,COMP   # limit the major refresh
npm run build:major                        # refresh only the major database
```

`--max-subjects` is a read-only preview: it never overwrites the committed
catalog and skips the major database, which needs the complete course set.
`tools/import-major.mjs` (`npm run import:major`) is a one-time bootstrap that
can rebuild the curated CPEG seed `static/data/majors/CPEG-2025-26.json` from
the legacy hardcoded table in git history. Elective-only blocks are deliberately
not modelled; the branch/area tables are captured so the outline can list the
available options.

`.github/workflows/update-data.yml` runs `tools/update-data.mjs --commit` on a
weekly schedule (and on demand). It installs `poppler-utils` for PDF parsing,
runs the test suite against the refreshed data, and only then pushes, which
triggers a redeploy.

## Data and privacy

There is no backend: every piece of user state lives in the browser, and the
course/major data is fetched only from this site's own origin. The one outbound
request is Vercel Web Analytics (cookieless, anonymized page-view collection) —
disable it by removing the `/_vercel/insights/script.js` snippet from the HTML
shells if you do not want it.

- USTree targets — `localStorage["hkust-course-tree:ustree:<year>"]`
- Completed courses — `localStorage["hkust-course-tree:completed:<year>"]`
- Last focused course — `localStorage["hkust-course-tree:focus:<year>"]`
- Selected major requirement — `localStorage["hkust-course-tree:major"]`
- Preferences (hide fulfilled prereqs, theme) —
  `localStorage["hkust-course-tree:hide-fulfilled-prereq"]`,
  `localStorage["hkust-course-tree:theme"]`
- Catalog cache — IndexedDB database `hkust-course-tree` (store `catalogs`)

The **Export**/**Import** buttons in the top bar move all of this between
browsers as a JSON file, and the **Reset** button erases it all from this
browser (see [Export and import](#export-and-import)). Clearing site data resets
the USTree and completion checkboxes; the catalog is re-downloaded from the host
on the next visit.

## Test

```bash
npm test
```

The application is an unofficial planning aid. Always verify enrollment rules
against the linked HKUST catalog entry.

## Interface principles

- The graph prioritizes courses and pathways. Boolean parser junctions are
  flattened into direct course edges on the canvas, while exact `AND`/`OR`
  wording remains available in course details.
- Course view keeps one selected course visually anchored between its backward
  prerequisite pathway and direct forward dependents. USTree is a separate
  page for combining multiple long-term targets, and it loads the backward
  prerequisite/corequisite pathway only.
- Major requirement view uses solid enclosures for `AND` rules and dotted
  enclosures for `OR` rules. Non-major relationship context stays dim until a
  course is inspected.
- Outline lists the mandatory core sections followed by the program's branch and
  area tables. Parser conditions and Boolean `ALL`/`ANY` nodes remain available
  through course details instead of competing with course scanning.
- Levels follow the deepest visible prerequisite chain so dependency arrows move
  toward later bands. Corequisites share a band; exclusions never affect rank.
- **Tree depth** limits how much of the enabled relationship graph is loaded and
  shown, while **Highlight depth** independently controls how many backward
  prerequisite course hops are colored on hover. Highlighting cannot extend
  beyond courses already included by the tree depth.
- Fit defines the minimum zoom for the current visible graph. Right-button drag
  pans from either empty canvas or a course node.
- Hover is progressive disclosure: the inspected course and its direct
  relationships remain prominent while unrelated paths fade.
- Clicking a course pins that highlight in place (`Esc` or empty canvas
  releases it), so desktop readers can keep it on screen while the details
  drawer is open. In the mobile layout a tap previews instead and a long press
  is what opens the details, since touch has no hover to preview with.
- When a course is hovered, each top-level `AND` requirement becomes a colored
  grouping; all `OR` alternatives inside that grouping share its background and
  edge color.
- The USTree target set lets students build one combined pathway for multiple
  desired courses. Shared prerequisites are merged once, while targets remain
  independently removable and persist by catalog year.
- Every starred USTree target is checked against the finished courses: a green
  border means its prerequisites are met, a red border marks a missing
  prerequisite, and a dashed amber border flags a requirement (such as a prose
  condition) that completed courses alone cannot settle. The verdict appears on
  the node, in the target list, in the outline, and in the course details, and
  updates the moment a completion checkbox is toggled.
- **Hide fulfilled prereqs & coreqs** removes prerequisite and corequisite
  branches already covered by a finished or starred/in-plan alternative on both
  the Course and USTree pages. Finishing (or starring) COMP 1023 hides
  COMP 1028 from `COMP 2211: COMP 1023 OR COMP 1028`, along with courses shown
  only because of COMP 1028, unless another visible course still needs them.
  The same applies to corequisites: finishing CHEM 2110 hides CHEM 2111 from
  `CHEM 2155: CHEM 2110 OR CHEM 2111`. Hiding follows the same verdict the
  target status shows, so a finished or starred course settles its branch even
  when the catalog adds a grade note such as "Grade A or above" (transcripts
  are not available); prose conditions stay visible because no completion can
  settle them. The USTree is evaluated strictly backward, top-down from its
  targets, so a course is only reconsidered when a target's own requirement
  still reaches it -- a course that merely happens to *depend* on a target is
  not dragged into the pathway. The toggle in the control bar is on by
  default and remembers an opt-out.
- A fixed checkbox in the top-left of every course node records completion
  without changing node dimensions or opening the details drawer.
- Subject color is secondary to labels and edge styles, so the graph remains
  understandable without relying on color alone.
- The dense desktop canvas supports repeated exploration; the mobile Outline and
  bottom sheet trade spatial overview for readable, touch-friendly inspection.
