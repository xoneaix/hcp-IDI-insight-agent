const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const IS_FILE_PREVIEW = location.protocol === "file:";
const API_BASE = IS_FILE_PREVIEW ? "http://127.0.0.1:4174" : "";
const WORKSPACE_URL = IS_FILE_PREVIEW ? "index.html" : "/";
const LOGIN_URL = IS_FILE_PREVIEW ? `${API_BASE}/login` : "/login";
const numberFormat = new Intl.NumberFormat("zh-CN");
const compactNumberFormat = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

const api = async (url, options = {}) => {
  const response = await fetch(`${API_BASE}${url}`, { credentials: IS_FILE_PREVIEW ? "include" : "same-origin", ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.href = LOGIN_URL;
    throw new Error("登录已过期");
  }
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
};

let lastCredential = "";
let usageDays = 14;

function showCredential(email, password) {
  if (!password) {
    lastCredential = "";
    $("#credentialBox").hidden = true;
    return;
  }
  lastCredential = `邮箱：${email}\n临时密码：${password}`;
  $("#credentialText").textContent = lastCredential;
  $("#credentialBox").hidden = false;
  $("#credentialBox").scrollIntoView({ behavior: "smooth", block: "center" });
}

function showDeliveryResult(data, actionText = "账号已开通") {
  if (data.emailed) {
    showCredential(data.email, "");
    $("#adminMessage").textContent = `${actionText}，临时账号与密码已通过邮件发送至 ${data.email}。`;
    $("#adminMessage").className = "message admin-global-message success";
    return;
  }
  showCredential(data.email, data.temporaryPassword);
  $("#adminMessage").textContent = `${actionText}，但邮件未发送成功：${data.emailError || "未知错误"} 请复制临时密码并通过安全渠道发送。`;
  $("#adminMessage").className = "message admin-global-message error";
}

function displayTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

function initials(email) {
  const parts = String(email || "").split("@")[0].split(/[._\-\s]+/).filter(Boolean);
  if (!parts.length) return "MV";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts.at(-1)[0]}`.toUpperCase();
}

function formatTokens(value, compact = false) {
  const amount = Math.max(0, Number(value) || 0);
  return compact && amount >= 1000 ? compactNumberFormat.format(amount) : numberFormat.format(amount);
}

function formatAudio(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (!total) return "未记录音频调用";
  if (total >= 3600) return `另有 ${(total / 3600).toFixed(1)} 小时音频`;
  if (total >= 60) return `另有 ${Math.round(total / 60)} 分钟音频`;
  return `另有 ${Math.round(total)} 秒音频`;
}

function niceMax(value) {
  const max = Math.max(1, Number(value) || 0);
  const power = 10 ** Math.floor(Math.log10(max));
  const normalized = max / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * power;
}

function renderUsageChart(daily = []) {
  const chart = $("#usageChart");
  const values = daily.map((day) => Math.max(0, Number(day.totalTokens) || 0));
  const peak = Math.max(0, ...values);
  if (!daily.length || peak === 0) {
    chart.innerHTML = '<div class="usage-chart-empty"><div>该周期暂无 Token 使用记录<span>新产生的 AI 调用将在这里按日呈现</span></div></div>';
    return;
  }

  const width = 1100;
  const height = 270;
  const left = 64;
  const right = 24;
  const top = 25;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = niceMax(peak);
  const step = plotWidth / daily.length;
  const barWidth = Math.max(7, Math.min(36, step * .55));
  const labelEvery = daily.length <= 14 ? 1 : daily.length <= 21 ? 2 : 3;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = top + plotHeight * ratio;
    const value = maxValue * (1 - ratio);
    return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="chart-label" x="${left - 11}" y="${y + 3}" text-anchor="end">${esc(formatTokens(value, true))}</text>`;
  }).join("");
  const bars = daily.map((day, index) => {
    const input = Math.max(0, Number(day.inputTokens) || 0);
    const output = Math.max(0, Number(day.outputTokens) || 0);
    const total = Math.max(input + output, Number(day.totalTokens) || 0);
    const x = left + step * index + (step - barWidth) / 2;
    const inputHeight = input / maxValue * plotHeight;
    const outputHeight = output / maxValue * plotHeight;
    const inputY = top + plotHeight - inputHeight;
    const outputY = inputY - outputHeight;
    const showValue = total > 0 && (daily.length <= 14 || total === peak);
    const dateText = String(day.date || "").slice(5).replace("-", "/");
    const dateLabel = index % labelEvery === 0 || index === daily.length - 1
      ? `<text class="chart-label" x="${x + barWidth / 2}" y="${height - 17}" text-anchor="middle">${esc(dateText)}</text>`
      : "";
    return `<g>
      <title>${esc(day.date)} · Input ${esc(formatTokens(input))} · Output ${esc(formatTokens(output))} · 合计 ${esc(formatTokens(total))}</title>
      ${outputHeight > 0 ? `<rect x="${x}" y="${outputY}" width="${barWidth}" height="${outputHeight}" rx="${Math.min(4, barWidth / 4)}" fill="#e2a14c"/>` : ""}
      ${inputHeight > 0 ? `<rect x="${x}" y="${inputY}" width="${barWidth}" height="${inputHeight}" rx="${Math.min(4, barWidth / 4)}" fill="#4e917b"/>` : ""}
      ${showValue ? `<text class="chart-value" x="${x + barWidth / 2}" y="${Math.max(13, outputY - 7)}" text-anchor="middle">${esc(formatTokens(total, true))}</text>` : ""}
      ${dateLabel}
    </g>`;
  }).join("");

  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    ${grid}
    <line class="chart-grid" x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}"/>
    ${bars}
  </svg>`;
}

function renderUsageRows(users = []) {
  $("#usageRows").innerHTML = users.map((user) => {
    const role = user.role === "admin" ? "管理员" : "试用用户";
    const state = user.active ? "已启用" : "已停用";
    return `<tr>
      <td><div class="usage-account"><span class="usage-avatar">${esc(initials(user.email))}</span><span><strong title="${esc(user.email)}">${esc(user.email)}</strong><small>${esc(formatAudio(user.audioSeconds))}</small></span></div></td>
      <td><span class="role-pill ${user.role === "admin" ? "admin" : ""}">${role}</span> <span class="pill ${user.active ? "" : "off"}">${state}</span></td>
      <td><span class="token-number ${user.todayTokens ? "" : "zero-token"}">${esc(formatTokens(user.todayTokens))}</span></td>
      <td><span class="token-number ${user.recentTokens ? "" : "zero-token"}">${esc(formatTokens(user.recentTokens))}</span></td>
      <td><span class="token-number total ${user.totalTokens ? "" : "zero-token"}">${esc(formatTokens(user.totalTokens))}</span></td>
      <td>${esc(formatTokens(user.requests))}</td>
      <td>${esc(displayTime(user.lastUsedAt))}</td>
    </tr>`;
  }).join("") || '<tr><td class="empty" colspan="7">暂无账号使用数据</td></tr>';
}

async function loadUsage() {
  document.querySelectorAll("[data-usage-days]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.usageDays) === usageDays);
    button.disabled = true;
  });
  $("#usageChart").innerHTML = '<div class="usage-chart-empty"><div>正在汇总真实用量…</div></div>';
  try {
    const usage = await api(`/api/admin/usage?days=${usageDays}`);
    $("#adminMetricToday").textContent = formatTokens(usage.summary.todayTokens, true);
    $("#adminMetricToday").title = `${formatTokens(usage.summary.todayTokens)} tokens`;
    $("#adminMetricRecent").textContent = formatTokens(usage.summary.recentTokens, true);
    $("#adminMetricRecent").title = `${formatTokens(usage.summary.recentTokens)} tokens`;
    $("#adminMetricRecentLabel").textContent = `近 ${usage.days} 日 Token`;
    $("#usagePeriodHeading").textContent = `近 ${usage.days} 日`;
    $("#usageAudioNote").textContent = `${formatAudio(usage.summary.audioSeconds)} · 音频时长不折算 Token`;
    renderUsageChart(usage.daily);
    renderUsageRows(usage.users);
  } finally {
    document.querySelectorAll("[data-usage-days]").forEach((button) => { button.disabled = false; });
  }
}

async function load() {
  $("#backToWorkspace").href = WORKSPACE_URL;
  if (IS_FILE_PREVIEW) {
    $("#adminSystemStatus").textContent = "本地文件预览模式：将连接 http://127.0.0.1:4174。";
  }
  const session = await api("/api/auth/session");
  if (!session.user || session.user.role !== "admin") return location.assign(WORKSPACE_URL);
  $("#adminIdentity").textContent = session.user.email;
  $(".admin-avatar").textContent = initials(session.user.email);

  const [usersData, requestsData, allowlistData, health] = await Promise.all([
    api("/api/admin/users"),
    api("/api/admin/requests"),
    api("/api/admin/allowed-emails"),
    api("/api/health")
  ]);
  const persistent = health.storage === "postgres";
  const emailReady = health.emailConfigured === true;
  $("#adminSystemStatus").textContent = `${persistent ? "历史账号已持久保存" : "当前使用本地账号存储"} · ${emailReady ? `邮件服务已配置：${health.emailProvider || "邮件服务"}` : "审批邮件尚未配置"} · 实际状态以发送结果为准`;
  $("#adminSystemStatus").className = `system-status ${persistent && emailReady ? "ready" : "warning"}`;

  const users = usersData.users || [];
  $("#adminMetricUsers").textContent = formatTokens(users.length);
  $("#adminMetricActive").textContent = formatTokens(users.filter((user) => Boolean(user.active)).length);
  $("#userRows").innerHTML = users.map((user) => `<tr>
    <td><div class="usage-account"><span class="usage-avatar">${esc(initials(user.email))}</span><span><strong>${esc(user.email)}</strong><small>${esc(displayTime(user.created_at))} 开通</small></span></div></td>
    <td><span class="role-pill ${user.role === "admin" ? "admin" : ""}">${user.role === "admin" ? "管理员" : "试用用户"}</span></td>
    <td><span class="pill ${user.active ? "" : "off"}">${user.active ? "已启用" : "已停用"}</span></td>
    <td>${user.must_change_password ? "待修改" : "已完成"}</td>
    <td>${esc(displayTime(user.last_login_at))}</td>
    <td><span class="row-actions"><button data-reset="${user.id}" data-email="${esc(user.email)}" data-role="${user.role}">重置密码</button><button data-toggle="${user.id}" data-active="${user.active}">${user.active ? "停用" : "启用"}</button></span></td>
  </tr>`).join("") || '<tr><td class="empty" colspan="6">暂无用户</td></tr>';

  const allowedEmails = allowlistData.allowedEmails || [];
  $("#allowlistCount").textContent = String(allowedEmails.length);
  $("#allowlistRows").innerHTML = allowedEmails.map((item) => `<tr><td>${esc(item.email)}</td><td>${esc(item.note || "—")}</td><td>${esc(displayTime(item.created_at))}</td><td><span class="row-actions"><button data-remove-allowed="${item.id}">移除</button></span></td></tr>`).join("") || '<tr><td class="empty" colspan="4">暂无外部白名单</td></tr>';

  const pending = (requestsData.requests || []).filter((item) => item.status === "pending");
  $("#pendingCount").textContent = String(pending.length);
  $("#requestRows").innerHTML = pending.map((item) => `<tr><td>${esc(item.email)}</td><td>${esc(item.note || "—")}</td><td>${esc(displayTime(item.requested_at))}</td><td><span class="row-actions"><button data-approve="${item.id}">批准并开通</button><button data-reject="${item.id}">拒绝</button></span></td></tr>`).join("") || '<tr><td class="empty" colspan="4">暂无待审批申请</td></tr>';
  bindRows();
  await loadUsage();
}

function bindRows() {
  document.querySelectorAll("[data-toggle]").forEach((button) => {
    button.onclick = async () => {
      await api(`/api/admin/users/${button.dataset.toggle}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: button.dataset.active !== "true" }) });
      await load();
    };
  });
  document.querySelectorAll("[data-reset]").forEach((button) => {
    button.onclick = async () => {
      const data = await api("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: button.dataset.email, role: button.dataset.role }) });
      showDeliveryResult(data, "密码已重置");
      await load();
    };
  });
  document.querySelectorAll("[data-approve]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = "正在批准…";
      const data = await api(`/api/admin/requests/${button.dataset.approve}/approve`, { method: "POST" });
      showDeliveryResult(data, "申请已批准");
      await load();
    };
  });
  document.querySelectorAll("[data-reject]").forEach((button) => {
    button.onclick = async () => {
      await api(`/api/admin/requests/${button.dataset.reject}/reject`, { method: "POST" });
      await load();
    };
  });
  document.querySelectorAll("[data-remove-allowed]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("确定移除该外部邮箱白名单吗？移除后该外部账号将无法继续登录。")) return;
      await api(`/api/admin/allowed-emails/${button.dataset.removeAllowed}`, { method: "DELETE" });
      $("#adminMessage").textContent = "外部邮箱已从白名单移除";
      $("#adminMessage").className = "message admin-global-message success";
      await load();
    };
  });
}

document.querySelectorAll("[data-usage-days]").forEach((button) => {
  button.onclick = async () => {
    usageDays = Number(button.dataset.usageDays);
    try {
      await loadUsage();
    } catch (error) {
      $("#adminMessage").textContent = `用量统计加载失败：${error.message}`;
      $("#adminMessage").className = "message admin-global-message error";
    }
  };
});

$("#addUserForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("#newUserEmail").value, role: $("#newUserRole").value }) });
    showDeliveryResult(data, "账号已开通");
    $("#newUserEmail").value = "";
    await load();
  } catch (error) {
    $("#adminMessage").textContent = error.message;
    $("#adminMessage").className = "message admin-global-message error";
  }
};

$("#refreshRequests").onclick = () => load().catch((error) => {
  $("#adminMessage").textContent = error.message;
  $("#adminMessage").className = "message admin-global-message error";
});

$("#sendTestEmail").onclick = async () => {
  const button = $("#sendTestEmail");
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "发送中…";
  try {
    const target = $("#testEmailTarget").value.trim();
    const data = await api("/api/admin/test-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: target }) });
    $("#adminMessage").textContent = `测试邮件已通过 ${data.provider || "邮件服务"} 提交至 ${data.email}。Delivery ID：${data.deliveryId || "已提交"}。`;
    $("#adminMessage").className = "message admin-global-message success";
  } catch (error) {
    $("#adminMessage").textContent = `测试邮件发送失败：${error.message}`;
    $("#adminMessage").className = "message admin-global-message error";
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
};

$("#allowlistForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/admin/allowed-emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("#allowEmail").value, note: $("#allowNote").value }) });
    $("#adminMessage").textContent = `${data.allowedEmail.email} 已加入外部白名单，可以申请试用或由管理员直接开通。`;
    $("#adminMessage").className = "message admin-global-message success";
    $("#allowEmail").value = "";
    $("#allowNote").value = "";
    await load();
  } catch (error) {
    $("#adminMessage").textContent = error.message;
    $("#adminMessage").className = "message admin-global-message error";
  }
};

$("#copyCredential").onclick = async () => {
  await navigator.clipboard.writeText(lastCredential);
  $("#adminMessage").textContent = "登录凭据已复制";
  $("#adminMessage").className = "message admin-global-message success";
};

$("#logoutButton").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = LOGIN_URL;
};

load().catch((error) => {
  const localHint = IS_FILE_PREVIEW ? "。本地演示请先启动本地服务，再访问 http://127.0.0.1:4174/admin。" : "";
  $("#adminMessage").textContent = `${error.message}${localHint}`;
  $("#adminMessage").className = "message admin-global-message error";
});
