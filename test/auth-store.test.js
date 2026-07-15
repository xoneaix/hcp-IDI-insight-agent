import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuthStore, isCompanyEmail } from "../lib/auth-store.mjs";

test("company access store enforces domain, sessions and approval workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-auth-"));
  try {
    const store = await AuthStore.create(join(directory, "auth.sqlite"));
    assert.equal(isCompanyEmail("user@hisunpharm.com"), true);
    assert.equal(isCompanyEmail("user@example.com"), false);
    await store.ensureAdmin("admin@hisunpharm.com", "Admin-password-2026!");
    const admin = await store.authenticate("admin@hisunpharm.com", "Admin-password-2026!");
    assert.equal(admin.role, "admin");
    const session = store.createSession(admin.id);
    assert.equal(store.sessionUser(session.token).email, "admin@hisunpharm.com");
    await store.requestAccess("colleague@hisunpharm.com", "患者访谈试用");
    const request = store.listRequests().find((item) => item.email === "colleague@hisunpharm.com");
    const credentials = await store.approveRequest(request.id, admin.id);
    assert.match(credentials.temporaryPassword, /^MV-/);
    const user = await store.authenticate(credentials.email, credentials.temporaryPassword);
    assert.equal(user.mustChangePassword, true);
    await store.changePassword(user.id, credentials.temporaryPassword, "New-password-2026!");
    assert.equal((await store.authenticate(credentials.email, "New-password-2026!")).mustChangePassword, false);

    await assert.rejects(() => store.requestAccess("partner@example.com", "外部合作方试用"), /白名单/);
    const allowed = store.addAllowedEmail("partner@example.com", "合作方验证", admin.id);
    assert.equal(allowed.email, "partner@example.com");
    assert.equal(store.listAllowedEmails().length, 1);
    await store.requestAccess("partner@example.com", "外部合作方试用");
    const externalRequest = store.listRequests().find((item) => item.email === "partner@example.com");
    const externalCredentials = await store.approveRequest(externalRequest.id, admin.id);
    assert.match(externalCredentials.temporaryPassword, /^MV-/);
    assert.equal((await store.authenticate("partner@example.com", externalCredentials.temporaryPassword)).email, "partner@example.com");
    store.removeAllowedEmail(allowed.id);
    assert.equal(await store.authenticate("partner@example.com", externalCredentials.temporaryPassword), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
