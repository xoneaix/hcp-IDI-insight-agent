function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function mailConfigured() {
  return Boolean(
    (process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL)
    || (process.env.RESEND_API_KEY && process.env.MAIL_FROM)
  );
}

export function mailProviderLabel() {
  const providers = [];
  if (process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL) providers.push("Brevo");
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) providers.push("Resend");
  return providers.join(" + ") || "未配置";
}

function explainMailError(provider, message, status) {
  const raw = String(message || "").trim();
  if (/not yet activated|request activation|smtp account/i.test(raw)) {
    return `${provider} 发信账号尚未激活：请登录 ${provider} 完成 Transactional Email/SMPP 激活与发件人验证，或按提示联系 contact@brevo.com 申请开通。激活前，请先复制页面显示的临时密码，通过公司内部安全渠道发送给同事。`;
  }
  if (/sender|from|not verified|unauthori[sz]ed/i.test(raw)) {
    return `${provider} 发件人邮箱或域名尚未验证：请先在邮件服务后台验证 MAIL_FROM_EMAIL/发件域名。原始错误：${raw}`;
  }
  return raw || `${provider} 邮件发送失败${status ? ` (${status})` : ""}`;
}

async function sendWithBrevo({ email, subject, htmlContent }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { name: process.env.MAIL_FROM_NAME || "MedVoice Insight", email: process.env.MAIL_FROM_EMAIL },
      to: [{ email }],
      subject,
      htmlContent,
      textContent: htmlToText(htmlContent)
    }),
    signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(explainMailError("Brevo", data?.message, response.status));
  return { id: data.messageId, provider: "brevo" };
}

async function sendWithResend({ email, subject, htmlContent }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `medvoice-access-${email}-${Date.now()}`
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: [email],
      subject,
      html: htmlContent,
      text: htmlToText(htmlContent)
    }),
    signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(explainMailError("Resend", data?.message, response.status));
  return { id: data.id, provider: "resend" };
}

export async function sendAccessApprovedEmail({ email, temporaryPassword }) {
  if (!mailConfigured()) throw new Error("邮件服务尚未配置：请设置 BREVO_API_KEY 与 MAIL_FROM_EMAIL");
  const appUrl = process.env.PUBLIC_APP_URL || "https://medvoice-insight-agent.onrender.com/";
  const subject = "MedVoice Insight 试用权限已开通";
  const htmlContent = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:620px;margin:auto;color:#16201e"><div style="background:#174b3e;padding:28px;border-radius:16px 16px 0 0;color:white"><div style="font-size:13px;letter-spacing:2px;color:#dff25b">MEDVOICE INSIGHT</div><h1 style="margin:8px 0 0">你的试用权限已开通</h1></div><div style="padding:30px;border:1px solid #dfe6e2;border-top:0;border-radius:0 0 16px 16px"><p>你好，你申请的医药访谈洞察工作台权限已经由管理员批准。</p><div style="background:#f1f5f3;padding:18px;border-radius:10px;margin:22px 0"><div><strong>登录邮箱：</strong>${escapeHtml(email)}</div><div style="margin-top:10px"><strong>临时密码：</strong><code style="font-size:16px;color:#245c4d">${escapeHtml(temporaryPassword)}</code></div></div><p><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#245c4d;color:white;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">进入 MedVoice Insight</a></p><p style="color:#71807a;font-size:13px">首次登录后系统会要求立即修改密码。请勿转发本邮件或共享临时密码；所有 AI 结果仍需研究、医学与合规人员复核。</p></div></div>`;
  const errors = [];
  if (process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL) {
    try {
      return await sendWithBrevo({ email, subject, htmlContent });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
    try {
      return await sendWithResend({ email, subject, htmlContent });
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.join("；") || "邮件发送失败");
}

export async function sendMailDeliveryTestEmail({ email }) {
  if (!mailConfigured()) throw new Error("邮件服务尚未配置：请设置 BREVO_API_KEY 与 MAIL_FROM_EMAIL");
  const appUrl = process.env.PUBLIC_APP_URL || "https://medvoice-insight-agent.onrender.com/";
  const subject = "MedVoice Insight 邮件链路测试";
  const htmlContent = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:620px;margin:auto;color:#16201e"><div style="background:#174b3e;padding:26px;border-radius:16px 16px 0 0;color:white"><div style="font-size:13px;letter-spacing:2px;color:#dff25b">MEDVOICE INSIGHT</div><h1 style="margin:8px 0 0">邮件链路测试成功</h1></div><div style="padding:28px;border:1px solid #dfe6e2;border-top:0;border-radius:0 0 16px 16px"><p>你好，这是一封由 MedVoice Insight 管理后台触发的测试邮件。</p><p>如果你收到这封邮件，说明 Brevo Transactional Email 已可正常发送审批账号与临时密码邮件。</p><div style="background:#f1f5f3;padding:16px;border-radius:10px;margin:20px 0"><strong>测试接收邮箱：</strong>${escapeHtml(email)}<br><strong>测试时间：</strong>${escapeHtml(new Date().toISOString())}</div><p><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#245c4d;color:white;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">返回 MedVoice Insight</a></p><p style="color:#71807a;font-size:13px">本邮件不包含真实临时密码，也不会修改任何用户账号。</p></div></div>`;
  const errors = [];
  if (process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL) {
    try {
      return await sendWithBrevo({ email, subject, htmlContent });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
    try {
      return await sendWithResend({ email, subject, htmlContent });
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.join("；") || "邮件发送失败");
}
