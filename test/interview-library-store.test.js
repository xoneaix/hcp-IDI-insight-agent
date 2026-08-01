import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteInterviewLibraryStore } from "../lib/interview-library-store.mjs";

test("interview library preserves Patient respondent type across create, update and list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-library-"));
  try {
    const store = await SqliteInterviewLibraryStore.create(join(directory, "library.sqlite"));
    await store.createItem(1, "11111111-1111-4111-8111-111111111111", {
      clientId: "Patient-001",
      name: "patient-interview.m4a",
      type: "Patient",
      status: "待转录"
    }, {
      fileName: "patient-interview.m4a",
      mimeType: "audio/mp4",
      fileSize: 1024,
      storagePath: join(directory, "patient-interview.m4a")
    });

    let [item] = await store.listItems(1);
    assert.equal(item.type, "Patient");

    item = await store.updateItem(1, item.serverId, { ...item, type: "Patient", status: "已转录" });
    assert.equal(item.type, "Patient");

    const [listedAgain] = await store.listItems(1);
    assert.equal(listedAgain.type, "Patient");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interview library migrates legacy product names in filenames and transcripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-library-compliance-"));
  const databasePath = join(directory, "library.sqlite");
  try {
    let store = await SqliteInterviewLibraryStore.create(databasePath);
    await store.createItem(1, "22222222-2222-4222-8222-222222222222", {
      clientId: "Patient-002",
      name: "痤疮玫满-院外首购.m4a",
      type: "Patient",
      status: "已转录",
      text: "受访者表示曾经使用玫满。",
      roleResult: { exchanges: [{ answer: "我使用过海正玫满。" }] }
    }, {
      fileName: "痤疮玫满-院外首购.m4a",
      mimeType: "audio/mp4",
      fileSize: 1024,
      storagePath: join(directory, "legacy-source.m4a")
    });
    let [item] = await store.listItems(1);
    assert.equal(item.name, "产品X-院外首购.m4a");
    assert.equal(item.text, "受访者表示曾经使用产品X。");
    assert.equal(item.roleResult.exchanges[0].answer, "我使用过产品X。");

    store.db.prepare(`
      UPDATE interview_assets
      SET name='本品痤疮-院外复购.m4a', transcript_text='继续使用玫满。'
      WHERE id=?
    `).run(item.serverId);
    store.db.close();

    store = await SqliteInterviewLibraryStore.create(databasePath);
    [item] = await store.listItems(1);
    assert.equal(item.name, "产品X-院外复购.m4a");
    assert.equal(item.text, "继续使用产品X。");
    store.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interview library deletes only the selected research project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-library-project-delete-"));
  try {
    const store = await SqliteInterviewLibraryStore.create(join(directory, "library.sqlite"));
    const makeItem = (id, projectId, fileName) => store.createItem(7, id, {
      clientId: fileName.replace(/\..+$/, ""),
      name: fileName,
      projectId,
      projectName: projectId,
      type: "Patient",
      status: "已转录"
    }, {
      fileName,
      mimeType: "audio/mp4",
      fileSize: 1024,
      storagePath: join(directory, fileName)
    });
    await makeItem("33333333-3333-4333-8333-333333333333", "study-a", "a.m4a");
    await makeItem("44444444-4444-4444-8444-444444444444", "study-b", "b.m4a");

    const deletedPaths = await store.deleteProject(7, "study-a");
    assert.deepEqual(deletedPaths, [join(directory, "a.m4a")]);
    const remaining = await store.listItems(7);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].projectId, "study-b");
    store.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
