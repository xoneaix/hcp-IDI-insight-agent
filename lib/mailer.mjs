function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

export function mailConfigured() {
  return Boolean(
    (process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL)
    || (process.env.RESEND_API_KEY && process.env.MAIL_FROM)
  );
}

export async function sendAccessApprovedEmail({ email, temporaryPassword }) {
  if (!mailConfigured()) throw new Error("邮件服务尚未配置：请设置 BREVO_API_KEY 与 MAIL_FROM_EMAIL");
  const appUrl = process.env.PUBLIC_APP_URL || "https://medvoice-insight-agent.onrender.com/";
  const subject = "MedVoice Insight 试用权限已开通";
  const htmlContent = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:620px;margin:auto;color:#16201e"><div style="background:#174b3e;padding:28px;border-radius:16px 16px 0 0;color:white"><div style="font-size:13px;letter-spacing:2px;color:#dff25b">MEDVOICE INSIGHT</div><h1 style="margin:8px 0 0">你的试用权限已开通</h1></div><div style="padding:30px;border:1px solid #dfe6e2;border-top:0;border-radius:0 0 16px 16px"><p>你好，你申请的医药访谈洞察工作台权限已经由管理员批准。</p><div style="background:#f1f5f3;padding:18px;border-radius:10px;margin:22px 0"><div><strong>登录邮箱：</strong>${escapeHtml(email)}</div><div style="margin-top:10px"><strong>临时密码：</strong><code style="font-size:16px;color:#245c4d">${escapeHtml(temporaryPassword)}</code></div></div><p><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#245c4d;color:white;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">进入 MedVoice Insight</a></p><p style="color:#71807a;font-size:13px">首次登录后系统会要求立即修改密码。请勿转发本邮件或共享临时密码；所有 AI 结果仍需研究、医学与合规人员复核。</p></div></div>`;
  if (process.env.BREVO_API_KEY && process.env.MAIL_FROM_EMAIL) {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: process.env.MAIL_FROM_NAME || "MedVoice Insight", email: process.env.MAIL_FROM_EMAIL },
        to: [{ email }],
        subject,
        htmlContent
      }),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `邮件发送失败 (${response.status})`);
    return { id: data.messageId, provider: "brevo" };
  }
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
      html: htmlContent
    }),
    signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || `邮件发送失败 (${response.status})`);
  return { id: data.id, provider: "resend" };
}
