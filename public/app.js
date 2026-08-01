import { interviewIdForType, nextInterviewId, repairInterviewIds, roleDocumentForExport } from "./interview-id.js?v=20260725.2";
import { flattenQuestionGroups, groupOutlineQuestions, groupsFromQuestions, normalizeQuestionGroups } from "./outline-structure.js?v=20260725.2";
import { createPreviewWorkspace } from "./preview-data.js?v=20260731.2";
import { trialUserIdentity } from "./user-identity.js?v=20260726.1";
import { redactProductNames, redactProductReferences } from "./compliance-redaction.js?v=20260731.2";

const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PROJECT_NAME = "未命名访谈项目";
const PRODUCT_X_DECK_TITLE = "产品X院外深访：从首购到复购，患者如何决定“该吃药了”";
const REQUIRED_INSIGHT_DIMENSIONS = ["决策路径", "核心阻碍", "疗效诉求", "安全顾虑", "信息与信任", "话术风险", "院外复购风险"];
const DEFAULT_DECK_INSTRUCTIONS = "以研究洞察报告为唯一内容主骨架，完整纳入决策路径、核心阻碍、疗效诉求、安全顾虑、信息与信任、话术风险、院外复购风险、跨场景原话证据、全部市场策略优先级和研究边界；核心阻碍、疗效诉求、话术风险、院外复购风险分别独立成页；每项策略写明证据基础、适用场景、行动与验证方式；以商业图表、路径、对比、证据链或优先级地图呈现，避免纯文字堆叠。";

function preferredInsightDeckTitle(projectName, fallback = "") {
  return /(?:产品X|玫满)/u.test(String(projectName || ""))
    ? PRODUCT_X_DECK_TITLE
    : redactProductNames(fallback || projectName || "研究洞察报告").trim();
}

function inferredInsightDimension(insight) {
  if (insight?.dimension) return insight.dimension;
  const text = `${insight?.theme || ""} ${insight?.finding || ""}`;
  return REQUIRED_INSIGHT_DIMENSIONS.find((dimension) => text.includes(dimension)) || insight?.theme || "其他关键洞察";
}

function deckCoverageText(slide) {
  return [
    slide?.title,
    slide?.takeaway,
    slide?.narrative,
    ...(slide?.report_links || []),
    ...(slide?.content || []).flatMap((block) => [block?.heading, block?.body]),
    ...(slide?.implications || [])
  ].filter(Boolean).join(" ");
}

function requiredInsightSlide(insight) {
  const dimension = inferredInsightDimension(insight);
  const finding = String(insight?.finding || "");
  return {
    title: `${dimension}：${String(insight?.theme || finding || "患者决策中的关键张力").slice(0, 44)}`,
    takeaway: finding,
    layout: dimension === "决策路径" || dimension === "院外复购风险" ? "旅程地图" : dimension === "话术风险" ? "证据链" : "洞察证据",
    content: [
      { heading: "研究发现", body: finding, supporting_points: [] },
      { heading: "首购与复购差异", body: String(insight?.scenario_contrast || ""), supporting_points: [] },
      { heading: "市场策略影响", body: String(insight?.implication || ""), supporting_points: [] }
    ],
    implications: [String(insight?.implication || "")].filter(Boolean),
    evidence: Array.isArray(insight?.evidence) ? insight.evidence.slice(0, 5) : [],
    report_links: [`dimension:${dimension}`]
  };
}

function requiredPrioritySlides(priorityEntries) {
  const chunks = [];
  for (let index = 0; index < priorityEntries.length; index += 3) chunks.push(priorityEntries.slice(index, index + 3));
  const concise = (value, limit) => {
    const text = String(value || "").replace(/^优先级\s*\d+\s*[:：]\s*/u, "").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };
  return chunks.map((chunk, chunkIndex) => ({
    title: chunkIndex === 0
      ? "治疗选择与信任建立，是院外转化的前置条件"
      : "复购增长需要风险沟通、随访与体验验证闭环",
    takeaway: "策略优先级直接承接研究洞察报告，并以证据基础、适用场景、行动与验证方式形成闭环。",
    layout: chunkIndex === 0 ? "机会优先级" : "策略框架",
    content: chunk.map(({ priority }) => ({
      heading: concise(priority.title, 30),
      body: `${concise(priority.rationale, 72)} 建议行动：${concise(priority.action, 64)}`,
      supporting_points: [concise(priority.action, 68)]
    })),
    implications: chunk.map(({ priority }) => priority.action),
    evidence: [],
    report_links: chunk.map(({ index }) => `priority:${String(index + 1).padStart(2, "0")}`)
  }));
}

function deckScriptForPresentation(script, projectName) {
  if (!script || typeof script !== "object") return script;
  const normalized = {
    ...script,
    title: preferredInsightDeckTitle(projectName, script.title),
    slides: (script.slides || []).map((slide, index) => ({
      ...slide,
      title: index === 0 || slide.layout === "封面" ? preferredInsightDeckTitle(projectName, script.title) : slide.title,
      content: Array.isArray(slide.content) ? slide.content.map((block) => ({ ...block })) : [],
      report_links: Array.isArray(slide.report_links) ? [...slide.report_links] : []
    }))
  };
  const injected = [];
  for (const insight of normalized.cross_scenario_insights || []) {
    const dimension = inferredInsightDimension(insight);
    if (!REQUIRED_INSIGHT_DIMENSIONS.includes(dimension)) continue;
    const reference = `dimension:${dimension}`;
    const covered = normalized.slides.some((slide) => slide.report_links.includes(reference) || deckCoverageText(slide).includes(dimension));
    if (!covered) injected.push(requiredInsightSlide(insight));
  }
  const missingPriorities = (normalized.strategic_priorities || []).map((priority, index) => ({ priority, index })).filter(({ priority, index }) => {
    const reference = `priority:${String(index + 1).padStart(2, "0")}`;
    const key = String(priority?.title || "").slice(0, 16);
    return !normalized.slides.some((slide) => slide.report_links.includes(reference) || (key && deckCoverageText(slide).includes(key)));
  });
  injected.push(...requiredPrioritySlides(missingPriorities));
  if (injected.length) {
    const boundaryIndex = normalized.slides.findIndex((slide) => slide.layout === "研究边界");
    normalized.slides.splice(boundaryIndex >= 0 ? boundaryIndex : normalized.slides.length, 0, ...injected);
    const injectedSet = new Set(injected);
    while (normalized.slides.length > 18) {
      let removable = -1;
      for (let index = normalized.slides.length - 1; index > 1; index -= 1) {
        if (!injectedSet.has(normalized.slides[index]) && normalized.slides[index].layout !== "研究边界") {
          removable = index;
          break;
        }
      }
      if (removable < 0) break;
      normalized.slides.splice(removable, 1);
    }
  }
  return normalized;
}

const state = {
  projectName: DEFAULT_PROJECT_NAME,
  activeProjectId: DEFAULT_PROJECT_ID,
  projects: [],
  allInterviews: [],
  interviews: [],
  outlineText: "",
  outlineSource: "",
  outlineFileMeta: null,
  questions: [],
  questionGroups: [],
  outlineGuides: [],
  activeOutlineGuideId: "",
  outlineUploadMode: "add",
  analyses: [],
  matrix: [],
  report: null,
  reportWorkspace: null,
  apiConfigured: false,
  apiKeySource: "none",
  authRequired: false,
  currentUser: null,
  pendingAfterConnect: null,
  libraryLoaded: false,
  libraryError: "",
  roleProcessing: false,
  roleProgress: null,
  recording: null,
  currentQuote: null,
  evidenceQuestionIndex: 0,
  evidenceRowIndex: 0,
  evidenceSearch: "",
  expandedGapQuestionIndex: null,
  overviewGuideFilter: "all",
  overviewInsightFilter: "all",
  previewMode: location.pathname === "/preview" || new URLSearchParams(location.search).get("mode") === "preview"
};
let outlineRenameGuideId = "";
let deckSnapshotGeneration = 0;
let deckThumbnailCache = { key: "", images: [] };
let workspaceSyncReady = false;
let hadLocalProjectCatalog = false;
const workspaceSaveTimers = new Map();
const workspaceSaveChains = new Map();

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
const LIBRARY_CHUNK_THRESHOLD = 12 * 1024 * 1024;
const LIBRARY_CHUNK_SIZE = 8 * 1024 * 1024;
const LOCAL_DB_NAME = "medvoice-interview-library";
const LOCAL_DB_VERSION = 1;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

const PREVIEW_ALLOWED_SELECTOR = [
  ".nav-item",
  "[data-view-jump]",
  "[data-insight-filter]",
  "[data-overview-guide]",
  "[data-matrix-guide]",
  ".insight-item",
  ".role-toggle",
  ".confidence-info-button",
  ".ledger-question-button",
  ".ledger-sample-button",
  ".report-dynamic-toc a",
  "#deckPreviewPrev",
  "#deckPreviewNext",
  "[data-deck-slide]",
  "#matrixVerticalScrollHint",
  "#matrixHorizontalScrollHint",
  "dialog .dialog-close",
  "#previewLoginLink"
].join(",");

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
  const storedProjects = localStorage.getItem(PROJECTS_STORAGE_KEY);
  hadLocalProjectCatalog = Boolean(storedProjects);
  try { parsed = JSON.parse(storedProjects || "[]"); } catch {}
  state.projects = Array.isArray(parsed) && parsed.length
    ? parsed.map((project) => ({ id: safeProjectId(project.id), name: redactProductNames(project.name || DEFAULT_PROJECT_NAME).slice(0, 80) }))
    : [{ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME }];
  const active = safeProjectId(localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) || state.projects[0].id);
  state.activeProjectId = state.projects.some((project) => project.id === active) ? active : state.projects[0].id;
  state.projectName = currentProject().name;
}

function saveProjects() {
  if (state.previewMode) return;
  state.projects = redactProductReferences(state.projects);
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(state.projects));
  localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, state.activeProjectId);
}

function readLocalProjectWorkspace(projectId) {
  try {
    const value = JSON.parse(localStorage.getItem(projectDataKey(projectId)) || "null");
    return value && typeof value === "object" && !Array.isArray(value)
      ? redactProductReferences(value)
      : null;
  } catch {
    return null;
  }
}

function createOutlineGuideId() {
  return `guide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function outlineGuideTitle(source = "", index = 0) {
  const filename = String(source || "").split(/[\\/]/).pop() || "";
  return filename.replace(/\.(?:docx|pdf|txt|md)$/i, "").trim().slice(0, 80) || `访谈大纲 ${index + 1}`;
}

function normalizedOutlineGuide(guide = {}, index = 0) {
  const questionGroups = Array.isArray(guide.questionGroups) && guide.questionGroups.length
    ? normalizeQuestionGroups(guide.questionGroups)
    : groupsFromQuestions(Array.isArray(guide.questions) ? guide.questions : []);
  return {
    id: String(guide.id || createOutlineGuideId()),
    title: String(guide.title || outlineGuideTitle(guide.outlineSource, index)).trim().slice(0, 80) || `访谈大纲 ${index + 1}`,
    outlineText: String(guide.outlineText || ""),
    outlineSource: String(guide.outlineSource || ""),
    outlineFileMeta: guide.outlineFileMeta && typeof guide.outlineFileMeta === "object" ? { ...guide.outlineFileMeta } : null,
    questionGroups,
    questions: flattenQuestionGroups(questionGroups),
    sampleIds: [...new Set(Array.isArray(guide.sampleIds) ? guide.sampleIds.map(String).filter(Boolean) : [])],
    analyses: Array.isArray(guide.analyses) ? guide.analyses : [],
    matrix: Array.isArray(guide.matrix) ? guide.matrix : [],
    report: guide.report || null,
    createdAt: Number(guide.createdAt || Date.now())
  };
}

function normalizedReportWorkspace(workspace = {}) {
  return {
    deckScript: workspace?.deckScript && typeof workspace.deckScript === "object" ? workspace.deckScript : null,
    instructions: String(workspace?.instructions || DEFAULT_DECK_INSTRUCTIONS).slice(0, 1200),
    supplementalFiles: (Array.isArray(workspace?.supplementalFiles) ? workspace.supplementalFiles : []).slice(0, 6).map((file) => ({
      id: String(file?.id || `${Date.now()}-${Math.random()}`),
      name: String(file?.name || "补充资料").slice(0, 180),
      type: String(file?.type || "FILE").slice(0, 20),
      size: Math.max(0, Number(file?.size || 0)),
      text: String(file?.text || "").slice(0, 40_000),
      truncated: Boolean(file?.truncated),
      addedAt: Number(file?.addedAt || Date.now())
    })).filter((file) => file.text),
    slideIndex: Math.max(0, Number(workspace?.slideIndex || 0)),
    generatedAt: Number(workspace?.generatedAt || 0),
    sourceFingerprint: String(workspace?.sourceFingerprint || ""),
    sourceSummary: workspace?.sourceSummary && typeof workspace.sourceSummary === "object" ? workspace.sourceSummary : null,
    engine: workspace?.engine && typeof workspace.engine === "object" ? workspace.engine : null
  };
}

function blankOutlineGuide(index = state.outlineGuides.length) {
  return normalizedOutlineGuide({ id: createOutlineGuideId(), title: `访谈大纲 ${index + 1}`, createdAt: Date.now() }, index);
}

function activeOutlineGuide() {
  return state.outlineGuides.find((guide) => guide.id === state.activeOutlineGuideId) || state.outlineGuides[0] || null;
}

function syncActiveOutlineGuideFromState() {
  const guide = activeOutlineGuide();
  if (!guide) return;
  guide.outlineText = state.outlineText;
  guide.outlineSource = state.outlineSource;
  guide.outlineFileMeta = state.outlineFileMeta ? { ...state.outlineFileMeta } : null;
  guide.questionGroups = state.questionGroups;
  guide.questions = state.questions;
  guide.analyses = state.analyses;
  guide.matrix = state.matrix;
  guide.report = state.report;
}

function applyOutlineGuideToState(guide = activeOutlineGuide()) {
  if (!guide) return;
  state.outlineText = guide.outlineText || "";
  state.outlineSource = guide.outlineSource || "";
  state.outlineFileMeta = guide.outlineFileMeta ? { ...guide.outlineFileMeta } : null;
  state.questionGroups = normalizeQuestionGroups(guide.questionGroups || []);
  state.questions = flattenQuestionGroups(state.questionGroups);
  state.analyses = Array.isArray(guide.analyses) ? guide.analyses : [];
  state.matrix = Array.isArray(guide.matrix) ? guide.matrix : [];
  state.report = guide.report || null;
  state.evidenceQuestionIndex = 0;
  state.evidenceRowIndex = 0;
  state.evidenceSearch = "";
  state.expandedGapQuestionIndex = null;
  const outlineInput = $("#outlineInput");
  if (outlineInput) outlineInput.value = state.outlineText;
}

function currentProjectWorkspaceSnapshot() {
  syncActiveOutlineGuideFromState();
  return {
    outlineText: state.outlineText,
    outlineSource: state.outlineSource,
    outlineFileMeta: state.outlineFileMeta,
    questions: state.questions,
    questionGroups: state.questionGroups,
    outlineGuides: state.outlineGuides,
    activeOutlineGuideId: state.activeOutlineGuideId,
    analyses: state.analyses,
    matrix: state.matrix,
    report: state.report,
    reportWorkspace: state.reportWorkspace,
    _localUpdatedAt: Date.now()
  };
}

async function persistProjectWorkspace(project, workspace) {
  const safeProjectName = redactProductNames(project.name);
  const safeWorkspace = redactProductReferences(workspace);
  const response = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(safeProjectId(project.id))}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectName: safeProjectName, workspace: safeWorkspace })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `工作区保存失败（${response.status}）`);
  return data;
}

function scheduleProjectWorkspaceSave(project, workspace) {
  if (!workspaceSyncReady || !state.currentUser) return;
  const projectId = safeProjectId(project.id);
  clearTimeout(workspaceSaveTimers.get(projectId));
  workspaceSaveTimers.set(projectId, setTimeout(() => {
    workspaceSaveTimers.delete(projectId);
    const previous = workspaceSaveChains.get(projectId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => persistProjectWorkspace(project, workspace))
      .catch((error) => {
        console.warn("MedVoice workspace sync failed", error);
        toast(`研究工作区暂未同步：${error.message}`, 5000);
      });
    workspaceSaveChains.set(projectId, next);
  }, 500));
}

function saveCurrentProjectWorkspace() {
  if (state.previewMode) return;
  const workspace = redactProductReferences(currentProjectWorkspaceSnapshot());
  localStorage.setItem(projectDataKey(), JSON.stringify(workspace));
  scheduleProjectWorkspaceSave({ ...currentProject() }, workspace);
}

function loadCurrentProjectWorkspace() {
  let data = {};
  try { data = redactProductReferences(JSON.parse(localStorage.getItem(projectDataKey()) || "{}")); } catch {}
  const persistedGuides = Array.isArray(data.outlineGuides) ? data.outlineGuides : [];
  const legacyGuide = {
    title: outlineGuideTitle(data.outlineSource, 0),
    outlineText: data.outlineText,
    outlineSource: data.outlineSource,
    outlineFileMeta: data.outlineFileMeta,
    questions: data.questions,
    questionGroups: data.questionGroups,
    analyses: data.analyses,
    matrix: data.matrix,
    report: data.report
  };
  state.outlineGuides = (persistedGuides.length ? persistedGuides : [legacyGuide]).map(normalizedOutlineGuide);
  if (!state.outlineGuides.length) state.outlineGuides = [blankOutlineGuide(0)];
  state.activeOutlineGuideId = state.outlineGuides.some((guide) => guide.id === data.activeOutlineGuideId)
    ? data.activeOutlineGuideId
    : state.outlineGuides[0].id;
  state.outlineUploadMode = "add";
  state.overviewGuideFilter = "all";
  state.overviewInsightFilter = "all";
  state.reportWorkspace = normalizedReportWorkspace(data.reportWorkspace);
  applyOutlineGuideToState();
}

function applyPreviewWorkspace() {
  const preview = createPreviewWorkspace();
  state.projects = [preview.project];
  state.activeProjectId = preview.project.id;
  state.projectName = preview.project.name;
  state.allInterviews = preview.interviews;
  state.interviews = preview.interviews;
  state.outlineGuides = preview.guides.map(normalizedOutlineGuide);
  state.activeOutlineGuideId = state.outlineGuides[0]?.id || "";
  state.reportWorkspace = normalizedReportWorkspace(preview.reportWorkspace);
  state.libraryLoaded = true;
  state.libraryError = "";
  state.apiConfigured = false;
  state.apiKeySource = "preview";
  state.authRequired = true;
  state.currentUser = null;
  state.overviewGuideFilter = "all";
  state.overviewInsightFilter = "all";
  applyOutlineGuideToState();
  state.reportWorkspace.sourceFingerprint = reportSourceFingerprint();
}

function previewBlockedMessage() {
  toast("当前为“访客模式”。登录或申请试用后即可上传、分析、编辑与导出。", 4200);
}

function previewActionAllowed(target) {
  return Boolean(target?.closest?.(PREVIEW_ALLOWED_SELECTOR));
}

function guardPreviewInteraction(event) {
  if (!state.previewMode) return;
  if (previewActionAllowed(event.target)) return;
  const actionable = event.target?.closest?.("button,a[href],input,select,textarea,[role='button'],[contenteditable='true']");
  if (!actionable && !["submit", "change", "input", "drop", "paste"].includes(event.type)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  previewBlockedMessage();
}

function configurePreviewMode() {
  if (!state.previewMode) return;
  document.body.classList.add("preview-mode");
  $("#previewModeBanner").hidden = false;
  $("#previewModeBadge").hidden = false;
  $("#adminAccess").hidden = true;
  $("#portalLogout").hidden = true;
  $("#modeLabel").textContent = "访客只读";
  $("#modeLabel").style.color = "#dff25b";
  $("#apiSettingsLabel").textContent = "功能已锁定";
  $("#apiSettingsButton").classList.remove("connected");
  $("#trialUserCard").hidden = false;
  $("#trialUserInitials").textContent = "VM";
  $("#trialUserName").textContent = "访客模式";
  $("#trialUserEmail").textContent = "空白工作区 · 只读浏览";
  document.title = "MedVoice Insight｜访客模式";
}

async function syncProjectWorkspaces() {
  if (!state.currentUser) return;
  const response = await fetch(`${API_BASE}/api/workspaces`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `工作区加载失败（${response.status}）`);
  const remoteRows = Array.isArray(data.workspaces) ? data.workspaces : [];
  const localProjects = state.projects.map((project) => ({ ...project }));
  const mergedProjects = [];
  const seen = new Set();
  let migratedCount = 0;

  for (const row of remoteRows) {
    const projectId = safeProjectId(row.projectId);
    const localProject = localProjects.find((project) => project.id === projectId);
    const localWorkspace = readLocalProjectWorkspace(projectId);
    const remoteWorkspace = row.workspace && typeof row.workspace === "object" ? row.workspace : {};
    const localUpdatedAt = Number(localWorkspace?._localUpdatedAt || 0);
    const remoteUpdatedAt = Number(remoteWorkspace?._localUpdatedAt || Date.parse(row.updatedAt) || 0);
    const project = {
      id: projectId,
      name: redactProductNames(localUpdatedAt > remoteUpdatedAt ? localProject?.name : row.projectName || localProject?.name || DEFAULT_PROJECT_NAME).slice(0, 80)
    };
    mergedProjects.push(project);
    seen.add(projectId);
    if (localWorkspace && localUpdatedAt > remoteUpdatedAt) {
      await persistProjectWorkspace(project, localWorkspace);
      migratedCount += 1;
    } else {
      localStorage.setItem(projectDataKey(projectId), JSON.stringify(remoteWorkspace));
    }
  }

  for (const project of localProjects) {
    if (seen.has(project.id)) continue;
    const localWorkspace = readLocalProjectWorkspace(project.id);
    const isSyntheticEmptyDefault = project.id === DEFAULT_PROJECT_ID
      && !hadLocalProjectCatalog;
    if (remoteRows.length && isSyntheticEmptyDefault) continue;
    const workspace = localWorkspace || { _localUpdatedAt: Date.now() };
    await persistProjectWorkspace(project, workspace);
    mergedProjects.push(project);
    seen.add(project.id);
    migratedCount += 1;
  }

  if (!mergedProjects.length) {
    const project = { id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME };
    const workspace = { _localUpdatedAt: Date.now() };
    await persistProjectWorkspace(project, workspace);
    mergedProjects.push(project);
  }

  state.projects = mergedProjects;
  if (!state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0].id;
  }
  state.projectName = currentProject().name;
  saveProjects();
  loadCurrentProjectWorkspace();
  workspaceSyncReady = true;
  if (migratedCount) toast(`已将 ${migratedCount} 个研究工作区同步到当前账号`, 4200);
}

function normalizeProjectFields(item = {}) {
  const id = safeProjectId(item.projectId || item.project_id || DEFAULT_PROJECT_ID);
  const project = state.projects.find((candidate) => candidate.id === id);
  return {
    projectId: id,
    projectName: redactProductNames(item.projectName || item.project_name || project?.name || DEFAULT_PROJECT_NAME).slice(0, 80)
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
    return "网络或大文件上传连接中断。当前资料已保留本机备份；请等待网络稳定后重试，系统会对长录音和大视频自动分片上传。";
  }
  if (/413|too large|content too large|payload too large|request entity too large/i.test(message)) {
    return "文件体积较大，服务器拒绝了单次上传。请点击“转录”，系统会自动分片上传、转换为 M4A 后再转录。";
  }
  return message || "未知错误";
}

async function fetchWithUploadRetry(url, options, retryOptions = {}) {
  const attempts = Math.max(1, retryOptions.attempts || 4);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), retryOptions.timeoutMs || 90_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok || (response.status < 500 && ![408, 425, 429].includes(response.status))) return response;
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `服务器暂时不可用（${response.status}）`);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      retryOptions.onRetry?.(attempt + 1, attempts);
      await delay(Math.min(5_000, 700 * (2 ** (attempt - 1))));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("分片上传失败");
}

async function uploadLibraryItemChunked(item, onProgress) {
  const file = item.file;
  const chunkCount = Math.ceil(file.size / LIBRARY_CHUNK_SIZE);
  const startResponse = await fetchWithUploadRetry(`${API_BASE}/api/library/uploads/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      meta: interviewPayload(item),
      fileName: item.fileName || item.name || file.name,
      mimeType: file.type || item.mimeType || "application/octet-stream",
      fileSize: file.size,
      chunkCount
    })
  }, { attempts: 3, timeoutMs: 30_000 });
  const start = await startResponse.json().catch(() => ({}));
  if (!startResponse.ok) throw new Error(start.error || "创建资料库分片上传任务失败");

  for (let index = 0; index < chunkCount; index += 1) {
    const begin = index * LIBRARY_CHUNK_SIZE;
    const chunk = file.slice(begin, Math.min(file.size, begin + LIBRARY_CHUNK_SIZE), "application/octet-stream");
    const uploadPart = () => fetchWithUploadRetry(`${API_BASE}/api/library/uploads/${encodeURIComponent(start.id)}/chunks`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Chunk-Index": String(index) },
      body: chunk
    }, {
      attempts: 5,
      timeoutMs: 90_000,
      onRetry: (attempt, total) => {
        item.progressText = `第 ${index + 1}/${chunkCount} 片网络中断，正在自动重试（${attempt}/${total}）`;
        renderTranscripts();
      }
    });
    const chunkResponse = await uploadPart();
    const chunkData = await chunkResponse.json().catch(() => ({}));
    if (!chunkResponse.ok) throw new Error(chunkData.error || `第 ${index + 1} 个资料分片上传失败`);
    onProgress(Math.min(96, Math.max(3, Math.round(((index + 1) / chunkCount) * 96))));
    item.progressText = `长录音正在分片保存（${index + 1}/${chunkCount} · ${Math.round(((index + 1) / chunkCount) * 100)}%）`;
    renderTranscripts();
  }

  item.progressText = "分片上传完成，正在校验并写入账号资料库";
  renderTranscripts();
  const completeResponse = await fetchWithUploadRetry(`${API_BASE}/api/library/uploads/${encodeURIComponent(start.id)}/complete`, {
    method: "POST"
  }, { attempts: 4, timeoutMs: 90_000 });
  const completed = await completeResponse.json().catch(() => ({}));
  if (!completeResponse.ok) throw new Error(completed.error || "资料分片合并失败");
  onProgress(100);
  return completed;
}

async function uploadChunkedConversionJob(file, item) {
  const chunkCount = Math.ceil(file.size / CONVERSION_CHUNK_SIZE);
  item.progressText = `大视频将分为 ${chunkCount} 片上传，并自动转换为 M4A`;
  renderTranscripts();
  const startResponse = await fetch(`${API_BASE}/api/media/convert-audio/chunked/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: item.fileName || redactProductNames(file.name), mimeType: file.type, size: file.size, chunkCount })
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
            "X-Filename": encodeURIComponent(item.fileName || redactProductNames(item.file.name))
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
  $$(".nav-item").forEach((button) => {
    const isActive = button.dataset.view === view;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (!state.previewMode) {
    try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch {}
  }
  if (options.updateHash !== false && location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "matrix") requestAnimationFrame(updateMatrixScrollState);
  if (view === "report") requestAnimationFrame(() => {
    if (state.reportWorkspace) renderDeckPreview(deckScriptForPresentation(state.reportWorkspace.deckScript, state.projectName));
  });
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
    renderTrialUserIdentity(state.authRequired ? data.user : null);
    if (state.authRequired && !data.authenticated) {
      location.assign("/login");
      return null;
    }
    if (data.user?.mustChangePassword) {
      location.assign("/login?change=1");
      return null;
    }
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
    return data;
  } catch (error) {
    console.warn("MedVoice session check failed", error);
    return null;
  }
}

function renderTrialUserIdentity(user) {
  const card = $("#trialUserCard");
  const identity = trialUserIdentity(user?.email);
  card.hidden = !identity;
  if (!identity) return;
  $("#trialUserInitials").textContent = identity.initials;
  $("#trialUserName").textContent = identity.displayName;
  $("#trialUserEmail").textContent = identity.email;
  card.title = `当前试用用户：${identity.email}`;
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

function nextId(type = "HCP") {
  return nextInterviewId(state.interviews, type);
}

function renameInterviewForType(item, type) {
  const normalizedType = normalizeRespondentType(type);
  item.id = interviewIdForType(state.interviews, item, normalizedType);
  item.type = normalizedType;
  syncRoleResultMetadata(item);
}

function syncRoleResultMetadata(item) {
  if (!item?.roleResult) return false;
  const nextType = normalizeRespondentType(item.type);
  const nextLabel = nextType === "Patient" ? "Patient/受访者" : "HCP/受访者";
  const changed = item.roleResult.document_id !== item.id
    || item.roleResult.name !== item.name
    || item.roleResult.type !== nextType
    || item.roleResult.respondent_label !== nextLabel;
  item.roleResult.document_id = item.id;
  item.roleResult.name = item.name;
  item.roleResult.type = nextType;
  item.roleResult.respondent_label = nextLabel;
  return changed;
}

function reconcileInterviewIds(items) {
  const repairs = repairInterviewIds(items);
  const repairedItems = new Map(repairs.map((repair) => [repair.item, repair]));
  for (const item of items) {
    if (!syncRoleResultMetadata(item) || repairedItems.has(item)) continue;
    repairedItems.set(item, { item, previousId: item.id, nextId: item.id });
  }
  return [...repairedItems.values()];
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
  return redactProductReferences({
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
  });
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

async function saveLocalInterviewItem(item) {
  if (!item) return;
  try {
    await withLocalStore("readwrite", (store) => store.put(localInterviewRecord(item)));
    item.localPersisted = true;
  } catch (error) {
    item.localPersistError = error.message;
  }
}

async function saveLocalInterview(index) {
  return saveLocalInterviewItem(state.interviews[index]);
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
  item.projectName = redactProductNames(item.projectName);
  item.name = redactProductNames(item.name);
  item.fileName = redactProductNames(item.fileName);
  item.progressText = redactProductNames(item.progressText);
  item.error = redactProductNames(item.error);
  item.text = redactProductNames(item.text);
  item.draftText = redactProductNames(item.draftText);
  item.roleResult = redactProductReferences(item.roleResult);
  if (/正在保存到账号资料库/.test(item.progressText || "")) item.progressText = "";
  item.uploadProgress = null;
  item.persisting = false;
  return item;
}

async function persistInterviewIdentityRepair(repair) {
  const { item, previousId } = repair;
  if (!item.serverId && previousId && previousId !== item.id) {
    await deleteLocalInterview({ ...item, id: previousId }, { remember: false });
  }
  if (item.serverId) {
    const response = await fetch(`${API_BASE}/api/library/items/${encodeURIComponent(item.serverId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(interviewPayload(item))
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `无法更新 ${item.id} 的唯一编码`);
    if (data.item) applyPersistedItem(item, data.item);
  }
  await saveLocalInterviewItem(item);
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
      const progressHandler = (percent) => {
        item.uploadProgress = percent;
        item.progressText = `正在保存到账号资料库（${percent}%）`;
        renderTranscripts();
      };
      const shouldChunkUpload = item.file.size >= LIBRARY_CHUNK_THRESHOLD || Number(item.durationSeconds || 0) >= 45 * 60;
      response = shouldChunkUpload
        ? await uploadLibraryItemChunked(item, progressHandler)
        : await uploadLibraryItem(item, progressHandler);
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
  for (let index = 0; index < state.interviews.length; index += 1) await persistInterview(index);
}

async function retryPendingAccountSaves(options = {}) {
  if (!navigator.onLine || !state.libraryLoaded) return;
  const pendingIndexes = state.interviews
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.serverId && item.file && item.localPersisted && !item.persisting)
    .map(({ index }) => index);
  if (!pendingIndexes.length) return;
  if (!options.silent) toast(`网络已恢复，正在续传 ${pendingIndexes.length} 份本机备份`);
  for (const index of pendingIndexes) await persistInterview(index);
}

async function loadInterviewLibrary() {
  state.libraryLoaded = false;
  state.libraryError = "";
  renderTranscripts();
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
    const identityRepairs = reconcileInterviewIds(state.allInterviews);
    mergeProjectsFromInterviews();
    saveProjects();
    syncCurrentProjectInterviews();
    state.libraryLoaded = true;
    renderAll();
    setTimeout(() => retryPendingAccountSaves({ silent: true }), 800);
    const repairResults = await Promise.allSettled(identityRepairs.map(persistInterviewIdentityRepair));
    const repairFailures = repairResults.filter((result) => result.status === "rejected").length;
    if (repairFailures) {
      toast(`已在当前页面修复重复编码，但有 ${repairFailures} 份资料未能回写账号，请稍后刷新重试`, 6500);
    } else if (state.interviews.length) {
      const repairText = identityRepairs.length ? ` · 已自动校正 ${identityRepairs.length} 个编码` : "";
      toast(`已恢复 ${state.interviews.length} 份账号资料${repairText}`);
    }
  } catch (error) {
    state.libraryLoaded = true;
    state.libraryError = error.message || "资料库加载失败";
    renderAll();
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
      name: redactProductNames(file.name),
      type: normalizeRespondentType(options.type),
      duration: Number.isFinite(options.durationSeconds) ? formatDuration(options.durationSeconds) : isText ? "—" : "读取中",
      durationSeconds: Number.isFinite(options.durationSeconds) ? options.durationSeconds : null,
      status: isText ? "可分析" : options.source === "实时录音" ? "录音已保存" : "待转录",
      text: "",
      file,
      fileName: redactProductNames(file.name),
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
  if (!state.libraryLoaded) {
    table.innerHTML = '<tr><td colspan="6" class="empty-row library-sync"><span class="library-sync-spinner"></span><strong>正在同步账号资料</strong><small>已导入的访谈和转录结果将在同步完成后自动恢复。</small></td></tr>';
  } else if (state.libraryError) {
    table.innerHTML = `<tr><td colspan="6" class="empty-row library-sync library-sync-error"><strong>账号资料暂时未能加载</strong><small>${escapeHTML(state.libraryError)}</small><button class="secondary-button" id="retryLibraryLoad" type="button">重新同步</button></td></tr>`;
  } else if (!state.interviews.length) {
    table.innerHTML = '<tr><td colspan="6" class="empty-row">尚未导入资料。可上传文件或使用“实时录音”。</td></tr>';
  } else {
    table.innerHTML = state.interviews.map((item, index) => {
      if (item.roleResult && /正在区分对话角色/.test(item.progressText || "")) item.progressText = "角色区分完成，可在下方预览并导出 Word。";
      const isMedia = (item.file || item.hasFile) && !/\.(txt|md|csv|json)$/i.test(item.name);
      const isTranscribing = ["大型文件处理中", "转录中", "快速转录中"].includes(item.status);
      const isAudioPreprocessing = item.status === "音频预处理中";
      const actionLabel = isMedia ? (isTranscribing ? "转录中" : isAudioPreprocessing ? "预处理中" : item.text ? "重新转录" : item.status === "转录失败" || item.status === "转换失败" ? "重试" : "转录") : "无需转录";
      const transcribeClass = isTranscribing ? "transcribing" : isAudioPreprocessing ? "preprocessing" : item.text ? "retranscribe" : item.status === "转录失败" || item.status === "转换失败" ? "retry" : "primary";
      const roleProcessingThis = state.roleProcessing && state.roleProgress?.currentName === item.id;
      const canIdentifyRole = Boolean(item.text) && !state.roleProcessing;
      const roleActionLabel = roleProcessingThis ? "处理中" : item.roleResult ? "重新区分" : "区分角色";
      const refreshActionIcon = '<svg class="refresh-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>';
      const statusClass = item.status.includes("中") || item.status.includes("预处理") ? "processing" : item.status === "转录失败" || item.status === "转换失败" || item.status === "角色区分失败" ? "failed" : item.status === "录音已保存" ? "saved" : "";
      const sourceLabel = item.source === "实时录音" ? `实时录音${item.recordedAt ? ` · ${escapeHTML(item.recordedAt)}` : ""}` : item.source === "音频预处理" ? "音频预处理" : "上传文件";
      const fileSize = item.file?.size || item.fileSize || 0;
      const uploadProgress = Number.isFinite(item.uploadProgress) ? Math.min(100, Math.max(0, item.uploadProgress)) : null;
      const isUploading = item.persisting || (uploadProgress !== null && uploadProgress < 100) || /正在保存到账号资料库/.test(item.progressText || "");
      const needsAccountSync = !item.serverId && Boolean(item.file) && item.localPersisted;
      const transcribeDisabled = !isMedia || isUploading || isTranscribing || isAudioPreprocessing;
      const fileKind = /\.(txt|md|csv|json)$/i.test(item.name) ? "DOC" : /\.(mp4|mov|mkv|webm)$/i.test(item.name) ? "VID" : "AUD";
      return `<tr>
        <td><input class="row-check" type="checkbox" data-index="${index}" ${item.selected ? "checked" : ""} aria-label="选择 ${escapeHTML(item.id)}" /></td>
        <td class="file-cell"><div class="file-record"><span class="file-kind">${fileKind}</span><div><strong>${escapeHTML(item.id)} · ${escapeHTML(item.name)}</strong><small class="${fileSize > 24 * 1024 * 1024 && !item.text ? "large-file-note" : "file-size-note"}">${item.roleResult ? "已区分角色 · 可导出问答 Word" : item.text ? "已建立逐字稿" : fileSize > 24 * 1024 * 1024 ? `${formatFileSize(fileSize)} · 服务端提取音轨并自动分片` : `${formatFileSize(fileSize)} · 等待语音转录`}${item.persisted ? " · 已保存到账户" : item.localPersisted ? " · 已保存本机备份" : item.persisting ? " · 保存中" : ""}</small><span class="source-badge ${item.source === "实时录音" ? "live" : ""}">${sourceLabel}</span>${item.error ? `<small class="file-error">失败原因：${escapeHTML(humanizeFileTransferError(item.error))}</small>` : ""}${item.persistError ? `<small class="file-error">保存提示：${escapeHTML(humanizeFileTransferError(item.persistError))}</small>` : ""}${item.localPersistError ? `<small class="file-error">本机备份提示：${escapeHTML(humanizeFileTransferError(item.localPersistError))}</small>` : ""}</div></div></td>
        <td><select class="type-select" data-index="${index}" aria-label="受访者类型"><option value="HCP" ${normalizeRespondentType(item.type) === "HCP" ? "selected" : ""}>HCP</option><option value="Patient" ${normalizeRespondentType(item.type) === "Patient" ? "selected" : ""}>Patient</option></select></td>
        <td>${escapeHTML(item.duration)}</td>
        <td><span class="status-pill ${statusClass}">${escapeHTML(item.status)}</span>${item.progressText ? `<small class="transcript-progress">${escapeHTML(item.progressText)}</small>` : ""}${uploadProgress !== null ? `<span class="upload-progress-bar" aria-label="上传保存进度 ${uploadProgress}%"><i style="width:${uploadProgress}%"></i></span>` : ""}</td>
        <td><div class="row-actions">${needsAccountSync ? `<button class="retry-save-button" data-index="${index}" ${isUploading ? "disabled" : ""}>${refreshActionIcon}<span>同步账号</span></button>` : ""}<button class="transcribe-button ${transcribeClass}" data-index="${index}" ${transcribeDisabled ? "disabled" : ""}>${actionLabel.startsWith("重新") ? refreshActionIcon : ""}<span>${escapeHTML(actionLabel)}</span></button><button class="role-row-button" data-index="${index}" ${canIdentifyRole ? "" : "disabled"}>${roleActionLabel.startsWith("重新") ? refreshActionIcon : ""}<span>${escapeHTML(roleActionLabel)}</span></button></div></td>
      </tr>`;
    }).join("");
  }
  const transcribed = state.interviews.filter((item) => item.text).length;
  $("#fileSummary").textContent = !state.libraryLoaded ? "正在同步账号资料…" : state.libraryError ? "资料同步失败 · 请重试" : `${state.interviews.length} 份访谈 · ${transcribed} 份可分析`;
  const libraryTotal = $("#libraryTotal");
  const libraryTranscribed = $("#libraryTranscribed");
  const libraryPending = $("#libraryPending");
  if (libraryTotal) libraryTotal.textContent = state.libraryLoaded && !state.libraryError ? state.interviews.length : "—";
  if (libraryTranscribed) libraryTranscribed.textContent = state.libraryLoaded && !state.libraryError ? transcribed : "—";
  if (libraryPending) libraryPending.textContent = state.libraryLoaded && !state.libraryError ? Math.max(0, state.interviews.length - transcribed) : "—";
  $("#navCount").textContent = state.interviews.length;
  $("#masterCheck").checked = state.interviews.length > 0 && state.interviews.every((item) => item.selected);
  $$(".row-check").forEach((checkbox) => checkbox.addEventListener("change", () => { state.interviews[+checkbox.dataset.index].selected = checkbox.checked; renderReadiness(); renderRoleMapper(); }));
  $$(".type-select").forEach((select) => select.addEventListener("change", async () => {
    const index = +select.dataset.index;
    const item = state.interviews[index];
    renameInterviewForType(item, select.value);
    renderAll();
    await persistInterview(index);
  }));
  $$(".transcribe-button").forEach((button) => button.addEventListener("click", () => transcribeInterview(+button.dataset.index)));
  $$(".retry-save-button").forEach((button) => button.addEventListener("click", async () => {
    const index = +button.dataset.index;
    await persistInterview(index);
    if (state.interviews[index]?.serverId) toast(`${state.interviews[index].id} 已续传并保存到账户资料库`);
  }));
  $$(".role-row-button").forEach((button) => button.addEventListener("click", () => identifyRoleForInterview(+button.dataset.index)));
  $("#retryLibraryLoad")?.addEventListener("click", loadInterviewLibrary);
  const transcriptTableScroll = $("#transcriptTableScroll");
  if (transcriptTableScroll) transcriptTableScroll.onscroll = updateTranscriptTableScrollState;
  updateTranscriptTableScrollState();
  requestAnimationFrame(() => requestAnimationFrame(updateTranscriptTableScrollState));
  document.fonts?.ready.then(updateTranscriptTableScrollState).catch(() => {});
}

function updateTranscriptTableScrollState() {
  const scroller = $("#transcriptTableScroll");
  const shell = $("#transcriptTableShell");
  const hint = $("#libraryScrollHint");
  if (!scroller || !shell || !hint) return;
  const scrollable = scroller.scrollHeight > scroller.clientHeight + 4;
  const atBottom = !scrollable || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
  shell.classList.toggle("scrollable", scrollable);
  shell.classList.toggle("at-bottom", atBottom);
  hint.hidden = !scrollable || atBottom;
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
  item.text = redactProductNames(
    (data.segments || []).map((segment) => `${segment.speaker} [${formatDuration(segment.start)}]：${segment.text}`).join("\n") || data.text || ""
  );
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
  const isLarge = fileSize > 24 * 1024 * 1024 || Number(item.durationSeconds || 0) >= 45 * 60;
  const mode = selectedTranscriptionMode();
  const estimatedChunks = estimatedChunkCount(item);
  if (isLarge && item.file && !item.serverId) {
    item.status = "大型文件处理中";
    item.progressText = "长录音将先分片保存到账号，再由服务器继续转录";
    renderTranscripts();
    await persistInterview(index);
    if (!item.serverId) {
      item.status = "录音已保存";
      item.progressText = "本机备份完整；账号同步尚未完成。网络稳定后再次点击“转录”即可续传。";
      await saveLocalInterview(index);
      renderAll();
      return toast("长录音尚未同步到账号，已保留本机备份；系统不会重复上传转录文件。", 7000);
    }
  }
  let ticker = null;
  item.error = "";
  item.progressText = isLarge
    ? `正在从账号资料库创建后台分片转录任务${estimatedChunks ? `（预计 ${estimatedChunks} 段）` : ""}`
    : mode === "fast" ? "正在快速转录音频为逐字稿" : "正在发送音频并识别说话人";
  item.status = isLarge ? "大型文件处理中" : mode === "fast" ? "快速转录中" : "转录中";
  renderTranscripts();
  try {
    let data;
    let response;
    if (item.serverId && isLarge) {
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
          "X-Filename": encodeURIComponent(item.fileName || redactProductNames(item.file.name)),
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

function updateRolePreviewScrollState() {
  const preview = $("#rolePreview");
  const shell = $("#rolePreviewShell");
  const hint = $("#roleScrollHint");
  if (!preview || !shell || !hint) return;
  const scrollable = preview.scrollHeight > preview.clientHeight + 4;
  const atBottom = !scrollable || preview.scrollTop + preview.clientHeight >= preview.scrollHeight - 8;
  shell.classList.toggle("scrollable", scrollable);
  shell.classList.toggle("at-bottom", atBottom);
  hint.hidden = !scrollable || atBottom;
}

function renderRoleMapper() {
  const preview = $("#rolePreview");
  const previousScrollTop = preview?.scrollTop || 0;
  const selected = selectedInterviews();
  const ready = selected.filter((item) => item.text);
  const completed = roleMappedInterviews();
  const selectedForWord = selectedRoleDocuments();
  const allRoleDocsSelected = completed.length > 0 && selectedForWord.length === completed.length;
  const allRoleDocsExpanded = completed.length > 0 && completed.every((item) => item.roleExpanded === true);

  $("#exportRoleWord").disabled = state.roleProcessing || !selectedForWord.length;
  $("#deleteRoleDocs").disabled = state.roleProcessing || !selectedForWord.length;
  $("#selectAllRoleDocs").disabled = state.roleProcessing || !completed.length;
  const toggleAllRolePreviews = $("#toggleAllRolePreviews");
  if (toggleAllRolePreviews) {
    toggleAllRolePreviews.disabled = state.roleProcessing || !completed.length;
    toggleAllRolePreviews.textContent = allRoleDocsExpanded ? "全部折叠" : "展开全部";
  }
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
    updateRolePreviewScrollState();
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
  $("#rolePreview").scrollTop = previousScrollTop;
  $("#rolePreview").onscroll = updateRolePreviewScrollState;
  requestAnimationFrame(updateRolePreviewScrollState);

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

async function pollRoleIdentifyJob(jobId, item, current, total) {
  let transientFailures = 0;
  for (;;) {
    await delay(1800);
    let response;
    let job;
    try {
      response = await fetch(`${API_BASE}/api/roles/identify/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      job = await response.json().catch(() => ({}));
    } catch (error) {
      transientFailures += 1;
      item.progressText = `读取角色区分进度时短暂中断，正在自动重试 ${transientFailures}/8；请暂时不要重复点击。`;
      renderAll();
      if (transientFailures < 8) continue;
      throw error;
    }
    if (!response.ok) {
      transientFailures += response.status >= 500 ? 1 : 8;
      if (transientFailures < 8) {
        item.progressText = `服务器正在恢复角色区分任务，自动重试 ${transientFailures}/8。`;
        renderAll();
        continue;
      }
      throw new Error(job.error?.message || job.error || "无法读取角色区分进度");
    }
    transientFailures = 0;
    const percent = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0;
    const batchText = job.batchCount ? ` · ${job.batchIndex || 0}/${job.batchCount} 批` : "";
    const message = job.message || "正在区分对话角色";
    state.roleProgress = { total, current, currentName: item.id, percent };
    item.status = job.status === "failed" ? "角色区分失败" : "角色区分中";
    item.progressText = `${message}（${percent}%${batchText}）`;
    renderAll();
    if (job.status === "completed") return job.results?.[0];
    if (job.status === "failed") throw new Error(job.error || "角色区分失败");
  }
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
  try {
    for (let index = 0; index < ready.length; index += 1) {
      const item = ready[index];
      state.roleProgress = { total: ready.length, current: index + 1, currentName: item.id, percent: 1 };
      item.status = "角色区分中";
      item.progressText = "正在创建角色区分任务（1%）";
      renderAll();
      const response = await fetch(`${API_BASE}/api/roles/identify/jobs`, {
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
      const result = data.status === "completed" ? data.results?.[0] : await pollRoleIdentifyJob(data.id, item, index + 1, ready.length);
      if (result) {
        item.roleResult = redactProductReferences(result);
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
  removeSamplesFromOutlineGuides(items);
  saveCurrentProjectWorkspace();
  renderAll();
  toast(`已删除 ${indexes.length} 份角色区分结果，原始访谈资料已保留`);
}

async function exportRoleWord() {
  const selectedItems = selectedRoleDocuments();
  const changedItems = selectedItems.filter((item) => syncRoleResultMetadata(item));
  const documents = selectedItems.map(roleDocumentForExport).filter(Boolean);
  if (!documents.length) return toast("请先勾选至少一份已完成角色区分的访谈");
  toast("正在生成一问一答 Word…");
  try {
    if (changedItems.length) {
      await Promise.allSettled(changedItems.map((item) => persistInterviewIdentityRepair({
        item,
        previousId: item.id,
        nextId: item.id
      })));
    }
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

function invalidateOutlineAnalysis() {
  state.analyses = [];
  state.matrix = [];
  state.report = null;
}

function syncQuestionFramework({ rerender = false } = {}) {
  state.questions = flattenQuestionGroups(state.questionGroups);
  invalidateOutlineAnalysis();
  saveCurrentProjectWorkspace();
  if (rerender) {
    renderQuestions();
  } else {
    $("#dimensionCount").textContent = state.questionGroups.filter((group) => group.questions?.some((question) => String(question).trim())).length;
    $("#questionCount").textContent = state.questions.length;
  }
  renderReadiness();
  renderOverview();
  renderMatrix();
  renderReport();
}

function parseOutlineFromText() {
  state.outlineText = redactProductNames($("#outlineInput").value).trim();
  $("#outlineInput").value = state.outlineText;
  state.questionGroups = groupOutlineQuestions(state.outlineText, extractQuestions(state.outlineText));
  state.questions = flattenQuestionGroups(state.questionGroups);
  state.outlineSource = state.outlineSource || "手动输入";
  if (state.outlineFileMeta) state.outlineFileMeta.edited = true;
  invalidateOutlineAnalysis();
  renderQuestions();
  saveCurrentProjectWorkspace();
  renderAll();
  toast(state.questions.length ? `已整理 ${state.questionGroups.length} 个维度、${state.questions.length} 个主要问题` : "尚未识别到问题，请检查大纲格式");
}

async function uploadOutline(file) {
  const form = new FormData();
  form.append("file", file);
  try {
    const response = await fetch(`${API_BASE}/api/outline/parse`, { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "大纲解析失败");
    const currentGuide = activeOutlineGuide();
    const shouldCreateGuide = state.outlineUploadMode !== "replace"
      && Boolean(currentGuide?.outlineText || currentGuide?.outlineFileMeta || currentGuide?.questions?.length);
    if (shouldCreateGuide) {
      syncActiveOutlineGuideFromState();
      const nextGuide = blankOutlineGuide();
      nextGuide.title = outlineGuideTitle(data.filename || file.name, state.outlineGuides.length);
      state.outlineGuides.push(nextGuide);
      state.activeOutlineGuideId = nextGuide.id;
      applyOutlineGuideToState(nextGuide);
    }
    const guide = activeOutlineGuide();
    if (guide && (shouldCreateGuide || state.outlineUploadMode === "replace" || /^访谈大纲\s*\d+$/u.test(guide.title))) {
      guide.title = outlineGuideTitle(data.filename || file.name, state.outlineGuides.indexOf(guide));
    }
    state.outlineText = redactProductNames(data.text);
    state.outlineSource = redactProductNames(data.filename);
    state.outlineFileMeta = {
      name: redactProductNames(data.filename || file.name),
      size: file.size,
      type: file.type || file.name.split(".").pop()?.toUpperCase() || "DOCUMENT",
      lastModified: file.lastModified || Date.now(),
      edited: false
    };
    state.questionGroups = groupOutlineQuestions(state.outlineText, redactProductReferences(data.questions || extractQuestions(state.outlineText)));
    state.questions = flattenQuestionGroups(state.questionGroups);
    invalidateOutlineAnalysis();
    $("#outlineInput").value = state.outlineText;
    saveCurrentProjectWorkspace();
    renderAll();
    toast(`已载入 ${state.outlineSource}，整理出 ${state.questionGroups.length} 个维度、${state.questions.length} 个问题`);
  } catch (error) {
    toast(error.message.includes("fetch") ? "请先启动 MedVoice 本地服务，再解析 Word / PDF" : error.message);
  } finally {
    state.outlineUploadMode = "add";
  }
}

function resizeQuestionEditor(editor) {
  editor.style.height = "auto";
  editor.style.height = `${Math.min(150, Math.max(42, editor.scrollHeight))}px`;
}

function renderQuestions() {
  const activeGroups = state.questionGroups.filter((group) => group.questions?.some((question) => String(question).trim()));
  $("#dimensionCount").textContent = activeGroups.length;
  $("#questionCount").textContent = state.questions.length;
  let questionNumber = 0;
  $("#questionList").innerHTML = state.questionGroups.length
    ? state.questionGroups.map((group, groupIndex) => `<section class="question-group">
      <div class="question-group-head">
        <span class="question-group-index">${String(groupIndex + 1).padStart(2, "0")}</span>
        <label><small>访谈维度</small><input class="question-group-title" data-group="${groupIndex}" value="${escapeHTML(group.title || "未命名维度")}" aria-label="编辑第 ${groupIndex + 1} 个问题维度名称" /></label>
        <em>${group.questions.length} 题</em>
        <button class="question-group-delete" data-group="${groupIndex}" type="button" aria-label="删除该问题维度" title="删除该维度">×</button>
      </div>
      <div class="question-group-body">${group.questions.map((question, questionIndex) => {
        questionNumber += 1;
        return `<div class="question-editor-row">
          <span>Q${String(questionNumber).padStart(2, "0")}</span>
          <textarea class="question-editor" rows="1" data-group="${groupIndex}" data-question="${questionIndex}" aria-label="编辑问题 Q${questionNumber}" placeholder="请输入访谈问题">${escapeHTML(question)}</textarea>
          <button class="question-delete" data-group="${groupIndex}" data-question="${questionIndex}" type="button" aria-label="删除问题 Q${questionNumber}" title="删除问题">×</button>
        </div>`;
      }).join("")}</div>
      <button class="question-add" data-group="${groupIndex}" type="button">＋ 在此维度添加问题</button>
    </section>`).join("")
    : '<div class="empty-compact">上传或输入大纲后，将在这里显示逐题分析框架。</div>';
  $("#outlineSource").textContent = state.outlineSource
    ? state.outlineFileMeta?.edited
      ? `来源：${state.outlineSource} · 原文或问题框架已人工校正`
      : `来源：${state.outlineSource}`
    : "尚未载入大纲";

  $$(".question-editor").forEach((editor) => {
    resizeQuestionEditor(editor);
    editor.addEventListener("input", () => {
      const group = state.questionGroups[+editor.dataset.group];
      if (!group) return;
      group.questions[+editor.dataset.question] = editor.value;
      resizeQuestionEditor(editor);
      syncQuestionFramework();
    });
  });
  $$(".question-group-title").forEach((input) => input.addEventListener("input", () => {
    const group = state.questionGroups[+input.dataset.group];
    if (!group) return;
    group.title = input.value;
    syncQuestionFramework();
  }));
  $$(".question-delete").forEach((button) => button.addEventListener("click", () => {
    const group = state.questionGroups[+button.dataset.group];
    if (!group) return;
    group.questions.splice(+button.dataset.question, 1);
    if (!group.questions.length) state.questionGroups.splice(+button.dataset.group, 1);
    syncQuestionFramework({ rerender: true });
  }));
  $$(".question-group-delete").forEach((button) => button.addEventListener("click", () => {
    state.questionGroups.splice(+button.dataset.group, 1);
    syncQuestionFramework({ rerender: true });
  }));
  $$(".question-add").forEach((button) => button.addEventListener("click", () => {
    const group = state.questionGroups[+button.dataset.group];
    if (!group) return;
    group.questions.push("");
    syncQuestionFramework({ rerender: true });
  }));
}

function analysisSampleKey(item) {
  return String(item?.serverId || item?.id || "");
}

function removeSamplesFromOutlineGuides(items) {
  const removed = new Set(items.map(analysisSampleKey));
  for (const guide of state.outlineGuides) {
    const next = (guide.sampleIds || []).filter((id) => !removed.has(id));
    if (next.length === (guide.sampleIds || []).length) continue;
    guide.sampleIds = next;
    guide.analyses = [];
    guide.matrix = [];
    guide.report = null;
  }
  applyOutlineGuideToState();
}

function eligibleAnalysisSamples() {
  return state.interviews.filter((item) => item.text && item.roleResult);
}

function selectedAnalysisSamples() {
  const selected = new Set(activeOutlineGuide()?.sampleIds || []);
  return eligibleAnalysisSamples().filter((item) => selected.has(analysisSampleKey(item)));
}

function switchOutlineGuide(guideId) {
  if (guideId === state.activeOutlineGuideId) return;
  syncActiveOutlineGuideFromState();
  const guide = state.outlineGuides.find((item) => item.id === guideId);
  if (!guide) return;
  state.activeOutlineGuideId = guide.id;
  state.outlineUploadMode = "add";
  applyOutlineGuideToState(guide);
  saveCurrentProjectWorkspace();
  renderAll();
}

function replaceOutlineGuide(guideId) {
  syncActiveOutlineGuideFromState();
  const guide = state.outlineGuides.find((item) => item.id === guideId);
  if (!guide) return;
  state.activeOutlineGuideId = guide.id;
  applyOutlineGuideToState(guide);
  saveCurrentProjectWorkspace();
  renderAll();
  state.outlineUploadMode = "replace";
  $("#outlineFile").click();
}

function openOutlineGuideRename(guideId) {
  const guide = state.outlineGuides.find((item) => item.id === guideId);
  if (!guide) return;
  outlineRenameGuideId = guide.id;
  $("#outlineRenameInput").value = guide.title;
  $("#outlineRenameDialog").showModal();
  $("#outlineRenameInput").focus();
  $("#outlineRenameInput").select();
}

function closeOutlineGuideRename() {
  outlineRenameGuideId = "";
  $("#outlineRenameDialog").close();
}

function saveOutlineGuideRename(event) {
  event.preventDefault();
  const guide = state.outlineGuides.find((item) => item.id === outlineRenameGuideId);
  if (!guide) return closeOutlineGuideRename();
  const name = $("#outlineRenameInput").value.trim().slice(0, 80);
  if (!name) return toast("请输入访谈大纲名称");
  guide.title = name;
  saveCurrentProjectWorkspace();
  closeOutlineGuideRename();
  renderAll();
  toast(`访谈大纲已重命名为“${name}”`);
}

function deleteOutlineGuide(guideId = state.activeOutlineGuideId) {
  const guide = state.outlineGuides.find((item) => item.id === guideId);
  if (!guide) return;
  const hasContent = Boolean(guide.outlineText || guide.questions?.length || guide.sampleIds?.length || guide.report);
  if (hasContent && !confirm(`确定删除“${guide.title}”及其样本绑定和分析结果吗？其他访谈大纲不会受影响。`)) return;
  syncActiveOutlineGuideFromState();
  const deletingActiveGuide = guide.id === state.activeOutlineGuideId;
  const index = state.outlineGuides.indexOf(guide);
  state.outlineGuides.splice(index, 1);
  if (!state.outlineGuides.length) state.outlineGuides.push(blankOutlineGuide(0));
  const next = deletingActiveGuide
    ? state.outlineGuides[Math.min(index, state.outlineGuides.length - 1)]
    : activeOutlineGuide() || state.outlineGuides[0];
  state.activeOutlineGuideId = next.id;
  state.outlineUploadMode = "add";
  applyOutlineGuideToState(next);
  saveCurrentProjectWorkspace();
  renderAll();
  toast(`已删除访谈大纲“${guide.title}”`);
}

function updateActiveGuideSamples(sampleIds) {
  const guide = activeOutlineGuide();
  if (!guide) return;
  guide.sampleIds = [...new Set(sampleIds.map(String).filter(Boolean))];
  invalidateOutlineAnalysis();
  saveCurrentProjectWorkspace();
  renderAll();
}

function renderOutlineGuideManager() {
  const guide = activeOutlineGuide();
  const tabs = $("#outlineGuideTabs");
  const picker = $("#analysisSamplePicker");
  if (!guide || !tabs || !picker) return;
  tabs.innerHTML = state.outlineGuides.map((item, index) => {
    const dimensions = item.questionGroups?.filter((group) => group.questions?.length).length || 0;
    const questions = item.questions?.length || 0;
    const selectedSamples = item.sampleIds?.length || 0;
    const hasResults = Boolean(item.report || item.matrix?.length);
    const fileName = item.outlineFileMeta?.name || item.outlineSource || "尚未上传大纲文件";
    const extension = item.outlineFileMeta || item.outlineSource
      ? String(fileName).split(".").pop()?.toUpperCase().slice(0, 4) || "DG"
      : "DG";
    const extensionClass = /^(DOC|DOCX)$/i.test(extension)
      ? "word"
      : /^PDF$/i.test(extension)
        ? "pdf"
        : /^MD$/i.test(extension)
          ? "markdown"
          : /^TXT$/i.test(extension)
            ? "text"
            : "generic";
    return `<div class="outline-guide-card ${item.id === guide.id ? "active" : ""}">
      <button class="outline-guide-tab" data-guide-id="${escapeHTML(item.id)}" type="button">
        <span class="outline-guide-document ${extensionClass}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4M9 12h6m-6 3h6"/></svg><b>${escapeHTML(extension)}</b><i>${String(index + 1).padStart(2, "0")}</i></span>
        <div><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(fileName)}</small><small class="outline-guide-metrics">${dimensions} 维度 · ${questions} 题 · ${selectedSamples} 样本</small></div>
        ${hasResults ? '<em>已分析</em>' : '<em>待分析</em>'}
      </button>
      <div class="outline-guide-actions">
        <button class="outline-guide-rename" data-guide-id="${escapeHTML(item.id)}" type="button" aria-label="重命名访谈大纲 ${escapeHTML(item.title)}" title="修改名称"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3.5 12.7 3 15l2.3-.5 8.2-8.2-1.8-1.8-8.2 8.2Z"/><path d="m10.8 5.4 1.8 1.8"/></svg></button>
        <button class="outline-guide-replace" data-guide-id="${escapeHTML(item.id)}" type="button" aria-label="替换访谈大纲 ${escapeHTML(item.title)}" title="替换文件"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M14.7 7A6 6 0 1 0 15 11"/><path d="M14.7 3.5V7h-3.5"/></svg></button>
        <button class="outline-guide-remove" data-guide-id="${escapeHTML(item.id)}" type="button" aria-label="删除访谈大纲 ${escapeHTML(item.title)}" title="删除该大纲"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="m5 5 8 8m0-8-8 8"/></svg></button>
      </div>
    </div>`;
  }).join("");
  $$(".outline-guide-tab").forEach((button) => button.addEventListener("click", () => switchOutlineGuide(button.dataset.guideId)));
  $$(".outline-guide-rename").forEach((button) => button.addEventListener("click", () => openOutlineGuideRename(button.dataset.guideId)));
  $$(".outline-guide-replace").forEach((button) => button.addEventListener("click", () => replaceOutlineGuide(button.dataset.guideId)));
  $$(".outline-guide-remove").forEach((button) => button.addEventListener("click", () => deleteOutlineGuide(button.dataset.guideId)));

  const eligible = eligibleAnalysisSamples();
  const selected = new Set(guide.sampleIds || []);
  const selectedEligible = eligible.filter((item) => selected.has(analysisSampleKey(item)));
  $("#sampleAssignmentTitle").textContent = `为“${guide.title}”选择样本`;
  $("#sampleAssignmentSummary").textContent = `${selectedEligible.length} 个已选 · ${eligible.length} 个可用`;
  $("#selectAllAnalysisSamples").disabled = !eligible.length || selectedEligible.length === eligible.length;
  $("#clearAnalysisSamples").disabled = !selectedEligible.length;
  picker.innerHTML = eligible.length
    ? eligible.map((item) => {
      const key = analysisSampleKey(item);
      const exchangeCount = item.roleResult?.exchanges?.length || 0;
      const documentIdentity = roleDocumentForExport(item);
      const respondentCode = documentIdentity?.document_id || item.id;
      const respondentType = documentIdentity?.type || normalizeRespondentType(item.type);
      return `<label class="analysis-sample-card ${selected.has(key) ? "selected" : ""}">
        <input class="analysis-sample-check" type="checkbox" value="${escapeHTML(key)}" aria-label="将 ${escapeHTML(respondentCode || item.name || "该样本")} 绑定到当前大纲" ${selected.has(key) ? "checked" : ""} />
        <span class="analysis-sample-code" title="${escapeHTML(respondentCode)}">${escapeHTML(respondentCode)}</span>
        <div><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(respondentType)} · 已转录 · ${exchangeCount} 组问答</small></div>
        <em>${selected.has(key) ? "已绑定" : "待选择"}</em>
      </label>`;
    }).join("")
    : '<div class="analysis-sample-empty"><strong>暂无可绑定样本</strong><span>请先在“访谈采集与转录”完成转录和角色区分，合格文件会自动同步到这里。</span></div>';
  $$(".analysis-sample-check").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const next = new Set(activeOutlineGuide()?.sampleIds || []);
    if (checkbox.checked) next.add(checkbox.value); else next.delete(checkbox.value);
    updateActiveGuideSamples([...next]);
  }));
}

function selectedInterviews() {
  return state.interviews.filter((item) => item.selected);
}

function renderReadiness() {
  const eligible = eligibleAnalysisSamples();
  const selected = selectedAnalysisSamples();
  const dimensionCount = state.questionGroups.filter((group) => group.questions?.some((question) => String(question).trim())).length;
  $("#readyFiles").textContent = `${selected.length} / ${eligible.length}`;
  $("#readyQuestions").textContent = `${dimensionCount} 维度 / ${state.questions.length} 题`;
  const isReady = selected.length > 0 && state.questions.length > 0;
  $("#readyStatus").textContent = activeOutlineGuide()?.report ? "已完成" : isReady ? "可以分析" : "未就绪";
  $("#runOutlineAnalysis").disabled = !isReady;
}

function overviewAnalyzedGuides() {
  syncActiveOutlineGuideFromState();
  return state.outlineGuides.filter((guide) => guide.report && Array.isArray(guide.matrix) && guide.matrix.length);
}

function overviewSelectedGuides() {
  const guides = overviewAnalyzedGuides();
  if (state.overviewGuideFilter === "all") return guides;
  const selected = guides.find((guide) => guide.id === state.overviewGuideFilter);
  if (selected) return [selected];
  state.overviewGuideFilter = "all";
  return guides;
}

function renderOverviewScope() {
  const container = $("#overviewGuideTabs");
  const analyzed = overviewAnalyzedGuides();
  const completedIds = new Set(analyzed.map((guide) => guide.id));
  const allActive = state.overviewGuideFilter === "all";
  const allSamples = analyzed.reduce((sum, guide) => sum + guide.matrix.length, 0);
  container.innerHTML = `<button class="overview-guide-tab all ${allActive ? "active" : ""}" type="button" data-overview-guide="all" role="radio" aria-checked="${allActive}">
      <span>ALL</span><div><strong>全部场景</strong><small>${analyzed.length} 份大纲 · ${allSamples} 个场景样本</small></div><em>${allActive ? "当前范围" : "跨场景"}</em>
    </button>${state.outlineGuides.map((guide, index) => {
      const ready = completedIds.has(guide.id);
      const active = state.overviewGuideFilter === guide.id;
      return `<button class="overview-guide-tab ${active ? "active" : ""}" type="button" data-overview-guide="${escapeHTML(guide.id)}" role="radio" aria-checked="${active}" ${ready ? "" : "disabled"}>
        <span>DG${String(index + 1).padStart(2, "0")}</span><div><strong title="${escapeHTML(guide.title)}">${escapeHTML(guide.title)}</strong><small>${guide.matrix?.length || 0} 份样本 · ${guide.questions?.length || 0} 个问题</small></div><em>${ready ? active ? "当前范围" : "查看洞察" : "待分析"}</em>
      </button>`;
    }).join("")}`;
  $$("[data-overview-guide]", container).forEach((button) => button.addEventListener("click", () => {
    state.overviewGuideFilter = button.dataset.overviewGuide;
    renderOverview();
  }));
}

function overviewInsightEntries(guides = overviewSelectedGuides()) {
  return guides.flatMap((guide) => (guide.report?.top_insights || []).map((insight, insightIndex) => ({
    guide,
    insight,
    insightIndex,
    guideIndex: Math.max(0, state.outlineGuides.findIndex((item) => item.id === guide.id))
  })));
}

function renderOverview() {
  renderOverviewScope();
  const guides = overviewSelectedGuides();
  const scopedRows = guides.flatMap((guide) => guide.matrix || []);
  const scopedQuestions = guides.reduce((sum, guide) => sum + (guide.questions?.length || 0), 0);
  const scopedInsights = overviewInsightEntries(guides);
  const hasScopedAnalysis = guides.length > 0;
  const transcribed = hasScopedAnalysis ? scopedRows.length : state.interviews.filter((item) => item.text).length;
  const typeSource = hasScopedAnalysis ? scopedRows : state.interviews;
  const hcpCount = typeSource.filter((item) => normalizeRespondentType(item.type) === "HCP").length;
  const patientCount = typeSource.filter((item) => normalizeRespondentType(item.type) === "Patient").length;
  const scopeLabel = guides.length > 1 ? `${guides.length} 个场景合并` : guides[0]?.title || "全部研究资料";
  $("#metricInterviews").innerHTML = `${hasScopedAnalysis ? scopedRows.length : state.matrix.length || 0} <em>份</em>`;
  $("#metricTypes").textContent = typeSource.length ? `${hcpCount} HCP${patientCount ? ` · ${patientCount} Patient` : ""}` : "等待导入资料";
  $("#metricTranscribed").innerHTML = `${transcribed} <em>份</em>`;
  $("#metricTranscribed").nextElementSibling.textContent = hasScopedAnalysis ? `当前范围 · ${scopeLabel}` : "支持中文与 English";
  $("#metricQuestions").innerHTML = `${hasScopedAnalysis ? scopedQuestions : state.questions.length}<em>题</em>`;
  $("#metricQuestions").nextElementSibling.textContent = hasScopedAnalysis ? "对应所选 Discussion Guide" : "等待导入研究大纲";
  $("#metricInsights").innerHTML = `${scopedInsights.length} <em>项</em>`;
  $("#metricInsights").nextElementSibling.textContent = guides.length > 1 ? "跨场景汇总并保留来源" : hasScopedAnalysis ? "当前场景已验证洞察" : "分析后自动生成";
  renderInsights();
  renderSignals();
  const contradictionCount = guides.reduce((sum, guide) => sum + (guide.analyses || []).reduce((guideSum, item) => guideSum + (item.contradictions?.length || 0), 0), 0);
  const hasReport = guides.some((guide) => guide.report);
  $(".contradiction-card h3").textContent = hasReport
    ? guides.length > 1 ? `跨场景保留 ${contradictionCount} 组分歧与反例` : `AI 发现 ${contradictionCount} 组关键分歧`
    : "等待识别跨样本分歧";
  $(".contradiction-card p").textContent = hasReport
    ? guides.length > 1
      ? "首购与复购的共同结论、场景差异和反例均保留来源，可进入矩阵逐项核验。"
      : `当前仅呈现“${guides[0].title}”的观点分层与反例，避免被其他场景平均。`
    : "完成大纲驱动分析后，将在这里显示观点分层与反例。";
}

function renderInsights(filter = state.overviewInsightFilter) {
  state.overviewInsightFilter = filter;
  const list = $("#insightList");
  const entries = overviewInsightEntries();
  if (!entries.length) {
    list.innerHTML = '<div class="empty-dashboard"><div><strong>暂无洞察结果</strong>完成任一 Discussion Guide 的样本绑定与并发分析后，即可在这里按场景查看。</div></div>';
    return;
  }
  const filtered = entries.filter(({ insight }) => filter === "all" || (filter === "high" && insight.confidence >= 85) || (filter === "action" && insight.implication));
  list.innerHTML = filtered.map(({ guide, guideIndex, insight, insightIndex }, index) => `<button class="insight-item" data-insight="${insightIndex}" data-insight-guide="${escapeHTML(guide.id)}"><span class="insight-rank">${String(index + 1).padStart(2, "0")}</span><span><span class="insight-scenario">DG${String(guideIndex + 1).padStart(2, "0")} · ${escapeHTML(guide.title)}</span><h3>${escapeHTML(insight.title)}</h3><p>${escapeHTML(insight.insight)}</p><span class="insight-meta"><em class="confidence">置信度 ${insight.confidence}%</em><em class="evidence-count">${insight.evidence?.length || 0} 条原话</em></span></span><span class="score-ring" style="--score:${insight.confidence}"><strong>${insight.confidence}</strong></span></button>`).join("");
  $$(".insight-item").forEach((button) => button.addEventListener("click", () => openEvidence(+button.dataset.insight, button.dataset.insightGuide)));
}

function renderSignals() {
  const chart = $("#signalChart");
  const guides = overviewSelectedGuides();
  if (!guides.length) {
    chart.innerHTML = '<div class="empty-compact">分析后显示各场景问题的完整覆盖、部分覆盖与未覆盖比例。</div>';
    return;
  }
  const perGuideLimit = guides.length > 1 ? Math.max(2, Math.floor(8 / guides.length)) : 8;
  const rows = guides.flatMap((guide) => {
    const guideIndex = Math.max(0, state.outlineGuides.findIndex((item) => item.id === guide.id));
    return (guide.questions || []).slice(0, perGuideLimit).map((question, questionIndex) => {
      const total = Math.max(guide.matrix?.length || 0, 1);
      const answers = (guide.matrix || []).map((row) => row.answers?.[questionIndex]).filter(Boolean);
      const full = answers.filter((item) => item.coverage === "完整覆盖").length;
      const partial = answers.filter((item) => item.coverage === "部分覆盖").length;
      return { guideIndex, question, questionIndex, total, full, partial, missing: Math.max(0, total - full - partial) };
    });
  }).slice(0, 8);
  chart.innerHTML = rows.map(({ guideIndex, question, questionIndex, total, full, partial, missing }) => `<div class="signal-row"><span title="${escapeHTML(question)}"><b>DG${String(guideIndex + 1).padStart(2, "0")} · Q${String(questionIndex + 1).padStart(2, "0")}</b>${escapeHTML(question)}</span><span class="stack-bar"><i class="positive" style="width:${full / total * 100}%"></i><i class="mid" style="width:${partial / total * 100}%"></i><i class="negative" style="width:${missing / total * 100}%"></i></span><strong>${full}/${total}</strong></div>`).join("");
}

function renderMatrixGuideSwitcher() {
  const container = $("#matrixGuideTabs");
  if (!container) return;
  const active = activeOutlineGuide();
  container.innerHTML = state.outlineGuides.map((guide, index) => {
    const questions = guide.id === active?.id ? state.questions : guide.questions || [];
    const matrix = guide.id === active?.id ? state.matrix : guide.matrix || [];
    const isActive = guide.id === active?.id;
    return `<button class="matrix-guide-tab ${isActive ? "active" : ""}" type="button" data-matrix-guide="${escapeHTML(guide.id)}" aria-pressed="${isActive}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHTML(guide.title)}</strong><small>${questions.length} 题 · ${matrix.length} 样本</small></span>
      <em>${matrix.length ? "已分析" : questions.length ? "待分析" : "待上传"}</em>
    </button>`;
  }).join("");
  $$("[data-matrix-guide]", container).forEach((button) => button.addEventListener("click", () => switchOutlineGuide(button.dataset.matrixGuide)));
}

function updateMatrixScrollState() {
  const wrap = $("#matrixTableWrap");
  const horizontalHint = $("#matrixHorizontalScrollHint");
  const verticalHint = $("#matrixVerticalScrollHint");
  if (!wrap || !horizontalHint || !verticalHint) return;
  const horizontalOverflow = wrap.scrollWidth - wrap.clientWidth > 12;
  const verticalOverflow = wrap.scrollHeight - wrap.clientHeight > 12;
  const reachedRight = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 18;
  const reachedBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 18;
  horizontalHint.hidden = !horizontalOverflow || reachedRight;
  verticalHint.hidden = !verticalOverflow || reachedBottom;
  $(".matrix-panel")?.classList.toggle("scrollable-x", horizontalOverflow);
  $(".matrix-panel")?.classList.toggle("scrollable-y", verticalOverflow);
}

function renderMatrix() {
  const table = $("#matrixTable");
  renderMatrixGuideSwitcher();
  if (!state.questions.length) {
    $("#exportExcel").disabled = true;
    table.innerHTML = '<tbody><tr><td class="empty-row">请先在“大纲驱动·并发分析”中导入研究大纲。</td></tr></tbody>';
    renderGaps();
    renderEvidenceLedger();
    requestAnimationFrame(updateMatrixScrollState);
    return;
  }
  const headers = state.questions.map((question, index) => `<th class="question-header">Q${index + 1}<br>${escapeHTML(question)}</th>`).join("");
  if (!state.matrix.length) {
    $("#exportExcel").disabled = true;
    table.innerHTML = `<thead><tr><th>受访者 / 样本</th>${headers}</tr></thead><tbody><tr><td colspan="${state.questions.length + 1}" class="empty-row">大纲框架已建立。完成并发分析后生成逐题矩阵。</td></tr></tbody>`;
    renderGaps();
    renderEvidenceLedger();
    requestAnimationFrame(updateMatrixScrollState);
    return;
  }
  table.innerHTML = `<thead><tr><th>受访者 / 样本</th>${headers}</tr></thead><tbody>${state.matrix.map((row, rowIndex) => `<tr><td class="matrix-sample-cell"><strong>${escapeHTML(row.document_id)}</strong><small title="${escapeHTML(row.name || row.type)}">${escapeHTML(row.name || row.type)}</small></td>${state.questions.map((_, questionIndex) => {
    const answer = row.answers?.[questionIndex] || { answer: "未覆盖", coverage: "未覆盖", quotes: [] };
    const cls = answer.coverage === "完整覆盖" ? "yes" : answer.coverage === "部分覆盖" ? "mixed" : "no";
    return `<td class="answer-cell" data-row="${rowIndex}" data-question="${questionIndex}">${escapeHTML(answer.answer)}<br><span class="coverage-badge ${cls}">${escapeHTML(answer.coverage)}</span></td>`;
  }).join("")}</tr>`).join("")}</tbody>`;
  $$(".answer-cell").forEach((cell) => cell.addEventListener("click", () => selectMatrixEvidence(+cell.dataset.row, +cell.dataset.question)));
  $("#exportExcel").disabled = false;
  renderGaps();
  renderEvidenceLedger();
  requestAnimationFrame(updateMatrixScrollState);
}

function renderGaps() {
  const container = $("#gapList");
  if (!state.matrix.length) {
    container.innerHTML = '<div class="empty-compact">完成分析后，自动统计未覆盖问题与补访优先级。</div>';
    return;
  }
  const gaps = state.questions.map((question, index) => {
    const missingRows = state.matrix.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) => row.answers?.[index]?.coverage === "未覆盖");
    return { question, index, missingRows };
  }).filter((item) => item.missingRows.length).sort((a, b) => b.missingRows.length - a.missingRows.length).slice(0, 8);
  container.innerHTML = gaps.length ? gaps.map((item) => {
    const expanded = state.expandedGapQuestionIndex === item.index;
    return `<article class="gap-item ${expanded ? "expanded" : ""}">
      <button class="gap-item-main" type="button" data-gap-question="${item.index}" aria-expanded="${expanded}">
        <span class="gap-question-code">Q${String(item.index + 1).padStart(2, "0")}</span>
        <span class="gap-question-copy"><strong>${escapeHTML(item.question)}</strong><small>${item.missingRows.length} 份样本尚未覆盖，建议补访或回看追问段落。</small></span>
        <span class="gap-coverage-score"><strong>${item.missingRows.length}/${state.matrix.length}</strong><small>未覆盖</small><em>查看编号</em></span>
        <span class="gap-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="gap-missing-samples" ${expanded ? "" : "hidden"}>
        <p>建议补访的样本编号</p>
        <div>${item.missingRows.map(({ row, rowIndex }) => `<button type="button" data-gap-row="${rowIndex}" data-gap-evidence-question="${item.index}"><span>${escapeHTML(row.document_id)}</span><small>${escapeHTML(row.name || row.type || "受访样本")}</small><em>查看缺口 →</em></button>`).join("")}</div>
      </div>
    </article>`;
  }).join("") : '<div class="empty-compact">所有大纲问题均有样本覆盖；仍建议人工核验回答深度。</div>';
  $$(".gap-item-main", container).forEach((button) => button.addEventListener("click", () => {
    const index = +button.dataset.gapQuestion;
    state.expandedGapQuestionIndex = state.expandedGapQuestionIndex === index ? null : index;
    renderGaps();
  }));
  $$("[data-gap-evidence-question]", container).forEach((button) => button.addEventListener("click", () => {
    selectMatrixEvidence(+button.dataset.gapRow, +button.dataset.gapEvidenceQuestion);
  }));
}

function selectMatrixEvidence(rowIndex, questionIndex) {
  state.evidenceQuestionIndex = Math.max(0, Math.min(questionIndex, state.questions.length - 1));
  state.evidenceRowIndex = Math.max(0, Math.min(rowIndex, state.matrix.length - 1));
  state.evidenceSearch = "";
  renderEvidenceLedger();
  $("#evidenceQuestionSearch").value = "";
  $(".evidence-ledger")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function coverageClass(coverage) {
  if (coverage === "完整覆盖") return "yes";
  if (coverage === "部分覆盖") return "mixed";
  return "no";
}

function renderEvidenceLedger() {
  const questionList = $("#ledgerQuestionList");
  const sampleTabs = $("#ledgerSampleTabs");
  const detail = $("#ledgerEvidenceDetail");
  const total = $("#evidenceQuestionTotal");
  if (!questionList || !sampleTabs || !detail || !total) return;
  total.textContent = `${state.questions.length} 个问题`;
  if (!state.questions.length) {
    questionList.innerHTML = '<div class="ledger-empty-list">等待问题框架</div>';
    sampleTabs.innerHTML = "";
    detail.innerHTML = '<div class="empty-compact">上传访谈大纲并完成分析后，可按问题与样本检索受访者原话。</div>';
    $("#ledgerQuestionCode").textContent = "Q—";
    $("#ledgerQuestionText").textContent = "尚未识别大纲问题";
    $("#copyQuote").disabled = true;
    state.currentQuote = null;
    return;
  }
  state.evidenceQuestionIndex = Math.max(0, Math.min(state.evidenceQuestionIndex, state.questions.length - 1));
  state.evidenceRowIndex = Math.max(0, Math.min(state.evidenceRowIndex, Math.max(state.matrix.length - 1, 0)));
  const query = state.evidenceSearch.trim().toLowerCase();
  const visibleQuestions = state.questions.map((question, index) => ({ question, index })).filter(({ question, index }) => !query || `q${index + 1} ${question}`.toLowerCase().includes(query));
  if (visibleQuestions.length && !visibleQuestions.some(({ index }) => index === state.evidenceQuestionIndex)) {
    state.evidenceQuestionIndex = visibleQuestions[0].index;
    state.evidenceRowIndex = 0;
  }
  questionList.innerHTML = visibleQuestions.length ? visibleQuestions.map(({ question, index }) => {
    const evidenceCount = state.matrix.filter((row) => row.answers?.[index]?.quotes?.length).length;
    const active = index === state.evidenceQuestionIndex;
    return `<button class="ledger-question-button ${active ? "active" : ""}" type="button" data-ledger-question="${index}" aria-pressed="${active}">
      <span>Q${String(index + 1).padStart(2, "0")}</span><strong>${escapeHTML(question)}</strong><em>${evidenceCount}/${state.matrix.length || 0} 证据</em>
    </button>`;
  }).join("") : '<div class="ledger-empty-list">未找到匹配问题</div>';
  const selectedQuestion = state.questions[state.evidenceQuestionIndex];
  $("#ledgerQuestionCode").textContent = `Q${String(state.evidenceQuestionIndex + 1).padStart(2, "0")}`;
  $("#ledgerQuestionText").textContent = selectedQuestion;
  if (!state.matrix.length) {
    sampleTabs.innerHTML = "";
    detail.innerHTML = '<div class="empty-compact">问题框架已建立；完成并发分析后可逐样本核对原话。</div>';
    $("#copyQuote").disabled = true;
    state.currentQuote = null;
  } else {
    sampleTabs.innerHTML = state.matrix.map((row, rowIndex) => {
      const answer = row.answers?.[state.evidenceQuestionIndex] || { coverage: "未覆盖", quotes: [] };
      const active = rowIndex === state.evidenceRowIndex;
      return `<button class="ledger-sample-button ${active ? "active" : ""}" type="button" data-ledger-row="${rowIndex}" aria-pressed="${active}">
        <strong>${escapeHTML(row.document_id)}</strong><span class="${coverageClass(answer.coverage)}">${escapeHTML(answer.coverage)}</span><small>${answer.quotes?.length || 0} 条原话</small>
      </button>`;
    }).join("");
    const row = state.matrix[state.evidenceRowIndex];
    const answer = row?.answers?.[state.evidenceQuestionIndex] || { answer: "未覆盖", coverage: "未覆盖", quotes: [] };
    const quotes = Array.isArray(answer.quotes) ? answer.quotes.filter((quote) => quote?.quote) : [];
    state.currentQuote = quotes.length ? quotes.map((quote) => `“${quote.quote}”`).join("\n\n") + `\n— ${row.document_id} · Q${state.evidenceQuestionIndex + 1}` : null;
    $("#copyQuote").disabled = !quotes.length;
    detail.innerHTML = `<div class="ledger-source-head">
      <div><span>${escapeHTML(row.document_id)}</span><strong>${escapeHTML(row.name || row.type || "受访样本")}</strong></div>
      <em class="${coverageClass(answer.coverage)}">${escapeHTML(answer.coverage || "未覆盖")}</em>
    </div>
    <div class="ledger-answer-summary"><small>AI 对应摘要</small><p>${escapeHTML(answer.answer || "该样本未形成对应回答。")}</p></div>
    <div class="ledger-verbatim-head"><div><small>VERBATIM EVIDENCE</small><strong>受访者原话</strong></div><span>${quotes.length} 条可追溯引文</span></div>
    <div class="ledger-quotes">${quotes.length ? quotes.map((quote, index) => `<blockquote><span>${String(index + 1).padStart(2, "0")}</span><p>“${escapeHTML(quote.quote)}”</p><footer>${escapeHTML(quote.speaker || "受访者")}${quote.meaning ? ` · ${escapeHTML(quote.meaning)}` : ""}</footer></blockquote>`).join("") : '<div class="ledger-no-quote"><span>!</span><div><strong>该问题暂无受访者原话</strong><p>此样本被标记为未覆盖或证据不足，建议补访并围绕当前问题追问。</p></div></div>'}</div>`;
  }
  $$(".ledger-question-button", questionList).forEach((button) => button.addEventListener("click", () => {
    state.evidenceQuestionIndex = +button.dataset.ledgerQuestion;
    state.evidenceRowIndex = 0;
    renderEvidenceLedger();
  }));
  $$(".ledger-sample-button", sampleTabs).forEach((button) => button.addEventListener("click", () => {
    state.evidenceRowIndex = +button.dataset.ledgerRow;
    renderEvidenceLedger();
  }));
}

function reportReadyGuides() {
  syncActiveOutlineGuideFromState();
  return state.outlineGuides.filter((guide) => guide.report && Array.isArray(guide.matrix) && guide.matrix.length);
}

function reportSourceFingerprint(guides = reportReadyGuides()) {
  return JSON.stringify(guides.map((guide) => ({
    id: guide.id,
    title: guide.title,
    samples: guide.matrix.length,
    questions: guide.questions.length,
    summary: guide.report?.executive_summary || "",
    insights: (guide.report?.top_insights || []).map((item) => item.title)
  })));
}

function reportEvidenceMetrics(guides) {
  const insights = guides.flatMap((guide) => guide.report?.top_insights || []);
  const evidenceCount = insights.reduce((sum, insight) => sum + (insight.evidence?.length || 0), 0);
  const confidence = insights.length ? Math.round(insights.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / insights.length) : 0;
  return {
    guideCount: guides.length,
    sampleCount: guides.reduce((sum, guide) => sum + guide.matrix.length, 0),
    questionCount: guides.reduce((sum, guide) => sum + guide.questions.length, 0),
    evidenceCount,
    confidence
  };
}

function comprehensiveReportPayload() {
  return {
    projectName: state.projectName,
    instructions: state.reportWorkspace?.instructions || DEFAULT_DECK_INSTRUCTIONS,
    supplementalDocuments: (state.reportWorkspace?.supplementalFiles || []).map((file) => ({
      name: file.name,
      type: file.type,
      text: file.text
    })),
    guides: reportReadyGuides().map((guide) => ({
      id: guide.id,
      title: guide.title,
      outlineText: guide.outlineText,
      questions: guide.questions,
      matrix: guide.matrix,
      report: guide.report,
      sampleIds: guide.sampleIds
    }))
  };
}

function renderReportSources(guides, metrics) {
  $("#reportSourceSummary").innerHTML = [
    [metrics.guideCount, "研究场景"],
    [metrics.sampleCount, "受访样本"],
    [metrics.questionCount, "大纲问题"]
  ].map(([value, label]) => `<span><b>${value}</b><small>${label}</small></span>`).join("");
  $("#reportSourceCards").innerHTML = guides.length
    ? guides.map((guide, index) => `<article class="report-source-card"><span>DG${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHTML(guide.title)}</strong><small>${guide.matrix.length} 份样本 · ${guide.questions.length} 个问题 · ${(guide.report?.top_insights || []).length} 条洞察</small></div></article>`).join("")
    : '<div class="report-empty-state" style="min-width:100%;min-height:80px"><div><strong>暂无可综合的研究场景</strong><span>请先在“大纲驱动 · 并发分析”中完成至少一份访谈大纲的样本分析。</span></div></div>';
}

function renderReportToc(sections, metrics, stale) {
  $("#reportDynamicToc").innerHTML = `<strong>报告导航</strong>${sections.map((section, index) => `<a href="#${section.id}" class="${index === 0 ? "active" : ""}">${String(index + 1).padStart(2, "0")} ${escapeHTML(section.label)}</a>`).join("")}<div><span>综合报告可信度</span><strong>${metrics.confidence ? `${metrics.confidence}%` : "—"}</strong><small>${metrics.evidenceCount} 条证据 · ${stale ? "研究输入已更新，建议重生成" : "AI 草案待人工复核"}</small></div>`;
}

function renderCombinedA4Report(guides, metrics, script, stale) {
  const paper = $("#reportPaper");
  const scenarioNames = guides.map((guide) => guide.title);
  if (!guides.length) {
    paper.innerHTML = '<div class="report-empty-state"><div><strong>洞察报告尚未形成</strong><span>当访谈大纲完成并发分析后，这里会综合多个研究场景、受访样本和原话证据。</span></div></div>';
    $("#reportDynamicToc").innerHTML = "";
    return;
  }
  const sections = [];
  if (script) {
    sections.push({ id: "report-executive", label: "执行摘要" }, { id: "report-cross", label: "跨场景洞察" }, { id: "report-strategy", label: "策略优先级" }, { id: "report-boundaries", label: "研究边界" });
    paper.innerHTML = `<div class="report-cover"><small>QUALITATIVE INSIGHT REPORT · HUMAN REVIEW REQUIRED</small><h1>${escapeHTML(script.title || state.projectName)}</h1><p>${escapeHTML(script.subtitle || "多访谈场景的证据驱动策略综合")}</p><div class="report-scenario-line">${scenarioNames.map((name) => `<span>${escapeHTML(name)}</span>`).join("")}</div></div>
      <section class="report-section" id="report-executive"><span>01 / EXECUTIVE SUMMARY</span><h2>执行摘要</h2><p>${escapeHTML(script.executive_summary || "研究洞察已生成，等待研究负责人复核。")}</p></section>
      <section class="report-section" id="report-cross"><span>02 / CROSS-SCENARIO INSIGHTS</span><h2>跨场景核心洞察</h2>${(script.cross_scenario_insights || []).map((insight, index) => `<article class="report-cross-insight"><h3>${String(index + 1).padStart(2, "0")} · ${escapeHTML(insight.dimension || insight.theme)}${insight.dimension && insight.theme && insight.dimension !== insight.theme ? `｜${escapeHTML(insight.theme)}` : ""}</h3><p>${escapeHTML(insight.finding)}</p>${insight.scenario_contrast ? `<p class="report-contrast"><strong>场景差异：</strong>${escapeHTML(insight.scenario_contrast)}</p>` : ""}<p><strong>策略影响：</strong>${escapeHTML(insight.implication)}</p><div class="report-evidence-list">${(insight.evidence || []).map((evidence) => `<blockquote>“${escapeHTML(evidence.quote)}” — ${escapeHTML(evidence.document_id)}</blockquote>`).join("")}</div></article>`).join("")}</section>
      <section class="report-section" id="report-strategy"><span>03 / STRATEGIC PRIORITIES</span><h2>市场策略优先级</h2><div class="report-strategy-list">${(script.strategic_priorities || []).map((priority) => `<article><div><h3>${escapeHTML(priority.title)}</h3><p>${escapeHTML(priority.rationale)}</p><p><strong>建议行动：</strong>${escapeHTML(priority.action)}</p></div></article>`).join("")}</div></section>
      <section class="report-section" id="report-boundaries"><span>04 / RESEARCH BOUNDARIES</span><h2>研究边界与人工复核</h2><ol class="report-actions">${(script.caveats || []).map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ol>${stale ? '<div class="report-highlight"><strong>研究输入已更新</strong><p>当前报告仍可浏览，但建议点击“生成洞察报告”以同步最新样本、研究洞察与专业 Deck。</p></div>' : ""}</section>`;
  } else {
    sections.push({ id: "report-context", label: "研究场景" }, { id: "report-findings", label: "分场景发现" }, { id: "report-next", label: "综合下一步" });
    paper.innerHTML = `<div class="report-cover"><small>QUALITATIVE INSIGHT REPORT · EVIDENCE INPUTS READY</small><h1>${escapeHTML(state.projectName)}<br>综合洞察报告</h1><p>已汇集 ${metrics.guideCount} 个研究场景与 ${metrics.sampleCount} 份受访样本，等待生成跨场景洞察与专业 Deck。</p><div class="report-scenario-line">${scenarioNames.map((name) => `<span>${escapeHTML(name)}</span>`).join("")}</div></div>
      <section class="report-section" id="report-context"><span>01 / RESEARCH CONTEXT</span><h2>研究场景与样本</h2><p>各访谈大纲作为独立研究场景，与其绑定样本分别完成大纲逐题分析；综合报告将在保持样本边界的前提下比较场景差异。</p></section>
      <section class="report-section" id="report-findings"><span>02 / SCENARIO FINDINGS</span><h2>分场景已验证发现</h2>${guides.map((guide, index) => `<div class="report-insight"><h3>DG${String(index + 1).padStart(2, "0")} · ${escapeHTML(guide.title)}</h3><p>${escapeHTML(guide.report.executive_summary || "")}</p>${(guide.report.top_insights || []).slice(0, 2).map((insight) => `<blockquote>${escapeHTML(insight.title)} · ${escapeHTML(insight.implication || "")}</blockquote>`).join("")}</div>`).join("")}</section>
      <section class="report-section" id="report-next"><span>03 / NEXT STEP</span><h2>生成专业洞察 Deck</h2><div class="report-highlight"><strong>以研究洞察报告为内容主骨架，直接生成可审阅的 16:9 商业演示</strong><p>Deck 将把场景差异、行为路径、原话证据、跨场景洞察、策略优先级与研究边界转译为多种商业图解和可下载的 PPTX。</p></div></section>`;
  }
  renderReportToc(sections, metrics, stale);
}

function renderDeckStatus(script, stale) {
  const status = $("#deckScriptStatus");
  if (!script?.slides?.length) {
    status.textContent = "等待生成";
    status.classList.remove("stale");
    return;
  }
  status.textContent = stale ? `${script.slides.length} 页 · 输入已更新` : `${script.slides.length} 页 · 已生成`;
  status.classList.toggle("stale", stale);
}

function deckLayoutGlyph(layout) {
  return { "封面": "✦", "执行摘要": "◫", "跨场景全景": "◎", "场景对比": "⇄", "洞察证据": "“", "证据链": "⟿", "旅程地图": "↗", "策略框架": "⌘", "机会优先级": "◇", "行动路线图": "→", "研究边界": "△" }[layout] || "•";
}

function deckPreviewSlideMarkup(slide, index, compact = false) {
  const layoutClasses = {
    "跨场景全景": "panorama",
    "场景对比": "comparison",
    "旅程地图": "journey",
    "策略框架": "framework",
    "机会优先级": "priority",
    "行动路线图": "roadmap",
    "洞察证据": "evidence",
    "证据链": "chain"
  };
  const cover = index === 0 || slide.layout === "封面";
  const visibleTitle = cover ? preferredInsightDeckTitle(state.projectName, slide.title) : slide.title;
  if (compact) {
    return `<div class="deck-thumbnail-canvas ${cover ? "cover" : ""}"><i>${escapeHTML(slide.layout || "INSIGHT")}</i><strong>${escapeHTML(visibleTitle)}</strong><b></b></div>`;
  }
  const blockLimit = ["旅程地图", "行动路线图", "证据链", "机会优先级"].includes(slide.layout) ? 4 : 3;
  const previewBlocks = (slide.content || []).slice(0, blockLimit).map((block) => ({ ...block }));
  if (slide.layout === "机会优先级" && previewBlocks.length === 3) {
    previewBlocks.push({ heading: slide.management_decisions?.[0] || "建立行动验证闭环", body: "明确责任团队、适用场景、验证指标与复盘周期。" });
  }
  const implication = slide.implications?.[0];
  return `<article class="deck-preview-slide ${cover ? "cover" : ""} ${layoutClasses[slide.layout] || "editorial"}">
    <span class="deck-preview-layout-icon">${deckLayoutGlyph(slide.layout)}</span>
    <small>${String(index + 1).padStart(2, "0")} · ${escapeHTML(slide.layout || "INSIGHT")}</small>
    <h3>${escapeHTML(visibleTitle)}</h3>
    <p>${escapeHTML(slide.takeaway)}</p>
    <div class="deck-preview-content">${previewBlocks.map((block, blockIndex) => `<article><i>${String(blockIndex + 1).padStart(2, "0")}</i><strong>${escapeHTML(String(block.heading || "").replace(/^优先级\s*\d+\s*[:：]\s*/u, "").slice(0, slide.layout === "机会优先级" ? 28 : 80))}</strong><p>${escapeHTML(String(block.body || "").slice(0, slide.layout === "策略框架" ? 118 : 360))}</p></article>`).join("")}</div>
    ${slide.evidence?.[0] && slide.layout === "洞察证据" ? `<blockquote>“${escapeHTML(slide.evidence[0].quote)}”<span>${escapeHTML(slide.evidence[0].document_id)}</span></blockquote>` : implication && index > 0 ? `<div class="deck-preview-implication"><span>STRATEGIC IMPLICATION</span><strong>${escapeHTML(implication)}</strong></div>` : ""}
  </article>`;
}

function deckSnapshotKey(slides) {
  return JSON.stringify(slides.map((slide) => [
    slide.title,
    slide.takeaway,
    slide.layout,
    (slide.content || []).map((block) => [block.heading, block.body])
  ]));
}

function inlineComputedStyles(source, target) {
  const sourceNodes = [source, ...source.querySelectorAll("*")];
  const targetNodes = [target, ...target.querySelectorAll("*")];
  sourceNodes.forEach((node, index) => {
    const computed = getComputedStyle(node);
    const targetNode = targetNodes[index];
    for (const property of computed) targetNode.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
  });
}

async function snapshotDeckSlide(element, width = 480) {
  const sourceWidth = Math.max(1, Math.round(element.getBoundingClientRect().width));
  const sourceHeight = Math.max(1, Math.round(element.getBoundingClientRect().height));
  const clone = element.cloneNode(true);
  inlineComputedStyles(element, clone);
  clone.style.width = `${sourceWidth}px`;
  clone.style.height = `${sourceHeight}px`;
  clone.style.margin = "0";
  clone.style.transform = "none";
  clone.style.position = "relative";
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sourceWidth}" height="${sourceHeight}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = blobUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width * 9 / 16);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function hydrateDeckThumbnailSnapshots(slides, key) {
  const generation = ++deckSnapshotGeneration;
  const elements = [...$("#deckPreviewTrack").querySelectorAll(".deck-preview-slide")];
  if (elements.length !== slides.length) return;
  const images = [];
  for (let index = 0; index < elements.length; index += 1) {
    if (generation !== deckSnapshotGeneration) return;
    try {
      images[index] = await snapshotDeckSlide(elements[index]);
      const button = $(`#deckPreviewThumbnails [data-deck-slide="${index}"]`);
      const fallback = button?.querySelector(".deck-thumbnail-canvas");
      if (fallback && images[index]) {
        const image = document.createElement("img");
        image.className = "deck-thumbnail-image";
        image.alt = `第 ${index + 1} 页幻灯片完整快照`;
        image.src = images[index];
        fallback.replaceWith(image);
      }
    } catch (error) {
      console.warn(`Deck thumbnail snapshot ${index + 1} failed`, error);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (generation === deckSnapshotGeneration) deckThumbnailCache = { key, images };
}

function renderDeckPreview(script) {
  const slides = script?.slides || [];
  const workspace = state.reportWorkspace;
  const snapshotKey = deckSnapshotKey(slides);
  const cachedImages = deckThumbnailCache.key === snapshotKey ? deckThumbnailCache.images : [];
  workspace.slideIndex = Math.min(Math.max(0, workspace.slideIndex), Math.max(0, slides.length - 1));
  $("#deckPreviewCounter").textContent = slides.length ? `${workspace.slideIndex + 1} / ${slides.length}` : "0 / 0";
  $("#deckThumbnailCount").textContent = `${slides.length} 页`;
  $("#deckPreviewPrev").disabled = !slides.length || workspace.slideIndex === 0;
  $("#deckPreviewNext").disabled = !slides.length || workspace.slideIndex === slides.length - 1;
  $("#deckPreviewTrack").innerHTML = slides.length
    ? slides.map((slide, index) => deckPreviewSlideMarkup(slide, index)).join("")
    : '<div class="report-empty-state" style="flex:0 0 100%"><div><strong>暂无 Deck 预览</strong><span>生成洞察报告后，这里将逐页显示专业 16:9 幻灯片。</span></div></div>';
  $("#deckPreviewThumbnails").innerHTML = slides.length
    ? slides.map((slide, index) => `<button class="deck-thumbnail ${index === workspace.slideIndex ? "active" : ""}" type="button" data-deck-slide="${index}" aria-label="查看第 ${index + 1} 页：${escapeHTML(index === 0 ? preferredInsightDeckTitle(state.projectName, slide.title) : slide.title)}"><span>${String(index + 1).padStart(2, "0")}</span>${cachedImages[index] ? `<img class="deck-thumbnail-image" src="${cachedImages[index]}" alt="第 ${index + 1} 页幻灯片完整快照">` : deckPreviewSlideMarkup(slide, index, true)}</button>`).join("")
    : '<div class="empty-compact">生成后显示全部页面缩略图</div>';
  requestAnimationFrame(() => {
    const track = $("#deckPreviewTrack");
    track.scrollTo({ left: track.clientWidth * workspace.slideIndex, behavior: "instant" });
    $("#deckPreviewThumbnails .active")?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    if (slides.length && cachedImages.length !== slides.length) hydrateDeckThumbnailSnapshots(slides, snapshotKey);
  });
}

function renderDeckReferences() {
  const files = state.reportWorkspace?.supplementalFiles || [];
  $("#deckReferenceList").innerHTML = files.map((file) => `<article class="deck-reference-file">
    <span>${escapeHTML(file.type || "FILE")}</span>
    <div><strong title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</strong><small>${formatFileSize(file.size)} · 已提取 ${file.text.length.toLocaleString()} 字${file.truncated ? " · 长文已智能截取" : ""}</small></div>
    <button type="button" data-remove-deck-reference="${escapeHTML(file.id)}" aria-label="删除 ${escapeHTML(file.name)}">×</button>
  </article>`).join("");
}

function renderReport() {
  state.reportWorkspace ||= normalizedReportWorkspace();
  const guides = reportReadyGuides();
  const metrics = reportEvidenceMetrics(guides);
  const workspace = state.reportWorkspace;
  const fingerprint = reportSourceFingerprint(guides);
  const stale = Boolean(workspace.deckScript && workspace.sourceFingerprint && workspace.sourceFingerprint !== fingerprint);
  const script = workspace.deckScript;
  const presentationScript = deckScriptForPresentation(script, state.projectName);
  renderReportSources(guides, metrics);
  renderCombinedA4Report(guides, metrics, script, stale);
  renderDeckStatus(presentationScript, stale);
  renderDeckPreview(presentationScript);
  renderDeckReferences();
  $("#deckInstructions").value = workspace.instructions || DEFAULT_DECK_INSTRUCTIONS;
  $("#generateDeckScript").disabled = !guides.length;
  $("#refreshDeckScript").disabled = !guides.length;
  $("#copyReport").disabled = !guides.length;
  $("#exportWord").disabled = !state.report;
  $("#exportPpt").disabled = !script?.slides?.length;
}

function reportResearchStageLabel(stage) {
  const labels = {
    queued: "研究任务排队",
    method_planning: "研究问题与边界规划",
    deep_research: "Deep Research 策略与方法研究",
    evidence_synthesis: "私有证据综合",
    deck_planning: "逐页叙事与 Deck 规划",
    completed: "研究完成",
    failed: "研究未完成"
  };
  return labels[stage] || "洞察研究进行中";
}

function setReportResearchProgress(job, visible = true) {
  const panel = $("#reportResearchProgress");
  panel.hidden = !visible;
  if (!visible) return;
  const progress = Math.max(0, Math.min(100, Math.round(Number(job.progress) || 0)));
  $("#reportResearchStage").textContent = reportResearchStageLabel(job.stage);
  $("#reportResearchPercent").textContent = `${progress}%`;
  $("#reportResearchBar").style.width = `${progress}%`;
  $("#reportResearchMessage").textContent = job.message || "正在处理";
  const seconds = Math.max(0, Math.round(Number(job.elapsedSeconds) || 0));
  $("#reportResearchElapsed").textContent = `已用时 ${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}`;
}

async function pollReportJob(jobId) {
  let transientFailures = 0;
  while (true) {
    try {
      const response = await fetch(`${API_BASE}/api/report/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      const job = await response.json();
      if (!response.ok) {
        const error = new Error(job.error || "读取洞察报告进度失败");
        error.terminal = response.status < 500;
        throw error;
      }
      transientFailures = 0;
      setReportResearchProgress(job);
      if (job.status === "completed") return job.result;
      if (job.status === "failed") {
        const error = new Error(job.error || "洞察报告生成失败");
        error.terminal = true;
        throw error;
      }
      await delay(2_000);
    } catch (error) {
      if (error.terminal) throw error;
      transientFailures += 1;
      if (transientFailures >= 8) throw error;
      $("#reportResearchMessage").textContent = `读取进度时短暂中断，正在自动重试 ${transientFailures}/8…`;
      await delay(1_000 * transientFailures);
    }
  }
}

async function generateComprehensiveDeckScript() {
  const payload = comprehensiveReportPayload();
  if (!payload.guides.length) return toast("请先完成至少一个访谈场景的并发分析");
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 服务");
  if (!state.apiConfigured) return openApiSettings(generateComprehensiveDeckScript);
  const buttons = [$("#generateDeckScript"), $("#refreshDeckScript")];
  buttons.forEach((button) => { button.disabled = true; button.dataset.label = button.textContent; button.textContent = "洞察报告生成中…"; });
  setReportResearchProgress({ stage: "queued", progress: 2, message: "正在创建洞察报告任务", elapsedSeconds: 0 });
  $("#reportResearchProgress").scrollIntoView({ behavior: "smooth", block: "center" });
  try {
    const response = await fetch(`${API_BASE}/api/report/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const job = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(job.error || "洞察报告任务创建失败");
    setReportResearchProgress(job);
    const data = await pollReportJob(job.id);
    state.reportWorkspace = normalizedReportWorkspace({
      ...state.reportWorkspace,
      deckScript: data.deckScript,
      instructions: payload.instructions,
      slideIndex: 0,
      generatedAt: Date.now(),
      sourceFingerprint: reportSourceFingerprint(payload.guides),
      sourceSummary: data.sourceSummary,
      engine: data.engine
    });
    saveCurrentProjectWorkspace();
    renderReport();
    const presentationCount = deckScriptForPresentation(data.deckScript, state.projectName)?.slides?.length || 0;
    setReportResearchProgress({ stage: "completed", progress: 100, message: `已形成 ${presentationCount} 页专业洞察 Deck`, elapsedSeconds: 0 });
    toast(`洞察报告已生成：${presentationCount} 页 16:9 Deck，可预览并下载 PPTX`);
  } catch (error) {
    setReportResearchProgress({ stage: "failed", progress: 100, message: error.message, elapsedSeconds: 0 });
    toast(error.message.includes("fetch") ? "请先启动 MedVoice 服务" : error.message);
  } finally {
    buttons.forEach((button) => { button.textContent = button.dataset.label || "生成洞察报告"; });
    renderReport();
  }
}

async function uploadDeckReferences(files) {
  const selected = [...(files || [])];
  if (!selected.length) return;
  state.reportWorkspace ||= normalizedReportWorkspace();
  if (state.reportWorkspace.supplementalFiles.length + selected.length > 6) return toast("单个研究项目最多保留 6 份补充资料");
  const accepted = /\.(docx?|pdf|pptx?|txt|md|png|jpe?g|webp|tiff?)$/i;
  for (const file of selected) {
    if (!accepted.test(file.name)) {
      toast(`${file.name} 格式暂不支持`);
      continue;
    }
    if (file.size > 35 * 1024 * 1024) {
      toast(`${file.name} 超过 35 MB，请压缩后再上传`);
      continue;
    }
    if (state.reportWorkspace.supplementalFiles.some((item) => item.name === file.name && item.size === file.size)) {
      toast(`${file.name} 已在补充资料中`);
      continue;
    }
    const button = $("#selectDeckReferences");
    const previous = button.textContent;
    button.disabled = true;
    button.textContent = `解析 ${file.name}…`;
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const response = await fetch(`${API_BASE}/api/report/references/parse`, { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `无法读取 ${file.name}`);
      state.reportWorkspace.supplementalFiles.push({
        id: data.id,
        name: data.filename || file.name,
        type: data.type || file.name.split(".").pop().toUpperCase(),
        size: data.size || file.size,
        text: data.text,
        truncated: data.truncated,
        addedAt: Date.now()
      });
      saveCurrentProjectWorkspace();
      renderDeckReferences();
      toast(`${file.name} 已加入研究背景`);
    } catch (error) {
      toast(error.message.includes("fetch") ? "请先启动 MedVoice 服务" : error.message);
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }
  $("#deckReferenceInput").value = "";
}

function removeDeckReference(id) {
  state.reportWorkspace ||= normalizedReportWorkspace();
  state.reportWorkspace.supplementalFiles = state.reportWorkspace.supplementalFiles.filter((file) => file.id !== id);
  saveCurrentProjectWorkspace();
  renderDeckReferences();
  toast("补充资料已移除");
}

function changeDeckPreview(direction) {
  const presentationScript = deckScriptForPresentation(state.reportWorkspace?.deckScript, state.projectName);
  const count = presentationScript?.slides?.length || 0;
  if (!count) return;
  state.reportWorkspace.slideIndex = Math.max(0, Math.min(count - 1, state.reportWorkspace.slideIndex + direction));
  saveCurrentProjectWorkspace();
  renderDeckPreview(presentationScript);
}

function selectDeckPreview(index) {
  const presentationScript = deckScriptForPresentation(state.reportWorkspace?.deckScript, state.projectName);
  const count = presentationScript?.slides?.length || 0;
  if (!count) return;
  state.reportWorkspace.slideIndex = Math.max(0, Math.min(count - 1, Number(index) || 0));
  saveCurrentProjectWorkspace();
  renderDeckPreview(presentationScript);
}

function openEvidence(index, guideId = state.activeOutlineGuideId) {
  syncActiveOutlineGuideFromState();
  const guide = state.outlineGuides.find((item) => item.id === guideId);
  const insight = guide?.report?.top_insights?.[index];
  if (!insight) return;
  const guideIndex = Math.max(0, state.outlineGuides.findIndex((item) => item.id === guideId));
  $("#evidenceContent").innerHTML = `<div class="eyebrow">INSIGHT EVIDENCE CHAIN · DG${String(guideIndex + 1).padStart(2, "0")}</div><span class="evidence-guide-source">${escapeHTML(guide.title)}</span><h2>${escapeHTML(insight.title)}</h2><p class="evidence-summary">${escapeHTML(insight.insight)}</p><div class="impact-box"><strong>策略影响</strong><br>${escapeHTML(insight.implication)}</div><div class="eyebrow">VERBATIM EVIDENCE · ${insight.evidence?.length || 0}</div>${(insight.evidence || []).map((evidence) => `<blockquote>“${escapeHTML(evidence.quote)}”<small>${escapeHTML(evidence.document_id)} · 已回链至原始笔录</small></blockquote>`).join("")}<p class="evidence-summary">置信度 ${insight.confidence}% · ${insight.prevalence} 份访谈支持。样本覆盖不代表总体发生率。</p>`;
  $("#evidenceDialog").showModal();
}

function formatAnalysisEta(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (!value) return "即将完成";
  if (value < 60) return `预计剩余约 ${Math.max(5, Math.ceil(value / 5) * 5)} 秒`;
  return `预计剩余约 ${Math.ceil(value / 60)} 分钟`;
}

function analysisPipelineStep(stage) {
  if (stage === "completed") return 4;
  if (stage === "validation") return 3;
  if (stage === "synthesis") return 2;
  if (stage === "mapping") return 1;
  return 0;
}

function setPipeline(step, percent, text, meta = {}) {
  const normalizedPercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  $$("#pipeline>div").forEach((element, index) => {
    element.classList.toggle("done", index < step);
    element.classList.toggle("active", index === step);
    element.querySelector("em").textContent = index < step ? "完成" : index === step ? "处理中" : "等待";
  });
  $("#progressBar").style.width = `${normalizedPercent}%`;
  $("#analysisProgressPercent").textContent = `${normalizedPercent}%`;
  $("#analysisProgressMeta").textContent = `${meta.completedDocuments || 0} / ${meta.documentCount || 0} 份样本 · ${meta.questionCount || state.questions.length} 个问题`;
  $("#analysisProgressEta").textContent = formatAnalysisEta(meta.estimatedRemainingSeconds);
  $("#analysisProgressTrack").setAttribute("aria-valuenow", String(normalizedPercent));
  $("#progressText").textContent = text;
}

async function pollAnalysisJob(jobId, questionCount) {
  let transientFailures = 0;
  while (true) {
    try {
      const response = await fetch(`${API_BASE}/api/analyze/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      const job = await response.json();
      if (!response.ok) {
        const error = new Error(job.error || "读取分析进度失败");
        error.terminal = response.status < 500;
        throw error;
      }
      transientFailures = 0;
      setPipeline(analysisPipelineStep(job.stage), job.progress, job.message, { ...job, questionCount });
      if (job.status === "completed") return job.result;
      if (job.status === "failed") {
        const error = new Error(job.error || "并发分析失败");
        error.terminal = true;
        throw error;
      }
      await delay(900);
    } catch (error) {
      if (error.terminal) throw error;
      transientFailures += 1;
      if (transientFailures >= 6) throw error;
      $("#progressText").textContent = `读取进度时短暂中断，正在自动重试 ${transientFailures}/6…`;
      await delay(900 * transientFailures);
    }
  }
}

async function runAnalysis() {
  const selected = selectedAnalysisSamples();
  if (!selected.length) return toast("请先为当前访谈大纲绑定至少一份已完成角色区分的样本");
  if (!state.questions.length) return toast("请先导入大纲并识别主要问题");
  const health = await checkHealth();
  if (!health) return toast("请先启动 MedVoice 本地服务");
  if (!state.apiConfigured) return openApiSettings(runAnalysis);
  const dialog = $("#analysisDialog");
  $("#dialogDescription").textContent = `${Math.min(4, selected.length)} 个并发 Agent 正在处理 ${selected.length} 份访谈，并完成跨样本综合。`;
  dialog.showModal();
  setPipeline(0, 2, "正在创建并发分析任务…", {
    completedDocuments: 0,
    documentCount: selected.length,
    questionCount: state.questions.length,
    estimatedRemainingSeconds: Math.max(45, Math.ceil(selected.length / 4) * 20 + 38)
  });
  try {
    const guide = activeOutlineGuide();
    const response = await fetch(`${API_BASE}/api/analyze/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectName: `${state.projectName} · ${guide?.title || "访谈大纲"}`, outline: state.outlineText, questions: state.questions, documents: selected.map(({ id, name, type, text }) => ({ id, name, type, text })) })
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "创建分析任务失败");
    setPipeline(analysisPipelineStep(job.stage), job.progress, job.message, { ...job, questionCount: state.questions.length });
    const data = await pollAnalysisJob(job.id, state.questions.length);
    state.report = redactProductReferences(data.report);
    state.analyses = redactProductReferences(data.analyses);
    state.matrix = redactProductReferences(data.matrix);
    state.questions = redactProductReferences(data.questions);
    saveCurrentProjectWorkspace();
    renderAll();
    await delay(320);
    if (dialog.open) dialog.close();
    showView("matrix");
    toast("并发分析完成：逐题矩阵与洞察报告已生成");
  } catch (error) {
    if (dialog.open) dialog.close();
    toast(error.message);
  }
}

function exportPayload(kind = "") {
  if (kind === "pptx" && state.reportWorkspace?.deckScript?.slides?.length) {
    return {
      projectName: state.projectName,
      deckScript: deckScriptForPresentation(state.reportWorkspace.deckScript, state.projectName),
      guides: reportReadyGuides().map((guide) => ({
        id: guide.id,
        title: guide.title,
        questions: guide.questions,
        matrix: guide.matrix,
        report: guide.report
      }))
    };
  }
  const guide = activeOutlineGuide();
  return { projectName: `${state.projectName} · ${guide?.title || "访谈大纲"}`, questions: state.questions, matrix: state.matrix, report: state.report };
}

async function downloadExport(kind) {
  const labels = { xlsx: "Excel 矩阵", docx: "Word 报告", pptx: "PPT Deck" };
  toast(`正在生成${labels[kind]}…`);
  try {
    const response = await fetch(`${API_BASE}/api/export/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(exportPayload(kind)) });
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
    let session = null;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      if (session) {
        session.lastChunkAt = Date.now();
        session.chunkCount += 1;
        session.recordedBytes += event.data.size;
      }
    };
    recorder.onerror = (event) => {
      if (!session || state.recording !== session) return;
      session.captureError = event.error?.message || "浏览器录音连接异常";
      setRecordingHint("录音连接出现异常；系统将保存已采集片段，请点击“停止并保存”后重试。", "error");
    };
    recorder.onstop = async () => {
      const stoppedSession = session || state.recording;
      const durationSeconds = Math.max(1, getRecordingElapsedSeconds(stoppedSession));
      const draftText = String(stoppedSession?.livePreviewText || $("#liveTranscript").textContent || "").replace(/^(正在聆听…|尚未开始)$/u, "").trim();
      const extension = recorder.mimeType.includes("mp4") ? "m4a" : "webm";
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = new File([blob], `Live-recording-${timestamp}.${extension}`, { type: blob.type });
      stream.getTracks().forEach((track) => track.stop());
      stopSpeechPreview(stoppedSession);
      clearInterval(stoppedSession?.timer);
      clearTimeout(stoppedSession?.speechRestartTimer);
      if (state.recording === stoppedSession) state.recording = null;
      $("#recordingConsole").classList.remove("active");
      $("#recordingStatus").textContent = "录音已保存";
      $("#startRecording").disabled = false;
      $("#pauseRecording").disabled = true;
      $("#pauseRecording").textContent = "暂停";
      $("#stopRecording").disabled = true;
      setRecordingHint("录音已生成本机备份，正在安全同步到账号资料库。", "active");
      const [newIndex] = await addFiles([file], {
        source: "实时录音",
        type: $("#recordRespondentType").value,
        durationSeconds,
        draftText,
        recordedAt: new Date().toLocaleString("zh-CN", { hour12: false })
      });
      if (Number.isInteger(newIndex) && $("#autoTranscribeRecording").checked) {
        const item = state.interviews[newIndex];
        if (item?.serverId) {
          toast("录音已保存至账号资料库，正在从服务器分片转录", 4000);
          await transcribeInterview(newIndex);
        } else {
          item.status = "录音已保存";
          item.progressText = "本机备份完整；账号同步成功后再启动转录，避免长录音重复上传。";
          await saveLocalInterview(newIndex);
          renderAll();
          toast("录音已安全保存在本机；账号同步尚未完成，请网络稳定后点击“转录”重试保存。", 8000);
        }
      } else {
        toast("录音已同步至“已导入资料”，可点击“转录”后区分角色", 4500);
      }
    };
    const now = Date.now();
    session = {
      recorder,
      stream,
      startedAt: now,
      pausedAt: 0,
      pauseStarted: null,
      livePreviewText: "",
      speechFinalText: "",
      lastSpeechPreviewActivity: now,
      lastChunkAt: now,
      chunkCount: 0,
      recordedBytes: 0,
      speechPreviewGeneration: 0,
      speechPreviewStopping: false,
      timer: null
    };
    state.recording = session;
    recorder.start(10_000);
    session.timer = setInterval(updateRecordingTime, 500);
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (state.recording !== session || recorder.state === "inactive") return;
        setRecordingHint("麦克风连接已中断，正在保存已采集片段。", "error");
        session.stopping = true;
        recorder.stop();
      };
    }
    $("#recordingConsole").classList.add("active");
    $("#recordingStatus").textContent = "正在录音";
    $("#recordingTime").textContent = "00:00";
    $("#startRecording").disabled = true;
    $("#pauseRecording").disabled = false;
    $("#pauseRecording").textContent = "暂停";
    $("#stopRecording").disabled = false;
    $("#liveTranscript").textContent = "正在聆听…";
    setRecordingHint("录音持续采集中；短暂静默不会结束录音。", "active");
    startSpeechPreview(session);
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
  const session = state.recording;
  const seconds = getRecordingElapsedSeconds(session);
  $("#recordingTime").textContent = formatDuration(seconds);
  const now = Date.now();
  if (session.recorder.state === "recording" && now - session.lastChunkAt > 25_000) {
    try { session.recorder.requestData(); } catch {}
    session.lastChunkAt = now;
  }
  const quietSeconds = Math.floor((now - session.lastSpeechPreviewActivity) / 1000);
  if (session.recorder.state === "paused") {
    setRecordingHint("录音已暂停；点击“继续”后恢复采集。", "warning");
  } else if (session.speechPreviewSupported && !session.speechPreviewFatal && quietSeconds >= 60) {
    setRecordingHint(`已静默约 ${Math.max(1, Math.floor(quietSeconds / 60))} 分钟，录音仍在持续；恢复说话后文字预览会自动重连。`, "warning");
  } else if (seconds >= 50 * 60) {
    setRecordingHint("长录音持续采集中；停止后将自动分片保存与转录，无需重新开始。", "active");
  }
}

function setRecordingHint(message, tone = "") {
  const hint = $("#recordingHint");
  if (!hint) return;
  if (hint.textContent !== message) hint.textContent = message;
  hint.dataset.tone = tone;
}

function pauseRecording() {
  const current = state.recording;
  if (!current) return;
  if (current.recorder.state === "recording") {
    current.recorder.pause();
    pauseSpeechPreview(current);
    current.pauseStarted = Date.now();
    updateRecordingTime();
    $("#pauseRecording").textContent = "继续";
    $("#recordingStatus").textContent = "录音已暂停";
  } else if (current.recorder.state === "paused") {
    current.pausedAt += Date.now() - current.pauseStarted;
    current.pauseStarted = null;
    current.recorder.resume();
    current.lastSpeechPreviewActivity = Date.now();
    current.speechPreviewStopping = false;
    startSpeechPreview(current);
    updateRecordingTime();
    $("#pauseRecording").textContent = "暂停";
    $("#recordingStatus").textContent = "正在录音";
  }
}

function stopRecording() {
  if (state.recording?.recorder && state.recording.recorder.state !== "inactive") {
    state.recording.stopping = true;
    setRecordingHint("正在封装录音并建立本机备份，请稍候。", "active");
    state.recording.recorder.stop();
  }
}

function startSpeechPreview(session = state.recording) {
  if (!session || state.recording !== session || session.recorder.state !== "recording") return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    session.speechPreviewSupported = false;
    $("#liveTranscript").textContent = "当前浏览器不支持实时文字预览；录音仍会正常保存并支持 AI 中英文转录。";
    return;
  }
  session.speechPreviewSupported = true;
  session.speechPreviewFatal = false;
  clearTimeout(session.speechRestartTimer);
  session.speechPreviewStopping = false;
  const generation = ++session.speechPreviewGeneration;
  const recognition = new SpeechRecognition();
  recognition.lang = $("#recordLanguage").value;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    if (state.recording !== session || generation !== session.speechPreviewGeneration) return;
    setRecordingHint("录音持续采集中；实时文字预览已连接。", "active");
  };
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) session.speechFinalText += `${text} `; else interim += text;
    }
    session.lastSpeechPreviewActivity = Date.now();
    const previewText = session.speechFinalText + interim;
    $("#liveTranscript").textContent = previewText;
    session.livePreviewText = previewText;
  };
  recognition.onerror = (event) => {
    if (state.recording !== session || generation !== session.speechPreviewGeneration) return;
    const fatal = ["not-allowed", "service-not-allowed", "audio-capture"].includes(event.error);
    session.speechPreviewFatal = fatal;
    setRecordingHint(
      fatal ? "实时文字预览不可用，但原始录音仍在持续采集。" : "录音仍在持续；实时文字预览连接中断，正在自动恢复。",
      "warning"
    );
  };
  recognition.onend = () => {
    if (state.recording !== session || generation !== session.speechPreviewGeneration) return;
    session.recognition = null;
    if (session.speechPreviewStopping || session.speechPreviewFatal || session.recorder.state !== "recording") return;
    setRecordingHint("录音仍在持续；实时文字预览正在自动重连。", "warning");
    session.speechRestartTimer = setTimeout(() => startSpeechPreview(session), 900);
  };
  session.recognition = recognition;
  try {
    recognition.start();
  } catch {
    session.speechRestartTimer = setTimeout(() => startSpeechPreview(session), 1200);
  }
}

function pauseSpeechPreview(session = state.recording) {
  if (!session) return;
  clearTimeout(session.speechRestartTimer);
  session.speechPreviewGeneration += 1;
  try { session.recognition?.abort(); } catch {}
  session.recognition = null;
}

function stopSpeechPreview(session = state.recording) {
  if (!session) return;
  session.speechPreviewStopping = true;
  pauseSpeechPreview(session);
}

function renderAll() {
  renderProjectSwitcher();
  renderTranscripts();
  renderRoleMapper();
  renderOutlineGuideManager();
  renderQuestions();
  renderReadiness();
  renderOverview();
  renderMatrix();
  renderReport();
}

$$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-view-jump]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewJump)));
$$("[data-insight-filter]").forEach((button) => button.addEventListener("click", () => {
  state.overviewInsightFilter = button.dataset.insightFilter;
  $$("[data-insight-filter]").forEach((item) => item.classList.toggle("active", item.dataset.insightFilter === state.overviewInsightFilter));
  renderInsights();
}));
$$("dialog .dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.addEventListener("click", (event) => { if (!event.target.closest(".confidence-info-button") && !event.target.closest("#confidenceFloatingPopover")) hideConfidencePopover(); });
["click", "submit", "change", "input", "drop", "paste"].forEach((eventName) => {
  document.addEventListener(eventName, guardPreviewInteraction, true);
});
document.addEventListener("keydown", (event) => {
  if (!state.previewMode || !["Enter", " "].includes(event.key) || previewActionAllowed(event.target)) return;
  if (!event.target.closest("button,a[href],input,select,textarea,[role='button']")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  previewBlockedMessage();
}, true);
window.addEventListener("scroll", hideConfidencePopover, true);
window.addEventListener("resize", hideConfidencePopover);
window.addEventListener("online", () => retryPendingAccountSaves());
$("#cancelAnalysis").addEventListener("click", () => $("#analysisDialog").close());
$("#uploadButton").addEventListener("click", () => $("#fileInput").click());
$("#browseButton")?.addEventListener("click", (event) => { event.stopPropagation(); $("#fileInput").click(); });
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
  removeSamplesFromOutlineGuides(selected);
  saveCurrentProjectWorkspace();
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
$("#toggleAllRolePreviews")?.addEventListener("click", () => {
  const completed = roleMappedInterviews();
  const shouldExpand = !completed.every((item) => item.roleExpanded === true);
  completed.forEach((item) => { item.roleExpanded = shouldExpand; });
  renderRoleMapper();
});
$("#deleteRoleDocs").addEventListener("click", deleteSelectedRoleDocs);
$("#exportRoleWord").addEventListener("click", exportRoleWord);
const outlineDropzone = $("#outlineUpload");
$("#outlineFile").addEventListener("click", (event) => event.stopPropagation());
$("#browseOutline").addEventListener("click", (event) => { event.stopPropagation(); state.outlineUploadMode = "add"; $("#outlineFile").click(); });
outlineDropzone.addEventListener("click", (event) => { if (!event.target.closest("button")) { state.outlineUploadMode = "add"; $("#outlineFile").click(); } });
outlineDropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); state.outlineUploadMode = "add"; $("#outlineFile").click(); } });
["dragenter", "dragover"].forEach((eventName) => outlineDropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  outlineDropzone.classList.add("dragging");
}));
outlineDropzone.addEventListener("dragleave", (event) => {
  if (!outlineDropzone.contains(event.relatedTarget)) outlineDropzone.classList.remove("dragging");
});
outlineDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  outlineDropzone.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.(?:docx|pdf|txt|md)$/i.test(file.name)) return toast("请上传 DOCX、PDF、TXT 或 MD 格式的访谈大纲");
  state.outlineUploadMode = "add";
  uploadOutline(file);
});
$("#outlineFile").addEventListener("change", (event) => {
  if (event.target.files[0]) uploadOutline(event.target.files[0]);
  event.target.value = "";
});
$("#outlineRenameForm").addEventListener("submit", saveOutlineGuideRename);
$("#cancelOutlineRename").addEventListener("click", closeOutlineGuideRename);
$("#closeOutlineRename").addEventListener("click", closeOutlineGuideRename);
$("#outlineRenameDialog").addEventListener("close", () => { outlineRenameGuideId = ""; });
$("#parseOutline").addEventListener("click", parseOutlineFromText);
$("#selectAllAnalysisSamples").addEventListener("click", () => updateActiveGuideSamples(eligibleAnalysisSamples().map(analysisSampleKey)));
$("#clearAnalysisSamples").addEventListener("click", () => updateActiveGuideSamples([]));
$("#outlineInput").addEventListener("input", () => {
  state.outlineText = $("#outlineInput").value;
  if (state.outlineFileMeta) {
    state.outlineFileMeta.edited = true;
  } else {
    state.outlineSource = "手动输入";
  }
  invalidateOutlineAnalysis();
  saveCurrentProjectWorkspace();
});
$("#addQuestionGroup").addEventListener("click", () => {
  state.questionGroups.push({ title: "新问题维度", questions: [""] });
  syncQuestionFramework({ rerender: true });
});
$("#runOutlineAnalysis").addEventListener("click", runAnalysis);
$("#exportExcel").addEventListener("click", () => downloadExport("xlsx"));
$("#exportWord").addEventListener("click", () => downloadExport("docx"));
$("#exportPpt").addEventListener("click", () => downloadExport("pptx"));
$("#generateDeckScript").addEventListener("click", generateComprehensiveDeckScript);
$("#refreshDeckScript").addEventListener("click", generateComprehensiveDeckScript);
$("#deckInstructions").addEventListener("input", (event) => {
  state.reportWorkspace ||= normalizedReportWorkspace();
  state.reportWorkspace.instructions = event.target.value.slice(0, 1200);
  saveCurrentProjectWorkspace();
});
$("#selectDeckReferences").addEventListener("click", () => $("#deckReferenceInput").click());
$("#deckReferenceInput").addEventListener("change", (event) => uploadDeckReferences(event.target.files));
for (const eventName of ["dragenter", "dragover"]) {
  $("#deckReferenceDropzone").addEventListener(eventName, (event) => {
    event.preventDefault();
    event.currentTarget.classList.add("dragover");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  $("#deckReferenceDropzone").addEventListener(eventName, (event) => {
    event.preventDefault();
    event.currentTarget.classList.remove("dragover");
  });
}
$("#deckReferenceDropzone").addEventListener("drop", (event) => uploadDeckReferences(event.dataTransfer.files));
$("#deckReferenceList").addEventListener("click", (event) => {
  const target = event.target.closest("[data-remove-deck-reference]");
  if (target) removeDeckReference(target.dataset.removeDeckReference);
});
$("#deckPreviewPrev").addEventListener("click", () => changeDeckPreview(-1));
$("#deckPreviewNext").addEventListener("click", () => changeDeckPreview(1));
$("#deckPreviewThumbnails").addEventListener("click", (event) => {
  const target = event.target.closest("[data-deck-slide]");
  if (target) selectDeckPreview(target.dataset.deckSlide);
});
$("#evidenceQuestionSearch").addEventListener("input", (event) => {
  state.evidenceSearch = event.target.value;
  renderEvidenceLedger();
});
$("#matrixTableWrap").addEventListener("scroll", updateMatrixScrollState, { passive: true });
$("#matrixHorizontalScrollHint").addEventListener("click", () => {
  const wrap = $("#matrixTableWrap");
  wrap.scrollBy({ left: Math.max(320, wrap.clientWidth * 0.72), behavior: "smooth" });
});
$("#matrixVerticalScrollHint").addEventListener("click", () => {
  const wrap = $("#matrixTableWrap");
  wrap.scrollBy({ top: Math.max(260, wrap.clientHeight * 0.72), behavior: "smooth" });
});
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
  saveCurrentProjectWorkspace();
  showView("transcripts");
  toast(`已创建研究：${project.name}`);
}

$("#projectSelect").addEventListener("change", (event) => setActiveProject(event.target.value));
$("#renameProject").addEventListener("click", renameCurrentProject);
$("#createProject").addEventListener("click", createProject);
window.addEventListener("hashchange", () => showView(savedView(), { updateHash: false }));
window.addEventListener("resize", () => {
  updateTranscriptTableScrollState();
  updateRolePreviewScrollState();
  updateMatrixScrollState();
});

async function initializeApp() {
  const initialView = savedView(INITIAL_HASH);
  if (state.previewMode) {
    applyPreviewWorkspace();
    showView(initialView, { updateHash: true, scroll: false });
    renderAll();
    configurePreviewMode();
    return;
  }
  loadProjects();
  loadCurrentProjectWorkspace();
  showView(initialView, { updateHash: true, scroll: false });
  renderAll();
  const session = await checkPortalSession();
  if (state.authRequired && !session?.authenticated) return;
  try {
    await syncProjectWorkspaces();
    renderAll();
  } catch (error) {
    workspaceSyncReady = Boolean(state.currentUser);
    console.warn("MedVoice project workspace bootstrap failed", error);
    toast(`账号工作区加载失败，当前继续使用本地缓存：${error.message}`, 6000);
  }
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
