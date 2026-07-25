import test from "node:test";
import assert from "node:assert/strict";
import { trialUserIdentity } from "../public/user-identity.js";

test("trial user identity uses first and last email-name initials", () => {
  assert.deepEqual(trialUserIdentity("lun.nie@hisunpharm.com"), {
    email: "lun.nie@hisunpharm.com",
    displayName: "Lun Nie",
    initials: "LN"
  });
  assert.equal(trialUserIdentity("john_smith+trial@example.com").initials, "JS");
});

test("trial user identity handles a single email-name token and invalid input", () => {
  assert.equal(trialUserIdentity("nielun@example.com").initials, "NI");
  assert.equal(trialUserIdentity("nielun@example.com").displayName, "Nielun");
  assert.equal(trialUserIdentity("not-an-email"), null);
});
