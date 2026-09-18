import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hidePrompt, loadHiddenPrompts } from "../extensions/history/hide-prompts.ts";
import { promptDedupKey } from "../extensions/history/selector-helpers.ts";

// Unit WU4 — tombstone write half + read half (spec C4, design §D6). fs-only
// coverage. The dev suite's deleteCurrent source-parse pins (T27/T28) and
// the deletionActionsFor planner pins cover the slice-3 selector branch and
// the slice-5 delete flow; they port with those slices.

function makeStateDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hide-prompts-${name}-`));
}

function readHideFile(stateDir: string) {
  return JSON.parse(
    fs.readFileSync(path.join(stateDir, "hidden.json"), "utf8"),
  );
}

// T24 — AC-S4-1: hide-key fidelity. Tombstone keys must byte-match the
// Change 2 dedup key for the same text — same imported helper, never a
// re-implementation: the stored file content is compared against
// promptDedupKey's own output with strict equality.
test("T24 (AC-S4-1): hide keys byte-match promptDedupKey across whitespace, case, and >120-char groups", () => {
  const stateDir = makeStateDir("t24");
  // Three normalization groups: internal whitespace runs (space + tab),
  // letter case, and a text longer than the 120-char key prefix.
  const texts = [
    "fix\t the   build",
    "Deploy THE api",
    `${"pad ".repeat(40)}tail beyond one hundred twenty chars`,
  ];
  for (const text of texts) {
    assert.deepEqual(hidePrompt(stateDir, text), { status: "written" });
  }
  const stored = readHideFile(stateDir);
  assert.ok(Array.isArray(stored), "hidden.json must hold a JSON array");
  // Byte-match: the file holds EXACTLY the shared helper's output, sorted.
  assert.deepEqual(stored, texts.map((text) => promptDedupKey(text)).sort());
  // The loaded set agrees.
  const loaded = loadHiddenPrompts(stateDir);
  for (const key of stored) {
    assert.ok(loaded.has(key));
  }
});

// T25 — AC-S4-2: hide persistence and tolerance. Two deletes of the same
// text compact to ONE key; a missing hide file reads as an empty set; reads
// never throw.
test("T25 (AC-S4-2): duplicate hides compact to one key; a missing file reads as empty; reads never throw", () => {
  const stateDir = makeStateDir("t25");
  // Missing file: empty set, no throw (before any write exists).
  assert.equal(loadHiddenPrompts(stateDir).size, 0);
  // Two deletes of the same text — variants differing by case + whitespace
  // runs normalize onto the same key.
  assert.deepEqual(hidePrompt(stateDir, "Same   Text"), { status: "written" });
  assert.deepEqual(hidePrompt(stateDir, "same text"), { status: "written" });
  const stored = readHideFile(stateDir);
  assert.deepEqual(stored, [promptDedupKey("same text")]);
  const loaded = loadHiddenPrompts(stateDir);
  assert.equal(loaded.size, 1);
  assert.ok(loaded.has(promptDedupKey("same text")));
});

// T26 — AC-S4-5: corrupt hidden.json is fail-open (READ half) AND the next
// hide rewrites the file clean as a sorted compact array — the rewrite half
// is the recovery path.
test("T26 (AC-S4-5): corrupt hidden.json loads as empty and the next hide rewrites it clean", () => {
  const stateDir = makeStateDir("t26");
  fs.writeFileSync(
    path.join(stateDir, "hidden.json"),
    "{corrupt bytes",
    "utf8",
  );
  assert.equal(loadHiddenPrompts(stateDir).size, 0);
  assert.deepEqual(hidePrompt(stateDir, "beta prompt"), { status: "written" });
  // The rewrite landed: clean JSON holding exactly the new key.
  assert.deepEqual(readHideFile(stateDir), [promptDedupKey("beta prompt")]);
  assert.equal(loadHiddenPrompts(stateDir).size, 1);
});

// WU4c — write-failure path (AC-S4-2 triangulation): a state dir that cannot
// be created (its parent is a regular file) makes the atomic write return
// false, and hidePrompt maps that to the toast-suitable error object —
// never a throw.
test("hide write failure returns the exact error shape for the delete-flow toast", () => {
  const base = makeStateDir("fail");
  const blocker = path.join(base, "blocker");
  fs.writeFileSync(blocker, "regular file", "utf8");
  const stateDir = path.join(blocker, "sealed"); // parent is a file → ENOTDIR
  assert.deepEqual(hidePrompt(stateDir, "kept prompt"), {
    status: "error",
    message: "Could not write the hide file; the prompt may reappear.",
  });
});
