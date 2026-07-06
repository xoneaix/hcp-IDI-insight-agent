import http from "node:http";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildRoleExchanges,
  extractOutlineQuestions,
  extractResponseText,
  maskSensitiveText,
  parseTranscriptTurns,
  runWithConcurrency,
  safeJsonParse,
  validateAnalysisPayload
} from "./lib/core.js";
import { buildInsightDeck, buildInsightDocx, buildMatrixWorkbook, buildRoleTranscriptDocx } from "./lib/office-exporter.mjs";
import { AuthStore } from "./lib/auth-store.mjs";

const ROOT = join(process.cwd(), "public");
const PORT = Number(process.env.PORT || 4174);
const MAP_MODEL = process.env.MAP_MODEL || "gpt-5.4-mini";
const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL || "gpt-5.5";
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 4);
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const JOB_DIR = process.env.JOB_DIR || join(DATA_DIR, "jobs");
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
let API_KEY = process.env.OPENAI_API_KEY || "";
const execFileAsync = promisify(execFile);
const DIRECT_AUDIO_LIMIT = 24 * 1024 * 1024;
const LARGE_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
const AUDIO_CHUNK_SECONDS = 10 * 60;
await mkdir(JOB_DIR, { recursive: true });
const authStore = await AuthStore.create(join(DATA_DIR, "medvoice.sqlite"));
if (AUTH_REQUIRED) {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) throw new Error("在线权限模式需要配置 ADMIN_EMAIL 和 ADMIN_PASSWORD");
  await authStore.ensureAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
}
const loginAttempts = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const quoteSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    quote: { type: "string" },
    speaker: { type: "string" },
    meaning: { type: "string" }
  },
  required: ["quote", "speaker", "meaning"]
};

const documentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    document_id: { type: "string" },
    respondent_profile: { type: "string" },
    summary: { type: "string" },
    outline_answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question_id: { type: "string" },
          question: { type: "string" },
          answer: { type: "string" },
          coverage: { type: "string", enum: ["完整覆盖", "部分覆盖", "未覆盖"] },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          quotes: { type: "array", items: quoteSchema }
        },
        required: ["question_id", "question", "answer", "coverage", "confidence", "quotes"]
      }
    },
    themes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          theme: { type: "string" },
          stance: { type: "string", enum: ["正向", "中性", "负向", "矛盾"] },
          finding: { type: "string" },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          quotes: { type: "array", items: quoteSchema }
        },
        required: ["theme", "stance", "finding", "confidence", "quotes"]
      }
    },
    unmet_needs: { type: "array", items: { type: "string" } },
    drivers: { type: "array", items: { type: "string" } },
    barriers: { type: "array", items: { type: "string" } },
    contradictions: { type: "array", items: { type: "string" } }
  },
  required: ["document_id", "respondent_profile", "summary", "outline_answers", "themes", "unmet_needs", "drivers", "barriers", "contradictions"]
};

const synthesisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    executive_summary: { type: "string" },
    sample_overview: { type: "string" },
    top_insights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          insight: { type: "string" },
          implication: { type: "string" },
          prevalence: { type: "integer", minimum: 0 },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                document_id: { type: "string" },
                quote: { type: "string" }
              },
              required: ["document_id", "quote"]
            }
          }
        },
        required: ["title", "insight", "implication", "prevalence", "confidence", "evidence"]
      }
    },
    theme_matrix: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          theme: { type: "string" },
          consensus: { type: "string" },
          divergence: { type: "string" },
          document_ids: { type: "array", items: { type: "string" } }
        },
        required: ["theme", "consensus", "divergence", "document_ids"]
      }
    },
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          document_ids: { type: "array", items: { type: "string" } },
          opportunity: { type: "string" }
        },
        required: ["name", "description", "document_ids", "opportunity"]
      }
    },
    unmet_needs: { type: "array", items: { type: "string" } },
    strategic_actions: { type: "array", items: { type: "string" } },
    caveats: { type: "array", items: { type: "string" } }
  },
  required: ["executive_summary", "sample_overview", "top_insights", "theme_matrix", "segments", "unmet_needs", "strategic_actions", "caveats"]
};

const roleAssignmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          line_no: { type: "integer", minimum: 1 },
          role: { type: "string", enum: ["interviewer", "respondent", "observer", "uncertain"] },
          confidence: { type: "integer", minimum: 0, maximum: 100 }
        },
        required: ["line_no", "role", "confidence"]
      }
    },
    review_notes: { type: "array", items: { type: "string" } }
  },
  required: ["assignments", "review_notes"]
};

async function openAIResponses(body) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI API 错误 (${response.status})`);
  return data;
}

async function analyzeDocument(document, outline, questions) {
  const questionList = questions.map((question, index) => `Q${index + 1}. ${question}`).join("\n");
  const prompt = `研究大纲原文：\n${outline}\n\n必须逐一回答的问题：\n${questionList}\n\n访谈编号：${document.id}\n受访者类型：${document.type}\n\n访谈内容：\n${maskSensitiveText(document.text)}`;
  const response = await openAIResponses({
    model: MAP_MODEL,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content: "你是严谨的医药定性研究分析师。仅依据访谈原文提取信息，不补造事实；所有判断都要与逐字引文对应。必须按输入顺序为每个大纲问题输出一条 outline_answers；原文没有涉及时明确写‘未覆盖’，不得猜测。区分事实、受访者观点和分析推断。中英文访谈均可分析，输出简体中文。"
      },
      { role: "user", content: prompt }
    ],
    text: { format: { type: "json_schema", name: "interview_analysis", strict: true, schema: documentSchema } }
  });
  return safeJsonParse(extractResponseText(response));
}

async function synthesize(projectName, outline, analyses) {
  const response = await openAIResponses({
    model: SYNTHESIS_MODEL,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content: "你是医药市场研究洞察负责人。跨样本综合时必须保留异质性、反例与证据链；不要把少数观点夸大为共识。prevalence 表示支持该洞察的不同访谈数量。输出可供医学、市场和患者策略团队行动的简体中文报告。"
      },
      {
        role: "user",
        content: `项目：${projectName}\n研究大纲：${outline}\n\n单份访谈结构化结果：\n${JSON.stringify(analyses)}`
      }
    ],
    text: { format: { type: "json_schema", name: "cross_interview_synthesis", strict: true, schema: synthesisSchema } }
  });
  return safeJsonParse(extractResponseText(response));
}

async function identifyRoleBatch(document, turns) {
  const transcript = turns.map((turn) => `${turn.line_no}\t${turn.speaker}\t${turn.timestamp || "-"}\t${maskSensitiveText(turn.text)}`).join("\n");
  const response = await openAIResponses({
    model: MAP_MODEL,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content: "你是严谨的定性访谈语义角色标注器。根据完整对话关系判断每行说话者身份：interviewer=访谈员/主持人，respondent=被访者，observer=明确的第三方或旁听者，uncertain=证据不足。角色依据是整段会话身份而非句式；受访者可能反问，访谈员也可能陈述。必须为输入的每个 line_no 输出且仅输出一次，不改写原话，不推断姓名、疾病或身份等新事实。"
      },
      {
        role: "user",
        content: `受访者类型：${document.type}\n文件：${document.name}\n\n逐行转录（行号 / 原说话人 / 时间 / 原话）：\n${transcript}`
      }
    ],
    text: { format: { type: "json_schema", name: "interview_role_assignments", strict: true, schema: roleAssignmentSchema } }
  });
  return safeJsonParse(extractResponseText(response));
}

async function identifyDocumentRoles(document) {
  const turns = parseTranscriptTurns(document.text);
  if (!turns.length) throw new Error(`${document.id} 没有可识别的转录行`);
  const batchSize = 140;
  const batches = [];
  for (let index = 0; index < turns.length; index += batchSize) batches.push(turns.slice(index, index + batchSize));
  const batchResults = await runWithConcurrency(batches, Math.min(3, MAX_CONCURRENCY), (batch) => identifyRoleBatch(document, batch));
  const assignments = batchResults.flatMap((result) => result.assignments || []);
  const structured = buildRoleExchanges(turns, assignments, document.type === "患者" ? "患者/受访者" : "HCP/受访者");
  return {
    document_id: document.id,
    name: document.name,
    type: document.type,
    ...structured,
    turn_count: turns.length,
    review_notes: batchResults.flatMap((result) => result.review_notes || []).slice(0, 30),
    model: MAP_MODEL
  };
}

async function readJson(req, maxBytes = 8_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRaw(req, maxBytes = 120_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType = "") {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error("缺少 multipart boundary");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor >= 0) {
    let start = cursor + boundary.length;
    if (buffer.slice(start, start + 2).toString() === "--") break;
    if (buffer.slice(start, start + 2).toString() === "\r\n") start += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), start);
    if (headerEnd < 0) break;
    const headers = buffer.slice(start, headerEnd).toString("utf8");
    const next = buffer.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    let end = next;
    if (buffer.slice(end - 2, end).toString() === "\r\n") end -= 2;
    const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (disposition) parts.push({ name: disposition[1], filename: disposition[2] || "", headers, data: buffer.slice(headerEnd + 4, end) });
    cursor = next;
  }
  return parts;
}

async function pythonBinary() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const bundled = "/Users/nielun/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";
  try {
    await access(bundled);
    return bundled;
  } catch {
    return "python3";
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter((part) => part.includes("=")).map((part) => {
    const index = part.indexOf("=");
    try {
      return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
    } catch {
      return [part.slice(0, index), part.slice(index + 1)];
    }
  }));
}

function currentUser(req) {
  if (!AUTH_REQUIRED) return { id: 0, email: "local@hisunpharm.com", role: "admin", mustChangePassword: false };
  return authStore.sessionUser(cookies(req).mv_session);
}

function sessionCookie(req, token, expires) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  return `mv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(req) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  return `mv_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function requireUser(req, res, role) {
  const user = currentUser(req);
  if (!user) {
    json(res, 401, { error: "登录已过期，请重新登录" });
    return null;
  }
  if (role && user.role !== role) {
    json(res, 403, { error: "当前账号没有管理员权限" });
    return null;
  }
  req.user = user;
  return user;
}

function checkLoginRateLimit(req, email) {
  const key = `${req.socket.remoteAddress || "unknown"}:${String(email || "").toLowerCase()}`;
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, startedAt: now };
  if (now - record.startedAt > 15 * 60 * 1000) {
    record.count = 0;
    record.startedAt = now;
  }
  record.count += 1;
  loginAttempts.set(key, record);
  if (record.count > 10) throw new Error("登录尝试过于频繁，请15分钟后重试");
  return () => loginAttempts.delete(key);
}

async function handleAuth(req, res, pathname) {
  if (pathname === "/api/auth/session" && req.method === "GET") {
    const user = currentUser(req);
    return json(res, 200, { authRequired: AUTH_REQUIRED, authenticated: Boolean(user), user });
  }
  if (pathname === "/api/auth/login" && req.method === "POST") {
    if (!AUTH_REQUIRED) return json(res, 200, { authenticated: true, user: currentUser(req) });
    const payload = await readJson(req, 100_000);
    const clearRateLimit = checkLoginRateLimit(req, payload.email);
    const user = await authStore.authenticate(payload.email, payload.password);
    if (!user) return json(res, 401, { error: "邮箱或密码不正确" });
    clearRateLimit();
    const session = authStore.createSession(user.id);
    return json(res, 200, { authenticated: true, user }, { "Set-Cookie": sessionCookie(req, session.token, session.expires) });
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    authStore.deleteSession(cookies(req).mv_session);
    return json(res, 200, { authenticated: false }, { "Set-Cookie": clearSessionCookie(req) });
  }
  if (pathname === "/api/auth/change-password" && req.method === "POST") {
    const user = requireUser(req, res);
    if (!user) return;
    const payload = await readJson(req, 100_000);
    await authStore.changePassword(user.id, payload.currentPassword, payload.newPassword);
    return json(res, 200, { changed: true });
  }
  if (pathname === "/api/access/request" && req.method === "POST") {
    const payload = await readJson(req, 100_000);
    const result = await authStore.requestAccess(payload.email, payload.note);
    return json(res, 200, { requested: !result.alreadyActive, alreadyActive: result.alreadyActive });
  }
  return false;
}

async function handleAdmin(req, res, pathname) {
  const admin = requireUser(req, res, "admin");
  if (!admin) return;
  if (pathname === "/api/admin/users" && req.method === "GET") return json(res, 200, { users: authStore.listUsers() });
  if (pathname === "/api/admin/users" && req.method === "POST") {
    const payload = await readJson(req, 100_000);
    return json(res, 200, await authStore.addUser(payload.email, payload.role));
  }
  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && req.method === "PATCH") {
    const payload = await readJson(req, 100_000);
    if (Number(userMatch[1]) === admin.id && payload.active === false) throw new Error("不能停用当前管理员账号");
    authStore.setUserActive(userMatch[1], Boolean(payload.active));
    return json(res, 200, { updated: true });
  }
  if (pathname === "/api/admin/requests" && req.method === "GET") return json(res, 200, { requests: authStore.listRequests() });
  const requestMatch = pathname.match(/^\/api\/admin\/requests\/(\d+)\/(approve|reject)$/);
  if (requestMatch && req.method === "POST") {
    if (requestMatch[2] === "approve") return json(res, 200, await authStore.approveRequest(requestMatch[1], admin.id));
    authStore.rejectRequest(requestMatch[1], admin.id);
    return json(res, 200, { rejected: true });
  }
  json(res, 404, { error: "管理接口不存在" });
}

function binary(res, status, body, contentType, filename) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function handleOutlineParse(req, res) {
  const raw = await readRaw(req, 30_000_000);
  const parts = parseMultipart(raw, req.headers["content-type"]);
  const file = parts.find((part) => part.filename);
  if (!file) throw new Error("请选择 Word、PDF 或文本大纲文件");
  const suffix = extname(file.filename).toLowerCase();
  if (![".docx", ".pdf", ".txt", ".md"].includes(suffix)) throw new Error("大纲仅支持 DOCX、PDF、TXT、MD 格式");
  const tempPath = join(tmpdir(), `medvoice-outline-${randomUUID()}${suffix}`);
  try {
    await writeFile(tempPath, file.data);
    const python = await pythonBinary();
    const script = join(process.cwd(), "scripts", "outline_parser.py");
    const { stdout } = await execFileAsync(python, [script, tempPath], { maxBuffer: 30_000_000 });
    const parsed = JSON.parse(stdout);
    const text = String(parsed.text || "").trim();
    if (!text) throw new Error("未能从文件中提取到可读文字；扫描版 PDF 请先执行 OCR");
    const questions = extractOutlineQuestions(text);
    json(res, 200, { filename: file.filename, text, questions });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

async function handleExport(req, res, kind) {
  const payload = await readJson(req, 25_000_000);
  if (kind === "role-docx") {
    if (!Array.isArray(payload.documents) || !payload.documents.length) throw new Error("请先完成至少一份访谈的角色区分");
    return binary(res, 200, await buildRoleTranscriptDocx(payload), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "MedVoice-role-labeled-transcript.docx");
  }
  if (!payload.report && kind !== "xlsx") throw new Error("请先完成大纲驱动分析，再导出报告");
  if (!Array.isArray(payload.questions) || !payload.questions.length) throw new Error("没有可导出的大纲问题");
  if (kind === "xlsx") return binary(res, 200, await buildMatrixWorkbook(payload), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "MedVoice-question-matrix.xlsx");
  if (kind === "docx") return binary(res, 200, await buildInsightDocx(payload), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "MedVoice-insight-report.docx");
  if (kind === "pptx") return binary(res, 200, await buildInsightDeck(payload), "application/vnd.openxmlformats-officedocument.presentationml.presentation", "MedVoice-insight-deck.pptx");
  throw new Error("不支持的导出格式");
}

async function handleIdentifyRoles(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请先完成临时 API Key 配置。" });
  const payload = await readJson(req, 25_000_000);
  if (!Array.isArray(payload.documents) || !payload.documents.length) throw new Error("请选择至少一份已转录访谈");
  if (payload.documents.length > 10) throw new Error("单次最多区分 10 份访谈，请分批处理");
  const documents = payload.documents.map((document, index) => {
    const text = String(document?.text || "").trim().slice(0, 120_000);
    if (!text) throw new Error(`第 ${index + 1} 份访谈尚无转录文本`);
    return {
      id: String(document.id || `INT-${index + 1}`).slice(0, 80),
      name: String(document.name || `访谈 ${index + 1}`).slice(0, 160),
      type: document.type === "患者" ? "患者" : "HCP",
      text
    };
  });
  const results = await runWithConcurrency(documents, Math.min(2, MAX_CONCURRENCY), identifyDocumentRoles);
  json(res, 200, { results, model: MAP_MODEL });
}

async function handleAnalyze(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请在页面右上角完成临时 API Key 配置。" });
  const payload = validateAnalysisPayload(await readJson(req));
  const analyses = await runWithConcurrency(payload.documents, MAX_CONCURRENCY, (doc) => analyzeDocument(doc, payload.outline, payload.questions));
  const report = await synthesize(payload.projectName, payload.outline, analyses);
  const matrix = payload.documents.map((document, index) => ({
    document_id: document.id,
    name: document.name,
    type: document.type,
    answers: analyses[index].outline_answers
  }));
  json(res, 200, { report, analyses, matrix, questions: payload.questions, models: { map: MAP_MODEL, synthesis: SYNTHESIS_MODEL } });
}

async function handleTranscribe(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请在页面右上角完成临时 API Key 配置。" });
  const raw = await readRaw(req, 27_000_000);
  const parts = parseMultipart(raw, req.headers["content-type"]);
  const file = parts.find((part) => part.filename);
  if (!file) throw new Error("没有收到可转录的音视频文件");
  if (file.data.length > DIRECT_AUDIO_LIMIT) throw new Error("该文件超过安全直传大小，请使用大型文件自动分片转录");
  const result = await transcribeAudioBytes(file.data, file.filename, file.headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream");
  json(res, 200, result);
}

function safeUploadSuffix(filename) {
  const suffix = extname(filename || "").toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(suffix) ? suffix : ".mp4";
}

async function streamUploadToFile(req, path) {
  let size = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(size > LARGE_UPLOAD_LIMIT ? new Error("单个音视频文件不能超过 2 GB") : null, chunk);
    }
  });
  await pipeline(req, limiter, createWriteStream(path, { flags: "wx" }));
  return size;
}

async function mediaDurationSeconds(path, fallbackDuration) {
  if (process.platform !== "darwin") {
    try {
      const { stdout } = await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
      const duration = Number(String(stdout).trim());
      if (Number.isFinite(duration) && duration > 0) return duration;
    } catch {}
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/mdls", ["-raw", "-name", "kMDItemDurationSeconds", path]);
    const duration = Number(String(stdout).trim());
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch {}
  try {
    const { stdout } = await execFileAsync("/usr/bin/afinfo", [path], { maxBuffer: 2_000_000 });
    const duration = Number(String(stdout).match(/estimated duration:\s*([\d.]+)\s*sec/i)?.[1]);
    if (Number.isFinite(duration) && duration > 0) return duration;
  } catch {}
  const fallback = Number(fallbackDuration);
  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  throw new Error("本机无法读取音视频时长；请确认文件可播放，或重新上传后重试");
}

async function extractAudioChunk(sourcePath, chunkPath, start, duration) {
  if (process.platform === "darwin") {
    return execFileAsync("/usr/bin/avconvert", [
      "--source", sourcePath,
      "--preset", "PresetAppleM4A",
      "--output", chunkPath,
      "--replace",
      "--start", String(start),
      "--duration", String(duration)
    ], { timeout: 20 * 60 * 1000, maxBuffer: 2_000_000 });
  }
  return execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(start), "-t", String(duration),
    "-i", sourcePath, "-vn", "-c:a", "aac", "-b:a", "96k", chunkPath
  ], { timeout: 20 * 60 * 1000, maxBuffer: 2_000_000 });
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestTranscription(bytes, filename, mimeType, mode) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), filename);
      if (mode === "diarize") {
        form.append("model", "gpt-4o-transcribe-diarize");
        form.append("response_format", "diarized_json");
        form.append("chunking_strategy", "auto");
      } else {
        form.append("model", "whisper-1");
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "segment");
      }
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(10 * 60 * 1000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;
      const error = new Error(data?.error?.message || `转录服务返回错误 (${response.status})`);
      error.status = response.status;
      throw error;
    } catch (error) {
      lastError = error;
      const quotaError = /quota|billing|insufficient_quota/i.test(error.message || "");
      const retryable = !error.status || [408, 429, 500, 502, 503, 504].includes(error.status);
      if (attempt < 2 && retryable && !quotaError) {
        await wait(800 * 2 ** attempt);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function transcribeAudioBytes(bytes, filename, mimeType = "audio/mp4") {
  if (bytes.length > DIRECT_AUDIO_LIMIT) throw new Error("音频分片仍超过 24 MB，请缩短分片后重试");
  try {
    const data = await requestTranscription(bytes, filename, mimeType, "diarize");
    return { ...data, transcription_mode: "speaker-diarization" };
  } catch (primaryError) {
    const modelUnavailable = [400, 403, 404].includes(primaryError.status) && /model|diariz|access|permission|not found|unsupported/i.test(primaryError.message || "");
    if (!modelUnavailable) throw new Error(`OpenAI 转录失败${primaryError.status ? ` (${primaryError.status})` : ""}：${primaryError.message}`);
    const fallback = await requestTranscription(bytes, filename, mimeType, "whisper").catch((error) => {
      throw new Error(`说话人转录模型不可用，兼容转录也失败${error.status ? ` (${error.status})` : ""}：${error.message}`);
    });
    return {
      ...fallback,
      segments: (fallback.segments || []).map((segment) => ({ ...segment, speaker: "待语义识别" })),
      transcription_mode: "whisper-fallback"
    };
  }
}

async function transcribeAudioFile(path, filename) {
  return transcribeAudioBytes(await readFile(path), filename, "audio/mp4");
}

async function handleLargeTranscribe(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请先完成临时 API Key 配置。" });
  let originalName = "interview.mp4";
  try {
    originalName = decodeURIComponent(String(req.headers["x-filename"] || originalName));
  } catch {}
  const jobId = randomUUID();
  const sourcePath = join(JOB_DIR, `medvoice-source-${jobId}${safeUploadSuffix(originalName)}`);
  const chunkPaths = [];
  try {
    await streamUploadToFile(req, sourcePath);
    const duration = await mediaDurationSeconds(sourcePath, req.headers["x-media-duration"]);
    const chunkCount = Math.ceil(duration / AUDIO_CHUNK_SECONDS);
    const results = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * AUDIO_CHUNK_SECONDS;
      const chunkDuration = Math.min(AUDIO_CHUNK_SECONDS, duration - start);
      const chunkPath = join(JOB_DIR, `medvoice-audio-${jobId}-${index + 1}.m4a`);
      chunkPaths.push(chunkPath);
      await extractAudioChunk(sourcePath, chunkPath, start, chunkDuration);
      let result;
      try {
        result = await transcribeAudioFile(chunkPath, `interview-part-${index + 1}.m4a`);
      } catch (error) {
        throw new Error(`第 ${index + 1}/${chunkCount} 个音频分片转录失败：${error.message}`);
      }
      const segments = Array.isArray(result.segments)
        ? result.segments.map((segment) => ({ ...segment, speaker: `片段${index + 1}-${segment.speaker || "speaker"}`, start: Number(segment.start || 0) + start, end: Number(segment.end || 0) + start }))
        : [];
      results.push({ text: result.text || "", segments, mode: result.transcription_mode });
      await unlink(chunkPath).catch(() => {});
    }
    const segments = results.flatMap((result) => result.segments);
    return json(res, 200, {
      text: results.map((result) => result.text).filter(Boolean).join("\n"),
      segments,
      duration,
      chunks: chunkCount,
      preprocessed: true,
      transcription_mode: results.some((result) => result.mode === "whisper-fallback") ? "whisper-fallback" : "speaker-diarization"
    });
  } finally {
    await Promise.all([sourcePath, ...chunkPaths].map((path) => unlink(path).catch(() => {})));
  }
}

async function handleSettings(req, res) {
  const payload = await readJson(req, 100_000);
  if (payload.action === "clear") {
    API_KEY = "";
    return json(res, 200, { apiConfigured: false });
  }
  if (payload.confirmedDataAuthorization !== true) throw new Error("请先确认已获得访谈资料的处理授权");
  const candidate = String(payload.apiKey || "").trim();
  if (!candidate) throw new Error("请输入 OpenAI API Key");
  const response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${candidate}` } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error?.message || "API Key 验证失败");
  }
  API_KEY = candidate;
  json(res, 200, { apiConfigured: true });
}

function assertLocalOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
  let originHost = "";
  try { originHost = new URL(origin).host.toLowerCase(); } catch {}
  const allowed = new Set([host, `localhost:${PORT}`, `127.0.0.1:${PORT}`]);
  if (!allowed.has(originHost)) throw new Error("仅允许从当前 MedVoice Portal 调用服务");
}

async function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(ROOT, relative));
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${sep}`)) return json(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mime[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) assertLocalOrigin(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/access/request") {
      const handled = await handleAuth(req, res, url.pathname);
      if (handled !== false) return handled;
    }
    if (url.pathname.startsWith("/api/admin/")) return await handleAdmin(req, res, url.pathname);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, apiConfigured: Boolean(API_KEY), apiKeySource: process.env.OPENAI_API_KEY ? "server" : API_KEY ? "temporary" : "none", authRequired: AUTH_REQUIRED, mapModel: MAP_MODEL, synthesisModel: SYNTHESIS_MODEL });
    }
    if (url.pathname.startsWith("/api/") && !requireUser(req, res)) return;
    if (req.method === "POST" && url.pathname === "/api/analyze") return await handleAnalyze(req, res);
    if (req.method === "POST" && url.pathname === "/api/roles/identify") return await handleIdentifyRoles(req, res);
    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (AUTH_REQUIRED && req.user.role !== "admin") return json(res, 403, { error: "仅管理员可以配置临时 API Key" });
      return await handleSettings(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/transcribe") return await handleTranscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/transcribe-large") return await handleLargeTranscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/outline/parse") return await handleOutlineParse(req, res);
    if (req.method === "POST" && url.pathname.startsWith("/api/export/")) return await handleExport(req, res, url.pathname.split("/").pop());
    if (req.method === "GET") {
      if (url.pathname === "/login" || url.pathname === "/login.html") return await serveStatic("/login.html", res);
      if (url.pathname === "/admin" || url.pathname === "/admin.html") {
        const user = currentUser(req);
        if (AUTH_REQUIRED && !user) return redirect(res, "/login");
        if (AUTH_REQUIRED && user.role !== "admin") return redirect(res, "/");
        return await serveStatic("/admin.html", res);
      }
      if ((url.pathname === "/" || url.pathname === "/index.html") && AUTH_REQUIRED && !currentUser(req)) return redirect(res, "/login");
      return await serveStatic(url.pathname, res);
    }
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(`[MedVoice] ${req.method} ${req.url}: ${error.message || "请求处理失败"}`);
    json(res, 400, { error: error.message || "请求处理失败" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MedVoice Insight running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(API_KEY ? `AI mode: ${MAP_MODEL} + ${SYNTHESIS_MODEL}` : "Local mode: connect an API Key from the app when AI processing is needed");
});
