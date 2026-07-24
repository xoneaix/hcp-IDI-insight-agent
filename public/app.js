const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PROJECT_NAME = "未命名访谈项目";

const state = {
  projectName: DEFAULT_PROJECT_NAME,
  activeProjectId: DEFAULT_PROJECT_ID,
  projects: [],
  allInterviews: [],
  interviews: [],
  outlineText: "",
  outlineSource: "",
  questions: [],
  analyses: [],
  matrix: [],
  report: null,
  apiConfigured: false,
  apiKeySource: "none",
  authRequired: false,
  currentUser: null,
  pendingAfterConnect: null,
  libraryLoaded: false,
  roleProcessing: false,
  roleProgress: null,
  recording: null,
  currentQuote: null
};

const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:4174" : "";
const WORKSPACE_URL = location.protocol === "file:" ? "index.html" : "/";
const ADMIN_URL = location.protocol === "file:" ? "admin.html" : "/admin";
const LOGIN_URL = location.protocol === "file:" ? `${API_BASE}/login` : "/login";
const VIEW_STORAGE_KEY = "medvoice.activeView";
const PROJECTS_STORAGE_KEY = "medvoice.projects";
const ACTIVE_PROJECT_STORAGE_KEY = "medvoice.activeProject";
const DELETED_INTERVIEWS_STORAGE_KEY = "medvoice.deletedInterviews";
const INITIAL_HASH = location.hash;
const LARGE_CONVERSION_CHUNK_THRESHOLD = 80 * 1024 * 1024;
const CONVERSION_CHUNK_SIZE = 8 * 1024 * 1024;
const LOCAL_DB_NAME = "medvoice-interview-library";
const LOCAL_DB_VERSION = 1;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function safeProjectId(value) {
  return String(value || DEFAULT_PROJECT_ID).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || DEFAULT_PROJECT_ID;
}

function createProjectId() {
  return `study-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function projectDataKey(projectId = state.activeProjectId) {
  return `medvoice.projectData.${safeProjectId(projectId)}`;
}

function currentProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0] || { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME };
}

function loadProjects() {
  let parsed = [];
  try { parsed = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) || "[]"); } catch {}
  state.projects = Array.isArray(parsed) && parsed.length
    ? parsed.map((project) => ({ id: safeProjectId(project.id), name: String(project.name || DEFAULT_PROJECT_NAME).slice(0, 80) }))
    : [{ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME }];
  const active = safeProjectId(localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) || state.projects[0].id);
  state.activeProjectId = state.projects.some((project) => project.id === active) ? active : state.projects[0].id;
  state.projectName = currentProject().name;
}

function saveProjects() {
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(state.projects));
  localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, state.activeProjectId);
}

function saveCurrentProjectWorkspace() {
  localStorage.setItem(projectDataKey(), JSON.stringify({
    outlineText: state.outlineText,
    outlineSource: state.outlineSource,
    questions: state.questions,
    analyses: state.analyses,
    matrix: state.matrix,
    report: state.report
  }));
}

function loadCurrentProjectWorkspace() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(projectDataKey()) || "{}"); } catch {}
  state.outlineText = data.outlineText || "";
  state.outlineSource = data.outlineSource || "";
  state.questions = Array.isArray(data.questions) ? data.questions : [];
  state.analyses = Array.isArray(data.analyses) ? data.analyses : [];
  state.matrix = Array.isArray(data.matrix) ? data.matrix : [];
  state.report = data.report || null;
  const outlineInput = $("#outlineInput");
  if (outlineInput) outlineInput.value = state.outlineText;
}

function normalizeProjectFields(item = {}) {
  const id = safeProjectId(item.projectId || item.project_id || DEFAULT_PROJECT_ID);
  const project = state.projects.find((candidate) => candidate.id === id);
  return {
    projectId: id,
    projectName: String(item.projectName || item.project_name || project?.name || DEFAULT_PROJECT_NAME).slice(0, 80)
  };
}

function mergeProjectsFromInterviews(items = state.allInterviews) {
  const known = new Set(state.projects.map((project) => project.id));
  for (const item of items) {
    const project = normalizeProjectFields(item);
    item.projectId = project.projectId;
    item.projectName = project.projectName;
    if (!known.has(project.projectId)) {
      state.projects.push({ id: project.projectId, name: project.projectName });
      known.add(project.projectId);
    }
  }
}

function syncCurrentProjectInterviews() {
  const activeId = safeProjectId(state.activeProjectId);
  state.interviews = state.allInterviews.filter((item) => safeProjectId(item.projectId || DEFAULT_PROJECT_ID) === activeId);
}

function setActiveProject(projectId) {
  saveCurrentProjectWorkspace();
  state.activeProjectId = safeProjectId(projectId);
  state.projectName = currentProject().name;
  saveProjects();
  loadCurrentProjectWorkspace();
  syncCurrentProjectInterviews();
  renderAll();
  showView(savedView(), { updateHash: false, scroll: false });
}

function renderProjectSwitcher() {
  const select = $("#projectSelect");
  if (!select) return;
  select.innerHTML = state.projects.map((project) => `<option value="${escapeHTML(project.id)}" ${project.id === state.activeProjectId ? "selected" : ""}>${escapeHTML(project.name)}</option>`).join("");
  $("#projectLabel").textContent = state.projectName;
  $("#breadcrumbProject").textContent = state.projectName;
}

function toast(message, duration = 2600) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), duration);
}

function filenameFromDisposition(disposition, fallback) {
  const encoded = String(disposition || "").match(/filename="?([^";]+)"?/i)?.[1];
  if (!encoded) return fallback;
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function pollConversionJob(jobId, onProgress = () => {}) {
  let transientFailures = 0;
  for (;;) {
    await delay(2500);
    let response;
    let job;
    try {
      response = await fetch(`${API_BASE}/api/media/convert-audio/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      job = await response.json().catch(() => ({}));
    } catch (error) {
      transientFailures += 1;
      onProgress({ status: "running", message: `读取转换进度时短暂中断，正在自动重试 ${transientFailures}/8`, progress: 0 });
      if (transientFailures < 8) continue;
      throw error;
    }
    if (!response.ok) {
      transientFailures += response.status >= 500 ? 1 : 8;
      if (transientFailures < 8) {
        onProgress({ status: "running", message: `服务器正在恢复转换任务，自动重试 ${transientFailures}/8`, progress: 0 });
        continue;
      }
      throw new Error(job.error || "无法读取转换进度");
    }
    transientFailures = 0;
    onProgress(job);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(job.error || "转换失败，请确认视频文件可播放且包含音轨");
  }
}

async function downloadConversionResult(job, options = {}) {
  const response = await fetch(`${API_BASE}${job.downloadUrl}`, { cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "下载转换后的音频失败");
  }
  const blob = await response.blob();
  const outputName = filenameFromDisposition(response.headers.get("Content-Disposition"), job.outputName || "interview-audio.m4a");
  if (options.save !== false) saveBlob(blob, outputName);
  return { outputName, blob };
}

function humanizeFileTransferError(message = "") {
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return "网络或大文件上传连接中断。当前资料已保留本机备份；请等待网络稳定后重试，系统会对大视频自动分片上传。";
  }
  if (/413|too large|content too large|payload too large|request entity too large/i.test(message)) {
    return "文件体积较大，服务器拒绝了单次上传。请点击“转录”，系统会自动分片上传、转换为 M4A 后再转录。";
  }
  return message || "未知错误";
}

async function uploadChunkedConversionJob(file, item) {
  const chunkCount = Math.ceil(file.size / CONVERSION_CHUNK_SIZE);
  item.progressText = `大视频将分为 ${chunkCount} 片上传，并自动转换为 M4A`;
  renderTranscripts();
  const startResponse = await fetch(`${API_BASE}/api/media/convert-audio/chunked/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, mimeType: file.type, size: file.size, chunkCount })
  });
  const start = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok) throw new Error(start.error || "创建分片上传任务失败");
  for (let index = 0; index < chunkCount; index += 1) {
    const begin = index * CONVERSION_CHUNK_SIZE;
    const chunk = file.slice(begin, Math.min(file.size, begin + CONVERSION_CHUNK_SIZE), "application/octet-stream");
    item.progressText = `正在分片上传视频用于音频预处理（${index + 1}/${chunkCount} · ${Math.round(((index + 1) / chunkCount) * 100)}%）`;
    renderTranscripts();
    const chunkResponse = await fetch(`${API_BASE}/api/media/convert-audio/chunked/${encodeURIComponent(start.id)}/chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Chunk-Index": String(index)
      },
      body: chunk
    });
    const chunkData = await chunkResponse.json().catch(() => ({}));
    if (!chunkResponse.ok) throw new Error(chunkData.error || `第 ${index + 1} 个分片上传失败`);
  }
  item.progressText = "视频分片上传完成，正在合并并创建 M4A 转换任务";
  renderTranscripts();
  const completeResponse = await fetch(`${API_BASE}/api/media/convert-audio/chunked/${encodeURIComponent(start.id)}/complete`, { method: "POST" });
  const completed = await completeResponse.json().catch(() => ({}));
  if (!completeResponse.ok) throw new Error(completed.error || "分片合并失败");
  return completed;
}

function isConvertibleVideoInterview(item) {
  return isVideoInterview(item) && !/\.m4a$/i.test(item.name || item.fileName || "");
}

function mergeConvertedAudioIntoSource(item, audioFile, outputName, convertedSize) {
  item.file = audioFile;
  item.name = outputName;
  item.fileName = outputName;
  item.mimeType = audioFile.type || "audio/mp4";
  item.fileSize = convertedSize || audioFile.size || item.fileSize || 0;
  item.hasFile = true;
  item.source = "音频预处理";
  item.derivedFromId = item.derivedFromId || item.id;
  item.status = item.text ? "已转录" : "待转录";
  item.progressText = "已自动转换为 M4A，正在转录轻量音频。";
  item.error = "";
  item.persistError = "";
  item.uploadProgress = null;
  return item;
}

function isVideoInterview(item) {
  return /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(item.name || item.fileName || "") || /^video\//i.test(item.mimeType || item.file?.type || "");
}

async function convertInterviewAudio(index, options = {}) {
  const item = state.interviews[index];
  if (!item) return;
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 服务");
  item.error = "";
  item.progressText = item.serverId ? "正在从账号资料库读取视频并创建 M4A 转换任务" : "正在上传视频并创建 M4A 转换任务";
  item.status = "音频预处理中";
  renderTranscripts();
  try {
    let started;
    if (item.serverId) {
      const response = await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(item.serverId)}/convert-audio/jobs`, { method: "POST" });
      started = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(started.error || `创建转换任务失败（HTTP ${response.status}）`);
    } else if (item.file) {
      if ((item.file.size || 0) >= LARGE_CONVERSION_CHUNK_THRESHOLD) {
        started = await uploadChunkedConversionJob(item.file, item);
      } else {
        const response = await fetch(`${API_BASE}/api/media/convert-audio/jobs`, {
          method: "POST",
          headers: {
            "Content-Type": item.file.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(item.file.name)
          },
          body: item.file
        });
        started = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(started.error || `创建转换任务失败（HTTP ${response.status}）`);
      }
    } else {
      throw new Error("没有可转换的原始文件，请重新上传视频");
    }
    item.progressText = started.message || "转换任务已创建，正在提取音轨";
    renderTranscripts();
    const job = await pollConversionJob(started.id, (job) => {
      const progressText = Number.isFinite(job.progress) && job.progress ? ` · ${job.progress}%` : "";
      item.progressText = `${job.message || "正在转换"}${progressText}`;
      renderTranscripts();
    });
    const { outputName, blob } = await downloadConversionResult(job, { save: false });
    const audioFile = new File([blob], outputName, { type: blob.type || "audio/mp4" });
    const originalServerId = item.serverId;
    await deleteLocalInterview(item, { remember: false });
    if (originalServerId) await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(originalServerId)}`, { method: "DELETE" }).catch(() => {});
    item.serverId = "";
    item.persisted = false;
    item.localPersisted = false;
    mergeConvertedAudioIntoSource(item, audioFile, outputName, job.convertedSize);
    forgetDeletedInterview(item);
    await persistInterview(index);
    renderAll();
    toast(`${item.id} 已自动转换为 M4A，正在转录轻量音频`, 4500);
    if (options.autoTranscribe !== false) await transcribeInterview(index, { skipAutoConvert: true });
    return;
  } catch (error) {
    item.status = "转换失败";
    item.progressText = "转换错误已保留，可点击“转录”重试";
    item.error = humanizeFileTransferError(error.message);
    toast(`转换失败：${item.error}`, 7000);
  }
  await persistInterview(index);
  renderAll();
}

function validView(view) {
  return ["overview", "transcripts", "outline", "matrix", "report"].includes(view) ? view : "overview";
}

function viewFromHash(hash = location.hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return "";
  return validView(raw);
}

function savedView(hash = location.hash) {
  const rawHash = String(hash || "");
  const fromHash = viewFromHash(rawHash);
  if (rawHash && fromHash) return fromHash;
  try { return validView(localStorage.getItem(VIEW_STORAGE_KEY)); } catch { return "overview"; }
}

function showView(view, options = {}) {
  view = validView(view);
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `${view}-view`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch {}
  if (options.updateHash !== false && location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: "smooth" });
}

async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `health ${response.status}`);
    state.apiConfigured = Boolean(data.apiConfigured);
    state.apiKeySource = data.apiKeySource || "none";
    $("#modeLabel").textContent = state.apiConfigured ? "AI 已连接" : "待配置 API";
    $("#modeLabel").style.color = state.apiConfigured ? "#dff25b" : "#f0b8a0";
    $("#apiSettingsLabel").textContent = state.apiKeySource === "server" ? "AI 企业服务" : state.apiConfigured ? "AI 已连接" : "连接 AI";
    $("#apiSettingsButton").classList.toggle("connected", state.apiConfigured);
    return data;
  } catch (error) {
    state.apiConfigured = false;
    console.warn("MedVoice health check failed", error);
    $("#modeLabel").textContent = "检查连接";
    $("#modeLabel").style.color = "#f0b8a0";
    $("#apiSettingsLabel").textContent = "服务未启动";
    $("#apiSettingsButton").classList.remove("connected");
    return null;
  }
}

async function checkPortalSession() {
  try {
    const response = await fetch(`${API_BASE}/api/auth/session`);
    const data = await response.json();
    state.authRequired = Boolean(data.authRequired);
    state.currentUser = data.user || null;
    if (state.authRequired && !data.authenticated) return location.assign("/login");
    if (data.user?.mustChangePassword) return location.assign("/login?change=1");
    $("#adminAccess").hidden = data.user?.role !== "admin" || !state.authRequired;
    $("#portalLogout").hidden = !state.authRequired;
    if (data.user?.role === "admin" && state.authRequired) {
      try {
        const requestsResponse = await fetch(`${API_BASE}/api/admin/requests`, { cache: "no-store" });
        const requestsData = await requestsResponse.json().catch(() => ({}));
        const pendingCount = (requestsData.requests || []).filter((item) => item.status === "pending").length;
        $("#adminAccess").textContent = pendingCount ? `Access 管理 · ${pendingCount}` : "Access 管理";
        $("#adminAccess").title = pendingCount ? `${pendingCount} 个试用申请待审批` : "暂无待审批申请";
      } catch (error) {
        console.warn("MedVoice admin request badge failed", error);
      }
    }
  } catch (error) {
    console.warn("MedVoice session check failed", error);
  }
}

function openApiSettings(nextAction = null) {
  state.pendingAfterConnect = nextAction;
  $("#apiKeyInput").value = "";
  $("#apiKeyInput").type = "password";
  $("#toggleApiKey").textContent = "显示";
  $("#dataConsent").checked = false;
  $("#apiSettingsDialog").showModal();
}

async function saveApiSettings(event) {
  event.preventDefault();
  const submit = event.submitter || $("#apiSettingsForm button[type=submit]");
  submit.disabled = true;
  submit.textContent = "正在验证…";
  try {
    const response = await fetch(`${API_BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: $("#apiKeyInput").value, confirmedDataAuthorization: $("#dataConsent").checked })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "连接失败");
    await checkHealth();
    $("#apiSettingsDialog").close();
    toast("AI 服务已连接；Key 将在本机服务重启后自动清除");
    const nextAction = state.pendingAfterConnect;
    state.pendingAfterConnect = null;
    if (nextAction) await nextAction();
  } catch (error) {
    toast(error.message.includes("fetch") ? "无法连接本地服务，请先启动 MedVoice" : error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = "验证并连接";
  }
}

async function clearApiSettings() {
  try {
    const response = await fetch(`${API_BASE}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "清除失败");
    state.pendingAfterConnect = null;
    $("#apiSettingsDialog").close();
    await checkHealth();
    toast("API Key 已从本机服务内存中清除");
  } catch (error) {
    toast(error.message);
  }
}

function normalizeRespondentType(type) {
  const value = String(type || "").trim().toLowerCase();
  return value === "patient" || value === "患者" ? "Patient" : "HCP";
}

function inferRespondentType(type, id = "", name = "") {
  const normalized = normalizeRespondentType(type);
  const label = `${id || ""} ${name || ""}`.trim();
  if (normalized === "HCP" && /^patient-\d+/i.test(label)) return "Patient";
  return normalized;
}

function respondentPrefix(type) {
  return normalizeRespondentType(type) === "Patient" ? "Patient" : "HCP";
}

function nextId(type = "HCP") {
  const prefix = respondentPrefix(type);
  const count = state.interviews.filter((item) => respondentPrefix(item.type) === prefix).length + 1;
  return `${prefix}-${String(count).padStart(3, "0")}`;
}

function renameInterviewForType(item, type) {
  const prefix = respondentPrefix(type);
  const currentPrefix = respondentPrefix(item.type);
  if (prefix === currentPrefix && String(item.id || "").startsWith(`${prefix}-`)) {
    item.type = normalizeRespondentType(type);
    return;
  }
  const count = state.interviews.filter((candidate) => candidate !== item && respondentPrefix(candidate.type) === prefix).length + 1;
  item.id = `${prefix}-${String(count).padStart(3, "0")}`;
  item.type = normalizeRespondentType(type);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function interviewPayload(item) {
  return {
    projectId: item.projectId || state.activeProjectId,
    projectName: item.projectName || state.projectName,
    clientId: item.id,
    name: item.name,
    type: normalizeRespondentType(item.type),
    source: item.source,
    derivedFromId: item.derivedFromId || "",
    recordedAt: item.recordedAt || "",
    durationSeconds: item.durationSeconds,
    status: item.status,
    progressText: item.progressText || "",
    error: item.error || "",
    text: item.text || "",
    draftText: item.draftText || "",
    roleResult: item.roleResult || null
  };
}

function accountLibraryPrefix() {
  return `${state.currentUser?.email || "local"}::`;
}

function localLibraryKey(item) {
  return `${accountLibraryPrefix()}${safeProjectId(item?.projectId || state.activeProjectId)}::${item.serverId || item.id}`;
}

function deletedInterviewKeys() {
  try { return new Set(JSON.parse(localStorage.getItem(DELETED_INTERVIEWS_STORAGE_KEY) || "[]")); } catch { return new Set(); }
}

function saveDeletedInterviewKeys(keys) {
  try { localStorage.setItem(DELETED_INTERVIEWS_STORAGE_KEY, JSON.stringify([...keys].slice(-1200))); } catch {}
}

function interviewIdentityKeys(item = {}, options = {}) {
  const projectId = safeProjectId(item.projectId || state.activeProjectId);
  const account = state.currentUser?.email || "local";
  const includeClientId = options.includeClientId !== false;
  const parts = [item.serverId, item.fileName, item.name, item.derivedFromId, includeClientId ? item.id : ""].filter(Boolean).map(String);
  return [...new Set(parts.flatMap((part) => [
    `${account}::${projectId}::${part}`,
    `${account}::${part}`,
    `${projectId}::${part}`,
    part
  ]))];
}

function rememberDeletedInterview(item, options = {}) {
  const keys = deletedInterviewKeys();
  for (const key of interviewIdentityKeys(item, options)) keys.add(key);
  saveDeletedInterviewKeys(keys);
}

function isDeletedInterview(item) {
  const keys = deletedInterviewKeys();
  return interviewIdentityKeys(item).some((key) => keys.has(key));
}

function forgetDeletedInterview(item) {
  const keys = deletedInterviewKeys();
  for (const key of interviewIdentityKeys(item)) keys.delete(key);
  saveDeletedInterviewKeys(keys);
}

function openLocalLibrary() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("当前浏览器不支持本地资料备份"));
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("interviews")) db.createObjectStore("interviews", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地资料库打开失败"));
  });
}

async function withLocalStore(mode, callback) {
  const db = await openLocalLibrary();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("interviews", mode);
      const store = tx.objectStore("interviews");
      Promise.resolve(callback(store)).then(resolve, reject);
      tx.onerror = () => reject(tx.error || new Error("本地资料库操作失败"));
    });
  } finally {
    db.close();
  }
}

function localInterviewRecord(item) {
  return {
    key: localLibraryKey(item),
    account: state.currentUser?.email || "local",
    savedAt: Date.now(),
    meta: interviewPayload(item),
    serverId: item.serverId || "",
    fileName: item.fileName || item.name,
    fileSize: item.file?.size || item.fileSize || 0,
    mimeType: item.file?.type || item.mimeType || "application/octet-stream",
    hasFile: Boolean(item.file || item.hasFile),
    blob: item.file || null
  };
}

async function saveLocalInterview(index) {
  const item = state.interviews[index];
  if (!item) return;
  try {
    await withLocalStore("readwrite", (store) => store.put(localInterviewRecord(item)));
    item.localPersisted = true;
  } catch (error) {
    item.localPersistError = error.message;
  }
}

async function loadLocalInterviews() {
  try {
    const prefix = accountLibraryPrefix();
    return await withLocalStore("readonly", (store) => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result || []).filter((record) => String(record.key || "").startsWith(prefix) && !record.deleted));
      request.onerror = () => reject(request.error || new Error("本地资料读取失败"));
    }));
  } catch {
    return [];
  }
}

async function clearLocalInterviews() {
  const records = await loadLocalInterviews();
  await withLocalStore("readwrite", async (store) => {
    for (const record of records) store.delete(record.key);
  }).catch(() => {});
}

async function deleteLocalInterview(item, options = {}) {
  if (!item) return;
  if (options.remember !== false) rememberDeletedInterview(item, { includeClientId: options.includeClientId });
  await withLocalStore("readwrite", (store) => new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onerror = () => reject(request.error || new Error("本机备份读取失败"));
    request.onsuccess = () => {
      const identity = new Set(interviewIdentityKeys(item, { includeClientId: options.includeClientId }));
      const directKeys = new Set([localLibraryKey(item), ...identity]);
      for (const record of request.result || []) {
        const meta = record.meta || {};
        const recordIdentity = new Set(interviewIdentityKeys({
          projectId: meta.projectId || meta.project_id,
          id: meta.clientId,
          serverId: record.serverId,
          name: meta.name,
          fileName: record.fileName,
          derivedFromId: meta.derivedFromId
        }, { includeClientId: options.includeClientId }));
        const sameRecord = directKeys.has(record.key) || [...recordIdentity].some((key) => identity.has(key));
        if (sameRecord) store.delete(record.key);
      }
      resolve();
    };
  })).catch(() => {});
}

function itemFromLocalRecord(record) {
  const meta = record.meta || {};
  const file = record.blob ? new File([record.blob], record.fileName || meta.name || "interview.webm", { type: record.mimeType || record.blob.type || "application/octet-stream" }) : null;
  const project = normalizeProjectFields(meta);
  return {
    ...project,
    id: meta.clientId || "HCP-001",
    serverId: record.serverId || "",
    name: meta.name || record.fileName || "访谈资料",
    type: inferRespondentType(meta.type, meta.clientId, meta.name || record.fileName),
    duration: Number.isFinite(Number(meta.durationSeconds)) ? formatDuration(Number(meta.durationSeconds)) : "—",
    durationSeconds: Number.isFinite(Number(meta.durationSeconds)) ? Number(meta.durationSeconds) : null,
    status: meta.status || "待转录",
    progressText: meta.progressText || "",
    error: meta.error || "",
    text: meta.text || "",
    draftText: meta.draftText || "",
    roleResult: meta.roleResult || null,
    file,
    fileName: record.fileName || meta.name,
    fileSize: record.fileSize || file?.size || 0,
    mimeType: record.mimeType || file?.type || "application/octet-stream",
    hasFile: Boolean(record.hasFile || file),
    source: meta.source || "上传文件",
    derivedFromId: meta.derivedFromId || "",
    recordedAt: meta.recordedAt || "",
    persisted: Boolean(record.serverId),
    localPersisted: true,
    selected: false
  };
}

function applyPersistedItem(local, persisted) {
  local.serverId = persisted.serverId;
  local.persisted = true;
  local.hasFile = persisted.hasFile;
  local.fileName = persisted.fileName || local.name;
  local.fileSize = persisted.fileSize || local.file?.size || 0;
  local.mimeType = persisted.mimeType || local.file?.type || "application/octet-stream";
  local.projectId = persisted.projectId || local.projectId || state.activeProjectId;
  local.projectName = persisted.projectName || local.projectName || state.projectName;
  return local;
}

function normalizeLoadedInterviewState(item) {
  if (!item) return item;
  if (/正在保存到账号资料库/.test(item.progressText || "")) item.progressText = "";
  item.uploadProgress = null;
  item.persisting = false;
  return item;
}

function generatedAudioSourceId(item) {
  const text = `${item.progressText || ""} ${item.source || ""}`;
  return item.derivedFromId || text.match(/已由\s*([A-Za-z]+-\d{3,})\s*自动生成\s*M4A/i)?.[1] || "";
}

async function removeSupersededVideoSources(items) {
  const sourceIds = new Set(items.map(generatedAudioSourceId).filter(Boolean));
  if (!sourceIds.size) return items;
  const kept = [];
  const removed = [];
  for (const item of items) {
    const superseded = sourceIds.has(item.id) && isVideoInterview(item) && /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(item.name || item.fileName || "");
    if (superseded) removed.push(item);
    else kept.push(item);
  }
  for (const item of removed) {
    if (item.serverId) await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(item.serverId)}`, { method: "DELETE" }).catch(() => {});
    await deleteLocalInterview(item, { includeClientId: false });
  }
  return kept;
}

async function persistInterview(index) {
  const item = state.interviews[index];
  if (!item || item.persisting) return;
  await saveLocalInterview(index);
  try {
    item.persisting = true;
    item.uploadProgress = item.serverId ? null : Math.max(3, item.uploadProgress || 0);
    if (!item.serverId && item.file) {
      item.progressText = `正在保存到账号资料库（${item.uploadProgress}%）`;
      renderTranscripts();
    }
    let response;
    if (item.serverId) {
      response = await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(item.serverId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(interviewPayload(item))
      });
    } else if (item.file) {
      response = await uploadLibraryItem(item, (percent) => {
        item.uploadProgress = percent;
        item.progressText = `正在保存到账号资料库（${percent}%）`;
        renderTranscripts();
      });
    } else {
      return;
    }
    const data = response instanceof Response ? await response.json().catch(() => ({})) : response;
    if (response instanceof Response && !response.ok) throw new Error(data.error || "资料保存失败");
    if (data.item) applyPersistedItem(item, data.item);
    item.persistError = "";
    item.uploadProgress = 100;
    if (/正在保存到账号资料库/.test(item.progressText || "")) item.progressText = "";
    await saveLocalInterview(index);
  } catch (error) {
    item.persistError = humanizeFileTransferError(error.message);
    toast(`资料未能保存到账户：${item.persistError}`, 6000);
  } finally {
    item.persisting = false;
    if (item.uploadProgress === 100 || item.persistError) item.uploadProgress = null;
    renderTranscripts();
  }
}

function uploadLibraryItem(item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/library/items`);
    xhr.setRequestHeader("Content-Type", item.file.type || "application/octet-stream");
    xhr.setRequestHeader("X-MedVoice-Meta", encodeURIComponent(JSON.stringify(interviewPayload(item))));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(98, Math.max(3, Math.round((event.loaded / event.total) * 98)));
      onProgress(percent);
    };
    xhr.onload = () => {
      const data = (() => {
        try { return JSON.parse(xhr.responseText || "{}"); } catch { return {}; }
      })();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve(data);
      } else {
        reject(new Error(data.error || `资料保存失败（${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error("Failed to fetch"));
    xhr.onabort = () => reject(new Error("资料保存已取消"));
    xhr.send(item.file);
  });
}

async function persistAllInterviews() {
  await Promise.all(state.interviews.map((_, index) => persistInterview(index)));
}

async function loadInterviewLibrary() {
  try {
    const localRecords = await loadLocalInterviews();
    const localItems = localRecords.map(itemFromLocalRecord).map(normalizeLoadedInterviewState);
    const response = await fetch(`${API_BASE}/api/library/items`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "资料库加载失败");
    const serverItems = (data.items || []).map((item) => normalizeLoadedInterviewState({
      ...normalizeProjectFields(item),
      id: item.id,
      serverId: item.serverId,
      name: item.name,
      type: inferRespondentType(item.type, item.id, item.name),
      duration: item.duration,
      durationSeconds: item.durationSeconds,
      status: item.status,
      progressText: item.progressText || "",
      error: item.error || "",
      text: item.text || "",
      draftText: item.draftText || "",
      roleResult: item.roleResult || null,
      file: null,
      fileName: item.fileName,
      fileSize: item.fileSize,
      mimeType: item.mimeType,
      hasFile: item.hasFile,
      source: item.source || "上传文件",
      derivedFromId: item.derivedFromId || "",
      recordedAt: item.recordedAt || "",
      persisted: true,
      selected: false
    }));
    const byId = new Map();
    const byClientId = new Map();
    for (const item of serverItems) {
      byId.set(item.serverId || item.id, item);
      byClientId.set(item.id, item);
    }
    for (const localItem of localItems) {
      const key = localItem.serverId || localItem.id;
      const serverItem = byId.get(key) || byClientId.get(localItem.id);
      if (serverItem) {
        serverItem.file = localItem.file;
        serverItem.fileSize = localItem.fileSize || serverItem.fileSize;
        serverItem.mimeType = localItem.mimeType || serverItem.mimeType;
        serverItem.localPersisted = true;
      } else {
        byId.set(key, localItem);
      }
    }
    state.allInterviews = await removeSupersededVideoSources([...byId.values()].map(normalizeLoadedInterviewState).filter((item) => !isDeletedInterview(item)));
    mergeProjectsFromInterviews();
    saveProjects();
    syncCurrentProjectInterviews();
    state.libraryLoaded = true;
    renderAll();
    if (state.interviews.length) toast(`已恢复 ${state.interviews.length} 份账号资料`);
  } catch (error) {
    toast(`账号资料加载失败：${error.message}`, 6000);
  }
}

function humanizeTranscriptionError(message = "") {
  if (/quota|billing|insufficient_quota|429/i.test(message)) {
    return "OpenAI API 额度不足或账单未开通，当前无法完成真实 AI 转录。请到 OpenAI Platform 的 Billing / Usage 检查余额、月度限额或更换有额度的 API Key；额度恢复后可点击“重新转录”。";
  }
  if (/401|unauthorized|invalid api key|incorrect api key/i.test(message)) {
    return "OpenAI API Key 无效或已失效，请在 Render 环境变量中更新 OPENAI_API_KEY 后重新部署。";
  }
  if (/413|too large|请求内容过大/i.test(message)) {
    return "音视频文件过大，请使用大型文件自动分片转录，或缩短录音后重试。";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "网络连接或服务端任务短暂中断，可能是页面刷新、Render 正在部署/重启，或浏览器到服务器连接超时。请等待 1 分钟后点击“重试”；如果仍失败，请点击列表行内“转录”，系统会自动完成音频预处理后再转录。";
  }
  if (/转录任务不存在|任务不存在|已过期/i.test(message)) {
    return "后台转录任务已中断或过期，通常是 Render 重启/重新部署导致任务队列被清空。请点击“重试”，系统会从账号资料库重新创建任务，无需重新上传文件。";
  }
  return message || "未知错误";
}

async function mediaMetadata(file) {
  if (!file.type.startsWith("audio/") && !file.type.startsWith("video/")) return { seconds: null, label: "—" };
  return new Promise((resolve) => {
    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (seconds) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve({ seconds: Number.isFinite(seconds) ? seconds : null, label: Number.isFinite(seconds) ? formatDuration(seconds) : "—" });
    };
    media.preload = "metadata";
    media.onloadedmetadata = () => finish(media.duration);
    media.onerror = () => finish(null);
    media.src = url;
    setTimeout(() => finish(null), 4000);
  });
}

async function addFiles(files, options = {}) {
  const supported = /\.(mp3|wav|mp4|m4a|webm|txt|md|csv|json)$/i;
  let added = 0;
  const addedIndexes = [];
  for (const file of files) {
    if (!supported.test(file.name) && !file.type.startsWith("audio/") && !file.type.startsWith("video/") && !file.type.startsWith("text/")) continue;
    const isText = /\.(txt|md|csv|json)$/i.test(file.name) || file.type.startsWith("text/");
    const index = state.interviews.length;
    const item = {
      projectId: state.activeProjectId,
      projectName: state.projectName,
      id: nextId(options.type),
      name: file.name,
      type: normalizeRespondentType(options.type),
      duration: Number.isFinite(options.durationSeconds) ? formatDuration(options.durationSeconds) : isText ? "—" : "读取中",
      durationSeconds: Number.isFinite(options.durationSeconds) ? options.durationSeconds : null,
      status: isText ? "可分析" : options.source === "实时录音" ? "录音已保存" : "待转录",
      text: "",
      file,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || "application/octet-stream",
      hasFile: true,
      source: options.source || "上传文件",
      recordedAt: options.recordedAt || "",
      draftText: options.draftText || "",
      error: "",
      progressText: "正在准备导入…",
      uploadProgress: 1,
      selected: true
    };
    forgetDeletedInterview(item);
    state.allInterviews.push(item);
    state.interviews.push(item);
    added += 1;
    addedIndexes.push(index);
    renderAll();
    if (isText) item.text = await file.text();
    if (!Number.isFinite(options.durationSeconds)) {
      const metadata = await mediaMetadata(file);
      item.duration = metadata.label;
      item.durationSeconds = metadata.seconds;
    }
    item.progressText = "正在保存到账号资料库…";
    renderTranscripts();
    await persistInterview(index);
  }
  renderAll();
  toast(added ? `已导入 ${added} 份访谈资料` : "没有找到支持的文件格式");
  return addedIndexes;
}

function renderTranscripts() {
  const table = $("#transcriptTable");
  if (!state.interviews.length) {
    table.innerHTML = '<tr><td colspan="6" class="empty-row">尚未导入资料。可上传文件或使用“实时录音”。</td></tr>';
  } else {
    table.innerHTML = state.interviews.map((item, index) => {
      if (item.roleResult && /正在区分对话角色/.test(item.progressText || "")) item.progressText = "角色区分完成，可在下方预览并导出 Word。";
      const isMedia = (item.file || item.hasFile) && !/\.(txt|md|csv|json)$/i.test(item.name);
      const actionLabel = isMedia ? (item.text ? "重新转录" : item.status === "转录失败" || item.status === "转换失败" ? "重试" : "转录") : "无需转录";
      const transcribeClass = item.text ? "retranscribe" : item.status === "转录失败" || item.status === "转换失败" ? "retry" : "primary";
      const roleProcessingThis = state.roleProcessing && state.roleProgress?.currentName === item.id;
      const canIdentifyRole = Boolean(item.text) && !state.roleProcessing;
      const roleActionLabel = roleProcessingThis ? "处理中" : item.roleResult ? "重新区分" : "区分角色";
      const statusClass = item.status.includes("中") || item.status.includes("预处理") ? "processing" : item.status === "转录失败" || item.status === "转换失败" || item.status === "角色区分失败" ? "failed" : item.status === "录音已保存" ? "saved" : "";
      const sourceLabel = item.source === "实时录音" ? `实时录音${item.recordedAt ? ` · ${escapeHTML(item.recordedAt)}` : ""}` : item.source === "音频预处理" ? "音频预处理" : "上传文件";
      const fileSize = item.file?.size || item.fileSize || 0;
      const uploadProgress = Number.isFinite(item.uploadProgress) ? Math.min(100, Math.max(0, item.uploadProgress)) : null;
      const isUploading = item.persisting || (uploadProgress !== null && uploadProgress < 100) || /正在保存到账号资料库/.test(item.progressText || "");
      const transcribeDisabled = !isMedia || isUploading;
      return `<tr>
        <td><input class="row-check" type="checkbox" data-index="${index}" ${item.selected ? "checked" : ""} aria-label="选择 ${escapeHTML(item.id)}" /></td>
        <td><strong>${escapeHTML(item.id)} · ${escapeHTML(item.name)}</strong><small class="${fileSize > 24 * 1024 * 1024 && !item.text ? "large-file-note" : "file-size-note"}">${item.roleResult ? "已区分角色 · 可导出问答 Word" : item.text ? "已建立逐字稿" : fileSize > 24 * 1024 * 1024 ? `${formatFileSize(fileSize)} · 服务端提取音轨并自动分片` : `${formatFileSize(fileSize)} · 等待语音转录`}${item.persisted ? " · 已保存到账户" : item.localPersisted ? " · 已保存本机备份" : item.persisting ? " · 保存中" : ""}</small><span class="source-badge ${item.source === "实时录音" ? "live" : ""}">${sourceLabel}</span>${item.error ? `<small class="file-error">失败原因：${escapeHTML(humanizeFileTransferError(item.error))}</small>` : ""}${item.persistError ? `<small class="file-error">保存提示：${escapeHTML(humanizeFileTransferError(item.persistError))}</small>` : ""}${item.localPersistError ? `<small class="file-error">本机备份提示：${escapeHTML(humanizeFileTransferError(item.localPersistError))}</small>` : ""}</td>
        <td><select class="type-select" data-index="${index}" aria-label="受访者类型"><option value="HCP" ${normalizeRespondentType(item.type) === "HCP" ? "selected" : ""}>HCP</option><option value="Patient" ${normalizeRespondentType(item.type) === "Patient" ? "selected" : ""}>Patient</option></select></td>
        <td>${escapeHTML(item.duration)}</td>
        <td><span class="status-pill ${statusClass}">${escapeHTML(item.status)}</span>${item.progressText ? `<small class="transcript-progress">${escapeHTML(item.progressText)}</small>` : ""}${uploadProgress !== null ? `<span class="upload-progress-bar" aria-label="上传保存进度 ${uploadProgress}%"><i style="width:${uploadProgress}%"></i></span>` : ""}</td>
        <td><div class="row-actions"><button class="transcribe-button ${transcribeClass}" data-index="${index}" ${transcribeDisabled ? "disabled" : ""}>${actionLabel}</button><button class="role-row-button" data-index="${index}" ${canIdentifyRole ? "" : "disabled"}>${roleActionLabel}</button></div></td>
      </tr>`;
    }).join("");
  }
  const transcribed = state.interviews.filter((item) => item.text).length;
  $("#fileSummary").textContent = `${state.interviews.length} 份访谈 · ${transcribed} 份可分析`;
  $("#navCount").textContent = state.interviews.length;
  $("#masterCheck").checked = state.interviews.length > 0 && state.interviews.every((item) => item.selected);
  $$(".row-check").forEach((checkbox) => checkbox.addEventListener("change", () => { state.interviews[+checkbox.dataset.index].selected = checkbox.checked; renderReadiness(); renderRoleMapper(); }));
  $$(".type-select").forEach((select) => select.addEventListener("change", async () => {
    const index = +select.dataset.index;
    const item = state.interviews[index];
    renameInterviewForType(item, select.value);
    item.roleResult = null;
    renderAll();
    await persistInterview(index);
  }));
  $$(".transcribe-button").forEach((button) => button.addEventListener("click", () => transcribeInterview(+button.dataset.index)));
  $$(".role-row-button").forEach((button) => button.addEventListener("click", () => identifyRoleForInterview(+button.dataset.index)));
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function selectedTranscriptionMode() {
  return "fast";
}

function estimatedChunkCount(item) {
  const duration = Number(item.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) return Math.max(1, Math.ceil(duration / 600));
  return 0;
}

function startTranscriptionTicker(item, index, phase, estimatedChunks, mode) {
  const startedAt = Date.now();
  return setInterval(() => {
    if (!["大型文件处理中", "转录中", "快速转录中"].includes(item.status)) return;
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const chunkText = estimatedChunks ? ` · 预计 ${estimatedChunks} 个分片` : "";
    const modeText = mode === "fast" ? "快速模式" : "说话人识别模式";
    item.progressText = `${phase}${chunkText} · 已等待 ${formatDuration(elapsed)} · ${modeText}`;
    if (state.interviews[index] === item) renderTranscripts();
  }, 9000);
}

async function pollTranscriptionJob(jobId, index, item, estimatedChunks, options = {}) {
  let transientFailures = 0;
  let restoredFromLibrary = false;
  for (;;) {
    await delay(2500);
    let response;
    let job;
    try {
      response = await fetch(`${API_BASE}/api/transcribe-large/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      job = await response.json().catch(() => ({}));
    } catch (error) {
      transientFailures += 1;
      item.progressText = `连接服务器读取进度时短暂中断，正在自动重试 ${transientFailures}/8；请暂时不要重复点击。`;
      if (state.interviews[index] === item) renderTranscripts();
      if (transientFailures < 8) continue;
      throw error;
    }
    if (!response.ok) {
      if (response.status === 404 && options.restartFromLibrary && !restoredFromLibrary) {
        restoredFromLibrary = true;
        item.progressText = "后台转录任务已中断，正在从账号资料库自动恢复，无需重新上传。";
        if (state.interviews[index] === item) renderTranscripts();
        const restartedJob = await options.restartFromLibrary();
        if (restartedJob.status === "completed") return restartedJob.result || {};
        jobId = restartedJob.id;
        item.progressText = restartedJob.message || "恢复任务已创建，正在继续转录。";
        if (state.interviews[index] === item) renderTranscripts();
        transientFailures = 0;
        continue;
      }
      transientFailures += response.status >= 500 ? 1 : 8;
      if (transientFailures < 8) {
        item.progressText = `服务器正在恢复转录任务，自动重试 ${transientFailures}/8。`;
        if (state.interviews[index] === item) renderTranscripts();
        continue;
      }
      throw new Error(job.error?.message || job.error || "无法读取转录进度");
    }
    transientFailures = 0;
    const chunkText = job.chunkCount ? `第 ${job.chunkIndex || 0}/${job.chunkCount} 段` : estimatedChunks ? `预计 ${estimatedChunks} 段` : "正在准备分片";
    const percentText = Number.isFinite(job.progress) ? ` · ${job.progress}%` : "";
    item.status = job.status === "failed" ? "转录失败" : "大型文件处理中";
    item.progressText = `${job.message || "正在处理"}（${chunkText}${percentText}）`;
    if (state.interviews[index] === item) renderTranscripts();
    if (job.status === "completed") return job.result || {};
    if (job.status === "failed") throw new Error(job.error || "大文件转录失败");
  }
}

async function createStoredTranscriptionJob(item, mode) {
  const startResponse = await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(item.serverId)}/transcribe/jobs`, {
    method: "POST",
    headers: { "X-Transcribe-Mode": mode }
  });
  const job = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok) throw new Error(job.error?.message || job.error || "创建资料库转录任务失败");
  return job;
}

function applyTranscriptionResult(item, data) {
  item.text = (data.segments || []).map((segment) => `${segment.speaker} [${formatDuration(segment.start)}]：${segment.text}`).join("\n") || data.text || "";
  item.roleResult = null;
  item.status = "已转录";
  item.progressText = data.transcription_mode === "fast-whisper"
    ? "快速转录完成：逐字稿已建立，可继续点击“区分所选访谈角色”。"
    : data.transcription_mode === "whisper-fallback"
      ? "已使用兼容转录模式，建议复核说话人角色"
      : "说话人分段已建立";
  if (data.duration) item.duration = formatDuration(data.duration);
  if (data.duration) item.durationSeconds = data.duration;
}

async function transcribeInterview(index, options = {}) {
  const item = state.interviews[index];
  if (!item) return;
  if (!options.skipAutoConvert && isConvertibleVideoInterview(item)) return convertInterviewAudio(index, { autoTranscribe: true });
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 本地服务");
  if (!state.apiConfigured) return openApiSettings(() => transcribeInterview(index));
  const fileSize = item.file?.size || item.fileSize || 0;
  const isLarge = fileSize > 24 * 1024 * 1024;
  const mode = selectedTranscriptionMode();
  const estimatedChunks = estimatedChunkCount(item);
  let ticker = null;
  item.error = "";
  item.progressText = isLarge
    ? `正在上传并创建后台转录任务${estimatedChunks ? `（预计 ${estimatedChunks} 段）` : ""}，请勿关闭页面`
    : mode === "fast" ? "正在快速转录音频为逐字稿" : "正在发送音频并识别说话人";
  item.status = isLarge ? "大型文件处理中" : mode === "fast" ? "快速转录中" : "转录中";
  renderTranscripts();
  try {
    let data;
    let response;
    if (!item.file && item.serverId && isLarge) {
      ticker = startTranscriptionTicker(item, index, "正在读取账号资料库大文件", estimatedChunks, mode);
      const job = await createStoredTranscriptionJob(item, mode);
      clearInterval(ticker);
      ticker = null;
      if (job.status === "completed") {
        data = job.result || {};
      } else {
        item.progressText = job.message || "已读取账号资料，正在提取音频并分片";
        renderTranscripts();
        data = await pollTranscriptionJob(job.id, index, item, estimatedChunks, {
          restartFromLibrary: () => createStoredTranscriptionJob(item, mode)
        });
      }
    } else if (!item.file && item.serverId) {
      ticker = startTranscriptionTicker(item, index, "服务端资料正在转录", estimatedChunks, mode);
      response = await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(item.serverId)}/transcribe`, {
        method: "POST",
        headers: { "X-Transcribe-Mode": mode }
      });
      data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.error || "转录失败");
    } else if (isLarge) {
      ticker = startTranscriptionTicker(item, index, "正在上传大文件并准备分片", estimatedChunks, mode);
      const startResponse = await fetch(`${API_BASE}/api/transcribe-large/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": item.file.type || "application/octet-stream",
          "X-Filename": encodeURIComponent(item.file.name),
          "X-Transcribe-Mode": mode,
          ...(Number.isFinite(item.durationSeconds) ? { "X-Media-Duration": String(item.durationSeconds) } : {})
        },
        body: item.file
      });
      const job = await startResponse.json().catch(() => ({}));
      if (!startResponse.ok) throw new Error(job.error?.message || job.error || "创建大文件转录任务失败");
      clearInterval(ticker);
      ticker = null;
      item.progressText = job.message || "上传完成，正在提取音频并分片";
      renderTranscripts();
      data = await pollTranscriptionJob(job.id, index, item, estimatedChunks, {
        restartFromLibrary: item.serverId ? () => createStoredTranscriptionJob(item, mode) : null
      });
    } else {
      ticker = startTranscriptionTicker(item, index, mode === "fast" ? "正在快速转录" : "正在识别说话人", 0, mode);
      const form = new FormData();
      form.append("file", item.file);
      form.append("transcriptionMode", mode);
      if (Number.isFinite(item.durationSeconds)) form.append("durationSeconds", String(item.durationSeconds));
      response = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: form });
      data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.error || "转录失败");
    }
    applyTranscriptionResult(item, data);
    toast(`${item.id} 转录完成${data.chunks ? `（${data.chunks} 个音频分片）` : ""}`);
  } catch (error) {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    const friendlyError = humanizeTranscriptionError(error.message);
    const isQuotaError = /quota|billing|insufficient_quota|429/i.test(error.message || "");
    const draftText = String(item.draftText || "").trim();
    if (isQuotaError && item.source === "实时录音" && draftText) {
      item.text = `【浏览器实时语音预览稿｜AI 转录未完成】\n待语义识别 [00:00]：${draftText}`;
      item.status = "预览稿待复核";
      item.progressText = "AI 额度不足，已先保存浏览器实时预览文本；额度恢复后可点击“重新转录”。";
      item.error = friendlyError;
      toast("AI 额度不足：已先保存实时语音预览稿，恢复额度后可重新转录。", 8000);
    } else {
      item.status = "转录失败";
      item.progressText = "错误详情已保留，可修正后点击“重试”";
      item.error = friendlyError;
      toast(`转录失败：${item.error}`, 8000);
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
  await persistInterview(index);
  renderAll();
}

function hideConfidencePopover() {
  const popover = $("#confidenceFloatingPopover");
  if (popover) popover.hidden = true;
}

function showConfidencePopover(anchor) {
  const popover = $("#confidenceFloatingPopover");
  if (!popover || !anchor) return;
  popover.innerHTML = `<strong>角色区分置信度</strong><em>90% 以上：整体稳定，建议抽查</em><em>80%–90%：可用，重点复核低置信片段</em><em>低于 80%：可能存在说话人混淆、转录质量差或多人插话</em><small>不是医学结论准确率，也不是转录准确率。</small>`;
  popover.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 32);
  popover.style.width = `${width}px`;
  const measured = popover.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 16, Math.max(16, rect.right - width));
  const belowTop = rect.bottom + 10;
  const aboveTop = rect.top - measured.height - 10;
  const top = belowTop + measured.height < window.innerHeight - 12 ? belowTop : Math.max(12, aboveTop);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function roleMappedInterviews() {
  return state.interviews.filter((item) => item.roleResult);
}

function selectedRoleDocuments() {
  return roleMappedInterviews().filter((item) => item.roleSelected === true);
}

function renderRoleMapper() {
  const selected = selectedInterviews();
  const ready = selected.filter((item) => item.text);
  const completed = roleMappedInterviews();
  const selectedForWord = selectedRoleDocuments();
  const allRoleDocsSelected = completed.length > 0 && selectedForWord.length === completed.length;

  $("#exportRoleWord").disabled = state.roleProcessing || !selectedForWord.length;
  $("#deleteRoleDocs").disabled = state.roleProcessing || !selectedForWord.length;
  $("#selectAllRoleDocs").disabled = state.roleProcessing || !completed.length;
  $("#selectAllRoleDocs").textContent = allRoleDocsSelected ? "取消全选" : "全选";
  $("#exportRoleWord").textContent = selectedForWord.length ? `导出 Word (${selectedForWord.length}) ↗` : "导出 Word ↗";
  const progress = state.roleProgress;
  const progressPercent = progress ? Math.max(0, Math.min(100, Math.round(progress.percent || 0))) : 0;
  $(".role-mapper-panel").classList.toggle("processing", state.roleProcessing);
  $("#roleSummary").textContent = state.roleProcessing && progress
    ? `正在处理 ${progress.currentName || "所选访谈"} · ${progress.current || 1}/${progress.total || ready.length || 1} · ${progressPercent}%`
    : ready.length
      ? `${ready.length} 份所选访谈可处理 · ${completed.length} 份已完成角色区分 · ${selectedForWord.length} 份勾选待导出`
      : completed.length
        ? `${completed.length} 份已完成角色区分 · ${selectedForWord.length} 份勾选待导出`
        : "等待所选资料完成转录";
  const progressBar = $("#roleProgressBar");
  if (progressBar) {
    progressBar.hidden = !state.roleProcessing;
    progressBar.querySelector("i").style.width = `${progressPercent}%`;
    progressBar.querySelector("b").textContent = state.roleProcessing ? `${progressPercent}%` : "";
  }

  if (!completed.length) {
    $("#rolePreview").innerHTML = '<div class="empty-compact">完成转录后，可在上方“已导入资料”的对应文件行点击“区分角色”。</div>';
    return;
  }

  $("#rolePreview").innerHTML = completed.map((item, itemIndex) => {
    if (item.roleSelected === undefined) item.roleSelected = false;
    if (item.roleExpanded === undefined) item.roleExpanded = false;
    const result = item.roleResult;
    const exchangeCount = result.exchanges?.length || 0;
    const previewCount = Math.min(exchangeCount, 3);
    const previews = item.roleExpanded ? (result.exchanges || []).slice(0, 3).map((exchange, index) => `<div class="qa-preview">
      <label class="${exchange.needs_review ? "review-tag" : ""}">Q${String(index + 1).padStart(2, "0")} · 访谈员${exchange.question_timestamp ? ` · ${escapeHTML(exchange.question_timestamp)}` : ""}${exchange.needs_review ? " · 待复核" : ""}</label>
      <p>${escapeHTML(exchange.question || "（未识别到完整提问）")}</p>
      <label>A · ${escapeHTML(result.respondent_label)}${exchange.answer_timestamp ? ` · ${escapeHTML(exchange.answer_timestamp)}` : ""}</label>
      <p>${escapeHTML(exchange.answer || "（未识别到完整回答）")}</p>
    </div>`).join("") : "";
    const body = item.roleExpanded
      ? `${previews || '<div class="role-more">未形成完整问答，请检查待确认发言。</div>'}${exchangeCount > previewCount ? `<div class="role-more">另有 ${exchangeCount - previewCount} 组问答，将完整写入 Word。</div>` : ""}`
      : `<div class="role-more role-collapsed-note">已折叠预览 · ${exchangeCount ? `点击展开查看前 ${previewCount} 组问答` : "未形成完整问答"} · Word 会导出完整内容</div>`;
    return `<section class="role-document ${item.roleExpanded ? "expanded" : "collapsed"}">
      <div class="role-document-head">
        <label class="role-doc-select">
          <input class="role-doc-check" type="checkbox" data-index="${itemIndex}" ${item.roleSelected === true ? "checked" : ""} />
          <strong>${escapeHTML(item.id)} · ${escapeHTML(item.name)}</strong>
        </label>
        <div class="role-doc-meta"><span>${exchangeCount} 组问答 · ${result.average_confidence || 0}% <button class="confidence-info-button" type="button" aria-label="查看角色区分置信度说明" title="查看角色区分置信度说明">i</button></span><button class="role-toggle" type="button" data-index="${itemIndex}">${item.roleExpanded ? "收起" : "展开预览"}</button></div>
      </div>
      ${body}
    </section>`;
  }).join("");

  $$(".role-doc-check").forEach((checkbox) => checkbox.addEventListener("change", (event) => {
    const item = roleMappedInterviews()[+event.currentTarget.dataset.index];
    if (item) item.roleSelected = event.currentTarget.checked;
    renderRoleMapper();
  }));
  $$(".role-toggle").forEach((button) => button.addEventListener("click", (event) => {
    const item = roleMappedInterviews()[+event.currentTarget.dataset.index];
    if (item) item.roleExpanded = !item.roleExpanded;
    renderRoleMapper();
  }));
  $$(".confidence-info-button").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    showConfidencePopover(event.currentTarget);
  }));
}

async function identifyRoleForInterview(index) {
  const item = state.interviews[index];
  if (!item?.text) return toast("请先完成该访谈的转录");
  item.selected = true;
  await identifyRolesForItems([item]);
}

async function identifyRolesForItems(ready) {
  if (!ready.length) return toast("请先选择至少一份已转录访谈");
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 本地服务");
  if (!state.apiConfigured) return openApiSettings(() => identifyRolesForItems(ready));
  state.roleProcessing = true;
  state.roleProgress = { total: ready.length, current: 1, currentName: ready[0]?.id || "所选访谈", percent: 3 };
  renderRoleMapper();
  let completedCount = 0;
  let ticker = null;
  try {
    for (let index = 0; index < ready.length; index += 1) {
      const item = ready[index];
      const basePercent = Math.round((index / ready.length) * 100);
      const ceilingPercent = Math.max(basePercent + 5, Math.round(((index + 0.88) / ready.length) * 100));
      state.roleProgress = { total: ready.length, current: index + 1, currentName: item.id, percent: Math.max(3, basePercent) };
      item.status = "角色区分中";
      item.progressText = `正在区分对话角色（${state.roleProgress.percent}%）`;
      renderAll();
      clearInterval(ticker);
      ticker = setInterval(() => {
        if (!state.roleProcessing || !state.roleProgress || item.status !== "角色区分中") return;
        state.roleProgress.percent = Math.min(ceilingPercent, Math.round((state.roleProgress.percent || basePercent) + Math.max(1, 10 / ready.length)));
        item.progressText = `正在区分对话角色（${state.roleProgress.percent}%）`;
        renderAll();
      }, 900);
      const response = await fetch(`${API_BASE}/api/roles/identify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents: [{ id: item.id, name: item.name, type: item.type, text: item.text }] })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        item.status = "角色区分失败";
        item.progressText = "角色区分失败，可点击“重新区分”重试。";
        item.error = humanizeFileTransferError(data.error || `${item.id} 角色区分失败`);
        await persistInterview(state.interviews.indexOf(item));
        throw new Error(data.error || `${item.id} 角色区分失败`);
      }
      clearInterval(ticker);
      ticker = null;
      const result = data.results?.[0];
      if (result) {
        item.roleResult = result;
        item.roleSelected = true;
        item.roleExpanded = false;
        item.status = "已转录";
        item.progressText = "角色区分完成，可在下方预览并导出 Word。";
        item.error = "";
        completedCount += 1;
        await persistInterview(state.interviews.indexOf(item));
      }
      state.roleProgress = { total: ready.length, current: index + 1, currentName: item.id, percent: Math.round(((index + 1) / ready.length) * 100) };
      renderAll();
    }
    toast(`已完成 ${completedCount} 份访谈的角色区分`);
  } catch (error) {
    toast(error.message);
  } finally {
    clearInterval(ticker);
    state.roleProcessing = false;
    state.roleProgress = null;
    renderAll();
  }
}

async function identifySelectedRoles() {
  const ready = selectedInterviews().filter((item) => item.text);
  return identifyRolesForItems(ready);
}

async function deleteSelectedRoleDocs() {
  const items = selectedRoleDocuments();
  if (!items.length) return toast("请先勾选需要删除的角色区分结果");
  if (!confirm(`确定删除选中的 ${items.length} 份角色区分结果吗？原始文件和转录文本会保留，可重新区分角色。`)) return;
  const indexes = items.map((item) => state.interviews.indexOf(item)).filter((index) => index >= 0);
  for (const index of indexes) {
    const item = state.interviews[index];
    item.roleResult = null;
    item.roleSelected = false;
    item.roleExpanded = false;
    await persistInterview(index);
  }
  renderAll();
  toast(`已删除 ${indexes.length} 份角色区分结果，原始访谈资料已保留`);
}

async function exportRoleWord() {
  const documents = selectedRoleDocuments().map((item) => item.roleResult).filter(Boolean);
  if (!documents.length) return toast("请先勾选至少一份已完成角色区分的访谈");
  toast("正在生成一问一答 Word…");
  try {
    const response = await fetch(`${API_BASE}/api/export/role-docx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectName: state.projectName, documents })
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Word 生成失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "MedVoice-role-labeled-transcript.docx";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    toast("一问一答 Word 已生成");
  } catch (error) {
    toast(error.message);
  }
}

function extractQuestions(text) {
  const lines = String(text || "").split(/\n+/).map((line) => line.replace(/^\s*(?:[-*•]+|(?:Q(?:uestion)?\s*)?\d+[.、):：-]?|[（(]?\d+[）)])\s*/i, "").trim()).filter((line) => line.length >= 4);
  const explicit = lines.filter((line) => /[?？]$/.test(line) || /^(如何|是否|哪些|什么|为何|为什么|怎样|请|谈谈|描述|how|what|why|which|when|where|do |does |is |are )/i.test(line));
  return [...new Set(explicit.length >= 2 ? explicit : lines)].slice(0, 50);
}

function parseOutlineFromText() {
  state.outlineText = $("#outlineInput").value.trim();
  state.questions = extractQuestions(state.outlineText);
  state.outlineSource = state.outlineSource || "手动输入";
  renderQuestions();
  saveCurrentProjectWorkspace();
  renderAll();
  toast(state.questions.length ? `已识别 ${state.questions.length} 个主要问题` : "尚未识别到问题，请检查大纲格式");
}

async function uploadOutline(file) {
  const form = new FormData();
  form.append("file", file);
  try {
    const response = await fetch(`${API_BASE}/api/outline/parse`, { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "大纲解析失败");
    state.outlineText = data.text;
    state.outlineSource = data.filename;
    state.questions = data.questions || extractQuestions(data.text);
    $("#outlineInput").value = state.outlineText;
    saveCurrentProjectWorkspace();
    renderAll();
    toast(`已从 ${data.filename} 识别 ${state.questions.length} 个问题`);
  } catch (error) {
    toast(error.message.includes("fetch") ? "请先启动 MedVoice 本地服务，再解析 Word / PDF" : error.message);
  }
}

function renderQuestions() {
  $("#questionCount").textContent = state.questions.length;
  $("#questionList").innerHTML = state.questions.length
    ? state.questions.map((question, index) => `<div class="question-item"><span>Q${index + 1}</span><p>${escapeHTML(question)}</p></div>`).join("")
    : '<div class="empty-compact">上传或输入大纲后，将在这里显示逐题分析框架。</div>';
  $("#outlineSource").textContent = state.outlineSource ? `来源：${state.outlineSource}` : "尚未载入大纲";
}

function selectedInterviews() {
  return state.interviews.filter((item) => item.selected);
}

function renderReadiness() {
  const selected = selectedInterviews();
  const ready = selected.filter((item) => item.text).length;
  $("#readyFiles").textContent = `${ready} / ${selected.length}`;
  $("#readyQuestions").textContent = `${state.questions.length} 题`;
  const isReady = ready > 0 && ready === selected.length && state.questions.length > 0;
  $("#readyStatus").textContent = isReady ? "可以分析" : "未就绪";
  $("#runOutlineAnalysis").disabled = !isReady;
}

function renderOverview() {
  const report = state.report;
  const selectedCount = state.interviews.length;
  const transcribed = state.interviews.filter((item) => item.text).length;
  const hcpCount = state.interviews.filter((item) => normalizeRespondentType(item.type) === "HCP").length;
  const patientCount = state.interviews.filter((item) => normalizeRespondentType(item.type) === "Patient").length;
  $("#metricInterviews").innerHTML = `${state.matrix.length || 0} <em>份</em>`;
  $("#metricTypes").textContent = selectedCount ? `${hcpCount} HCP${patientCount ? ` · ${patientCount} Patient` : ""}` : "等待导入资料";
  $("#metricTranscribed").innerHTML = `${transcribed} <em>份</em>`;
  $("#metricQuestions").innerHTML = `${state.questions.length}<em>题</em>`;
  $("#metricInsights").innerHTML = `${report?.top_insights?.length || 0} <em>项</em>`;
  renderInsights();
  renderSignals();
  const contradictionCount = state.analyses.reduce((sum, item) => sum + (item.contradictions?.length || 0), 0);
  $(".contradiction-card h3").textContent = report ? `AI 发现 ${contradictionCount} 组关键分歧` : "等待识别跨样本分歧";
  $(".contradiction-card p").textContent = report ? "分歧与反例不会被平均结论掩盖，可在问题矩阵中逐项核验。" : "完成大纲驱动分析后，将在这里显示观点分层与反例。";
}

function renderInsights(filter = "all") {
  const list = $("#insightList");
  if (!state.report?.top_insights?.length) {
    list.innerHTML = '<div class="empty-dashboard"><div><strong>暂无洞察结果</strong>先导入访谈、完成转录，再进入“大纲驱动·并发分析”。</div></div>';
    return;
  }
  const insights = state.report.top_insights.filter((item) => filter === "all" || (filter === "high" && item.confidence >= 85) || (filter === "action" && item.implication));
  list.innerHTML = insights.map((item, index) => `<button class="insight-item" data-insight="${state.report.top_insights.indexOf(item)}"><span class="insight-rank">${String(index + 1).padStart(2, "0")}</span><span><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.insight)}</p><span class="insight-meta"><em class="confidence">置信度 ${item.confidence}%</em><em class="evidence-count">${item.evidence?.length || 0} 条原话</em></span></span><span class="score-ring" style="--score:${item.confidence}"><strong>${item.confidence}</strong></span></button>`).join("");
  $$(".insight-item").forEach((button) => button.addEventListener("click", () => openEvidence(+button.dataset.insight)));
}

function renderSignals() {
  const chart = $("#signalChart");
  if (!state.matrix.length || !state.questions.length) {
    chart.innerHTML = '<div class="empty-compact">分析后显示各问题的完整覆盖、部分覆盖与未覆盖比例。</div>';
    return;
  }
  chart.innerHTML = state.questions.slice(0, 8).map((question, index) => {
    const answers = state.matrix.map((row) => row.answers?.[index]).filter(Boolean);
    const total = Math.max(answers.length, 1);
    const full = answers.filter((item) => item.coverage === "完整覆盖").length;
    const partial = answers.filter((item) => item.coverage === "部分覆盖").length;
    const missing = total - full - partial;
    return `<div class="signal-row"><span title="${escapeHTML(question)}">Q${index + 1} ${escapeHTML(question)}</span><span class="stack-bar"><i class="positive" style="width:${full / total * 100}%"></i><i class="mid" style="width:${partial / total * 100}%"></i><i class="negative" style="width:${missing / total * 100}%"></i></span><strong>${full}/${total}</strong></div>`;
  }).join("");
}

function renderMatrix() {
  const table = $("#matrixTable");
  if (!state.questions.length) {
    table.innerHTML = '<tbody><tr><td class="empty-row">请先在“大纲驱动·并发分析”中导入研究大纲。</td></tr></tbody>';
    renderGaps();
    return;
  }
  const headers = state.questions.map((question, index) => `<th class="question-header">Q${index + 1}<br>${escapeHTML(question)}</th>`).join("");
  if (!state.matrix.length) {
    table.innerHTML = `<thead><tr><th>HCP / 受访者</th>${headers}</tr></thead><tbody><tr><td colspan="${state.questions.length + 1}" class="empty-row">大纲框架已建立。完成并发分析后生成逐题矩阵。</td></tr></tbody>`;
    renderGaps();
    return;
  }
  table.innerHTML = `<thead><tr><th>HCP / 受访者</th>${headers}</tr></thead><tbody>${state.matrix.map((row, rowIndex) => `<tr><td><strong>${escapeHTML(row.document_id)}</strong><small>${escapeHTML(row.name || row.type)}</small></td>${state.questions.map((_, questionIndex) => {
    const answer = row.answers?.[questionIndex] || { answer: "未覆盖", coverage: "未覆盖", quotes: [] };
    const cls = answer.coverage === "完整覆盖" ? "yes" : answer.coverage === "部分覆盖" ? "mixed" : "no";
    return `<td class="answer-cell" data-row="${rowIndex}" data-question="${questionIndex}">${escapeHTML(answer.answer)}<br><span class="coverage-badge ${cls}">${escapeHTML(answer.coverage)}</span></td>`;
  }).join("")}</tr>`).join("")}</tbody>`;
  $$(".answer-cell").forEach((cell) => cell.addEventListener("click", () => selectMatrixEvidence(+cell.dataset.row, +cell.dataset.question)));
  $("#exportExcel").disabled = false;
  renderGaps();
}

function renderGaps() {
  const container = $("#gapList");
  if (!state.matrix.length) {
    container.innerHTML = '<div class="empty-compact">完成分析后，自动统计未覆盖问题与补访优先级。</div>';
    return;
  }
  const gaps = state.questions.map((question, index) => {
    const missing = state.matrix.filter((row) => row.answers?.[index]?.coverage === "未覆盖").length;
    return { question, index, missing };
  }).filter((item) => item.missing).sort((a, b) => b.missing - a.missing).slice(0, 5);
  container.innerHTML = gaps.length ? gaps.map((item) => `<div class="gap-item"><strong>Q${item.index + 1} · ${escapeHTML(item.question)}</strong><p>${item.missing} / ${state.matrix.length} 份访谈未覆盖，建议补访或回看追问段落。</p><span>补访优先</span></div>`).join("") : '<div class="empty-compact">所有大纲问题均有样本覆盖；仍建议人工核验回答深度。</div>';
}

function selectMatrixEvidence(rowIndex, questionIndex) {
  const row = state.matrix[rowIndex];
  const answer = row.answers?.[questionIndex];
  const quote = answer?.quotes?.[0];
  state.currentQuote = quote ? `“${quote.quote}” — ${row.document_id}` : "该单元格没有可用逐字引文。";
  $("#matrixQuote").textContent = quote ? `“${quote.quote}”` : "该回答没有可用逐字引文，请回看原始笔录。";
  $("#quoteSource").textContent = `${row.document_id} · ${row.name || row.type}`;
  $("#quoteQuestion").textContent = `Q${questionIndex + 1} · ${answer?.coverage || "未覆盖"}`;
  $("#copyQuote").disabled = !quote;
}

function renderReport() {
  const paper = $("#reportPaper");
  const enabled = Boolean(state.report);
  ["#copyReport", "#exportWord", "#exportPpt"].forEach((selector) => { $(selector).disabled = !enabled; });
  if (!state.report) {
    paper.innerHTML = '<div class="empty-dashboard" style="min-height:700px"><div><strong>报告尚未生成</strong>报告将基于大纲逐题分析矩阵，自动形成结论、证据、影响与建议。</div></div>';
    $("#reportConfidence").textContent = "—";
    $("#reportConfidenceBar").style.width = "0";
    $("#reportEvidenceCount").textContent = "等待分析证据";
    return;
  }
  const report = state.report;
  const evidenceCount = report.top_insights.reduce((sum, insight) => sum + (insight.evidence?.length || 0), 0);
  const confidence = report.top_insights.length ? Math.round(report.top_insights.reduce((sum, item) => sum + item.confidence, 0) / report.top_insights.length) : 0;
  $("#reportConfidence").textContent = `${confidence}%`;
  $("#reportConfidenceBar").style.width = `${confidence}%`;
  $("#reportEvidenceCount").textContent = `基于 ${state.matrix.length} 份访谈、${evidenceCount} 条证据`;
  paper.innerHTML = `<div class="report-cover"><small>QUALITATIVE INSIGHT REPORT · AI DRAFT</small><h1>${escapeHTML(state.projectName)}<br>HCP 深度访谈洞察报告</h1><p>MedVoice Insight 自动生成草案 · 待研究负责人复核</p></div><section class="report-section"><span>01 / EXECUTIVE SUMMARY</span><h2>执行摘要</h2><p>${escapeHTML(report.executive_summary)}</p></section><section class="report-section"><span>02 / CORE INSIGHTS</span><h2>核心洞察</h2>${report.top_insights.map((insight, index) => `<div class="report-insight"><h3>${String(index + 1).padStart(2, "0")} · ${escapeHTML(insight.title)}</h3><p>${escapeHTML(insight.insight)}</p>${insight.evidence?.[0] ? `<blockquote>“${escapeHTML(insight.evidence[0].quote)}” — ${escapeHTML(insight.evidence[0].document_id)}</blockquote>` : ""}<p><strong>策略影响：</strong>${escapeHTML(insight.implication)}</p></div>`).join("")}</section><section class="report-section"><span>03 / UNMET NEEDS</span><h2>未满足需求</h2><ol class="report-actions">${(report.unmet_needs || []).map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ol></section><section class="report-section"><span>04 / STRATEGIC ACTIONS</span><h2>建议的下一步行动</h2><ol class="report-actions">${(report.strategic_actions || []).map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ol></section><section class="report-section"><span>05 / RESEARCH CAVEATS</span><h2>研究边界</h2><ol class="report-actions">${(report.caveats || []).map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ol></section>`;
}

function openEvidence(index) {
  const insight = state.report?.top_insights?.[index];
  if (!insight) return;
  $("#evidenceContent").innerHTML = `<div class="eyebrow">INSIGHT EVIDENCE CHAIN</div><h2>${escapeHTML(insight.title)}</h2><p class="evidence-summary">${escapeHTML(insight.insight)}</p><div class="impact-box"><strong>策略影响</strong><br>${escapeHTML(insight.implication)}</div><div class="eyebrow">VERBATIM EVIDENCE · ${insight.evidence?.length || 0}</div>${(insight.evidence || []).map((evidence) => `<blockquote>“${escapeHTML(evidence.quote)}”<small>${escapeHTML(evidence.document_id)} · 已回链至原始笔录</small></blockquote>`).join("")}<p class="evidence-summary">置信度 ${insight.confidence}% · ${insight.prevalence} 份访谈支持。样本覆盖不代表总体发生率。</p>`;
  $("#evidenceDialog").showModal();
}

function setPipeline(step, percent, text) {
  $$("#pipeline>div").forEach((element, index) => {
    element.classList.toggle("done", index < step);
    element.classList.toggle("active", index === step);
    element.querySelector("em").textContent = index < step ? "完成" : index === step ? "处理中" : "等待";
  });
  $("#progressBar").style.width = `${percent}%`;
  $("#progressText").textContent = text;
}

async function runAnalysis() {
  const selected = selectedInterviews();
  if (!selected.length) return toast("请先选择至少一份访谈");
  if (selected.some((item) => !item.text)) return toast("所选访谈中仍有待转录文件，请先逐一点击“转录”");
  if (!state.questions.length) return toast("请先导入大纲并识别主要问题");
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 本地服务");
  if (!state.apiConfigured) return openApiSettings(runAnalysis);
  const dialog = $("#analysisDialog");
  dialog.showModal();
  setPipeline(0, 12, "正在执行隐私检查与角色映射…");
  try {
    await new Promise((resolve) => setTimeout(resolve, 280));
    setPipeline(1, 38, `正在并发分析 ${selected.length} 份访谈 × ${state.questions.length} 个问题…`);
    const response = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectName: state.projectName, outline: state.outlineText, questions: state.questions, documents: selected.map(({ id, name, type, text }) => ({ id, name, type, text })) })
    });
    setPipeline(2, 70, "正在识别共识、分歧、反例与信息缺口…");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "分析失败");
    state.report = data.report;
    state.analyses = data.analyses;
    state.matrix = data.matrix;
    state.questions = data.questions;
    saveCurrentProjectWorkspace();
    setPipeline(3, 93, "正在校验洞察与逐字引文证据链…");
    renderAll();
    await new Promise((resolve) => setTimeout(resolve, 420));
    setPipeline(4, 100, "分析完成");
    await new Promise((resolve) => setTimeout(resolve, 260));
    dialog.close();
    showView("matrix");
    toast("并发分析完成：逐题矩阵与洞察报告已生成");
  } catch (error) {
    dialog.close();
    toast(error.message);
  }
}

function exportPayload() {
  return { projectName: state.projectName, questions: state.questions, matrix: state.matrix, report: state.report };
}

async function downloadExport(kind) {
  const labels = { xlsx: "Excel 矩阵", docx: "Word 报告", pptx: "PPT Deck" };
  toast(`正在生成${labels[kind]}…`);
  try {
    const response = await fetch(`${API_BASE}/api/export/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(exportPayload()) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "导出失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `MedVoice-export.${kind}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(`${labels[kind]}已生成`);
  } catch (error) {
    toast(error.message.includes("fetch") ? "请先启动 MedVoice 本地服务" : error.message);
  }
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("当前浏览器不支持实时录音");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      const session = state.recording;
      const durationSeconds = Math.max(1, getRecordingElapsedSeconds(session));
      const draftText = String(session?.livePreviewText || $("#liveTranscript").textContent || "").replace(/^(正在聆听…|尚未开始)$/u, "").trim();
      const extension = recorder.mimeType.includes("mp4") ? "m4a" : "webm";
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = new File([blob], `Live-recording-${timestamp}.${extension}`, { type: blob.type });
      stream.getTracks().forEach((track) => track.stop());
      stopSpeechPreview();
      clearInterval(session?.timer);
      state.recording = null;
      $("#recordingConsole").classList.remove("active");
      $("#recordingStatus").textContent = "录音已保存";
      $("#startRecording").disabled = false;
      $("#pauseRecording").disabled = true;
      $("#pauseRecording").textContent = "暂停";
      $("#stopRecording").disabled = true;
      const [newIndex] = await addFiles([file], {
        source: "实时录音",
        type: $("#recordRespondentType").value,
        durationSeconds,
        draftText,
        recordedAt: new Date().toLocaleString("zh-CN", { hour12: false })
      });
      if (Number.isInteger(newIndex) && $("#autoTranscribeRecording").checked) {
        toast("录音已同步至“已导入资料”，正在自动转录", 4000);
        await transcribeInterview(newIndex);
      } else {
        toast("录音已同步至“已导入资料”，可点击“转录”后区分角色", 4500);
      }
    };
    recorder.start(1000);
    state.recording = { recorder, stream, startedAt: Date.now(), pausedAt: 0, pauseStarted: null, livePreviewText: "", timer: setInterval(updateRecordingTime, 500) };
    $("#recordingConsole").classList.add("active");
    $("#recordingStatus").textContent = "正在录音";
    $("#recordingTime").textContent = "00:00";
    $("#startRecording").disabled = true;
    $("#pauseRecording").disabled = false;
    $("#pauseRecording").textContent = "暂停";
    $("#stopRecording").disabled = false;
    $("#liveTranscript").textContent = "正在聆听…";
    startSpeechPreview();
  } catch (error) {
    toast(error.name === "NotAllowedError" ? "麦克风权限未开启" : `无法开始录音：${error.message}`);
  }
}

function getRecordingElapsedSeconds(session, now = Date.now()) {
  if (!session?.startedAt) return 0;
  const activePausedMs = session.pauseStarted ? now - session.pauseStarted : 0;
  return Math.max(0, (now - session.startedAt - session.pausedAt - activePausedMs) / 1000);
}

function updateRecordingTime() {
  if (!state.recording) return;
  const seconds = getRecordingElapsedSeconds(state.recording);
  $("#recordingTime").textContent = formatDuration(seconds);
}

function pauseRecording() {
  const current = state.recording;
  if (!current) return;
  if (current.recorder.state === "recording") {
    current.recorder.pause();
    current.pauseStarted = Date.now();
    updateRecordingTime();
    $("#pauseRecording").textContent = "继续";
    $("#recordingStatus").textContent = "录音已暂停";
  } else if (current.recorder.state === "paused") {
    current.pausedAt += Date.now() - current.pauseStarted;
    current.pauseStarted = null;
    current.recorder.resume();
    updateRecordingTime();
    $("#pauseRecording").textContent = "暂停";
    $("#recordingStatus").textContent = "正在录音";
  }
}

function stopRecording() {
  if (state.recording?.recorder && state.recording.recorder.state !== "inactive") {
    state.recording.recorder.stop();
  }
}

function startSpeechPreview() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("#liveTranscript").textContent = "当前浏览器不支持实时文字预览；录音仍会正常保存并支持 AI 中英文转录。";
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = $("#recordLanguage").value;
  recognition.continuous = true;
  recognition.interimResults = true;
  let finalText = "";
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) finalText += `${text} `; else interim += text;
    }
    const previewText = finalText + interim;
    $("#liveTranscript").textContent = previewText;
    if (state.recording) state.recording.livePreviewText = previewText;
  };
  recognition.onerror = () => {};
  recognition.start();
  state.recording.recognition = recognition;
}

function stopSpeechPreview() {
  try { state.recording?.recognition?.stop(); } catch {}
}

function renderAll() {
  renderProjectSwitcher();
  renderTranscripts();
  renderRoleMapper();
  renderQuestions();
  renderReadiness();
  renderOverview();
  renderMatrix();
  renderReport();
}

$$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-view-jump]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewJump)));
$$("[data-insight-filter]").forEach((button) => button.addEventListener("click", () => { $$("[data-insight-filter]").forEach((item) => item.classList.remove("active")); button.classList.add("active"); renderInsights(button.dataset.insightFilter); }));
$$("dialog .dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.addEventListener("click", (event) => { if (!event.target.closest(".confidence-info-button") && !event.target.closest("#confidenceFloatingPopover")) hideConfidencePopover(); });
window.addEventListener("scroll", hideConfidencePopover, true);
window.addEventListener("resize", hideConfidencePopover);
$("#cancelAnalysis").addEventListener("click", () => $("#analysisDialog").close());
$("#goCollect").addEventListener("click", () => showView("transcripts"));
$("#goAnalyze").addEventListener("click", () => showView("outline"));
$("#newAnalysis").addEventListener("click", createProject);
$("#uploadButton").addEventListener("click", () => $("#fileInput").click());
$("#browseButton").addEventListener("click", (event) => { event.stopPropagation(); $("#fileInput").click(); });
$("#uploadZone").addEventListener("click", (event) => { if (!event.target.closest("button")) $("#fileInput").click(); });
$("#uploadZone").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") $("#fileInput").click(); });
$("#fileInput").addEventListener("change", (event) => addFiles([...event.target.files]));
["dragenter", "dragover"].forEach((name) => $("#uploadZone").addEventListener(name, (event) => { event.preventDefault(); $("#uploadZone").classList.add("dragging"); }));
["dragleave", "drop"].forEach((name) => $("#uploadZone").addEventListener(name, (event) => { event.preventDefault(); $("#uploadZone").classList.remove("dragging"); }));
$("#uploadZone").addEventListener("drop", (event) => addFiles([...event.dataTransfer.files]));
$("#selectAll").addEventListener("click", () => { state.interviews.forEach((item) => { item.selected = true; }); renderAll(); });
$("#masterCheck").addEventListener("change", (event) => { state.interviews.forEach((item) => { item.selected = event.target.checked; }); renderAll(); });
$("#clearFiles").addEventListener("click", async () => {
  const selected = state.interviews.filter((item) => item.selected);
  if (!state.interviews.length) return toast("当前没有可删除的资料");
  if (!selected.length) return toast("请先勾选需要删除的资料");
  const deletingAll = selected.length === state.interviews.length;
  const message = deletingAll
    ? `你已选中全部 ${selected.length} 份资料。确定删除全部已导入资料吗？此操作会同步删除服务端保存的原始文件。`
    : `确定删除选中的 ${selected.length} 份资料吗？此操作会同步删除服务端保存的原始文件。`;
  if (!confirm(message)) return;
  for (const item of selected) {
    rememberDeletedInterview(item);
    if (item.serverId) {
      await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(item.serverId)}`, { method: "DELETE" }).catch(() => {});
    }
    await deleteLocalInterview(item);
  }
  const selectedKeys = new Set(selected.map((item) => item.serverId || item.id));
  state.allInterviews = state.allInterviews.filter((item) => !selectedKeys.has(item.serverId || item.id));
  syncCurrentProjectInterviews();
  state.matrix = [];
  state.report = null;
  state.analyses = [];
  renderAll();
  toast(`已删除 ${selected.length} 份选中资料`);
});
$("#recordButton").addEventListener("click", (event) => { event.stopPropagation(); $("#recordingConsole").hidden = !$("#recordingConsole").hidden; });
$("#startRecording").addEventListener("click", startRecording);
$("#pauseRecording").addEventListener("click", pauseRecording);
$("#stopRecording").addEventListener("click", stopRecording);
$("#selectAllRoleDocs").addEventListener("click", () => {
  const completed = roleMappedInterviews();
  const shouldSelectAll = selectedRoleDocuments().length !== completed.length;
  completed.forEach((item) => { item.roleSelected = shouldSelectAll; });
  renderRoleMapper();
});
$("#deleteRoleDocs").addEventListener("click", deleteSelectedRoleDocs);
$("#exportRoleWord").addEventListener("click", exportRoleWord);
$("#browseOutline").addEventListener("click", (event) => { event.stopPropagation(); $("#outlineFile").click(); });
$("#outlineUpload").addEventListener("click", (event) => { if (!event.target.closest("button")) $("#outlineFile").click(); });
$("#outlineUpload").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") $("#outlineFile").click(); });
$("#outlineFile").addEventListener("change", (event) => { if (event.target.files[0]) uploadOutline(event.target.files[0]); });
$("#parseOutline").addEventListener("click", parseOutlineFromText);
$("#outlineInput").addEventListener("input", () => { state.outlineText = $("#outlineInput").value; state.outlineSource = "手动输入"; saveCurrentProjectWorkspace(); });
$("#clearOutline").addEventListener("click", () => { state.outlineText = ""; state.outlineSource = ""; state.questions = []; $("#outlineInput").value = ""; saveCurrentProjectWorkspace(); renderAll(); });
$("#runOutlineAnalysis").addEventListener("click", runAnalysis);
$("#exportExcel").addEventListener("click", () => downloadExport("xlsx"));
$("#exportWord").addEventListener("click", () => downloadExport("docx"));
$("#exportPpt").addEventListener("click", () => downloadExport("pptx"));
$("#copyQuote").addEventListener("click", async () => { if (state.currentQuote) { await navigator.clipboard?.writeText(state.currentQuote); toast("原话与来源已复制"); } });
$("#copyReport").addEventListener("click", async () => { await navigator.clipboard?.writeText($("#reportPaper").innerText); toast("报告全文已复制"); });
$("#helpButton").addEventListener("click", () => toast("流程：采集/上传 → 逐份转录 → 导入大纲 → 并发分析 → 导出 Excel / Word / PPT"));
$("#apiSettingsButton").addEventListener("click", () => {
  if (state.apiKeySource === "server") return toast("AI Key 由企业服务端安全管理，无需个人配置");
  if (state.authRequired && state.currentUser?.role !== "admin") return toast("请联系 Portal 管理员配置 AI 服务");
  openApiSettings();
});
$("#adminAccess").addEventListener("click", () => { location.href = ADMIN_URL; });
$("#portalLogout").addEventListener("click", async () => { await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: location.protocol === "file:" ? "include" : "same-origin" }); location.href = LOGIN_URL; });
$("#apiSettingsForm").addEventListener("submit", saveApiSettings);
$("#clearApiKey").addEventListener("click", clearApiSettings);
$("#cancelApiSettings").addEventListener("click", () => { state.pendingAfterConnect = null; $("#apiSettingsDialog").close(); });
$("#toggleApiKey").addEventListener("click", () => {
  const input = $("#apiKeyInput");
  input.type = input.type === "password" ? "text" : "password";
  $("#toggleApiKey").textContent = input.type === "password" ? "显示" : "隐藏";
});
function renameCurrentProject() {
  const name = prompt("请输入当前研究项目名称", state.projectName);
  if (!name?.trim()) return;
  const project = currentProject();
  project.name = name.trim().slice(0, 80);
  state.projectName = project.name;
  state.interviews.forEach((item) => { item.projectName = project.name; });
  saveProjects();
  saveCurrentProjectWorkspace();
  renderAll();
  state.interviews.forEach((_, index) => persistInterview(index));
  toast("研究项目名称已更新");
}

function createProject() {
  const name = prompt("请输入新研究项目名称", `新研究 ${state.projects.length + 1}`);
  if (!name?.trim()) return;
  const project = { id: createProjectId(), name: name.trim().slice(0, 80) };
  state.projects.push(project);
  setActiveProject(project.id);
  showView("transcripts");
  toast(`已创建研究：${project.name}`);
}

$("#projectSelect").addEventListener("change", (event) => setActiveProject(event.target.value));
$("#renameProject").addEventListener("click", renameCurrentProject);
$("#createProject").addEventListener("click", createProject);
window.addEventListener("hashchange", () => showView(savedView(), { updateHash: false }));

async function initializeApp() {
  const initialView = savedView(INITIAL_HASH);
  loadProjects();
  loadCurrentProjectWorkspace();
  showView(initialView, { updateHash: true, scroll: false });
  renderAll();
  await checkPortalSession();
  const health = await checkHealth();
  try {
    await loadInterviewLibrary();
  } catch (error) {
    console.warn("MedVoice library bootstrap failed", error);
    toast(`账号资料加载失败：${error.message}`, 6000);
  }
  showView(savedView(location.hash || INITIAL_HASH), { updateHash: true, scroll: false });
  if (!health) toast("连接状态检查失败，请稍后刷新或查看 Render 服务状态", 4200);
}

initializeApp().catch((error) => {
  console.error("MedVoice initialization failed", error);
  toast(`页面初始化异常：${error.message}`, 7000);
});
