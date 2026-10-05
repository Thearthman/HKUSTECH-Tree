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
