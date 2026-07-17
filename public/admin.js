const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const IS_FILE_PREVIEW = location.protocol === "file:";
const API_BASE = IS_FILE_PREVIEW ? "http://127.0.0.1:4174" : "";
const WORKSPACE_URL = IS_FILE_PREVIEW ? "index.html" : "/";
const LOGIN_URL = IS_FILE_PREVIEW ? `${API_BASE}/login` : "/login";

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
    $("#adminMessage").className = "message success";
    return;
  }
  showCredential(data.email, data.temporaryPassword);
  $("#adminMessage").textContent = `${actionText}，但邮件未发送成功：${data.emailError || "未知错误"} 请复制上方临时密码转发给同事；待邮件服务激活后，可再次点击“重置密码”重新发送。`;
  $("#adminMessage").className = "message error";
}

function displayTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

async function load() {
  $("#backToWorkspace").href = WORKSPACE_URL;
  if (IS_FILE_PREVIEW) {
    $("#adminSystemStatus").textContent = "本地文件预览模式：将自动连接 http://127.0.0.1:4174。若下方提示 Failed to fetch，请先启动本地服务。";
  }
  const session = await api("/api/auth/session");
  if (!session.user || session.user.role !== "admin") return location.assign(WORKSPACE_URL);
  $("#adminIdentity").textContent = `管理员：${session.user.email}`;
  const [usersData, requestsData, allowlistData, health] = await Promise.all([api("/api/admin/users"), api("/api/admin/requests"), api("/api/admin/allowed-emails"), api("/api/health")]);
  const persistent = health.storage === "postgres";
  const emailReady = health.emailConfigured === true;
  $("#adminSystemStatus").textContent = `${persistent ? "✓ 历史账号已持久保存" : "⚠ 当前账号仍为临时存储"} · ${emailReady ? `✓ 邮件参数已配置：${esc(health.emailProvider || "邮件服务")}` : "⚠ 审批邮件待配置"} · 实际发送以重置/审批结果为准`;
  $("#adminSystemStatus").className = `system-status ${persistent && emailReady ? "ready" : "warning"}`;

  $("#userRows").innerHTML = usersData.users.map((user) => `<tr><td>${esc(user.email)}</td><td>${user.role === "admin" ? "管理员" : "试用用户"}</td><td><span class="pill ${user.active ? "" : "off"}">${user.active ? "已启用" : "已停用"}</span></td><td>${user.must_change_password ? "待修改" : "已完成"}</td><td>${esc(displayTime(user.last_login_at))}</td><td><span class="row-actions"><button data-reset="${user.id}" data-email="${esc(user.email)}" data-role="${user.role}">重置密码</button><button data-toggle="${user.id}" data-active="${user.active}">${user.active ? "停用" : "启用"}</button></span></td></tr>`).join("") || '<tr><td class="empty" colspan="6">暂无用户</td></tr>';

  const allowedEmails = allowlistData.allowedEmails || [];
  $("#allowlistCount").textContent = String(allowedEmails.length);
  $("#allowlistRows").innerHTML = allowedEmails.map((item) => `<tr><td>${esc(item.email)}</td><td>${esc(item.note || "—")}</td><td>${esc(displayTime(item.created_at))}</td><td><span class="row-actions"><button data-remove-allowed="${item.id}">移除</button></span></td></tr>`).join("") || '<tr><td class="empty" colspan="4">暂无外部白名单</td></tr>';

  const pending = requestsData.requests.filter((item) => item.status === "pending");
  $("#pendingCount").textContent = String(pending.length);
  $("#requestRows").innerHTML = pending.map((item) => `<tr><td>${esc(item.email)}</td><td>${esc(item.note || "—")}</td><td>${esc(displayTime(item.requested_at))}</td><td><span class="row-actions"><button data-approve="${item.id}">批准并生成密码</button><button data-reject="${item.id}">拒绝</button></span></td></tr>`).join("") || '<tr><td class="empty" colspan="4">暂无待审批申请</td></tr>';
  bindRows();
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
      if (!confirm("确定移除该外部邮箱白名单吗？移除后该外部账号将无法继续登录，需重新加入白名单。")) return;
      await api(`/api/admin/allowed-emails/${button.dataset.removeAllowed}`, { method: "DELETE" });
      $("#adminMessage").textContent = "外部邮箱已从白名单移除";
      $("#adminMessage").className = "message success";
      await load();
    };
  });
}

$("#addUserForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("#newUserEmail").value, role: $("#newUserRole").value }) });
    showDeliveryResult(data, "账号已开通");
    $("#newUserEmail").value = "";
    await load();
  } catch (error) {
    $("#adminMessage").textContent = error.message;
  }
};

$("#refreshRequests").onclick = () => load().catch((error) => { $("#adminMessage").textContent = error.message; });
$("#sendTestEmail").onclick = async () => {
  const button = $("#sendTestEmail");
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "发送中…";
  try {
    const target = $("#testEmailTarget").value.trim();
    const data = await api("/api/admin/test-email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: target }) });
    $("#adminMessage").textContent = `测试邮件已通过 ${data.provider || "邮件服务"} 提交至 ${data.email}。发件人：${data.from || "已配置发件人"}。Delivery ID：${data.deliveryId || "已提交"}。如果未收到，请检查垃圾邮件、企业邮箱隔离区，或在 Brevo Transactional logs 中搜索该邮箱。`;
    $("#adminMessage").className = "message success";
  } catch (error) {
    $("#adminMessage").textContent = `测试邮件发送失败：${error.message}`;
    $("#adminMessage").className = "message error";
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
    $("#adminMessage").className = "message success";
    $("#allowEmail").value = "";
    $("#allowNote").value = "";
    await load();
  } catch (error) {
    $("#adminMessage").textContent = error.message;
    $("#adminMessage").className = "message error";
  }
};
$("#copyCredential").onclick = async () => {
  await navigator.clipboard.writeText(lastCredential);
  $("#adminMessage").textContent = "登录凭据已复制";
};
$("#logoutButton").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = LOGIN_URL;
};

load().catch((error) => {
  const localHint = IS_FILE_PREVIEW ? "。本地演示请先在终端运行本地服务，然后访问 http://127.0.0.1:4174/admin；或点击“返回工作台”回到本地静态工作台。" : "";
  $("#adminMessage").textContent = `${error.message}${localHint}`;
  $("#adminMessage").className = "message error";
});
