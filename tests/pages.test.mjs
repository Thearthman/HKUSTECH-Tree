import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(name) {
  return readFileSync(new URL(`../static/${name}`, import.meta.url), "utf8");
}

test("ustree.html mirrors index.html", () => {
  assert.equal(
    read("ustree.html"),
    read("index.html"),
    "static/ustree.html drifted from static/index.html; regenerate with `npm run build:pages`"
  );
});

test("the shell includes the USTree workspace markup", () => {
  const html = read("index.html");
  for (const id of ["ustreeManager", "ustreeButton", "ustreeTargets", "ustreeEmpty"]) {
    assert.ok(
      html.includes(`id="${id}"`),
      `the shared shell should include the USTree element #${id}`
    );
  }
  assert.ok(
    html.includes('href="/ustree"'),
    "the shared shell should link to the dedicated /ustree page"
  );
});

test("app.js switches into USTree mode from the /ustree URL", () => {
  const app = read("app.js");
  assert.ok(
    app.includes('=== "/ustree"'),
    "app.js should detect the USTree page from the URL path"
  );
  assert.ok(
    app.includes('IS_USTREE_PAGE ? "ustree" : "course"'),
    "app.js should mark the body as the ustree page"
  );
  assert.ok(
    app.includes("elements.ustreeManager.hidden = !IS_USTREE_PAGE"),
    "app.js should reveal the USTree manager only on /ustree"
  );
});

test("USTree loads only the backward prerequisite pathway", () => {
  const app = read("app.js");
  // Design choice: the USTree is a study plan, so its graph requests never ask
  // for forward dependents. The Course page keeps showing direct dependents.
  assert.ok(
    app.includes('var GRAPH_DIRECTION = IS_USTREE_PAGE ? "backward" : "both"'),
    "USTree must request backward-only graphs while the Course page keeps forward dependents"
  );
  assert.ok(
    app.includes("direction: GRAPH_DIRECTION"),
    "the graph request should use the page's direction constant"
  );
  assert.ok(
    !app.includes('IS_USTREE_PAGE ? "both"'),
    "USTree must never request a forward or both-direction graph"
  );
});

test("the shared shell loads the browser-only client", () => {
  const html = read("index.html");
  for (const asset of ["/catalog-client.js", "/ustree.js", "/app.js"]) {
    assert.ok(html.includes(asset), `${asset} should be loaded by the shared shell`);
  }
  assert.ok(!html.includes("/api/"), "the static shell must not call the Flask API");
});

test("every shell exposes export/import/reset controls and loads the transfer module", () => {
  for (const name of ["index.html", "ustree.html", "major-requirement.html"]) {
    const html = read(name);
    assert.ok(html.includes('src="/data-transfer.js"'), `${name} should load the data-transfer module`);
    for (const id of ["exportData", "importData", "importDataInput", "resetData", "resetDataCancel"]) {
      assert.ok(html.includes(`id="${id}"`), `${name} should include the #${id} control`);
    }
  }
  const app = read("app.js");
  assert.ok(
    app.includes("HKUSTDataTransfer.bind") && app.includes("onApplied: applyImportedData"),
    "app.js should wire the transfer module and re-render after an import"
  );
  const major = read("major-requirements.js");
  assert.ok(
    major.includes("HKUSTDataTransfer.saveSelectedMajor") &&
      major.includes("HKUSTDataTransfer.loadSelectedMajor") &&
      major.includes("HKUSTDataTransfer.bind"),
    "the major page should persist, restore and import its selected program"
  );
  const transfer = read("data-transfer.js");
  assert.ok(
    transfer.includes("function clearAll") && transfer.includes('getElementById("resetData")'),
    "the transfer module should own the reset control and the clearing logic"
  );
  assert.ok(
    transfer.includes("function clearCache") || read("catalog-client.js").includes("function clearCache"),
    "the catalog cache should be droppable for a reset"
  );
});

test("major-requirement.html loads the browser-only client", () => {
  const html = read("major-requirement.html");
  assert.ok(html.includes("/catalog-client.js"));
  assert.ok(!html.includes("/api/"));
});

test("every shell loads Vercel Web Analytics", () => {
  // Static hosts get the framework-agnostic snippet instead of the React
  // <Analytics/> component; Vercel serves the script from /_vercel/insights/.
  for (const name of ["index.html", "ustree.html", "major-requirement.html"]) {
    const html = read(name);
    assert.ok(
      html.includes("window.va = window.va || function"),
      `${name} should queue Vercel Analytics with the window.va stub`
    );
    assert.ok(
      html.includes('defer src="/_vercel/insights/script.js"'),
      `${name} should load the Vercel Analytics script`
    );
  }
});

test("every shell loads the theme controller and a toggle", () => {
  for (const name of ["index.html", "ustree.html", "major-requirement.html"]) {
    const html = read(name);
    assert.ok(html.includes('src="/theme.js"'), `${name} should load the shared theme controller`);
    assert.ok(html.includes("data-theme-toggle"), `${name} should expose a theme toggle`);
  }
});

test("every shell loads the zen controller with a toggle and a way out", () => {
  for (const name of ["index.html", "ustree.html", "major-requirement.html"]) {
    const html = read(name);
    assert.ok(html.includes('src="/zen.js"'), `${name} should load the shared zen controller`);
    assert.ok(html.includes('id="zenToggle"'), `${name} should expose a zen toggle`);
    assert.ok(html.includes('id="zenExit"'), `${name} should expose a floating zen exit`);
  }
  const css = read("styles.css");
  assert.ok(
    css.includes("body.is-zen") && css.includes(".zen-exit"),
    "zen mode should hide the chrome and style the floating exit control"
  );
  for (const name of ["app.js", "major-requirements.js"]) {
    assert.ok(
      read(name).includes('window.addEventListener("hkust-zen-change"'),
      `${name} should grow and re-fit its canvas when zen mode toggles`
    );
  }
});

test("theme.js follows the OS by default and persists an override", () => {
  const js = read("theme.js");
  assert.ok(js.includes("prefers-color-scheme: dark"), "the OS preference is the default theme");
  assert.ok(js.includes("hkust-course-tree:theme"), "the explicit choice is stored locally");
  assert.ok(js.includes("hkust-theme-change"), "theme changes are broadcast for the graphs");
});

test("styles.css defines a dark theme", () => {
  const css = read("styles.css");
  assert.ok(css.includes('html[data-theme="dark"]'), "the dark theme overrides the light tokens");
});

test("the segmented page nav matches the Major requirement bar on every page", () => {
  const css = read("styles.css");
  // The Major requirement header keeps the brand and the segmented bar sized to
  // their content by letting the trailing column absorb the free space
  // (`minmax(230px, 1fr)`). Mirror that on the shared Course/USTree topbar:
  // without a flexible track the loose space is shared between the `auto`
  // columns, which slides the bar away from the title and stretches it across
  // the row on wide displays.
  assert.ok(
    /\.topbar\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*auto\)\s+auto\s+minmax\(0,\s*1fr\)\s+auto/s.test(
      css
    ),
    "the shared topbar must keep the brand and nav content sized and let the search absorb the slack"
  );
  assert.ok(
    /\.page-nav\s*\{[^}]*justify-self:\s*start/s.test(css),
    "the page nav must stay anchored to the left instead of stretching across its column"
  );
  // The "Course / USTree / Major req." bar must never wrap its labels: without
  // nowrap, "Major req." breaks onto a second line and the shared Course/USTree
  // bar grows taller and narrower than the Major requirement bar.
  assert.ok(
    /\.page-nav a\s*\{[^}]*white-space:\s*nowrap/s.test(css),
    "the page-nav links must not wrap their labels"
  );
  // The shared topbar carries a search field on top of the catalog controls, so
  // (and export/import buttons) it needs more room than the Major topbar before
  // the nav fits on one line. Collapse it into the Major page's two-row layout
  // earlier, scoped to the shared shell so the dedicated Major header keeps its
  // own grid.
  assert.ok(
    css.includes("@media (max-width: 1300px)") && css.includes("body:not(.major-page) .page-nav"),
    "the shared topbar must collapse into the two-row layout before the nav is squeezed"
  );
  // Narrow screens stretch the bar edge to edge with evenly sized links, the
  // same treatment the Major requirement page applies to its own nav.
  assert.ok(
    /body:not\(\.major-page\)\s*\.page-nav\s*\{[^}]*width:\s*100%/s.test(css) &&
      /body:not\(\.major-page\)\s*\.page-nav a\s*\{[^}]*flex:\s*1/s.test(css),
    "the shared page nav must stretch to full width on narrow screens"
  );
});

test("the major-requirement map defines its completion controls", () => {
  const major = read("major-requirements.js");
  // These back the clickable checkbox on every course node (including the
  // "Standard sequence" node). Dropping any of them throws on load and the
  // whole map, checkbox included, stops rendering.
  for (const identifier of [
    "MOBILE_QUERY",
    "STORAGE_PREFIX"
  ]) {
    assert.ok(
      major.includes(`var ${identifier}`),
      `major-requirements.js should declare ${identifier} for its completion checkbox`
    );
  }
  assert.ok(
    major.includes("function checkboxImage"),
    "major-requirements.js should build the completion checkbox image"
  );
  assert.ok(
    major.includes("GraphInteractionSupport.hitCheckbox"),
    "the major map should hit-test its checkbox through the shared geometry"
  );
  assert.ok(
    major.includes("HKUSTTheme"),
    "the major map should read its graph colors from the shared theme"
  );
});

test("the clickable checkbox area lines up with the painted checkbox", () => {
  const support = read("graph-interactions.js");
  assert.ok(
    support.includes("var CHECKBOX_SIZE") && support.includes("var CHECKBOX_INSET"),
    "graph-interactions.js should own the single source of truth for checkbox geometry"
  );
  assert.ok(
    support.includes("function checkboxHitRect") && support.includes("function hitCheckbox"),
    "the shared geometry should expose a hit rect and a hit test"
  );
  assert.ok(
    support.includes("checkboxHitRect: checkboxHitRect") &&
      support.includes("hitCheckbox: hitCheckbox") &&
      support.includes("CHECKBOX_INSET: CHECKBOX_INSET"),
    "the shared checkbox geometry should be exported on GraphInteractionSupport"
  );
  // The painted checkbox hangs off the node's visual corner, not its padded
  // bounding-box corner, so the hit rect must be derived from rendered size.
  assert.ok(
    support.includes("renderedPosition()") && support.includes("renderedWidth()"),
    "the hit rect should be derived from the node's rendered centre and size"
  );

  for (const name of ["app.js", "major-requirements.js"]) {
    const js = read(name);
    assert.ok(
      js.includes("window.GraphInteractionSupport.hitCheckbox(node, renderedPosition)"),
      `${name} should delegate its completion hit test to the shared geometry`
    );
    assert.ok(
      js.includes('"background-offset-x": CHECKBOX_INSET') &&
        js.includes('"background-offset-y": CHECKBOX_INSET'),
      `${name} should paint the checkbox at the shared CHECKBOX_INSET`
    );
    assert.ok(
      js.includes('"background-width": CHECKBOX_SIZE') &&
        js.includes('"background-height": CHECKBOX_SIZE'),
      `${name} should paint the checkbox at the shared CHECKBOX_SIZE`
    );
  }
});

test("the graph shows the normal cursor over nodes and a pointer over checkboxes", () => {
  const support = read("graph-interactions.js");
  assert.ok(
    support.includes("function bindNodeCursor"),
    "graph-interactions.js should define a node cursor binder"
  );
  assert.ok(
    support.includes("bindNodeCursor: bindNodeCursor"),
    "the node cursor binder should be exported on GraphInteractionSupport"
  );
  // Both graph pages inherit the stage's grab cursor onto the Cytoscape canvas,
  // so each must wire the binder to override it over node content.
  for (const name of ["app.js", "major-requirements.js"]) {
    assert.ok(
      read(name).includes(
        "GraphInteractionSupport.bindNodeCursor(elements.graphStage, state.cy, completionHit)"
      ),
      `${name} should bind the node cursor for its course graph`
    );
  }
});

test("the target checkbox keeps its tick inside the box and its star on the box row", () => {
  const app = read("app.js");
  // The star/target image paints a node-sized SVG whose checkbox sits at
  // CHECKBOX_INSET, while the tick path is authored for a box at (1,1). The
  // tick must be shared and translated, or it renders up and left of the box.
  assert.ok(
    app.includes("function checkboxCheckMark(palette)"),
    "app.js should own a single tick path so every checkbox reuses it"
  );
  assert.ok(
    app.includes("completed ? checkboxCheckMark(palette) : \"\""),
    "the small checkbox should draw the shared tick"
  );
  assert.ok(
    app.includes(
      "'<g transform=\"translate(' + (CHECKBOX_INSET - 1) + ' ' + (CHECKBOX_INSET - 1) + ')\">' + checkboxCheckMark(palette) + \"</g>\""
    ),
    "targetImage should translate the shared tick onto its CHECKBOX_INSET box"
  );
  // The star polygon is authored near the top edge; nudge it down so it lines
  // up with the checkbox instead of floating above it.
  assert.ok(
    app.includes('transform="translate(0 4.5)"'),
    "the target star should be lowered onto the checkbox row"
  );
});

test("client code has no server API calls", () => {
  for (const name of ["app.js", "catalog-client.js", "major-requirements.js", "ustree.js"]) {
    assert.ok(!read(name).includes('"/api/'), `${name} still calls /api/`);
    assert.ok(!read(name).includes("'/api/"), `${name} still calls /api/`);
  }
});

test("user data is persisted in the browser", () => {
  const app = read("app.js");
  assert.ok(app.includes("localStorage"), "completions, targets, and focus use localStorage");
  for (const key of [":completed:", ":ustree:", ":focus:"]) {
    assert.ok(app.includes(key), `app.js should persist the ${key} key locally`);
  }
  assert.ok(read("ustree.js").includes("storageKey"), "USTree targets use localStorage");
  assert.ok(read("catalog-client.js").includes("indexedDB"), "the catalog is cached in IndexedDB");
});

test("USTree targets are checked against the finished courses", () => {
  const app = read("app.js");
  assert.ok(
    app.includes("function refreshRequirementStatuses"),
    "app.js should derive a prerequisite verdict for each starred target"
  );
  assert.ok(
    app.includes("support.requirementStatus(course, state.completions)"),
    "the verdict should compare the target's prerequisites to the completed set"
  );
  assert.ok(
    app.includes("applyRequirementStatuses"),
    "toggling a completion should update the target verdict in place"
  );
  const ustree = read("ustree.js");
  assert.ok(
    ustree.includes("function requirementStatus(course, completed)"),
    "ustree.js should own the prerequisite verdict logic"
  );
  assert.ok(
    ustree.includes("requirementStatus: requirementStatus"),
    "the verdict helper should be exported on USTreeSupport"
  );
  const catalog = read("catalog-client.js");
  assert.ok(
    catalog.includes("function record(code)"),
    "the catalog client should expose a synchronous record lookup for the check"
  );
  assert.ok(
    read("index.html").includes("status-key met"),
    "the USTree legend should explain the prerequisite verdict colors"
  );
});

test("completions are shared with the major-requirement page under the catalog year", () => {
  const app = read("app.js");
  const major = read("major-requirements.js");

  // Completions are keyed by catalog year. The major page only learns its year
  // when the program document resolves, so it must (re)load completions then.
  // Reading them earlier would use an empty-year key and never share state.
  const applyDataStart = major.indexOf("function applyData(data) {");
  assert.ok(applyDataStart !== -1, "major-requirements.js should define applyData");
  const applyDataBody = major.slice(applyDataStart, major.indexOf("\n  function ", applyDataStart + 1));
  const yearIndex = applyDataBody.indexOf("CATALOG_YEAR = data.catalogYear;");
  const loadIndex = applyDataBody.indexOf("loadCompletions();");
  assert.ok(
    yearIndex !== -1 && loadIndex > yearIndex,
    "the major page must load completions after learning its catalog year"
  );
  assert.ok(
    !major.slice(major.indexOf("function bootstrap()"), major.indexOf("bootstrap();")).includes("loadCompletions()"),
    "the major page must not read completions before its catalog year is known"
  );

  // Both pages listen for cross-tab storage changes to the completion key so a
  // checkbox ticked on one page is reflected on the other.
  for (const [name, js] of [["app.js", app], ["major-requirements.js", major]]) {
    assert.ok(
      js.includes('window.addEventListener("storage"') && js.includes("event.key !== completionKey()"),
      `${name} should resync completions on cross-tab storage events`
    );
  }
});

test("a toggle hides prerequisites and corequisites fulfilled by finished or starred courses", () => {
  const html = read("index.html");
  assert.ok(
    html.includes('id="hideFulfilledToggle"') && html.includes("Hide fulfilled prereqs"),
    "the shell should expose a labelled hide-fulfilled-prereqs toggle"
  );
  const app = read("app.js");
  assert.ok(
    app.includes('getElementById("hideFulfilledToggle")'),
    "app.js should bind the hide-fulfilled toggle"
  );
  assert.ok(
    app.includes("function activeGraph") &&
      app.includes("hiddenFulfilledPrereqNodes(state.graph, state.completions, planned)"),
    "app.js should render the graph pruned against the finished and starred courses"
  );
  const ustree = read("ustree.js");
  assert.ok(
    ustree.includes("function hiddenFulfilledPrereqNodes") &&
      ustree.includes("requirementRelations = { prerequisite: true, corequisite: true }"),
    "ustree.js should own the fulfilled prerequisite/corequisite pruning"
  );
  assert.ok(
    ustree.includes("hiddenFulfilledPrereqNodes: hiddenFulfilledPrereqNodes"),
    "the pruning helper should be exported on USTreeSupport"
  );
});

test("graph node background and border stay minimal and do not grow status colors", () => {
  const app = read("app.js");
  const css = read("styles.css");
  const theme = read("theme.js");

  // Border is the course department, chosen from a fixed 10-colour palette that
  // exists in both themes in the same order.
  for (let index = 0; index < 10; index += 1) {
    assert.ok(
      css.includes(`--cy-dept-${index}:`),
      `styles.css should define the --cy-dept-${index} palette slot`
    );
    assert.ok(
      theme.includes(`"dept-${index}"`),
      `theme.js should surface --cy-dept-${index} to the graph`
    );
  }
  assert.ok(
    app.includes("function deptStackAdd") &&
      app.includes("function deptStackRemove") &&
      app.includes('"dept-" + (index % DEPT_COLOR_COUNT)'),
    "app.js should keep the department palette stack's add/remove pair"
  );
  assert.ok(
    app.includes("DEPT_STACK_KEY") && app.includes("function loadDeptStack") && app.includes("function saveDeptStack"),
    "the department stack should persist across navigation and reloads"
  );
  assert.ok(
    app.includes("function compactOverflowedDepartments") &&
      app.includes("hole >= DEPT_COLOR_COUNT"),
    "a removal should pull an overflown department into a freed slot below the palette"
  );
  assert.ok(
    app.includes("syncDepartments(state.graph && state.graph.nodes") &&
      app.includes("function syncDepartments"),
    "department slots should be reconciled from the FULL graph, not the projected subset"
  );
  assert.ok(
    !app.includes("state.deptAssignments") && !app.includes("state.deptIndex"),
    "the append-only deptAssignments/deptIndex model must not come back"
  );
  assert.ok(
    app.includes('selector: "node.dept-" + index'),
    "course borders should be driven by the department class only"
  );

  // The retired channels must not creep back onto course nodes.
  assert.ok(!app.includes('"node:selected"'), "selection must not repaint a node's border");
  assert.ok(!app.includes('"node.subject-'), "subject classes must not repaint a node's border");
  for (const selector of ["is-focus", "is-dependent", "is-unresolved", "is-satisfied"]) {
    assert.ok(
      !app.includes(`"node.${selector}"`),
      `${selector} must not repaint a course node's background or border`
    );
  }
  assert.ok(
    !/"node\.is-prereq-(met|unmet|unknown|completed)"/.test(app),
    "prerequisite verdicts must not repaint a course node's background or border"
  );

  // Highlighting is click/pin only: no hover-driven repaint remains.
  assert.ok(
    !app.includes('state.cy.on("mouseover", "node"') && !app.includes('state.cy.on("mouseout", "node"'),
    "the graph must not recolor on hover; only a click pins the highlight"
  );
});
