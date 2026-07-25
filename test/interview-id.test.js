import test from "node:test";
import assert from "node:assert/strict";
import { interviewIdForType, nextInterviewId, repairInterviewIds } from "../public/interview-id.js";

test("next interview id advances beyond the highest occupied sequence", () => {
  const items = [
    { id: "Patient-001", type: "Patient" },
    { id: "Patient-005", type: "Patient" },
    { id: "Patient-011", type: "Patient" }
  ];
  assert.equal(nextInterviewId(items, "Patient"), "Patient-012");
});

test("historical duplicate ids are repaired per project without changing the first item", () => {
  const first = { id: "Patient-005", type: "Patient", projectId: "study-a" };
  const duplicate = { id: "Patient-005", type: "Patient", projectId: "study-a" };
  const highest = { id: "Patient-011", type: "Patient", projectId: "study-a" };
  const anotherProject = { id: "Patient-005", type: "Patient", projectId: "study-b" };
  const repairs = repairInterviewIds([first, duplicate, highest, anotherProject]);

  assert.equal(first.id, "Patient-005");
  assert.equal(duplicate.id, "Patient-012");
  assert.equal(highest.id, "Patient-011");
  assert.equal(anotherProject.id, "Patient-005");
  assert.deepEqual(repairs.map((repair) => repair.nextId), ["Patient-012"]);
});

test("manual respondent type changes preserve the sequence when free and avoid collisions", () => {
  const patient = { id: "Patient-005", type: "Patient" };
  const hcpConflict = { id: "HCP-005", type: "HCP" };
  const highestHcp = { id: "HCP-009", type: "HCP" };
  const items = [patient, hcpConflict, highestHcp];

  assert.equal(interviewIdForType(items, patient, "HCP"), "HCP-010");
  hcpConflict.id = "HCP-006";
  assert.equal(interviewIdForType(items, patient, "HCP"), "HCP-005");
});
