const $ = (selector) => document.querySelector(selector);
const message = (text, type = "") => {
  const el = $("#authMessage");
  el.textContent = text;
  el.className = `message ${type}`;
};

let loginPassword = "";
const resetToken = new URLSearchParams(location.search).get("reset") || "";

function showTab(tab) {
  $("#authTabs").hidden = false;
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $("#loginForm").hidden = tab !== "login";
  $("#requestForm").hidden = tab !== "request";
  $("#changePasswordForm").hidden = true;
  $("#forgotPasswordForm").hidden = true;
  $("#resetPasswordForm").hidden = true;
  $("#cardTitle").textContent = tab === "request" ? "申请试用" : "登录工作台";
  $("#cardDescription").textContent = tab === "request" ? "提交邮箱与试用说明，由管理员审核开通。" : "使用管理员开通的邮箱和密码登录。";
  message("");
}

function showPasswordChange() {
  $("#authTabs").hidden = true;
  $("#loginForm").hidden = true;
  $("#requestForm").hidden = true;
  $("#forgotPasswordForm").hidden = true;
  $("#resetPasswordForm").hidden = true;
  $("#changePasswordForm").hidden = false;
  $("#cardTitle").textContent = "设置新密码";
  $("#cardDescription").textContent = "首次登录必须更换管理员生成的临时密码。";
  $("#currentPassword").value = loginPassword;
}

function showForgotPassword() {
  $("#authTabs").hidden = true;
  $("#loginForm").hidden = true;
  $("#requestForm").hidden = true;
  $("#changePasswordForm").hidden = true;
  $("#resetPasswordForm").hidden = true;
  $("#forgotPasswordForm").hidden = false;
  $("#cardTitle").textContent = "重置密码";
  $("#cardDescription").textContent = "通过账号邮箱完成身份验证并设置新密码。";
  $("#forgotPasswordEmail").value = $("#loginEmail").value;
  message("");
  $("#forgotPasswordEmail").focus();
}

function showPasswordReset() {
  $("#authTabs").hidden = true;
  $("#loginForm").hidden = true;
  $("#requestForm").hidden = true;
  $("#changePasswordForm").hidden = true;
  $("#forgotPasswordForm").hidden = true;
  $("#resetPasswordForm").hidden = false;
  $("#cardTitle").textContent = "设置新密码";
  $("#cardDescription").textContent = "重置链接验证通过后，新密码会立即保存到服务器。";
}

async function getSession() {
  return fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" }).then((response) => response.json()).catch(() => null);
}

async function verifySessionAfterLogin() {
  const session = await getSession();
  if (!session?.authenticated) {
    throw new Error("登录已验证，但浏览器未保存登录态。请刷新页面后重试；如仍失败，请确认使用的是 https://medvoice-insight-agent.onrender.com 访问。 ");
  }
  return session;
}

document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => showTab(button.dataset.tab)));
$("#showForgotPassword").addEventListener("click", showForgotPassword);
$("#backToLogin").addEventListener("click", () => showTab("login"));

$("#toggleLoginPassword").addEventListener("click", (event) => {
  const input = $("#loginPassword");
  const button = event.currentTarget;
  const isVisible = input.type === "text";
  input.type = isVisible ? "password" : "text";
  button.classList.toggle("is-visible", !isVisible);
  button.setAttribute("aria-pressed", String(!isVisible));
  button.setAttribute("aria-label", isVisible ? "显示密码" : "隐藏密码");
  button.title = isVisible ? "显示密码" : "隐藏密码";
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("正在验证…");
  loginPassword = $("#loginPassword").value;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("#loginEmail").value, password: loginPassword })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "登录失败");
    const session = await verifySessionAfterLogin();
    if (session.user.mustChangePassword) return showPasswordChange();
    location.href = "/";
  } catch (error) {
    message(error.message, "error");
  }
});

$("#requestForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  message("正在提交…");
  try {
    const response = await fetch("/api/access/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("#requestEmail").value, note: $("#requestNote").value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "提交失败");
    message(data.alreadyActive ? "该邮箱已开通，请联系管理员重置密码。" : "申请已提交。管理员批准后，账号和临时密码会自动发送至你的邮箱，请留意收件箱及垃圾邮件。", "success");
  } catch (error) {
    message(error.message, "error");
  }
});

$("#forgotPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "正在发送…";
  message("正在验证账号并提交邮件…");
  try {
    const response = await fetch("/api/auth/password-reset/request", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: $("#forgotPasswordEmail").value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "重置邮件发送失败");
    message(data.message || "重置邮件已提交，请检查收件箱和垃圾邮件。", "success");
    button.textContent = "邮件已提交";
  } catch (error) {
    message(error.message, "error");
    button.disabled = false;
    button.textContent = "发送重置邮件";
  }
});

$("#resetPasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const newPassword = $("#resetNewPassword").value;
  const confirmPassword = $("#resetConfirmPassword").value;
  if (newPassword !== confirmPassword) return message("两次输入的新密码不一致", "error");
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    const response = await fetch("/api/auth/password-reset/confirm", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: resetToken, newPassword, confirmPassword })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "密码重置失败");
    history.replaceState({}, "", "/login");
    showTab("login");
    message("新密码已保存到服务器，请使用新密码登录。", "success");
  } catch (error) {
    message(error.message, "error");
    button.disabled = false;
    button.textContent = "保存新密码";
  }
});

$("#changePasswordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = $("#newPassword").value;
  if (next !== $("#confirmPassword").value) return message("两次输入的新密码不一致", "error");
  try {
    const response = await fetch("/api/auth/change-password", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: $("#currentPassword").value, newPassword: next })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "密码修改失败");
    location.href = "/";
  } catch (error) {
    message(error.message, "error");
  }
});

if (resetToken) {
  showPasswordReset();
} else {
  const session = await getSession();
  if (session && !session.authRequired) location.href = "/";
  else if (session?.authenticated) {
    if (session.user.mustChangePassword) showPasswordChange();
    else location.href = "/";
  }
}
