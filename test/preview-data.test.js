import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewWorkspace } from "../public/preview-data.js";

test("visitor mode provides a blank read-only workspace", () => {
  const workspace = createPreviewWorkspace();

  assert.equal(workspace.project.id, "preview-study");
  assert.equal(workspace.project.name, "访客模式");
  assert.deepEqual(workspace.interviews, []);
  assert.deepEqual(workspace.guides, []);
  assert.equal(workspace.reportWorkspace.engine.mode, "preview");
  assert.equal(workspace.reportWorkspace.deckScript, null);
  assert.deepEqual(workspace.reportWorkspace.supplementalFiles, []);
});
