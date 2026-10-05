import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function loadUstree() {
  const source = readFileSync(new URL("../static/ustree.js", import.meta.url), "utf8");
  const sandbox = {
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.USTreeSupport;
}

function course(code, prerequisiteExpression) {
  return {
    code,
    requirements: prerequisiteExpression
      ? {
          prerequisite: {
            relation: "prerequisite",
            raw: "",
            status: "parsed",
            warnings: [],
            expression: prerequisiteExpression
          }
        }
      : {}
  };
}

function courseNode(code) {
  return { type: "course", code };
}

function and(...items) {
  return { type: "all", items };
}

function any(...items) {
  return { type: "any", items };
}

// Minimal graph shaped like the catalog client emits it: course/detail nodes
// joined by boolean junctions, with prerequisite edges pointing child -> parent.
function courseNodeById(code) {
  return { id: `course:${code}`, type: "course", code };
}

function edge(source, target) {
  return { source, target, relation: "prerequisite" };
}

function qualifiedEdge(source, target, qualifier) {
  return { source, target, relation: "prerequisite", qualifier };
}

function coreqEdge(source, target) {
  return { source, target, relation: "corequisite", symmetric: true };
}

function graph(roots, nodes, edges) {
  return { roots, nodes, edges };
}

// The vm sandbox has its own Array realm, so copy results into this realm
// before strict deep-equality comparisons.
function hidden(support, g, completed, planned) {
  return Array.from(support.hiddenFulfilledPrereqNodes(g, completed, planned));
}

test("a target without prerequisites is always satisfied", () => {
  const support = loadUstree();
  const target = course("COMP 1991", null);
  assert.equal(support.requirementStatus(target, new Set()), "met");
  assert.equal(support.requirementStatus(target, new Set(["COMP 2011"])), "met");
});

test("a single missing prerequisite reports unmet until it is finished", () => {
  const support = loadUstree();
  const target = course("COMP 4211", courseNode("COMP 2011"));
  assert.equal(support.requirementStatus(target, new Set()), "unmet");
  assert.equal(support.requirementStatus(target, new Set(["COMP 2011"])), "met");
});

test("an AND requirement needs every course and an OR needs just one", () => {
  const support = loadUstree();
  const andTarget = course("COMP 3111", and(courseNode("COMP 2011"), courseNode("COMP 2711")));
  assert.equal(support.requirementStatus(andTarget, new Set(["COMP 2011"])), "unmet");
  assert.equal(
    support.requirementStatus(andTarget, new Set(["COMP 2011", "COMP 2711"])),
    "met"
  );

  const orTarget = course("COMP 4212", any(courseNode("COMP 2711"), courseNode("MATH 2111")));
  assert.equal(support.requirementStatus(orTarget, new Set()), "unmet");
  assert.equal(support.requirementStatus(orTarget, new Set(["MATH 2111"])), "met");
});

test("prose conditions keep a mixed requirement unclear instead of lying", () => {
  const support = loadUstree();
  const target = course(
    "COMP 4911",
    and(courseNode("COMP 3111"), { type: "condition", text: "permission of instructor" })
  );
  assert.equal(support.requirementStatus(target, new Set(["COMP 3111"])), "unknown");
  assert.equal(support.requirementStatus(target, new Set()), "unmet");
});

test("a course-pattern prerequisite matches completed courses by subject and level", () => {
  const support = loadUstree();
  const target = course("COMP 4900", {
    type: "coursePattern",
    subject: "COMP",
    minimumLevel: 3,
    text: "any COMP course of 3000-level or above"
  });
  assert.equal(support.requirementStatus(target, new Set(["COMP 2011"])), "unmet");
  assert.equal(support.requirementStatus(target, new Set(["COMP 3021"])), "met");
  assert.equal(support.requirementStatus(target, new Set(["MATH 3321"])), "unmet");
});

test("a finished target reports completed and carries a human label", () => {
  const support = loadUstree();
  const target = course("COMP 4211", courseNode("COMP 2011"));
  assert.equal(support.requirementStatus(target, new Set(["COMP 4211"])), "completed");
  assert.equal(support.requirementStatusLabel("completed"), "Completed");
  assert.equal(support.requirementStatusLabel("unmet"), "Prereqs not met");
  assert.equal(support.requirementStatusMarker("met"), "\u2713");
  assert.equal(support.requirementStatusMarker("unmet"), "\u2717");
});

test("hiding fulfilled prereqs drops an OR alternative covered by a finished course", () => {
  const support = loadUstree();
  // COMP 2211 requires COMP 1023 OR COMP 1028.
  const orGraph = graph(
    ["COMP 2211"],
    [
      courseNodeById("COMP 2211"),
      { id: "bool:COMP 2211:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1028")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 2211:prerequisite:0"),
      edge("course:COMP 1028", "bool:COMP 2211:prerequisite:0"),
      edge("bool:COMP 2211:prerequisite:0", "course:COMP 2211")
    ]
  );
  assert.deepEqual(hidden(support, orGraph, new Set()), []);
  assert.deepEqual(
    hidden(support, orGraph, new Set(["COMP 1023"])),
    ["course:COMP 1028"]
  );
  assert.deepEqual(
    hidden(support, orGraph, new Set(["COMP 1028"])),
    ["course:COMP 1023"]
  );
  // Both alternatives finished: nothing is redundant.
  assert.deepEqual(
    hidden(support, orGraph, new Set(["COMP 1023", "COMP 1028"])),
    []
  );
});

test("a starred/in-plan course counts as complete when hiding prereqs", () => {
  const support = loadUstree();
  // COMP 2211 requires COMP 1023 OR COMP 1028.
  const orGraph = graph(
    ["COMP 2211", "COMP 1023"],
    [
      courseNodeById("COMP 2211"),
      { id: "bool:COMP 2211:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1028")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 2211:prerequisite:0"),
      edge("course:COMP 1028", "bool:COMP 2211:prerequisite:0"),
      edge("bool:COMP 2211:prerequisite:0", "course:COMP 2211")
    ]
  );
  // Nothing is finished, but COMP 1023 is starred (in-plan), so the unused
  // COMP 1028 alternative is redundant. The planned course itself stays.
  assert.deepEqual(
    hidden(support, orGraph, new Set(), ["COMP 1023"]),
    ["course:COMP 1028"]
  );
  // A planned-and-finished course behaves the same as a finished one.
  assert.deepEqual(
    hidden(support, orGraph, new Set(["COMP 1023"]), ["COMP 1023"]),
    ["course:COMP 1028"]
  );
  // A grade-qualified branch is credited too: hiding follows the same verdict
  // as the target status, which ignores the "Grade A or above" note (the view
  // cannot read transcripts).
  const qualified = graph(
    ["COMP 2012H", "COMP 1023"],
    [
      courseNodeById("COMP 2012H"),
      { id: "bool:COMP 2012H:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1028")
    ],
    [
      qualifiedEdge("course:COMP 1023", "bool:COMP 2012H:prerequisite:0", "Grade A or above"),
      edge("course:COMP 1028", "bool:COMP 2012H:prerequisite:0"),
      edge("bool:COMP 2012H:prerequisite:0", "course:COMP 2012H")
    ]
  );
  assert.deepEqual(
    hidden(support, qualified, new Set(), ["COMP 1023"]),
    ["course:COMP 1028"]
  );
});

test("hiding fulfilled corequisites drops an OR alternative", () => {
  const support = loadUstree();
  // CENG 2210 coreq: CHEM 1008 OR CHEM 1012.
  const coreqGraph = graph(
    ["CENG 2210"],
    [
      courseNodeById("CENG 2210"),
      { id: "bool:CENG 2210:corequisite:0", type: "any", relation: "corequisite" },
      courseNodeById("CHEM 1008"),
      courseNodeById("CHEM 1012")
    ],
    [
      coreqEdge("course:CHEM 1008", "bool:CENG 2210:corequisite:0"),
      coreqEdge("course:CHEM 1012", "bool:CENG 2210:corequisite:0"),
      coreqEdge("bool:CENG 2210:corequisite:0", "course:CENG 2210")
    ]
  );
  assert.deepEqual(hidden(support, coreqGraph, new Set()), []);
  assert.deepEqual(
    hidden(support, coreqGraph, new Set(["CHEM 1008"])),
    ["course:CHEM 1012"]
  );
  // A starred/in-plan corequisite counts the same as a finished one.
  assert.deepEqual(
    hidden(support, coreqGraph, new Set(), ["CHEM 1008"]),
    ["course:CHEM 1012"]
  );
  // Both alternatives finished: nothing is redundant.
  assert.deepEqual(
    hidden(support, coreqGraph, new Set(["CHEM 1008", "CHEM 1012"])),
    []
  );
});

test("an AND corequisite only prunes once every member is finished", () => {
  const support = loadUstree();
  // CHEM 2550 coreq: CHEM 2110 AND CHEM 2210.
  const andGraph = graph(
    ["CHEM 2550"],
    [
      courseNodeById("CHEM 2550"),
      { id: "bool:CHEM 2550:corequisite:0", type: "all", relation: "corequisite" },
      courseNodeById("CHEM 2110"),
      courseNodeById("CHEM 2210")
    ],
    [
      coreqEdge("course:CHEM 2110", "bool:CHEM 2550:corequisite:0"),
      coreqEdge("course:CHEM 2210", "bool:CHEM 2550:corequisite:0"),
      coreqEdge("bool:CHEM 2550:corequisite:0", "course:CHEM 2550")
    ]
  );
  assert.deepEqual(hidden(support, andGraph, new Set(["CHEM 2110"])), []);
  assert.deepEqual(
    hidden(support, andGraph, new Set(["CHEM 2110", "CHEM 2210"])),
    []
  );
});

test("a satisfied prerequisite never hides an unmet corequisite", () => {
  const support = loadUstree();
  // COMP 9999 requires COMP 1000, and its corequisite COMP 2000 is unmet.
  // The two relations are independent: finishing COMP 1000 must not drop the
  // corequisite branch just because it is a second top-level edge.
  const mixed = graph(
    ["COMP 9999"],
    [
      courseNodeById("COMP 9999"),
      courseNodeById("COMP 1000"),
      courseNodeById("COMP 2000")
    ],
    [
      edge("course:COMP 1000", "course:COMP 9999"),
      coreqEdge("course:COMP 2000", "course:COMP 9999")
    ]
  );
  assert.deepEqual(hidden(support, mixed, new Set(["COMP 1000"])), []);
  // The corequisite is only hidden once it is itself fulfilled by an
  // alternative -- here there is no alternative to drop, so nothing hides.
  assert.deepEqual(
    hidden(support, mixed, new Set(["COMP 1000", "COMP 2000"])),
    []
  );
});

test("hiding a fulfilled branch also drops prerequisites shown only because of it", () => {
  const support = loadUstree();
  // COMP 2211 requires 1023 OR 1028, and 1028 requires 1021.
  const nested = graph(
    ["COMP 2211"],
    [
      courseNodeById("COMP 2211"),
      { id: "bool:COMP 2211:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1028"),
      courseNodeById("COMP 1021")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 2211:prerequisite:0"),
      edge("course:COMP 1028", "bool:COMP 2211:prerequisite:0"),
      edge("course:COMP 1021", "course:COMP 1028"),
      edge("bool:COMP 2211:prerequisite:0", "course:COMP 2211")
    ]
  );
  assert.deepEqual(
    hidden(support, nested, new Set(["COMP 1023"])),
    ["course:COMP 1021", "course:COMP 1028"]
  );
});

test("a course another visible target still needs is never hidden", () => {
  const support = loadUstree();
  // COMP 2211 requires 1023 OR 1028, and COMP 3031 requires 1028 (unmet).
  const shared = graph(
    ["COMP 2211", "COMP 3031"],
    [
      courseNodeById("COMP 2211"),
      { id: "bool:COMP 2211:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1028"),
      courseNodeById("COMP 3031")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 2211:prerequisite:0"),
      edge("course:COMP 1028", "bool:COMP 2211:prerequisite:0"),
      edge("bool:COMP 2211:prerequisite:0", "course:COMP 2211"),
      edge("course:COMP 1028", "course:COMP 3031")
    ]
  );
  assert.deepEqual(hidden(support, shared, new Set(["COMP 1023"])), []);
});

test("an AND requirement only prunes once every member is finished", () => {
  const support = loadUstree();
  const andGraph = graph(
    ["COMP 3111"],
    [
      courseNodeById("COMP 3111"),
      { id: "bool:COMP 3111:prerequisite:0", type: "all" },
      courseNodeById("COMP 2011"),
      courseNodeById("COMP 2711")
    ],
    [
      edge("course:COMP 2011", "bool:COMP 3111:prerequisite:0"),
      edge("course:COMP 2711", "bool:COMP 3111:prerequisite:0"),
      edge("bool:COMP 3111:prerequisite:0", "course:COMP 3111")
    ]
  );
  assert.deepEqual(hidden(support, andGraph, new Set(["COMP 2011"])), []);
  assert.deepEqual(
    hidden(support, andGraph, new Set(["COMP 2011", "COMP 2711"])),
    []
  );
});

test("a dropped OR branch keeps only the finished courses it contains", () => {
  const support = loadUstree();
  // COMP 2211 requires 1023 OR (1028 AND 1208); 1023 and 1028 are finished.
  const mixed = graph(
    ["COMP 2211"],
    [
      courseNodeById("COMP 2211"),
      { id: "bool:COMP 2211:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      { id: "bool:COMP 2211:prerequisite:0.1", type: "all" },
      courseNodeById("COMP 1028"),
      courseNodeById("COMP 1208")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 2211:prerequisite:0"),
      edge("bool:COMP 2211:prerequisite:0.1", "bool:COMP 2211:prerequisite:0"),
      edge("course:COMP 1028", "bool:COMP 2211:prerequisite:0.1"),
      edge("course:COMP 1208", "bool:COMP 2211:prerequisite:0.1"),
      edge("bool:COMP 2211:prerequisite:0", "course:COMP 2211")
    ]
  );
  // The dropped AND branch still holds the finished COMP 1028, so that course
  // and the junction above it stay -- but the unfinished COMP 1208 that was
  // only introduced by the redundant branch is dropped.
  assert.deepEqual(
    hidden(support, mixed, new Set(["COMP 1023", "COMP 1028"])),
    ["course:COMP 1208"]
  );
  // With only COMP 1023 finished the whole unused branch is redundant.
  assert.deepEqual(
    hidden(support, mixed, new Set(["COMP 1023"])),
    ["bool:COMP 2211:prerequisite:0.1", "course:COMP 1028", "course:COMP 1208"]
  );
});

test("a redundant branch kept for a finished course does not revive its other alternatives", () => {
  const support = loadUstree();
  // COMP 4211 needs COMP 9000 OR COMP 9001, and COMP 9000 is finished. COMP
  // 9001's prerequisite is "(Grade A or above in COMP 1010) OR COMP 1011 OR
  // COMP 1012", with COMP 1010 finished and COMP 1012 requiring COMP 1013.
  // Keeping COMP 9001's branch only for the finished COMP 1010 must not drag
  // the unused COMP 1011/COMP 1012/COMP 1013 back into the tree (the real
  // MATH 2431 leak, where the finished MATH 1014 kept MATH 1020/MATH 1024).
  const leaked = graph(
    ["COMP 4211"],
    [
      courseNodeById("COMP 4211"),
      { id: "bool:COMP 4211:prerequisite:0", type: "any" },
      courseNodeById("COMP 9000"),
      courseNodeById("COMP 9001"),
      { id: "bool:COMP 9001:prerequisite:0", type: "any" },
      courseNodeById("COMP 1010"),
      courseNodeById("COMP 1011"),
      courseNodeById("COMP 1012"),
      courseNodeById("COMP 1013")
    ],
    [
      edge("course:COMP 9000", "bool:COMP 4211:prerequisite:0"),
      edge("course:COMP 9001", "bool:COMP 4211:prerequisite:0"),
      edge("bool:COMP 4211:prerequisite:0", "course:COMP 4211"),
      qualifiedEdge("course:COMP 1010", "bool:COMP 9001:prerequisite:0", "Grade A or above"),
      edge("course:COMP 1011", "bool:COMP 9001:prerequisite:0"),
      edge("course:COMP 1012", "bool:COMP 9001:prerequisite:0"),
      edge("bool:COMP 9001:prerequisite:0", "course:COMP 9001"),
      edge("course:COMP 1013", "course:COMP 1012")
    ]
  );
  assert.deepEqual(
    hidden(support, leaked, new Set(["COMP 9000", "COMP 1010"])),
    [
      "course:COMP 1011",
      "course:COMP 1012",
      "course:COMP 1013",
      "course:COMP 9001"
    ]
  );
});

test("a target that is a redundant alternative is still never hidden", () => {
  const support = loadUstree();
  // Target COMP 4211 requires COMP 4212 OR COMP 4911; COMP 4911 is finished.
  const targets = graph(
    ["COMP 4211", "COMP 4212"],
    [
      courseNodeById("COMP 4211"),
      { id: "bool:COMP 4211:prerequisite:0", type: "any" },
      courseNodeById("COMP 4212"),
      courseNodeById("COMP 4911")
    ],
    [
      edge("course:COMP 4212", "bool:COMP 4211:prerequisite:0"),
      edge("course:COMP 4911", "bool:COMP 4211:prerequisite:0"),
      edge("bool:COMP 4211:prerequisite:0", "course:COMP 4211")
    ]
  );
  assert.deepEqual(hidden(support, targets, new Set(["COMP 4911"])), []);
});

test("a dependent reached through a boolean junction still drives pruning", () => {
  const support = loadUstree();
  // Root COMP 1023 has no prerequisite of its own. COMP 2211 is a dependent:
  // it needs COMP 1023 OR COMP 1028. Finishing COMP 1023 should hide COMP 1028
  // even though the dependency sits behind an OR junction.
  const dependent = graph(
    ["COMP 1023"],
    [
      courseNodeById("COMP 1023"),
      { id: "bool:COMP 2211:prerequisite:0", type: "any" },
      courseNodeById("COMP 2211"),
      courseNodeById("COMP 1028")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 2211:prerequisite:0"),
      edge("course:COMP 1028", "bool:COMP 2211:prerequisite:0"),
      edge("bool:COMP 2211:prerequisite:0", "course:COMP 2211")
    ]
  );
  assert.deepEqual(
    hidden(support, dependent, new Set(["COMP 1023"])),
    ["course:COMP 1028"]
  );
  // Without the finishing course nothing is redundant.
  assert.deepEqual(hidden(support, dependent, new Set()), []);
});

test("an unmet requirement still prunes a satisfied alternative nested inside it", () => {
  const support = loadUstree();
  // ELEC 2600-style shape: root COMP 1023 is a prerequisite of COMP 9000, but
  // COMP 9000 also needs COMP 8888, so its top-level AND stays unmet. The
  // middle OR (COMP 1021 OR COMP 1022 OR COMP 1024) is satisfied by COMP 1021,
  // so its unused alternatives must still be hidden even though an ancestor is
  // unmet. This mirrors MATH 4427 keeping MATH 2023/MATH 2024 because it also
  // needs a missing course.
  const dependent = graph(
    ["COMP 1023"],
    [
      courseNodeById("COMP 1023"),
      { id: "bool:COMP 9000:prerequisite:0", type: "all" },
      { id: "bool:COMP 9000:prerequisite:0.0", type: "any" },
      courseNodeById("COMP 9999"),
      { id: "bool:COMP 9000:prerequisite:0.1", type: "any" },
      courseNodeById("COMP 1021"),
      courseNodeById("COMP 1022"),
      courseNodeById("COMP 1024"),
      courseNodeById("COMP 8888"),
      courseNodeById("COMP 9000")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 9000:prerequisite:0.0"),
      edge("course:COMP 9999", "bool:COMP 9000:prerequisite:0.0"),
      edge("bool:COMP 9000:prerequisite:0.0", "bool:COMP 9000:prerequisite:0"),
      edge("course:COMP 1021", "bool:COMP 9000:prerequisite:0.1"),
      edge("course:COMP 1022", "bool:COMP 9000:prerequisite:0.1"),
      edge("course:COMP 1024", "bool:COMP 9000:prerequisite:0.1"),
      edge("bool:COMP 9000:prerequisite:0.1", "bool:COMP 9000:prerequisite:0"),
      edge("course:COMP 8888", "bool:COMP 9000:prerequisite:0"),
      edge("bool:COMP 9000:prerequisite:0", "course:COMP 9000")
    ]
  );
  assert.deepEqual(
    hidden(support, dependent, new Set(["COMP 1021"])),
    ["course:COMP 1022", "course:COMP 1024"]
  );

  // A redundant alternative another visible target still needs is protected.
  const shared = graph(
    ["COMP 1023", "COMP 3031"],
    [
      courseNodeById("COMP 1023"),
      { id: "bool:COMP 9000:prerequisite:0", type: "all" },
      { id: "bool:COMP 9000:prerequisite:0.0", type: "any" },
      courseNodeById("COMP 9999"),
      { id: "bool:COMP 9000:prerequisite:0.1", type: "any" },
      courseNodeById("COMP 1021"),
      courseNodeById("COMP 1022"),
      courseNodeById("COMP 8888"),
      courseNodeById("COMP 9000"),
      courseNodeById("COMP 3031")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 9000:prerequisite:0.0"),
      edge("course:COMP 9999", "bool:COMP 9000:prerequisite:0.0"),
      edge("bool:COMP 9000:prerequisite:0.0", "bool:COMP 9000:prerequisite:0"),
      edge("course:COMP 1021", "bool:COMP 9000:prerequisite:0.1"),
      edge("course:COMP 1022", "bool:COMP 9000:prerequisite:0.1"),
      edge("bool:COMP 9000:prerequisite:0.1", "bool:COMP 9000:prerequisite:0"),
      edge("course:COMP 8888", "bool:COMP 9000:prerequisite:0"),
      edge("bool:COMP 9000:prerequisite:0", "course:COMP 9000"),
      edge("course:COMP 1022", "course:COMP 3031")
    ]
  );
  assert.deepEqual(hidden(support, shared, new Set(["COMP 1021"])), []);
});

test("a backward-only pathway does not revive a branch just because it depends on a target", () => {
  const support = loadUstree();
  // Real USTree leak: target MATH 2011 is a corequisite of MATH 2421, and
  // COMP 4211 (another target) can be met by ELEC 2600 OR MATH 2421. Once
  // ELEC 2600 is credited, MATH 2421 is a redundant alternative for COMP 4211
  // and must be hidden. MATH 2421 merely *depending* on the MATH 2011 target
  // must not drag it back in: a backward-only graph is evaluated top-down from
  // its targets, so the forward/dependent walk never seeds MATH 2421.
  const backward = Object.assign(graph(
    ["COMP 4211", "MATH 2011"],
    [
      courseNodeById("COMP 4211"),
      { id: "bool:COMP 4211:prerequisite:0", type: "any" },
      courseNodeById("ELEC 2600"),
      courseNodeById("MATH 2421"),
      { id: "bool:MATH 2421:corequisite:0", type: "any" },
      courseNodeById("MATH 2011")
    ],
    [
      edge("course:ELEC 2600", "bool:COMP 4211:prerequisite:0"),
      edge("course:MATH 2421", "bool:COMP 4211:prerequisite:0"),
      edge("bool:COMP 4211:prerequisite:0", "course:COMP 4211"),
      coreqEdge("course:MATH 2011", "bool:MATH 2421:corequisite:0"),
      coreqEdge("bool:MATH 2421:corequisite:0", "course:MATH 2421")
    ]
  ), { direction: "backward" });
  assert.deepEqual(
    hidden(support, backward, new Set(), ["ELEC 2600", "MATH 2011"]),
    ["course:MATH 2421"]
  );
});

test("a grade-qualified branch collapses once its course is credited", () => {
  const support = loadUstree();
  // COMP 2012H can be met by "Grade A or above in COMP 1023" OR COMP 1028.
  // Hiding follows the target verdict, which treats the finished COMP 1023 as
  // settling the branch (grades cannot be read from completions).
  const qualified = graph(
    ["COMP 2012H"],
    [
      courseNodeById("COMP 2012H"),
      { id: "bool:COMP 2012H:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1028")
    ],
    [
      qualifiedEdge("course:COMP 1023", "bool:COMP 2012H:prerequisite:0", "Grade A or above"),
      edge("course:COMP 1028", "bool:COMP 2012H:prerequisite:0"),
      edge("bool:COMP 2012H:prerequisite:0", "course:COMP 2012H")
    ]
  );
  assert.deepEqual(
    hidden(support, qualified, new Set(["COMP 1023"])),
    ["course:COMP 1028"]
  );

  // The same shape without the qualifier prunes the alternative.
  const unqualified = graph(
    ["COMP 2012H"],
    [
      courseNodeById("COMP 2012H"),
      { id: "bool:COMP 2012H:prerequisite:0", type: "any" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1028")
    ],
    [
      edge("course:COMP 1023", "bool:COMP 2012H:prerequisite:0"),
      edge("course:COMP 1028", "bool:COMP 2012H:prerequisite:0"),
      edge("bool:COMP 2012H:prerequisite:0", "course:COMP 2012H")
    ]
  );
  assert.deepEqual(
    hidden(support, unqualified, new Set(["COMP 1023"])),
    ["course:COMP 1028"]
  );
});

test("the real COMP 2012H shape drops its grade-qualified second route", () => {
  const support = loadUstree();
  // COMP 2012H: "(Grade A or above in COMP 1023) OR (Grade A or above in
  // COMP 1021 AND Pass grade in COMP 1028)". With COMP 1023 and COMP 1021
  // credited, the first route settles the requirement, so the whole second
  // route -- the AND junction and COMP 1028 -- is hidden.
  const comp2012h = graph(
    ["COMP 2012H"],
    [
      courseNodeById("COMP 2012H"),
      { id: "bool:COMP 2012H:prerequisite:0", type: "any" },
      { id: "bool:COMP 2012H:prerequisite:0.1", type: "all" },
      courseNodeById("COMP 1023"),
      courseNodeById("COMP 1021"),
      courseNodeById("COMP 1028")
    ],
    [
      qualifiedEdge("course:COMP 1023", "bool:COMP 2012H:prerequisite:0", "Grade A or above"),
      edge("bool:COMP 2012H:prerequisite:0.1", "bool:COMP 2012H:prerequisite:0"),
      qualifiedEdge("course:COMP 1021", "bool:COMP 2012H:prerequisite:0.1", "Grade A or above"),
      qualifiedEdge("course:COMP 1028", "bool:COMP 2012H:prerequisite:0.1", "Pass grade"),
      edge("bool:COMP 2012H:prerequisite:0", "course:COMP 2012H")
    ]
  );
  assert.deepEqual(
    hidden(support, comp2012h, new Set(["COMP 1023", "COMP 1021"])),
    ["course:COMP 1028"]
  );
});
