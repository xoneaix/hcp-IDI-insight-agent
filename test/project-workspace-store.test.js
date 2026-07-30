import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteProjectWorkspaceStore } from "../lib/project-workspace-store.mjs";

test("project workspaces persist per account and project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-workspaces-"));
  const databasePath = join(directory, "workspaces.sqlite");
  try {
    let store = await SqliteProjectWorkspaceStore.create(databasePath);
    const first = await store.upsert(7, "study-first", "院外首购", {
      outlineGuides: [{ id: "guide-1", title: "首购大纲" }],
      matrix: [{ document_id: "Patient-001" }],
      report: { executive_summary: "首购洞察" },
      _localUpdatedAt: 100
    });
    assert.equal(first.projectId, "study-first");
    assert.equal(first.revision, 1);
    assert.deepEqual((await store.list(8)), []);

    const updated = await store.upsert(7, "study-first", "院外首购深访", {
      outlineGuides: [{ id: "guide-1", title: "首购大纲" }],
      reportWorkspace: { deckScript: { title: "洞察报告" } },
      _localUpdatedAt: 200
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.projectName, "院外首购深访");
    store.db.close();

    store = await SqliteProjectWorkspaceStore.create(databasePath);
    const restored = await store.list(7);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].workspace.reportWorkspace.deckScript.title, "洞察报告");
    assert.equal(restored[0].workspace._localUpdatedAt, 200);
    assert.equal(await store.delete(8, "study-first"), false);
    assert.equal(await store.delete(7, "study-first"), true);
    assert.deepEqual(await store.list(7), []);
    store.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
