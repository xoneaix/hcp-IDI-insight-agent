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

test("project workspace migration redacts product names across reports and Deck content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-workspaces-compliance-"));
  const databasePath = join(directory, "workspaces.sqlite");
  try {
    let store = await SqliteProjectWorkspaceStore.create(databasePath);
    await store.upsert(9, "product-study", "玫满院外深访", {
      outlineGuides: [{
        title: "痤疮玫满-院外首购",
        matrix: [{ name: "Patient-001 · 痤疮玫满-院外首购.m4a", answer: "选择玫满。" }]
      }],
      reportWorkspace: { deckScript: { title: "玫满患者洞察" } }
    });
    let [workspace] = await store.list(9);
    assert.equal(workspace.projectName, "产品X院外深访");
    assert.equal(workspace.workspace.outlineGuides[0].title, "产品X-院外首购");
    assert.equal(workspace.workspace.reportWorkspace.deckScript.title, "产品X患者洞察");

    store.db.prepare(`
      UPDATE project_workspaces
      SET project_name='玫满院外深访',
          workspace='{"report":{"summary":"患者提到泰尔丝和玫满"}}'
      WHERE user_id=9 AND project_id='product-study'
    `).run();
    store.db.close();

    store = await SqliteProjectWorkspaceStore.create(databasePath);
    [workspace] = await store.list(9);
    assert.equal(workspace.projectName, "产品X院外深访");
    assert.equal(workspace.workspace.report.summary, "患者提到泰尔丝和产品X");
    store.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
