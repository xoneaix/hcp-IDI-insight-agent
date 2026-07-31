import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewWorkspace } from "../public/preview-data.js";

test("feature preview provides a complete, internally consistent read-only workspace", () => {
  const workspace = createPreviewWorkspace();

  assert.equal(workspace.project.id, "preview-study");
  assert.equal(workspace.interviews.length, 6);
  assert.equal(workspace.guides.length, 2);
  assert.equal(workspace.reportWorkspace.engine.mode, "preview");
  assert.equal(workspace.reportWorkspace.deckScript.slides.length, 8);

  const interviewIds = workspace.interviews.map((item) => item.id);
  const serverIds = workspace.interviews.map((item) => item.serverId);
  assert.equal(new Set(interviewIds).size, interviewIds.length);
  assert.equal(new Set(serverIds).size, serverIds.length);
  assert.deepEqual(interviewIds, [
    "Patient-001",
    "Patient-002",
    "Patient-003",
    "Patient-004",
    "Patient-005",
    "Patient-006"
  ]);

  for (const guide of workspace.guides) {
    assert.equal(guide.questions.length, 6);
    assert.equal(guide.sampleIds.length, 3);
    assert.equal(guide.matrix.length, 3);
    assert.equal(guide.report.top_insights.length, 3);
    assert.ok(guide.sampleIds.every((id) => serverIds.includes(id)));
    assert.ok(guide.matrix.every((row) => interviewIds.includes(row.document_id)));
  }
});
