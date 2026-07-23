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
