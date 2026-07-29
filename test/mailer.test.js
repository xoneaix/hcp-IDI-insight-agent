import test from "node:test";
import assert from "node:assert/strict";
import {
  mailConfigured,
  sendAccessApprovedEmail,
  sendAdminPasswordResetEmail,
  sendMailDeliveryTestEmail,
  sendPasswordResetLinkEmail
} from "../lib/mailer.mjs";

test("approval mail uses HTTPS provider without exposing credentials in logs", async () => {
  const previous = { key: process.env.BREVO_API_KEY, email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME, fetch: global.fetch };
  process.env.BREVO_API_KEY = "test-api-key";
  process.env.MAIL_FROM_EMAIL = "access@example.com";
  process.env.MAIL_FROM_NAME = "MedVoice Insight";
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ messageId: "mail-123" }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(mailConfigured(), true);
    const result = await sendAccessApprovedEmail({ email: "colleague@hisunpharm.com", temporaryPassword: "Temp-Password!" });
    assert.deepEqual(result, { id: "mail-123", provider: "brevo" });
    assert.equal(request.url, "https://api.brevo.com/v3/smtp/email");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.to[0].email, "colleague@hisunpharm.com");
    assert.match(payload.htmlContent, /Temp-Password!/);
    assert.match(payload.textContent, /Temp-Password!/);
  } finally {
    global.fetch = previous.fetch;
    if (previous.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = previous.key;
    if (previous.email === undefined) delete process.env.MAIL_FROM_EMAIL; else process.env.MAIL_FROM_EMAIL = previous.email;
    if (previous.name === undefined) delete process.env.MAIL_FROM_NAME; else process.env.MAIL_FROM_NAME = previous.name;
  }
});

test("delivery test mail uses same HTTPS provider without creating credentials", async () => {
  const previous = { key: process.env.BREVO_API_KEY, email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME, fetch: global.fetch };
  process.env.BREVO_API_KEY = "test-api-key";
  process.env.MAIL_FROM_EMAIL = "access@example.com";
  process.env.MAIL_FROM_NAME = "MedVoice Insight";
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ messageId: "mail-test-456" }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await sendMailDeliveryTestEmail({ email: "admin@hisunpharm.com" });
    assert.deepEqual(result, { id: "mail-test-456", provider: "brevo" });
    assert.equal(request.url, "https://api.brevo.com/v3/smtp/email");
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.to[0].email, "admin@hisunpharm.com");
    assert.match(payload.subject, /邮件链路测试/);
    assert.equal(payload.htmlContent.includes("临时密码：</strong><code"), false);
    assert.match(payload.textContent, /邮件链路测试成功/);
  } finally {
    global.fetch = previous.fetch;
    if (previous.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = previous.key;
    if (previous.email === undefined) delete process.env.MAIL_FROM_EMAIL; else process.env.MAIL_FROM_EMAIL = previous.email;
    if (previous.name === undefined) delete process.env.MAIL_FROM_NAME; else process.env.MAIL_FROM_NAME = previous.name;
  }
});

test("password lifecycle mails clearly distinguish admin reset and verified self-service reset", async () => {
  const previous = { key: process.env.BREVO_API_KEY, email: process.env.MAIL_FROM_EMAIL, fetch: global.fetch };
  process.env.BREVO_API_KEY = "test-api-key";
  process.env.MAIL_FROM_EMAIL = "access@example.com";
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ messageId: `mail-${requests.length}` }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    await sendAdminPasswordResetEmail({ email: "qianru.liu@hisunpharm.com", temporaryPassword: "MV-New-Password!" });
    await sendPasswordResetLinkEmail({
      email: "qianru.liu@hisunpharm.com",
      resetUrl: "https://medvoice-insight-agent.onrender.com/login?reset=one-time-token",
      expiresMinutes: 30
    });
    assert.match(requests[0].payload.subject, /管理员重置/);
    assert.match(requests[0].payload.textContent, /旧临时密码均已失效/);
    assert.match(requests[0].payload.textContent, /MV-New-Password!/);
    assert.match(requests[1].payload.subject, /重置你的/);
    assert.match(requests[1].payload.textContent, /30 分钟/);
    assert.match(requests[1].payload.textContent, /one-time-token/);
    assert.equal(requests[1].payload.textContent.includes("MV-New-Password!"), false);
  } finally {
    global.fetch = previous.fetch;
    if (previous.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = previous.key;
    if (previous.email === undefined) delete process.env.MAIL_FROM_EMAIL; else process.env.MAIL_FROM_EMAIL = previous.email;
  }
});
