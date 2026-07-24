import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { access, appendFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, sep } from "node:path";
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
import { PostgresAuthStore } from "./lib/postgres-auth-store.mjs";
import { PostgresInterviewLibraryStore, SqliteInterviewLibraryStore } from "./lib/interview-library-store.mjs";
import { mailConfigured, mailProviderLabel, sendAccessApprovedEmail, sendMailDeliveryTestEmail } from "./lib/mailer.mjs";

const ROOT = join(process.cwd(), "public");
const PORT = Number(process.env.PORT || 4174);
const MAP_MODEL = process.env.MAP_MODEL || "gpt-5.4-mini";
const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL || "gpt-5.5";
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 4);
const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "data");
const JOB_DIR = process.env.JOB_DIR || join(DATA_DIR, "jobs");
const LIBRARY_FILE_DIR = process.env.LIBRARY_FILE_DIR || join(DATA_DIR, "interview-library");
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
let API_KEY = process.env.OPENAI_API_KEY || "";
const execFileAsync = promisify(execFile);
const DIRECT_AUDIO_LIMIT = 24 * 1024 * 1024;
const LARGE_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;
const AUDIO_CHUNK_SECONDS = 10 * 60;
await mkdir(JOB_DIR, { recursive: true });
await mkdir(LIBRARY_FILE_DIR, { recursive: true });
const authStore = process.env.DATABASE_URL
  ? await PostgresAuthStore.create(process.env.DATABASE_URL)
  : await AuthStore.create(join(DATA_DIR, "medvoice.sqlite"));
const libraryStore = process.env.DATABASE_URL
  ? await PostgresInterviewLibraryStore.create(process.env.DATABASE_URL)
  : await SqliteInterviewLibraryStore.create(join(DATA_DIR, "interview-library.sqlite"));
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

function formatRoleTranscriptTurns(turns, activeLineSet) {
  return turns.map((turn) => {
    const scope = activeLineSet?.has(turn.line_no) ? "待标注" : "上下文";
    return `${scope}\t${turn.line_no}\t${turn.speaker}\t${turn.timestamp || "-"}\t${maskSensitiveText(turn.text)}`;
  }).join("\n");
}

async function identifyRoleBatch(document, turns, contextTurns = turns) {
  const activeLineSet = new Set(turns.map((turn) => turn.line_no));
  const transcript = formatRoleTranscriptTurns(contextTurns, activeLineSet);
  const activeRange = `${turns[0]?.line_no || 1}-${turns[turns.length - 1]?.line_no || turns.length}`;
  const response = await openAIResponses({
    model: MAP_MODEL,
    reasoning: { effort: "low" },
    input: [
      {
        role: "system",
        content: "你是严谨的定性访谈语义角色标注器。根据完整对话关系判断每行说话者身份：interviewer=访谈员/主持人，respondent=被访者，observer=明确的第三方或旁听者，uncertain=证据不足。角色依据是整段会话身份而非句式；受访者可能反问，访谈员也可能陈述。输入中会包含“上下文”行和“待标注”行：上下文行只用于理解前后语义和说话关系，严禁输出上下文行；必须仅为每个“待标注”line_no 输出且仅输出一次。不改写原话，不推断姓名、疾病或身份等新事实。"
      },
      {
        role: "user",
        content: `受访者类型：${document.type}\n文件：${document.name}\n正式待标注行号范围：${activeRange}\n\n逐行转录（范围 / 行号 / 原说话人 / 时间 / 原话）：\n${transcript}\n\n请只输出“待标注”行的 assignments，不要输出“上下文”行。`
      }
    ],
    text: { format: { type: "json_schema", name: "interview_role_assignments", strict: true, schema: roleAssignmentSchema } }
  });
  const parsed = safeJsonParse(extractResponseText(response));
  parsed.assignments = (parsed.assignments || []).filter((assignment) => activeLineSet.has(Number(assignment.line_no)));
  return parsed;
}

async function identifyDocumentRoles(document, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const turns = parseTranscriptTurns(document.text);
  if (!turns.length) throw new Error(`${document.id} 没有可识别的转录行`);
  const batchSize = 140;
  const contextWindow = 8;
  const batches = [];
  for (let index = 0; index < turns.length; index += batchSize) {
    batches.push({
      active: turns.slice(index, index + batchSize),
      context: turns.slice(Math.max(0, index - contextWindow), Math.min(turns.length, index + batchSize + contextWindow))
    });
  }
  let completedBatches = 0;
  onProgress({ stage: "splitting", progress: 6, batchIndex: 0, batchCount: batches.length, message: `已拆分为 ${batches.length} 批语句，并加入前后文缓冲` });
  const batchResults = await runWithConcurrency(batches, Math.min(3, MAX_CONCURRENCY), async (batch, batchIndex) => {
    const result = await identifyRoleBatch(document, batch.active, batch.context);
    completedBatches += 1;
    onProgress({
      stage: "mapping",
      progress: Math.min(92, 8 + Math.round((completedBatches / batches.length) * 82)),
      batchIndex: completedBatches,
      batchCount: batches.length,
      message: `已完成 ${completedBatches}/${batches.length} 批角色判断`
    });
    return result;
  });
  onProgress({ stage: "structuring", progress: 96, batchIndex: batches.length, batchCount: batches.length, message: "正在合并问答结构并计算置信度" });
  const assignments = batchResults.flatMap((result) => result.assignments || []);
  const structured = buildRoleExchanges(turns, assignments, ["患者", "Patient"].includes(document.type) ? "Patient/受访者" : "HCP/受访者");
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

async function currentUser(req) {
  if (!AUTH_REQUIRED) return { id: 0, email: "local@hisunpharm.com", role: "admin", mustChangePassword: false };
  return authStore.sessionUser(cookies(req).mv_session);
}

function isSecureRequest(req) {
  return Boolean(process.env.RENDER || req.headers["x-forwarded-proto"] === "https" || req.headers["x-forwarded-ssl"] === "on");
}

function isLocalHost(host) {
  return /^localhost(?::\d+)?$/i.test(host) || /^127\.0\.0\.1(?::\d+)?$/i.test(host);
}

function sessionCookie(req, token, expires) {
  const secure = isSecureRequest(req);
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  return `mv_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(req) {
  const secure = isSecureRequest(req);
  return `mv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
}

async function requireUser(req, res, role) {
  const user = await currentUser(req);
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
    const user = await currentUser(req);
    return json(res, 200, { authRequired: AUTH_REQUIRED, authenticated: Boolean(user), user });
  }
  if (pathname === "/api/auth/login" && req.method === "POST") {
    if (!AUTH_REQUIRED) return json(res, 200, { authenticated: true, user: await currentUser(req) });
    const payload = await readJson(req, 100_000);
    const clearRateLimit = checkLoginRateLimit(req, payload.email);
    const user = await authStore.authenticate(payload.email, payload.password);
    if (!user) return json(res, 401, { error: "邮箱或密码不正确" });
    clearRateLimit();
    const session = await authStore.createSession(user.id);
    return json(res, 200, { authenticated: true, user, sessionExpiresAt: session.expires.toISOString() }, { "Set-Cookie": sessionCookie(req, session.token, session.expires) });
  }
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    await authStore.deleteSession(cookies(req).mv_session);
    return json(res, 200, { authenticated: false }, { "Set-Cookie": clearSessionCookie(req) });
  }
  if (pathname === "/api/auth/change-password" && req.method === "POST") {
    const user = await requireUser(req, res);
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
  const admin = await requireUser(req, res, "admin");
  if (!admin) return;
  if (pathname === "/api/admin/users" && req.method === "GET") return json(res, 200, { users: await authStore.listUsers() });
  if (pathname === "/api/admin/test-email" && req.method === "POST") {
    if (!mailConfigured()) throw new Error("邮件服务尚未配置：请先设置 BREVO_API_KEY 与 MAIL_FROM_EMAIL");
    const payload = await readJson(req, 100_000).catch(() => ({}));
    const targetEmail = String(payload.email || admin.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) throw new Error("请输入有效的测试收件邮箱");
    const delivery = await sendMailDeliveryTestEmail({ email: targetEmail });
    return json(res, 200, { emailed: true, email: targetEmail, deliveryId: delivery.id, provider: delivery.provider, from: process.env.MAIL_FROM_EMAIL || process.env.MAIL_FROM || "" });
  }
  if (pathname === "/api/admin/users" && req.method === "POST") {
    const payload = await readJson(req, 100_000);
    const credentials = await authStore.addUser(payload.email, payload.role);
    if (mailConfigured()) {
      try {
        const delivery = await sendAccessApprovedEmail(credentials);
        return json(res, 200, { email: credentials.email, emailed: true, deliveryId: delivery.id });
      } catch (error) {
        return json(res, 200, { email: credentials.email, temporaryPassword: credentials.temporaryPassword, emailed: false, emailError: error.message || "邮件发送失败" });
      }
    }
    return json(res, 200, { ...credentials, emailed: false, emailError: "邮件服务尚未配置" });
  }
  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && req.method === "PATCH") {
    const payload = await readJson(req, 100_000);
    if (Number(userMatch[1]) === admin.id && payload.active === false) throw new Error("不能停用当前管理员账号");
    await authStore.setUserActive(userMatch[1], Boolean(payload.active));
    return json(res, 200, { updated: true });
  }
  if (pathname === "/api/admin/allowed-emails" && req.method === "GET") {
    return json(res, 200, { allowedEmails: await authStore.listAllowedEmails() });
  }
  if (pathname === "/api/admin/allowed-emails" && req.method === "POST") {
    const payload = await readJson(req, 100_000);
    const allowedEmail = await authStore.addAllowedEmail(payload.email, payload.note, admin.id);
    return json(res, 200, { allowedEmail });
  }
  const allowedEmailMatch = pathname.match(/^\/api\/admin\/allowed-emails\/(\d+)$/);
  if (allowedEmailMatch && req.method === "DELETE") {
    await authStore.removeAllowedEmail(allowedEmailMatch[1]);
    return json(res, 200, { deleted: true });
  }
  if (pathname === "/api/admin/requests" && req.method === "GET") return json(res, 200, { requests: await authStore.listRequests() });
  const requestMatch = pathname.match(/^\/api\/admin\/requests\/(\d+)\/(approve|reject)$/);
  if (requestMatch && req.method === "POST") {
    if (requestMatch[2] === "approve") {
      if (!mailConfigured()) throw new Error("邮件服务尚未配置，暂不能批准申请；请先设置 BREVO_API_KEY 与 MAIL_FROM_EMAIL");
      const credentials = await authStore.approveRequest(requestMatch[1], admin.id);
      try {
        const delivery = await sendAccessApprovedEmail(credentials);
        return json(res, 200, { email: credentials.email, emailed: true, deliveryId: delivery.id });
      } catch (error) {
        return json(res, 200, { email: credentials.email, temporaryPassword: credentials.temporaryPassword, emailed: false, emailError: error.message || "邮件发送失败" });
      }
    }
    await authStore.rejectRequest(requestMatch[1], admin.id);
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
      type: ["患者", "Patient"].includes(document.type) ? "Patient" : "HCP",
      text
    };
  });
  const results = await runWithConcurrency(documents, Math.min(2, MAX_CONCURRENCY), identifyDocumentRoles);
  json(res, 200, { results, model: MAP_MODEL });
}

const ROLE_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const roleJobs = new Map();

function cleanupRoleJobs() {
  const now = Date.now();
  for (const [id, job] of roleJobs.entries()) {
    if (now - job.updatedAt > ROLE_JOB_TTL_MS) roleJobs.delete(id);
  }
}

function publicRoleJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    documentIndex: job.documentIndex,
    documentCount: job.documentCount,
    batchIndex: job.batchIndex,
    batchCount: job.batchCount,
    currentName: job.currentName,
    message: job.message,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    results: job.status === "completed" ? job.results : undefined,
    error: job.status === "failed" ? job.error : undefined
  };
}

function updateRoleJob(id, patch) {
  const job = roleJobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function runRoleIdentifyJob(jobId, documents) {
  try {
    const results = [];
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const documentBase = Math.round((index / documents.length) * 100);
      const documentSpan = 100 / documents.length;
      updateRoleJob(jobId, {
        status: "running",
        stage: "queued",
        documentIndex: index + 1,
        documentCount: documents.length,
        currentName: document.id,
        progress: Math.max(2, documentBase),
        message: `正在准备 ${document.id} 的角色区分`
      });
      const result = await identifyDocumentRoles(document, {
        onProgress: (progress) => updateRoleJob(jobId, {
          status: "running",
          ...progress,
          documentIndex: index + 1,
          documentCount: documents.length,
          currentName: document.id,
          progress: Math.min(99, Math.round(documentBase + (Number(progress.progress || 0) / 100) * documentSpan))
        })
      });
      results.push(result);
      updateRoleJob(jobId, {
        status: "running",
        stage: "document-completed",
        documentIndex: index + 1,
        documentCount: documents.length,
        currentName: document.id,
        progress: Math.min(99, Math.round(((index + 1) / documents.length) * 100)),
        message: `${document.id} 角色区分完成`
      });
    }
    updateRoleJob(jobId, { status: "completed", stage: "completed", progress: 100, message: "全部角色区分完成", results });
  } catch (error) {
    updateRoleJob(jobId, { status: "failed", stage: "failed", progress: 100, message: "角色区分失败", error: humanizeOpenAIError(error) });
  }
}

function normalizeRoleDocuments(payload) {
  if (!Array.isArray(payload.documents) || !payload.documents.length) throw new Error("请选择至少一份已转录访谈");
  if (payload.documents.length > 10) throw new Error("单次最多区分 10 份访谈，请分批处理");
  return payload.documents.map((document, index) => {
    const text = String(document?.text || "").trim().slice(0, 120_000);
    if (!text) throw new Error(`第 ${index + 1} 份访谈尚无转录文本`);
    return {
      id: String(document.id || `INT-${index + 1}`).slice(0, 80),
      name: String(document.name || `访谈 ${index + 1}`).slice(0, 160),
      type: ["患者", "Patient"].includes(document.type) ? "Patient" : "HCP",
      text
    };
  });
}

async function handleIdentifyRolesJobStart(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请先完成临时 API Key 配置。" });
  cleanupRoleJobs();
  const documents = normalizeRoleDocuments(await readJson(req, 25_000_000));
  const id = randomUUID();
  const job = {
    id,
    userId: req.user?.id,
    status: "queued",
    stage: "queued",
    progress: 1,
    documentIndex: 0,
    documentCount: documents.length,
    batchIndex: 0,
    batchCount: 0,
    currentName: documents[0]?.id || "所选访谈",
    message: "角色区分任务已创建，正在进入队列",
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  roleJobs.set(id, job);
  runRoleIdentifyJob(id, documents);
  return json(res, 202, publicRoleJob(job));
}

function handleIdentifyRolesJobStatus(req, res, id) {
  cleanupRoleJobs();
  const job = roleJobs.get(id);
  if (!job || (job.userId && req.user?.id && job.userId !== req.user.id)) return json(res, 404, { error: "角色区分任务不存在或已过期" });
  return json(res, 200, publicRoleJob(job));
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


const CONVERSION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const CHUNKED_CONVERSION_UPLOAD_TTL_MS = 60 * 60 * 1000;
const conversionJobs = new Map();
const chunkedConversionUploads = new Map();

async function cleanupChunkedConversionUploads() {
  const now = Date.now();
  for (const [id, upload] of chunkedConversionUploads.entries()) {
    if (now - upload.updatedAt > CHUNKED_CONVERSION_UPLOAD_TTL_MS) {
      await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
      chunkedConversionUploads.delete(id);
    }
  }
}

function cleanupConversionJobs() {
  cleanupChunkedConversionUploads().catch(() => {});
  const now = Date.now();
  for (const [id, job] of conversionJobs.entries()) {
    if (now - job.updatedAt > CONVERSION_JOB_TTL_MS) {
      if (job.removeSource) unlink(job.sourcePath).catch(() => {});
      if (job.audioPath) unlink(job.audioPath).catch(() => {});
      conversionJobs.delete(id);
    }
  }
}

function outputAudioName(originalName) {
  const cleanBase = basename(originalName || "interview-video", extname(originalName || "")).replace(/[\r\n"]/g, "").slice(0, 180) || "interview-audio";
  return `${cleanBase}.m4a`;
}

function publicConversionJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    originalName: job.originalName,
    outputName: job.outputName,
    originalSize: job.originalSize,
    convertedSize: job.convertedSize,
    downloadUrl: job.status === "completed" ? `/api/media/convert-audio/jobs/${job.id}/download` : undefined,
    error: job.status === "failed" ? job.error : undefined,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function updateConversionJob(id, patch) {
  const job = conversionJobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function runConversionJob(jobId) {
  const job = conversionJobs.get(jobId);
  if (!job) return;
  try {
    updateConversionJob(jobId, { status: "running", stage: "converting", progress: 20, message: "正在提取音轨并压缩为 M4A" });
    await convertMediaToCompactM4a(job.sourcePath, job.audioPath);
    const info = await stat(job.audioPath);
    updateConversionJob(jobId, { status: "completed", stage: "completed", progress: 100, message: "M4A 已生成，可下载后上传转录", convertedSize: info.size });
  } catch (error) {
    if (job.removeSource) await unlink(job.sourcePath).catch(() => {});
    await unlink(job.audioPath).catch(() => {});
    updateConversionJob(jobId, { status: "failed", stage: "failed", progress: 100, message: "转换失败", error: error.stderr || error.message || "请确认视频文件可播放且包含音轨" });
  }
}

async function createConversionJob({ req, res, sourcePath, originalName, originalSize, removeSource }) {
  cleanupConversionJobs();
  const id = randomUUID();
  const audioPath = join(JOB_DIR, `medvoice-convert-audio-${id}.m4a`);
  const job = {
    id,
    userId: req.user?.id,
    status: "queued",
    stage: "queued",
    progress: 5,
    message: "视频文件已接收，正在准备转换任务",
    sourcePath,
    audioPath,
    removeSource,
    originalName,
    outputName: outputAudioName(originalName),
    originalSize,
    convertedSize: 0,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  conversionJobs.set(id, job);
  runConversionJob(id);
  return json(res, 202, publicConversionJob(job));
}

async function handleChunkedConvertAudioStart(req, res) {
  cleanupConversionJobs();
  const payload = await readJson(req, 100_000).catch(() => ({}));
  const originalName = String(payload.filename || "interview-video.mp4").slice(0, 240);
  const fileSize = Number(payload.size || 0);
  const chunkCount = Math.max(1, Math.min(2000, Number(payload.chunkCount || 1)));
  const id = randomUUID();
  const dir = join(JOB_DIR, `medvoice-convert-chunks-${id}`);
  await mkdir(dir, { recursive: true });
  chunkedConversionUploads.set(id, {
    id,
    userId: req.user?.id,
    dir,
    originalName,
    fileSize,
    chunkCount,
    received: new Set(),
    receivedBytes: 0,
    startedAt: Date.now(),
    updatedAt: Date.now()
  });
  return json(res, 200, { id, chunkCount, message: "已创建大文件分片上传任务" });
}

async function handleChunkedConvertAudioChunk(req, res, id) {
  cleanupConversionJobs();
  const upload = chunkedConversionUploads.get(id);
  if (!upload || (upload.userId && req.user?.id && upload.userId !== req.user.id)) return json(res, 404, { error: "分片上传任务不存在或已过期，请重新点击生成 M4A" });
  const index = Number(req.headers["x-chunk-index"]);
  if (!Number.isInteger(index) || index < 0 || index >= upload.chunkCount) return json(res, 400, { error: "分片序号无效" });
  const partPath = join(upload.dir, `${index}.part`);
  await unlink(partPath).catch(() => {});
  const size = await streamUploadToFile(req, partPath);
  if (!upload.received.has(index)) upload.received.add(index);
  upload.receivedBytes += size;
  upload.updatedAt = Date.now();
  return json(res, 200, { received: upload.received.size, chunkCount: upload.chunkCount });
}

async function handleChunkedConvertAudioComplete(req, res, id) {
  cleanupConversionJobs();
  const upload = chunkedConversionUploads.get(id);
  if (!upload || (upload.userId && req.user?.id && upload.userId !== req.user.id)) return json(res, 404, { error: "分片上传任务不存在或已过期，请重新点击生成 M4A" });
  if (upload.received.size !== upload.chunkCount) return json(res, 409, { error: `仍有 ${upload.chunkCount - upload.received.size} 个分片未上传完成` });
  const sourcePath = join(JOB_DIR, `medvoice-convert-source-${id}${safeUploadSuffix(upload.originalName)}`);
  await unlink(sourcePath).catch(() => {});
  let originalSize = 0;
  try {
    for (let index = 0; index < upload.chunkCount; index += 1) {
      const partPath = join(upload.dir, `${index}.part`);
      const part = await readFile(partPath);
      originalSize += part.length;
      await appendFile(sourcePath, part);
    }
    await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
    chunkedConversionUploads.delete(id);
    return createConversionJob({ req, res, sourcePath, originalName: upload.originalName, originalSize, removeSource: true });
  } catch (error) {
    await unlink(sourcePath).catch(() => {});
    throw new Error(`大文件分片合并失败：${error.message || "请重试"}`);
  }
}

async function handleConvertAudioJobStart(req, res) {
  let originalName = "interview-video.mp4";
  try {
    originalName = decodeURIComponent(String(req.headers["x-filename"] || originalName));
  } catch {}
  const id = randomUUID();
  const sourcePath = join(JOB_DIR, `medvoice-convert-source-${id}${safeUploadSuffix(originalName)}`);
  try {
    const originalSize = await streamUploadToFile(req, sourcePath);
    return createConversionJob({ req, res, sourcePath, originalName, originalSize, removeSource: true });
  } catch (error) {
    await unlink(sourcePath).catch(() => {});
    throw new Error(`视频上传失败：${error.message || "请检查文件大小或网络连接"}`);
  }
}

async function handleStoredConvertAudioJobStart(req, res, userId, itemId) {
  const item = await libraryStore.getItem(userId, itemId);
  if (!item?.storagePath) return json(res, 404, { error: "没有找到该账号下的原始文件" });
  const fileInfo = await stat(item.storagePath).catch(() => null);
  if (!fileInfo?.isFile()) return json(res, 404, { error: "原始文件已不在服务端，请重新上传" });
  return createConversionJob({ req, res, sourcePath: item.storagePath, originalName: item.fileName || item.name, originalSize: fileInfo.size, removeSource: false });
}

function handleConvertAudioJobStatus(req, res, id) {
  cleanupConversionJobs();
  const job = conversionJobs.get(id);
  if (!job || (job.userId && req.user?.id && job.userId !== req.user.id)) return json(res, 404, { error: "转换任务不存在或已过期" });
  return json(res, 200, publicConversionJob(job));
}

async function handleConvertAudioJobDownload(req, res, id) {
  cleanupConversionJobs();
  const job = conversionJobs.get(id);
  if (!job || (job.userId && req.user?.id && job.userId !== req.user.id)) return json(res, 404, { error: "转换任务不存在或已过期" });
  if (job.status !== "completed") return json(res, 409, { error: "音频还未生成完成" });
  const info = await stat(job.audioPath).catch(() => null);
  if (!info?.isFile()) return json(res, 404, { error: "音频文件已过期，请重新转换" });
  res.writeHead(200, {
    "Content-Type": "audio/mp4",
    "Content-Length": info.size,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(job.outputName)}"`,
    "X-Original-Size": String(job.originalSize || 0),
    "X-Converted-Size": String(info.size),
    "Cache-Control": "no-store"
  });
  return createReadStream(job.audioPath).pipe(res);
}

async function handleConvertAudio(req, res) {
  return handleConvertAudioJobStart(req, res);
}

async function handleTranscribe(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请在页面右上角完成临时 API Key 配置。" });
  const raw = await readRaw(req, 27_000_000);
  const parts = parseMultipart(raw, req.headers["content-type"]);
  const file = parts.find((part) => part.filename);
  if (!file) throw new Error("没有收到可转录的音视频文件");
  if (file.data.length > DIRECT_AUDIO_LIMIT) throw new Error("该文件超过安全直传大小，请使用大型文件自动分片转录");
  const durationPart = parts.find((part) => part.name === "durationSeconds");
  const modePart = parts.find((part) => part.name === "transcriptionMode");
  const mode = normalizeTranscriptionMode(modePart?.data?.toString("utf8") || req.headers["x-transcribe-mode"]);
  const result = await transcribeUploadedMedia(file.data, file.filename, file.headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "application/octet-stream", durationPart?.data?.toString("utf8"), mode);
  json(res, 200, result);
}

function safeUploadSuffix(filename) {
  const suffix = extname(filename || "").toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(suffix) ? suffix : ".mp4";
}

async function streamUploadToFile(req, path) {
  await mkdir(dirname(path), { recursive: true });
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

function decodeMetadataHeader(req) {
  const raw = String(req.headers["x-medvoice-meta"] || "");
  if (!raw) return {};
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new Error("资料元数据格式错误，请重新上传");
  }
}

function libraryFilePath(userId, id, filename) {
  return join(LIBRARY_FILE_DIR, String(userId), `${id}${safeUploadSuffix(filename)}`);
}

async function removeStoredFiles(paths) {
  await Promise.all((paths || []).map((path) => path ? unlink(path).catch(() => {}) : Promise.resolve()));
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
  const ffmpegArgs = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", String(start), "-t", String(duration),
    "-i", sourcePath, "-vn", "-c:a", "aac", "-b:a", "96k", chunkPath
  ];
  try {
    return await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", ffmpegArgs, { timeout: 20 * 60 * 1000, maxBuffer: 2_000_000 });
  } catch (error) {
    if (process.platform !== "darwin") throw error;
    return execFileAsync("/usr/bin/avconvert", [
      "--source", sourcePath,
      "--preset", "PresetAppleM4A",
      "--output", chunkPath,
      "--replace",
      "--start", String(start),
      "--duration", String(duration)
    ], { timeout: 20 * 60 * 1000, maxBuffer: 2_000_000 });
  }
}

async function convertMediaToM4a(sourcePath, outputPath) {
  return execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourcePath, "-vn", "-c:a", "aac", "-b:a", "96k", outputPath
  ], { timeout: 20 * 60 * 1000, maxBuffer: 2_000_000 });
}

async function convertMediaToCompactM4a(sourcePath, outputPath) {
  try {
    return await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", sourcePath, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", outputPath
    ], { timeout: 60 * 60 * 1000, maxBuffer: 2_000_000 });
  } catch (error) {
    if (process.platform !== "darwin") throw error;
    return execFileAsync("/usr/bin/avconvert", [
      "--source", sourcePath,
      "--preset", "PresetAppleM4A",
      "--output", outputPath,
      "--replace"
    ], { timeout: 60 * 60 * 1000, maxBuffer: 2_000_000 });
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function humanizeOpenAIError(error) {
  const message = error?.message || "";
  const code = error?.code || "";
  const status = error?.status;
  if (status === 429 || /quota|billing|insufficient_quota/i.test(`${message} ${code}`)) {
    return "OpenAI API 额度不足或账单未开通，请检查 OpenAI Platform 的 Billing / Usage、月度限额，或在 Render 环境变量中更换有额度的 OPENAI_API_KEY。";
  }
  if (status === 401 || /invalid api key|incorrect api key|unauthorized/i.test(message)) {
    return "OpenAI API Key 无效或已失效，请更新 Render 环境变量 OPENAI_API_KEY 后重新部署。";
  }
  return message || "未知错误";
}

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
      const openAIError = data?.error || {};
      const error = new Error(humanizeOpenAIError({ ...openAIError, status: response.status }));
      error.status = response.status;
      error.code = openAIError.code || "";
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

function normalizeTranscriptionMode(mode) {
  return String(mode || "").toLowerCase() === "fast" ? "fast" : "diarize";
}

function transcriptionModeFromRequest(req) {
  return normalizeTranscriptionMode(req.headers["x-transcribe-mode"] || req.headers["x-transcription-mode"]);
}

async function transcribeAudioBytes(bytes, filename, mimeType = "audio/mp4", mode = "diarize") {
  if (bytes.length > DIRECT_AUDIO_LIMIT) throw new Error("音频分片仍超过 24 MB，请缩短分片后重试");
  if (normalizeTranscriptionMode(mode) === "fast") {
    const data = await requestTranscription(bytes, filename, mimeType, "whisper").catch((error) => {
      throw new Error(`快速转录失败${error.status ? ` (${error.status})` : ""}：${humanizeOpenAIError(error)}`);
    });
    return {
      ...data,
      segments: (data.segments || []).map((segment) => ({ ...segment, speaker: "待语义识别" })),
      transcription_mode: "fast-whisper"
    };
  }
  try {
    const data = await requestTranscription(bytes, filename, mimeType, "diarize");
    return { ...data, transcription_mode: "speaker-diarization" };
  } catch (primaryError) {
    const modelUnavailable = [400, 403, 404].includes(primaryError.status) && /model|diariz|access|permission|not found|unsupported/i.test(primaryError.message || "");
    if (!modelUnavailable) throw new Error(`OpenAI 转录失败${primaryError.status ? ` (${primaryError.status})` : ""}：${humanizeOpenAIError(primaryError)}`);
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

async function transcribeUploadedMedia(bytes, filename, mimeType = "application/octet-stream", fallbackDuration, mode = "diarize") {
  const jobId = randomUUID();
  const sourcePath = join(JOB_DIR, `medvoice-direct-source-${jobId}${safeUploadSuffix(filename)}`);
  const audioPath = join(JOB_DIR, `medvoice-direct-audio-${jobId}.m4a`);
  try {
    await writeFile(sourcePath, bytes);
    try {
      await convertMediaToM4a(sourcePath, audioPath);
    } catch (conversionError) {
      const directSupported = /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(filename || "") || /^audio\//i.test(mimeType) || /^video\//i.test(mimeType);
      if (!directSupported) throw conversionError;
      const result = await transcribeAudioBytes(bytes, filename, mimeType, mode);
      return { ...result, preprocessed: false };
    }
    const audioBytes = await readFile(audioPath);
    const duration = await mediaDurationSeconds(audioPath, fallbackDuration).catch(() => Number(fallbackDuration) || undefined);
    const result = await transcribeAudioBytes(audioBytes, "interview-audio.m4a", "audio/mp4", mode);
    return Number.isFinite(duration) && duration > 0 ? { ...result, duration, preprocessed: true } : { ...result, preprocessed: true };
  } finally {
    await Promise.all([sourcePath, audioPath].map((path) => unlink(path).catch(() => {})));
  }
}

async function transcribeAudioFile(path, filename, mode = "diarize") {
  return transcribeAudioBytes(await readFile(path), filename, "audio/mp4", mode);
}

async function transcribeLargeMediaFile(sourcePath, fallbackDuration, options = {}) {
  const jobId = randomUUID();
  const chunkPaths = [];
  const mode = normalizeTranscriptionMode(options.mode);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  try {
    onProgress({ stage: "detecting", progress: 3, message: "正在读取媒体时长并准备分片" });
    const duration = await mediaDurationSeconds(sourcePath, fallbackDuration);
    const chunkCount = Math.ceil(duration / AUDIO_CHUNK_SECONDS);
    const results = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * AUDIO_CHUNK_SECONDS;
      const chunkDuration = Math.min(AUDIO_CHUNK_SECONDS, duration - start);
      const chunkPath = join(JOB_DIR, `medvoice-audio-${jobId}-${index + 1}.m4a`);
      chunkPaths.push(chunkPath);
      onProgress({ stage: "extracting", chunkIndex: index + 1, chunkCount, progress: Math.round((index / chunkCount) * 92) + 4, message: `正在提取第 ${index + 1}/${chunkCount} 段音轨` });
      await extractAudioChunk(sourcePath, chunkPath, start, chunkDuration);
      let result;
      try {
        onProgress({ stage: "transcribing", chunkIndex: index + 1, chunkCount, progress: Math.round(((index + 0.35) / chunkCount) * 92) + 4, message: `正在转录第 ${index + 1}/${chunkCount} 段${mode === "fast" ? "（快速模式）" : "（说话人识别）"}` });
        result = await transcribeAudioFile(chunkPath, `interview-part-${index + 1}.m4a`, mode);
      } catch (error) {
        throw new Error(`第 ${index + 1}/${chunkCount} 个音频分片转录失败：${error.message}`);
      }
      const segments = Array.isArray(result.segments)
        ? result.segments.map((segment) => ({ ...segment, speaker: `片段${index + 1}-${segment.speaker || "speaker"}`, start: Number(segment.start || 0) + start, end: Number(segment.end || 0) + start }))
        : [];
      results.push({ text: result.text || "", segments, mode: result.transcription_mode });
      await unlink(chunkPath).catch(() => {});
      onProgress({ stage: "chunk-completed", chunkIndex: index + 1, chunkCount, progress: Math.round(((index + 1) / chunkCount) * 92) + 4, message: `已完成第 ${index + 1}/${chunkCount} 段` });
    }
    const segments = results.flatMap((result) => result.segments);
    return {
      text: results.map((result) => result.text).filter(Boolean).join("\n"),
      segments,
      duration,
      chunks: chunkCount,
      preprocessed: true,
      transcription_mode: mode === "fast" ? "fast-whisper" : results.some((result) => result.mode === "whisper-fallback") ? "whisper-fallback" : "speaker-diarization"
    };
  } finally {
    await Promise.all(chunkPaths.map((path) => unlink(path).catch(() => {})));
  }
}


const TRANSCRIPTION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const transcriptionJobs = new Map();

function cleanupTranscriptionJobs() {
  const now = Date.now();
  for (const [id, job] of transcriptionJobs.entries()) {
    if (now - job.updatedAt > TRANSCRIPTION_JOB_TTL_MS) transcriptionJobs.delete(id);
  }
}

function publicTranscriptionJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    chunkIndex: job.chunkIndex,
    chunkCount: job.chunkCount,
    message: job.message,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    result: job.status === "completed" ? job.result : undefined,
    error: job.status === "failed" ? job.error : undefined
  };
}

function updateTranscriptionJob(id, patch) {
  const job = transcriptionJobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function runLargeTranscriptionJob(jobId, sourcePath, fallbackDuration, mode, removeSource = true) {
  try {
    updateTranscriptionJob(jobId, { status: "running", stage: "queued", progress: 1, message: "文件已上传，正在进入转录队列" });
    const result = await transcribeLargeMediaFile(sourcePath, fallbackDuration, {
      mode,
      onProgress: (progress) => updateTranscriptionJob(jobId, { status: "running", ...progress })
    });
    updateTranscriptionJob(jobId, { status: "completed", stage: "completed", progress: 100, message: "全部分片转录完成", result });
  } catch (error) {
    updateTranscriptionJob(jobId, { status: "failed", stage: "failed", progress: 100, message: "转录失败", error: humanizeOpenAIError(error) });
  } finally {
    if (removeSource) await unlink(sourcePath).catch(() => {});
  }
}

async function handleLargeTranscribeJobStart(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请先完成临时 API Key 配置。" });
  cleanupTranscriptionJobs();
  let originalName = "interview.mp4";
  try {
    originalName = decodeURIComponent(String(req.headers["x-filename"] || originalName));
  } catch {}
  const id = randomUUID();
  const mode = transcriptionModeFromRequest(req);
  const sourcePath = join(JOB_DIR, `medvoice-source-${id}${safeUploadSuffix(originalName)}`);
  await streamUploadToFile(req, sourcePath);
  const job = {
    id,
    userId: req.user?.id,
    status: "queued",
    stage: "uploaded",
    progress: 1,
    chunkIndex: 0,
    chunkCount: 0,
    message: "上传完成，正在提取音频并分片",
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  transcriptionJobs.set(id, job);
  runLargeTranscriptionJob(id, sourcePath, req.headers["x-media-duration"], mode);
  return json(res, 202, publicTranscriptionJob(job));
}

function handleLargeTranscribeJobStatus(req, res, id) {
  cleanupTranscriptionJobs();
  const job = transcriptionJobs.get(id);
  if (!job || (job.userId && req.user?.id && job.userId !== req.user.id)) return json(res, 404, { error: "转录任务不存在或已过期" });
  return json(res, 200, publicTranscriptionJob(job));
}

async function handleLargeTranscribe(req, res) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请先完成临时 API Key 配置。" });
  let originalName = "interview.mp4";
  try {
    originalName = decodeURIComponent(String(req.headers["x-filename"] || originalName));
  } catch {}
  const jobId = randomUUID();
  const sourcePath = join(JOB_DIR, `medvoice-source-${jobId}${safeUploadSuffix(originalName)}`);
  try {
    await streamUploadToFile(req, sourcePath);
    return json(res, 200, await transcribeLargeMediaFile(sourcePath, req.headers["x-media-duration"], { mode: transcriptionModeFromRequest(req) }));
  } finally {
    await unlink(sourcePath).catch(() => {});
  }
}


async function handleStoredTranscribeJobStart(req, res, userId, itemId) {
  if (!API_KEY) return json(res, 503, { error: "尚未连接 AI 服务；请先完成 AI 服务配置。" });
  cleanupTranscriptionJobs();
  const item = await libraryStore.getItem(userId, itemId);
  if (!item?.storagePath) return json(res, 404, { error: "没有找到该账号下的访谈原始文件" });
  const fileInfo = await stat(item.storagePath).catch(() => null);
  if (!fileInfo?.isFile()) return json(res, 404, { error: "原始访谈文件已不在服务端，请重新上传" });
  if (fileInfo.size <= DIRECT_AUDIO_LIMIT) {
    const result = await transcribeStoredLibraryItem(userId, itemId, transcriptionModeFromRequest(req));
    return json(res, 200, { status: "completed", result });
  }
  const id = randomUUID();
  const mode = transcriptionModeFromRequest(req);
  const job = {
    id,
    userId,
    status: "queued",
    stage: "library",
    progress: 1,
    chunkIndex: 0,
    chunkCount: 0,
    message: "已读取账号资料库文件，正在提取音频并分片",
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  transcriptionJobs.set(id, job);
  runLargeTranscriptionJob(id, item.storagePath, item.durationSeconds, mode, false);
  return json(res, 202, publicTranscriptionJob(job));
}

async function transcribeStoredLibraryItem(userId, id, mode = "diarize") {
  if (!API_KEY) throw new Error("尚未连接 AI 服务；请先完成 AI 服务配置。");
  const item = await libraryStore.getItem(userId, id);
  if (!item?.storagePath) throw new Error("没有找到该账号下的访谈原始文件");
  const fileInfo = await stat(item.storagePath).catch(() => null);
  if (!fileInfo?.isFile()) throw new Error("原始访谈文件已不在服务端，请重新上传");
  if (fileInfo.size > DIRECT_AUDIO_LIMIT) return transcribeLargeMediaFile(item.storagePath, item.durationSeconds, { mode });
  const bytes = await readFile(item.storagePath);
  return transcribeUploadedMedia(bytes, item.fileName || item.name, item.mimeType, item.durationSeconds, mode);
}

async function handleLibrary(req, res, pathname) {
  const user = req.user;
  if (req.method === "GET" && pathname === "/api/library/items") {
    return json(res, 200, { items: await libraryStore.listItems(user.id) });
  }
  if (req.method === "POST" && pathname === "/api/library/items") {
    const meta = decodeMetadataHeader(req);
    const id = randomUUID();
    const fileName = String(meta.name || "interview.bin").slice(0, 240);
    const storagePath = libraryFilePath(user.id, id, fileName);
    const size = await streamUploadToFile(req, storagePath);
    const item = await libraryStore.createItem(user.id, id, meta, {
      fileName,
      mimeType: String(req.headers["content-type"] || meta.mimeType || "application/octet-stream").slice(0, 160),
      fileSize: size,
      storagePath
    });
    return json(res, 200, { item });
  }
  const itemMatch = pathname.match(/^\/api\/library\/items\/([^/]+)$/);
  if (itemMatch && req.method === "PATCH") {
    const patch = await readJson(req, 2_000_000);
    const item = await libraryStore.updateItem(user.id, itemMatch[1], patch);
    if (!item) return json(res, 404, { error: "资料不存在或无权访问" });
    return json(res, 200, { item });
  }
  if (itemMatch && req.method === "DELETE") {
    await removeStoredFiles(await libraryStore.deleteItem(user.id, itemMatch[1]));
    return json(res, 200, { deleted: true });
  }
  if (itemMatch && req.method === "GET") {
    const item = await libraryStore.getItem(user.id, itemMatch[1]);
    if (!item?.storagePath) return json(res, 404, { error: "资料不存在或无权访问" });
    const info = await stat(item.storagePath).catch(() => null);
    if (!info?.isFile()) return json(res, 404, { error: "原始访谈文件已不在服务端，请重新上传" });
    res.writeHead(200, {
      "Content-Type": item.mimeType || "application/octet-stream",
      "Content-Length": info.size,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(item.fileName || item.name)}"`,
      "Cache-Control": "no-store"
    });
    return createReadStream(item.storagePath).pipe(res);
  }
  const convertJobMatch = pathname.match(/^\/api\/library\/items\/([^/]+)\/convert-audio\/jobs$/);
  if (convertJobMatch && req.method === "POST") return handleStoredConvertAudioJobStart(req, res, user.id, convertJobMatch[1]);
  const transcribeJobMatch = pathname.match(/^\/api\/library\/items\/([^/]+)\/transcribe\/jobs$/);
  if (transcribeJobMatch && req.method === "POST") return handleStoredTranscribeJobStart(req, res, user.id, transcribeJobMatch[1]);
  const transcribeMatch = pathname.match(/^\/api\/library\/items\/([^/]+)\/transcribe$/);
  if (transcribeMatch && req.method === "POST") {
    const result = await transcribeStoredLibraryItem(user.id, transcribeMatch[1], transcriptionModeFromRequest(req));
    return json(res, 200, result);
  }
  if (req.method === "DELETE" && pathname === "/api/library/items") {
    await removeStoredFiles(await libraryStore.deleteAll(user.id));
    return json(res, 200, { deleted: true });
  }
  return json(res, 404, { error: "资料库接口不存在" });
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
  if (!process.env.RENDER && origin === "null" && isLocalHost(host)) return;
  let originHost = "";
  try { originHost = new URL(origin).host.toLowerCase(); } catch {}
  const allowed = new Set([host, `localhost:${PORT}`, `127.0.0.1:${PORT}`]);
  if (!allowed.has(originHost)) throw new Error("仅允许从当前 MedVoice Portal 调用服务");
}

function applyApiCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
  let allowedOrigin = "";
  if (!process.env.RENDER && origin === "null" && isLocalHost(host)) {
    allowedOrigin = "null";
  } else {
    let originHost = "";
    try { originHost = new URL(origin).host.toLowerCase(); } catch {}
    const allowed = new Set([host, `localhost:${PORT}`, `127.0.0.1:${PORT}`]);
    if (allowed.has(originHost)) allowedOrigin = origin;
  }
  if (!allowedOrigin) return;
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Filename");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
}

async function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(ROOT, relative));
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${sep}`)) return json(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(filePath);
    const extension = extname(filePath);
    res.writeHead(200, {
      "Content-Type": mime[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache, must-revalidate" : "public, max-age=300"
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      applyApiCors(req, res);
      assertLocalOrigin(req);
    }
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
      return json(res, 200, { ok: true, apiConfigured: Boolean(API_KEY), apiKeySource: process.env.OPENAI_API_KEY ? "server" : API_KEY ? "temporary" : "none", authRequired: AUTH_REQUIRED, storage: process.env.DATABASE_URL ? "postgres" : "sqlite", dataDir: DATA_DIR, libraryFileDir: LIBRARY_FILE_DIR, emailConfigured: mailConfigured(), emailProvider: mailProviderLabel(), mapModel: MAP_MODEL, synthesisModel: SYNTHESIS_MODEL });
    }
    if (url.pathname.startsWith("/api/")) {
      const apiUser = await requireUser(req, res);
      if (!apiUser) return;
    }
    if (req.method === "POST" && url.pathname === "/api/analyze") return await handleAnalyze(req, res);
    if (req.method === "POST" && url.pathname === "/api/roles/identify") return await handleIdentifyRoles(req, res);
    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (AUTH_REQUIRED && req.user.role !== "admin") return json(res, 403, { error: "仅管理员可以配置临时 API Key" });
      return await handleSettings(req, res);
    }
    if (url.pathname.startsWith("/api/library/")) return await handleLibrary(req, res, url.pathname);
    if (req.method === "POST" && url.pathname === "/api/media/convert-audio") return await handleConvertAudio(req, res);
    if (req.method === "POST" && url.pathname === "/api/media/convert-audio/jobs") return await handleConvertAudioJobStart(req, res);
    if (req.method === "POST" && url.pathname === "/api/media/convert-audio/chunked/start") return await handleChunkedConvertAudioStart(req, res);
    const chunkedConvertChunkMatch = url.pathname.match(/^\/api\/media\/convert-audio\/chunked\/([^/]+)\/chunks$/);
    if (req.method === "POST" && chunkedConvertChunkMatch) return await handleChunkedConvertAudioChunk(req, res, chunkedConvertChunkMatch[1]);
    const chunkedConvertCompleteMatch = url.pathname.match(/^\/api\/media\/convert-audio\/chunked\/([^/]+)\/complete$/);
    if (req.method === "POST" && chunkedConvertCompleteMatch) return await handleChunkedConvertAudioComplete(req, res, chunkedConvertCompleteMatch[1]);
    const convertJobDownloadMatch = url.pathname.match(/^\/api\/media\/convert-audio\/jobs\/([^/]+)\/download$/);
    if (req.method === "GET" && convertJobDownloadMatch) return await handleConvertAudioJobDownload(req, res, convertJobDownloadMatch[1]);
    const convertJobMatch = url.pathname.match(/^\/api\/media\/convert-audio\/jobs\/([^/]+)$/);
    if (req.method === "GET" && convertJobMatch) return handleConvertAudioJobStatus(req, res, convertJobMatch[1]);
    if (req.method === "POST" && url.pathname === "/api/transcribe") return await handleTranscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/transcribe-large/jobs") return await handleLargeTranscribeJobStart(req, res);
    const transcribeJobMatch = url.pathname.match(/^\/api\/transcribe-large\/jobs\/([^/]+)$/);
    if (req.method === "GET" && transcribeJobMatch) return handleLargeTranscribeJobStatus(req, res, transcribeJobMatch[1]);
    if (req.method === "POST" && url.pathname === "/api/transcribe-large") return await handleLargeTranscribe(req, res);
    if (req.method === "POST" && url.pathname === "/api/outline/parse") return await handleOutlineParse(req, res);
    if (req.method === "POST" && url.pathname === "/api/roles/identify/jobs") return await handleIdentifyRolesJobStart(req, res);
    const roleJobMatch = url.pathname.match(/^\/api\/roles\/identify\/jobs\/([^/]+)$/);
    if (req.method === "GET" && roleJobMatch) return handleIdentifyRolesJobStatus(req, res, roleJobMatch[1]);
    if (req.method === "POST" && url.pathname.startsWith("/api/export/")) return await handleExport(req, res, url.pathname.split("/").pop());
    if (req.method === "GET") {
      if (url.pathname === "/login" || url.pathname === "/login.html") return await serveStatic("/login.html", res);
      if (url.pathname === "/admin" || url.pathname === "/admin.html") {
        const user = await currentUser(req);
        if (AUTH_REQUIRED && !user) return redirect(res, "/login");
        if (AUTH_REQUIRED && user.role !== "admin") return redirect(res, "/");
        return await serveStatic("/admin.html", res);
      }
      if ((url.pathname === "/" || url.pathname === "/index.html") && AUTH_REQUIRED) {
        const user = await currentUser(req);
        if (!user) return redirect(res, "/login");
      }
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
