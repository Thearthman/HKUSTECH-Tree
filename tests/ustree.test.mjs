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
  // A grade-qualified alternative is not proven by a mere star.
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
  assert.deepEqual(hidden(support, qualified, new Set(), ["COMP 1023"]), []);
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

test("a dropped OR branch keeps any finished course it contains", () => {
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
  // The dropped AND branch still holds the finished COMP 1028, so it stays.
  assert.deepEqual(
    hidden(support, mixed, new Set(["COMP 1023", "COMP 1028"])),
    []
  );
  // With only COMP 1023 finished the whole unused branch is redundant.
  assert.deepEqual(
    hidden(support, mixed, new Set(["COMP 1023"])),
    ["bool:COMP 2211:prerequisite:0.1", "course:COMP 1028", "course:COMP 1208"]
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

test("a grade-qualified branch survives a bare completion", () => {
  const support = loadUstree();
  // COMP 2012H can be met by "Grade A or above in COMP 1023" OR COMP 1028.
  // A finished COMP 1023 does not prove the grade, so the alternative stays.
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
  assert.deepEqual(hidden(support, qualified, new Set(["COMP 1023"])), []);

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
