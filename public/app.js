const state = {
  projectName: "未命名访谈项目",
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
  roleProcessing: false,
  recording: null,
  currentQuote: null
};

const API_BASE = location.protocol === "file:" ? "http://127.0.0.1:4174" : "";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function toast(message, duration = 2600) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), duration);
}

function showView(view) {
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `${view}-view`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE}/api/health`);
    const data = await response.json();
    state.apiConfigured = Boolean(data.apiConfigured);
    state.apiKeySource = data.apiKeySource || "none";
    $("#modeLabel").textContent = state.apiConfigured ? "AI 已连接" : "待配置 API";
    $("#modeLabel").style.color = state.apiConfigured ? "#dff25b" : "#f0b8a0";
    $("#apiSettingsLabel").textContent = state.apiKeySource === "server" ? "AI 企业服务" : state.apiConfigured ? "AI 已连接" : "连接 AI";
    $("#apiSettingsButton").classList.toggle("connected", state.apiConfigured);
    return data;
  } catch {
    state.apiConfigured = false;
    $("#modeLabel").textContent = "本地服务未启动";
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
      const requestsResponse = await fetch(`${API_BASE}/api/admin/requests`);
      const requestsData = await requestsResponse.json();
      const pendingCount = (requestsData.requests || []).filter((item) => item.status === "pending").length;
      $("#adminAccess").textContent = pendingCount ? `Access 管理 · ${pendingCount}` : "Access 管理";
      $("#adminAccess").title = pendingCount ? `${pendingCount} 个试用申请待审批` : "暂无待审批申请";
    }
  } catch {}
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

function nextId() {
  return `HCP-${String(state.interviews.length + 1).padStart(3, "0")}`;
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
    const text = isText ? await file.text() : "";
    const metadata = Number.isFinite(options.durationSeconds)
      ? { seconds: options.durationSeconds, label: formatDuration(options.durationSeconds) }
      : await mediaMetadata(file);
    const index = state.interviews.length;
    state.interviews.push({
      id: nextId(),
      name: file.name,
      type: options.type === "患者" ? "患者" : "HCP",
      duration: metadata.label,
      durationSeconds: metadata.seconds,
      status: isText ? "可分析" : options.source === "实时录音" ? "录音已保存" : "待转录",
      text,
      file,
      source: options.source || "上传文件",
      recordedAt: options.recordedAt || "",
      error: "",
      selected: true
    });
    added += 1;
    addedIndexes.push(index);
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
      const isMedia = item.file && !/\.(txt|md|csv|json)$/i.test(item.name);
      const actionLabel = isMedia ? (item.text ? "重新转录" : item.status === "转录失败" ? "重试" : "转录") : "无需转录";
      const statusClass = item.status.includes("中") ? "processing" : item.status === "转录失败" ? "failed" : item.status === "录音已保存" ? "saved" : "";
      const sourceLabel = item.source === "实时录音" ? `实时录音${item.recordedAt ? ` · ${escapeHTML(item.recordedAt)}` : ""}` : "上传文件";
      return `<tr>
        <td><input class="row-check" type="checkbox" data-index="${index}" ${item.selected ? "checked" : ""} aria-label="选择 ${escapeHTML(item.id)}" /></td>
        <td><strong>${escapeHTML(item.id)} · ${escapeHTML(item.name)}</strong><small class="${item.file?.size > 24 * 1024 * 1024 && !item.text ? "large-file-note" : "file-size-note"}">${item.roleResult ? "已区分角色 · 可导出问答 Word" : item.text ? "已建立逐字稿" : item.file?.size > 24 * 1024 * 1024 ? `${formatFileSize(item.file.size)} · 将本地提取音轨并自动分片` : `${formatFileSize(item.file?.size)} · 等待语音转录`}</small><span class="source-badge ${item.source === "实时录音" ? "live" : ""}">${sourceLabel}</span>${item.error ? `<small class="file-error">失败原因：${escapeHTML(item.error)}</small>` : ""}</td>
        <td><select class="type-select" data-index="${index}" aria-label="受访者类型"><option value="HCP" ${item.type === "HCP" ? "selected" : ""}>HCP</option><option value="患者" ${item.type === "患者" ? "selected" : ""}>患者</option></select></td>
        <td>${escapeHTML(item.duration)}</td>
        <td><span class="status-pill ${statusClass}">${escapeHTML(item.status)}</span>${item.progressText ? `<small class="transcript-progress">${escapeHTML(item.progressText)}</small>` : ""}</td>
        <td><button class="transcribe-button ${item.status === "转录失败" ? "retry" : ""}" data-index="${index}" ${isMedia ? "" : "disabled"}>${actionLabel}</button></td>
      </tr>`;
    }).join("");
  }
  const transcribed = state.interviews.filter((item) => item.text).length;
  $("#fileSummary").textContent = `${state.interviews.length} 份访谈 · ${transcribed} 份可分析`;
  $("#navCount").textContent = state.interviews.length;
  $("#masterCheck").checked = state.interviews.length > 0 && state.interviews.every((item) => item.selected);
  $$(".row-check").forEach((checkbox) => checkbox.addEventListener("change", () => { state.interviews[+checkbox.dataset.index].selected = checkbox.checked; renderReadiness(); renderRoleMapper(); }));
  $$(".type-select").forEach((select) => select.addEventListener("change", () => { const item = state.interviews[+select.dataset.index]; item.type = select.value; item.roleResult = null; renderAll(); }));
  $$(".transcribe-button").forEach((button) => button.addEventListener("click", () => transcribeInterview(+button.dataset.index)));
}

async function transcribeInterview(index) {
  const item = state.interviews[index];
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 本地服务");
  if (!state.apiConfigured) return openApiSettings(() => transcribeInterview(index));
  const isLarge = item.file.size > 24 * 1024 * 1024;
  item.error = "";
  item.progressText = isLarge ? "正在上传至本机并提取音轨，请勿关闭页面" : "正在发送音频并识别说话人";
  item.status = isLarge ? "大型文件处理中" : "转录中";
  renderTranscripts();
  try {
    let response;
    if (isLarge) {
      response = await fetch(`${API_BASE}/api/transcribe-large`, {
        method: "POST",
        headers: {
          "Content-Type": item.file.type || "application/octet-stream",
          "X-Filename": encodeURIComponent(item.file.name),
          ...(Number.isFinite(item.durationSeconds) ? { "X-Media-Duration": String(item.durationSeconds) } : {})
        },
        body: item.file
      });
    } else {
      const form = new FormData();
      form.append("file", item.file);
      form.append("model", "gpt-4o-transcribe-diarize");
      form.append("response_format", "diarized_json");
      form.append("chunking_strategy", "auto");
      response = await fetch(`${API_BASE}/api/transcribe`, { method: "POST", body: form });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.error || "转录失败");
    item.text = (data.segments || []).map((segment) => `${segment.speaker} [${formatDuration(segment.start)}]：${segment.text}`).join("\n") || data.text || "";
    item.roleResult = null;
    item.status = "已转录";
    item.progressText = data.transcription_mode === "whisper-fallback" ? "已使用兼容转录模式，建议复核说话人角色" : "说话人分段已建立";
    if (data.duration) item.duration = formatDuration(data.duration);
    toast(`${item.id} 转录完成${data.chunks ? `（${data.chunks} 个音频分片）` : ""}`);
  } catch (error) {
    item.status = "转录失败";
    item.progressText = "错误详情已保留，可修正后点击“重试”";
    item.error = error.message || "未知错误";
    toast(`转录失败：${item.error}`, 8000);
  }
  renderAll();
}

function renderRoleMapper() {
  const selected = selectedInterviews();
  const ready = selected.filter((item) => item.text);
  const completed = selected.filter((item) => item.roleResult);
  $("#identifyRoles").disabled = state.roleProcessing || !ready.length;
  $("#exportRoleWord").disabled = state.roleProcessing || !completed.length;
  $("#identifyRoles").textContent = state.roleProcessing ? "正在理解对话角色…" : "✦ 区分所选访谈角色";
  $(".role-mapper-panel").classList.toggle("processing", state.roleProcessing);
  $("#roleSummary").textContent = ready.length
    ? `${ready.length} 份所选访谈可处理 · ${completed.length} 份已完成角色区分`
    : "等待所选资料完成转录";
  const results = state.interviews.filter((item) => item.roleResult && (item.selected || !completed.length));
  if (!results.length) {
    $("#rolePreview").innerHTML = '<div class="empty-compact">完成转录后，选择一份或多份资料并点击“区分所选访谈角色”。</div>';
    return;
  }
  $("#rolePreview").innerHTML = results.slice(0, 3).map((item) => {
    const result = item.roleResult;
    const previews = (result.exchanges || []).slice(0, 3).map((exchange, index) => `<div class="qa-preview">
      <label class="${exchange.needs_review ? "review-tag" : ""}">Q${String(index + 1).padStart(2, "0")} · 访谈员${exchange.question_timestamp ? ` · ${escapeHTML(exchange.question_timestamp)}` : ""}${exchange.needs_review ? " · 待复核" : ""}</label>
      <p>${escapeHTML(exchange.question || "（未识别到完整提问）")}</p>
      <label>A · ${escapeHTML(result.respondent_label)}${exchange.answer_timestamp ? ` · ${escapeHTML(exchange.answer_timestamp)}` : ""}</label>
      <p>${escapeHTML(exchange.answer || "（未识别到完整回答）")}</p>
    </div>`).join("");
    return `<section class="role-document"><div class="role-document-head"><strong>${escapeHTML(item.id)} · ${escapeHTML(item.name)}</strong><span>${result.exchanges?.length || 0} 组问答 · ${result.average_confidence || 0}%</span></div>${previews || '<div class="role-more">未形成完整问答，请检查待确认发言。</div>'}${result.exchanges?.length > 3 ? `<div class="role-more">另有 ${result.exchanges.length - 3} 组问答，将完整写入 Word。</div>` : ""}</section>`;
  }).join("");
}

async function identifySelectedRoles() {
  const ready = selectedInterviews().filter((item) => item.text);
  if (!ready.length) return toast("请先选择至少一份已转录访谈");
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 本地服务");
  if (!state.apiConfigured) return openApiSettings(identifySelectedRoles);
  state.roleProcessing = true;
  renderRoleMapper();
  try {
    const response = await fetch(`${API_BASE}/api/roles/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents: ready.map(({ id, name, type, text }) => ({ id, name, type, text })) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "角色区分失败");
    for (const result of data.results || []) {
      const item = state.interviews.find((interview) => interview.id === result.document_id);
      if (item) item.roleResult = result;
    }
    toast(`已完成 ${data.results?.length || 0} 份访谈的角色区分`);
  } catch (error) {
    toast(error.message);
  } finally {
    state.roleProcessing = false;
    renderAll();
  }
}

async function exportRoleWord() {
  const documents = selectedInterviews().map((item) => item.roleResult).filter(Boolean);
  if (!documents.length) return toast("请先完成所选访谈的角色区分");
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
  const hcpCount = state.interviews.filter((item) => item.type === "HCP").length;
  const patientCount = selectedCount - hcpCount;
  $("#metricInterviews").innerHTML = `${state.matrix.length || 0} <em>份</em>`;
  $("#metricTypes").textContent = selectedCount ? `${hcpCount} HCP${patientCount ? ` · ${patientCount} 患者` : ""}` : "等待导入资料";
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
      const stoppedAt = Date.now();
      const finalPausedMs = session?.pauseStarted && session?.stoppedWhilePaused ? stoppedAt - session.pauseStarted : 0;
      const durationSeconds = Math.max(1, (stoppedAt - (session?.startedAt || stoppedAt) - (session?.pausedAt || 0) - finalPausedMs) / 1000);
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
      $("#stopRecording").disabled = true;
      const [newIndex] = await addFiles([file], {
        source: "实时录音",
        type: $("#recordRespondentType").value,
        durationSeconds,
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
    state.recording = { recorder, stream, startedAt: Date.now(), pausedAt: 0, timer: setInterval(updateRecordingTime, 500) };
    $("#recordingConsole").classList.add("active");
    $("#recordingStatus").textContent = "正在录音";
    $("#startRecording").disabled = true;
    $("#pauseRecording").disabled = false;
    $("#stopRecording").disabled = false;
    $("#liveTranscript").textContent = "正在聆听…";
    startSpeechPreview();
  } catch (error) {
    toast(error.name === "NotAllowedError" ? "麦克风权限未开启" : `无法开始录音：${error.message}`);
  }
}

function updateRecordingTime() {
  if (!state.recording) return;
  const seconds = (Date.now() - state.recording.startedAt - state.recording.pausedAt) / 1000;
  $("#recordingTime").textContent = formatDuration(seconds);
}

function pauseRecording() {
  const current = state.recording;
  if (!current) return;
  if (current.recorder.state === "recording") {
    current.recorder.pause();
    current.pauseStarted = Date.now();
    $("#pauseRecording").textContent = "继续";
    $("#recordingStatus").textContent = "录音已暂停";
  } else if (current.recorder.state === "paused") {
    current.pausedAt += Date.now() - current.pauseStarted;
    current.recorder.resume();
    $("#pauseRecording").textContent = "暂停";
    $("#recordingStatus").textContent = "正在录音";
  }
}

function stopRecording() {
  if (state.recording?.recorder && state.recording.recorder.state !== "inactive") {
    state.recording.stoppedWhilePaused = state.recording.recorder.state === "paused";
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
    $("#liveTranscript").textContent = finalText + interim;
  };
  recognition.onerror = () => {};
  recognition.start();
  state.recording.recognition = recognition;
}

function stopSpeechPreview() {
  try { state.recording?.recognition?.stop(); } catch {}
}

function renderAll() {
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
$("#cancelAnalysis").addEventListener("click", () => $("#analysisDialog").close());
$("#goCollect").addEventListener("click", () => showView("transcripts"));
$("#goAnalyze").addEventListener("click", () => showView("outline"));
$("#newAnalysis").addEventListener("click", () => showView("transcripts"));
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
$("#clearFiles").addEventListener("click", () => { if (!state.interviews.length || confirm("确定清空当前会话中的全部访谈资料吗？")) { state.interviews = []; state.matrix = []; state.report = null; state.analyses = []; renderAll(); } });
$("#recordButton").addEventListener("click", (event) => { event.stopPropagation(); $("#recordingConsole").hidden = !$("#recordingConsole").hidden; });
$("#startRecording").addEventListener("click", startRecording);
$("#pauseRecording").addEventListener("click", pauseRecording);
$("#stopRecording").addEventListener("click", stopRecording);
$("#identifyRoles").addEventListener("click", identifySelectedRoles);
$("#exportRoleWord").addEventListener("click", exportRoleWord);
$("#browseOutline").addEventListener("click", (event) => { event.stopPropagation(); $("#outlineFile").click(); });
$("#outlineUpload").addEventListener("click", (event) => { if (!event.target.closest("button")) $("#outlineFile").click(); });
$("#outlineUpload").addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") $("#outlineFile").click(); });
$("#outlineFile").addEventListener("change", (event) => { if (event.target.files[0]) uploadOutline(event.target.files[0]); });
$("#parseOutline").addEventListener("click", parseOutlineFromText);
$("#outlineInput").addEventListener("input", () => { state.outlineText = $("#outlineInput").value; state.outlineSource = "手动输入"; });
$("#clearOutline").addEventListener("click", () => { state.outlineText = ""; state.outlineSource = ""; state.questions = []; $("#outlineInput").value = ""; renderAll(); });
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
$("#adminAccess").addEventListener("click", () => { location.href = "/admin"; });
$("#portalLogout").addEventListener("click", async () => { await fetch("/api/auth/logout", { method: "POST" }); location.href = "/login"; });
$("#apiSettingsForm").addEventListener("submit", saveApiSettings);
$("#clearApiKey").addEventListener("click", clearApiSettings);
$("#cancelApiSettings").addEventListener("click", () => { state.pendingAfterConnect = null; $("#apiSettingsDialog").close(); });
$("#toggleApiKey").addEventListener("click", () => {
  const input = $("#apiKeyInput");
  input.type = input.type === "password" ? "text" : "password";
  $("#toggleApiKey").textContent = input.type === "password" ? "显示" : "隐藏";
});
$("#projectButton").addEventListener("click", () => {
  const name = prompt("请输入研究项目名称", state.projectName);
  if (name?.trim()) {
    state.projectName = name.trim();
    $("#projectLabel").textContent = state.projectName;
    $("#breadcrumbProject").textContent = state.projectName;
    renderReport();
  }
});

renderAll();
checkPortalSession();
checkHealth();
