const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

const api = async (url, options = {}) => {
  const response = await fetch(url, options);
  const data = await response.json();
  if (response.status === 401) {
    location.href = "/login";
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
  $("#adminMessage").textContent = `${actionText}，但邮件未发送成功：${data.emailError || "未知错误"}。请复制上方临时密码转发给同事，或稍后重置密码重试邮件发送。`;
  $("#adminMessage").className = "message error";
}

function displayTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value));
}

async function load() {
  const session = await api("/api/auth/session");
  if (!session.user || session.user.role !== "admin") return location.assign("/");
  $("#adminIdentity").textContent = `管理员：${session.user.email}`;
  const [usersData, requestsData, health] = await Promise.all([api("/api/admin/users"), api("/api/admin/requests"), api("/api/health")]);
  const persistent = health.storage === "postgres";
  const emailReady = health.emailConfigured === true;
  $("#adminSystemStatus").textContent = `${persistent ? "✓ 历史账号已持久保存" : "⚠ 当前账号仍为临时存储"} · ${emailReady ? "✓ 审批邮件已启用" : "⚠ 审批邮件待配置"}`;
  $("#adminSystemStatus").className = `system-status ${persistent && emailReady ? "ready" : "warning"}`;

  $("#userRows").innerHTML = usersData.users.map((user) => `<tr><td>${esc(user.email)}</td><td>${user.role === "admin" ? "管理员" : "试用用户"}</td><td><span class="pill ${user.active ? "" : "off"}">${user.active ? "已启用" : "已停用"}</span></td><td>${user.must_change_password ? "待修改" : "已完成"}</td><td>${esc(displayTime(user.last_login_at))}</td><td><span class="row-actions"><button data-reset="${user.id}" data-email="${esc(user.email)}" data-role="${user.role}">重置密码</button><button data-toggle="${user.id}" data-active="${user.active}">${user.active ? "停用" : "启用"}</button></span></td></tr>`).join("") || '<tr><td class="empty" colspan="6">暂无用户</td></tr>';

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
$("#copyCredential").onclick = async () => {
  await navigator.clipboard.writeText(lastCredential);
  $("#adminMessage").textContent = "登录凭据已复制";
};
$("#logoutButton").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/login";
};

load().catch((error) => { $("#adminMessage").textContent = error.message; });
