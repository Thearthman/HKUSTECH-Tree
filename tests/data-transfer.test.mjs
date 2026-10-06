import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    get length() {
      return data.size;
    },
    key(index) {
      return Array.from(data.keys())[index] ?? null;
    },
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    }
  };
}

function loadTransfer() {
  const source = readFileSync(new URL("../static/data-transfer.js", import.meta.url), "utf8");
  const sandbox = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.HKUSTDataTransfer;
}

// Minimal stand-ins for the DOM pieces the double-confirmation reset touches.
function fakeButton(id) {
  const listeners = { click: [] };
  const classes = new Set();
  const label = { textContent: "" };
  return {
    id,
    hidden: false,
    disabled: false,
    title: "",
    textContent: "",
    labelNode: label,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    setAttribute() {},
    removeAttribute() {},
    querySelector(selector) {
      return selector === ".data-transfer-label" ? label : null;
    },
    addEventListener(type, handler) {
      (listeners[type] = listeners[type] || []).push(handler);
    },
    click() {
      (listeners.click || []).forEach((handler) => handler());
    }
  };
}

test("collect snapshots USTree targets, completed courses and the selected major", () => {
  const transfer = loadTransfer();
  const storage = fakeStorage({
    "hkust-course-tree:ustree:2026-27": JSON.stringify(["COMP 2211", "comp1023"]),
    "hkust-course-tree:completed:2026-27": JSON.stringify(["COMP 1023", "MATH 1013"]),
    "hkust-course-tree:focus:2026-27": "COMP 2211",
    "hkust-course-tree:major": JSON.stringify({ id: "CPEG-2025-26", programCode: "CPEG", intake: "2025-26", catalogYear: "2026-27" }),
    "hkust-course-tree:hide-fulfilled-prereq": "0",
    "hkust-course-tree:theme": "dark",
    "unrelated-key": "ignored"
  });

  const payload = transfer.collect(storage);
  assert.equal(payload.format, "hkust-course-tree");
  // The vm sandbox has its own Array realm, so copy into this realm first.
  assert.deepEqual(Array.from(payload.years["2026-27"].targets), ["COMP 1023", "COMP 2211"]);
  assert.deepEqual(Array.from(payload.years["2026-27"].completed), ["COMP 1023", "MATH 1013"]);
  assert.equal(payload.years["2026-27"].focus, "COMP 2211");
  assert.equal(payload.major.id, "CPEG-2025-26");
  assert.equal(payload.preferences.hideFulfilledPrereq, false);
  assert.equal(payload.preferences.theme, "dark");
  assert.ok(!("unrelated-key" in payload));
});

test("collect reads the legacy single-target key when no USTree list exists", () => {
  const transfer = loadTransfer();
  const storage = fakeStorage({ "hkust-course-tree:target:2026-27": "COMP 2012" });
  const payload = transfer.collect(storage);
  assert.deepEqual(Array.from(payload.years["2026-27"].targets), ["COMP 2012"]);
});

test("an export round-trips into a fresh browser", () => {
  const transfer = loadTransfer();
  const source = fakeStorage({
    "hkust-course-tree:ustree:2026-27": JSON.stringify(["COMP 2211", "COMP 2012"]),
    "hkust-course-tree:completed:2026-27": JSON.stringify(["COMP 1023"]),
    "hkust-course-tree:focus:2026-27": "COMP 2211",
    "hkust-course-tree:major": JSON.stringify({ id: "COMP-2025-26", programCode: "COMP", intake: "2025-26", catalogYear: "2026-27" }),
    "hkust-course-tree:theme": "dark"
  });

  const text = transfer.serialize(transfer.collect(source));
  const target = fakeStorage();
  const summary = transfer.apply(target, transfer.parse(text), { year: "2026-27" });

  assert.deepEqual(JSON.parse(target.getItem("hkust-course-tree:ustree:2026-27")), ["COMP 2012", "COMP 2211"]);
  assert.deepEqual(JSON.parse(target.getItem("hkust-course-tree:completed:2026-27")), ["COMP 1023"]);
  assert.equal(target.getItem("hkust-course-tree:focus:2026-27"), "COMP 2211");
  assert.equal(transfer.loadSelectedMajor(target).id, "COMP-2025-26");
  assert.equal(target.getItem("hkust-course-tree:theme"), "dark");
  assert.equal(summary.targetsAdded, 2);
  assert.equal(summary.completedAdded, 1);
  assert.ok(summary.major);
});

test("import merges with existing data instead of dropping it", () => {
  const transfer = loadTransfer();
  const storage = fakeStorage({
    "hkust-course-tree:ustree:2026-27": JSON.stringify(["COMP 1023"]),
    "hkust-course-tree:completed:2026-27": JSON.stringify(["MATH 1013"])
  });
  const payload = {
    format: "hkust-course-tree",
    version: 1,
    years: { "2026-27": { targets: ["COMP 2211"], completed: ["COMP 1023"] } }
  };

  const summary = transfer.apply(storage, payload, { year: "2026-27" });
  assert.deepEqual(JSON.parse(storage.getItem("hkust-course-tree:ustree:2026-27")), ["COMP 1023", "COMP 2211"]);
  assert.deepEqual(JSON.parse(storage.getItem("hkust-course-tree:completed:2026-27")), ["COMP 1023", "MATH 1013"]);
  assert.equal(summary.targetsAdded, 1, "only the new target counts as added");
  assert.equal(summary.completedAdded, 1, "only the new completion counts as added");
  assert.equal(summary.targets, 2, "the reported total keeps the pre-existing target");
});

test("a legacy flat file lands on the caller's catalog year", () => {
  const transfer = loadTransfer();
  const storage = fakeStorage();
  const payload = transfer.parse(JSON.stringify({ targets: ["COMP 2211"], completed: ["COMP 1023"] }));
  transfer.apply(storage, payload, { year: "2026-27" });
  assert.deepEqual(JSON.parse(storage.getItem("hkust-course-tree:ustree:2026-27")), ["COMP 2211"]);
  assert.deepEqual(JSON.parse(storage.getItem("hkust-course-tree:completed:2026-27")), ["COMP 1023"]);
});

test("import rejects malformed files and foreign exports", () => {
  const transfer = loadTransfer();
  assert.throws(() => transfer.parse("not json"), /not valid JSON/);
  assert.throws(() => transfer.parse("[1, 2, 3]"), /does not look like/);
  assert.throws(
    () => transfer.parse(JSON.stringify({ format: "some-other-app", years: { "2026-27": {} } })),
    /not HKUST Course Tree/
  );
  assert.throws(() => transfer.parse(JSON.stringify({ unrelated: true })), /does not contain/);
  // A valid but empty snapshot imports as a no-op rather than erroring.
  const empty = transfer.parse(JSON.stringify(transfer.collect(fakeStorage())));
  assert.deepEqual(Array.from(Object.keys(empty.years)), []);
});

test("the selected major persists between save and load", () => {
  const transfer = loadTransfer();
  const storage = fakeStorage();
  transfer.saveSelectedMajor(storage, { id: "CPEG-2025-26", programCode: "CPEG", intake: "2025-26", catalogYear: "2026-27" });
  const stored = transfer.loadSelectedMajor(storage);
  assert.equal(stored.id, "CPEG-2025-26");
  assert.equal(stored.programCode, "CPEG");
  assert.equal(transfer.saveSelectedMajor(storage, "COMP-2025-26").id, "COMP-2025-26");
  assert.equal(transfer.loadSelectedMajor(storage).id, "COMP-2025-26");
});

test("clearAll erases every owned key and leaves unrelated storage alone", async () => {
  const transfer = loadTransfer();
  const storage = fakeStorage({
    "hkust-course-tree:ustree:2026-27": JSON.stringify(["COMP 2211"]),
    "hkust-course-tree:completed:2026-27": JSON.stringify(["COMP 1023"]),
    "hkust-course-tree:focus:2026-27": "COMP 2211",
    "hkust-course-tree:major": JSON.stringify({ id: "CPEG-2025-26" }),
    "hkust-course-tree:hide-fulfilled-prereq": "0",
    "hkust-course-tree:theme": "dark",
    "hkust-course-tree:dept-stack": JSON.stringify(["COMP", null, "MATH"]),
    "unrelated-key": "keep me"
  });

  const result = await transfer.clearAll(storage);
  assert.equal(storage.getItem("hkust-course-tree:ustree:2026-27"), null);
  assert.equal(storage.getItem("hkust-course-tree:major"), null);
  assert.equal(storage.getItem("hkust-course-tree:theme"), null);
  assert.equal(
    storage.getItem("hkust-course-tree:dept-stack"),
    null,
    "reset is the only thing allowed to clear the department stack"
  );
  assert.equal(storage.getItem("unrelated-key"), "keep me", "keys we do not own are untouched");
  assert.deepEqual(
    Array.from(result.keys).sort(),
    [
      "hkust-course-tree:completed:2026-27",
      "hkust-course-tree:dept-stack",
      "hkust-course-tree:focus:2026-27",
      "hkust-course-tree:hide-fulfilled-prereq",
      "hkust-course-tree:major",
      "hkust-course-tree:theme",
      "hkust-course-tree:ustree:2026-27"
    ],
    "clearAll reports exactly the keys it removed"
  );
  assert.equal(result.databaseDeleted, false, "no IndexedDB in this sandbox");
});

test("the reset control needs a second click before it erases anything", async () => {
  const source = readFileSync(new URL("../static/data-transfer.js", import.meta.url), "utf8");
  const storage = fakeStorage({
    "hkust-course-tree:ustree:2026-27": JSON.stringify(["COMP 2211"]),
    "hkust-course-tree:completed:2026-27": JSON.stringify(["COMP 1023"])
  });
  const resetButton = fakeButton("resetData");
  const cancelButton = fakeButton("resetDataCancel");
  const elements = { resetData: resetButton, resetDataCancel: cancelButton };
  const sandbox = {
    document: { getElementById: (id) => elements[id] || null },
    // Deterministic, non-lingering timers so arming never keeps the test alive.
    setTimeout: () => 1,
    clearTimeout: () => {}
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.HKUSTDataTransfer.bind({ storage });

  // First click arms the button only.
  resetButton.click();
  assert.equal(resetButton.labelNode.textContent, "Confirm reset");
  assert.ok(resetButton.classList.contains("is-armed"));
  assert.equal(cancelButton.hidden, false);
  assert.equal(storage.getItem("hkust-course-tree:ustree:2026-27") !== null, true, "the first click must not erase");

  // Cancel backs out without deleting.
  cancelButton.click();
  assert.equal(resetButton.classList.contains("is-armed"), false);
  assert.equal(storage.getItem("hkust-course-tree:completed:2026-27") !== null, true);

  // Arm again and confirm: the second click is the one that erases.
  resetButton.click();
  resetButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(storage.getItem("hkust-course-tree:ustree:2026-27"), null);
  assert.equal(storage.getItem("hkust-course-tree:completed:2026-27"), null);
});
