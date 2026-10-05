# HKUST Course Tree

A local course-selection helper that turns the HKUST undergraduate catalog into
an explorable prerequisite tech tree. It preserves nested `AND`/`OR` rules,
corequisites, exclusions, catalog conditions, and the original HKUST wording.

A prebuilt copy of the catalog ships with the site, so the whole application can
run as a **browser-only static app**: no server, no database, and no data sent
anywhere at runtime. The optional Flask server is kept for offline catalog
crawling during development.

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

`npm run build` regenerates `static/data/catalog.json` from the live HKUST
catalog when it is missing (`npm run build:catalog` always regenerates). The
generated file is committed so deploys are deterministic and hermetic.

To deploy on Vercel, create a project from this repository with the repository
root as the project root. `vercel.json` sets `static/` as the output directory,
enables clean URLs, and rewrites `/ustree` to the single-page entry point. The
only runtime requirement is that `data/catalog.json` is served from the same
origin as the pages.

## Run (Flask development server)

The development environment is a Nix flake; there is no virtualenv and nothing
is installed into the working copy.

```bash
cd /home/johnmich/Work/Personal/HKUSTECH-Tree
nix develop
python -m hkust_tree
```

`nix develop` supplies Python 3.14 with Flask, BeautifulSoup, requests, and
pytest, and puts the checkout itself on `PYTHONPATH`, so edits under
`hkust_tree/` and `static/` take effect on the next request with no rebuild
step. `flake.lock` pins the exact nixpkgs revision; run `nix flake update` to
move it. `requirements.txt` remains only as a version reference for non-Nix
setups.

Without entering the shell, any command can be prefixed with
`nix develop -c`, for example `nix develop -c python -m hkust_tree`.

Open <http://127.0.0.1:5000>. The server binds only to the local machine by
default. Set `HKUST_TREE_HOST`, `HKUST_TREE_PORT`, `HKUST_TREE_DB`, or
`HKUST_TREE_YEAR` to override its defaults.

The default **Course** page focuses on one selected course, showing its
prerequisite pathway and the courses that directly use it as a prerequisite.
Open <http://127.0.0.1:5000/ustree> for the dedicated multi-target **USTree**
workspace.

Open <http://127.0.0.1:5000/major-requirement> for the **Major requirement**
map. It currently models the 2025-26 CPEG intake from the supplied official
report, including its nested `AND`/`OR` choice rules and catalog relationship
context.

The current `2026-27` catalog is already cached in `data/catalog.sqlite3` in the
working copy; the Flask backend serves its own `/api/*` endpoints and refreshes
from the live catalog when asked. The static build instead reads the committed
`static/data/catalog.json`; its **Check for updates** button re-fetches that file
from the host and falls back to the browser's IndexedDB copy when offline.

## Test

```bash
nix develop -c python -m pytest -q
```

The application is an unofficial planning aid. Always verify enrollment rules
against the linked HKUST catalog entry.

## Interface principles

- The graph prioritizes courses and pathways. Boolean parser junctions are
  flattened into direct course edges on the canvas, while exact `AND`/`OR`
  wording remains available in course details.
- Course view keeps one selected course visually anchored between its backward
  prerequisite pathway and direct forward dependents. USTree is a separate
  page for combining multiple long-term targets.
- Major requirement view uses solid enclosures for `AND` rules and dotted
  enclosures for `OR` rules. Non-major relationship context stays dim until a
  course is inspected.
- Outline lists courses only. Parser conditions and Boolean `ALL`/`ANY` nodes
  remain available through course details instead of competing with course
  scanning.
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
- When a course is hovered, each top-level `AND` requirement becomes a colored
  grouping; all `OR` alternatives inside that grouping share its background and
  edge color.
- The USTree target set lets students build one combined pathway for multiple
  desired courses. Shared prerequisites are merged once, while targets remain
  independently removable and persist by catalog year.
- A fixed checkbox in the top-left of every course node records completion
  without changing node dimensions or opening the details drawer.
- Subject color is secondary to labels and edge styles, so the graph remains
  understandable without relying on color alone.
- The dense desktop canvas supports repeated exploration; the mobile Outline and
  bottom sheet trade spatial overview for readable, touch-friendly inspection.
