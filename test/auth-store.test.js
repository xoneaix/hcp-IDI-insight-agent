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

test("AI usage statistics preserve exact tokens and aggregate by account and day", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-usage-"));
  try {
    const store = await AuthStore.create(join(directory, "auth.sqlite"));
    await store.ensureAdmin("admin@hisunpharm.com", "Admin-password-2026!");
    const admin = await store.authenticate("admin@hisunpharm.com", "Admin-password-2026!");
    const userCredentials = await store.addUser("researcher@hisunpharm.com");
    const user = await store.authenticate(userCredentials.email, userCredentials.temporaryPassword);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const outsideWindow = new Date(Date.now() - 12 * 86_400_000).toISOString();
    store.recordUsage({ userId: admin.id, userEmail: admin.email, operation: "历史调用", model: "gpt-test", inputTokens: 100, totalTokens: 100, occurredAt: outsideWindow });
    store.recordUsage({ userId: admin.id, userEmail: admin.email, operation: "角色识别", model: "gpt-test", inputTokens: 120, outputTokens: 30, totalTokens: 150, occurredAt: yesterday });
    store.recordUsage({ userId: user.id, userEmail: user.email, operation: "访谈分析", model: "gpt-test", inputTokens: 500, outputTokens: 180, totalTokens: 680 });
    store.recordUsage({ userId: user.id, userEmail: user.email, operation: "音频转录", model: "whisper-test", audioSeconds: 92.5 });

    const stats = store.usageStats(7);
    assert.equal(stats.days, 7);
    assert.equal(stats.summary.totalTokens, 930);
    assert.equal(stats.summary.inputTokens, 720);
    assert.equal(stats.summary.outputTokens, 210);
    assert.equal(stats.summary.requests, 4);
    assert.equal(stats.summary.audioSeconds, 92.5);
    assert.equal(stats.daily.reduce((total, day) => total + day.totalTokens, 0), 830);
    assert.equal(stats.summary.recentTokens, 830);
    const researcher = stats.users.find((item) => item.email === "researcher@hisunpharm.com");
    assert.equal(researcher.totalTokens, 680);
    assert.equal(researcher.todayTokens, 680);
    assert.equal(researcher.requests, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed passwords persist across store restarts and reset links are single use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "medvoice-password-"));
  const databasePath = join(directory, "auth.sqlite");
  try {
    let store = await AuthStore.create(databasePath);
    const credentials = await store.addUser("qianru.liu@hisunpharm.com");
    const user = await store.authenticate(credentials.email, credentials.temporaryPassword);
    await store.changePassword(user.id, credentials.temporaryPassword, "Qianru-secure-2026!");
    store.db.close();

    store = await AuthStore.create(databasePath);
    assert.equal(await store.authenticate(credentials.email, credentials.temporaryPassword), null);
    assert.equal((await store.authenticate(credentials.email, "Qianru-secure-2026!")).mustChangePassword, false);

    const reset = store.createPasswordReset(credentials.email, 30);
    assert.equal(reset.email, credentials.email);
    assert.match(reset.token, /^[A-Za-z0-9_-]{40,}$/);
    await store.resetPasswordWithToken(reset.token, "Qianru-recovered-2026!");
    assert.equal(await store.authenticate(credentials.email, "Qianru-secure-2026!"), null);
    assert.equal((await store.authenticate(credentials.email, "Qianru-recovered-2026!")).mustChangePassword, false);
    await assert.rejects(() => store.resetPasswordWithToken(reset.token, "Another-password-2026!"), /无效或已过期/);

    const adminReset = await store.resetPasswordById(user.id);
    assert.equal(adminReset.email, credentials.email);
    assert.equal(await store.authenticate(credentials.email, "Qianru-recovered-2026!"), null);
    assert.equal((await store.authenticate(credentials.email, adminReset.temporaryPassword)).mustChangePassword, true);
    store.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
