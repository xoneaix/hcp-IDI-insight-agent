export const MAX_DOCUMENTS = 30;
export const MAX_TEXT_LENGTH = 120_000;

export function sanitizeText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeDocumentType(type) {
  const value = String(type || "").trim().toLowerCase();
  return value === "patient" || value === "患者" ? "Patient" : "HCP";
}

export function validateAnalysisPayload(body) {
  if (!body || typeof body !== "object") throw new Error("请求体必须是 JSON 对象");
  if (!Array.isArray(body.documents) || body.documents.length === 0) {
    throw new Error("请至少提供一份访谈笔录");
  }
  if (body.documents.length > MAX_DOCUMENTS) {
    throw new Error(`单次最多分析 ${MAX_DOCUMENTS} 份笔录`);
  }
  const documents = body.documents.map((doc, index) => {
    const text = sanitizeText(doc?.text);
    if (!text) throw new Error(`第 ${index + 1} 份笔录内容为空`);
    return {
      id: sanitizeText(doc.id || `INT-${index + 1}`, 80),
      name: sanitizeText(doc.name || `访谈 ${index + 1}`, 160),
      type: normalizeDocumentType(doc.type),
      text
    };
  });
  const outline = sanitizeText(body.outline, 20_000);
  const questions = Array.isArray(body.questions)
    ? body.questions.map((question) => sanitizeText(question?.question || question, 800)).filter(Boolean).slice(0, 50)
    : extractOutlineQuestions(outline);
  if (!outline && !questions.length) throw new Error("请先在“大纲驱动·并发分析”中提供访谈大纲");
  return {
    documents,
    outline,
    questions,
    projectName: sanitizeText(body.projectName || "未命名访谈项目", 160)
  };
}

export function extractOutlineQuestions(value) {
  const lines = sanitizeText(value, 20_000)
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]+|(?:Q(?:uestion)?\s*)?\d+[.、):：-]?|[（(]?\d+[）)])\s*/i, "").trim())
    .filter((line) => line.length >= 4);
  const explicit = lines.filter((line) => /[?？]$/.test(line) || /^(如何|是否|哪些|什么|为何|为什么|怎样|请|谈谈|描述|how|what|why|which|when|where|do |does |is |are )/i.test(line));
  const source = explicit.length >= 2 ? explicit : lines;
  return [...new Set(source)].slice(0, 50);
}

export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return results;
}

export function extractResponseText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  throw new Error("模型未返回可解析的文本结果");
}

export function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("模型返回的结构化结果无法解析");
  }
}

export function maskSensitiveText(value) {
  return sanitizeText(value)
    .replace(/\b\d{17}[\dXx]\b/g, "[身份证号已脱敏]")
    .replace(/1[3-9]\d{9}/g, "[手机号已脱敏]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已脱敏]");
}

export function parseTranscriptTurns(value) {
  const lines = sanitizeText(value).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const timed = line.match(/^(.{1,80}?)\s*\[([^\]]{1,20})\]\s*[：:]\s*(.+)$/);
    const labeled = line.match(/^(.{1,80}?)\s*[：:]\s*(.+)$/);
    const match = timed || labeled;
    return {
      line_no: index + 1,
      speaker: sanitizeText(match?.[1] || "未知说话人", 80),
      timestamp: sanitizeText(timed?.[2] || "", 30),
      text: sanitizeText(match?.[timed ? 3 : 2] || line, 4000)
    };
  });
}

export function buildRoleExchanges(turns, assignments, respondentLabel = "受访者") {
  const assignmentMap = new Map((assignments || []).map((item) => [Number(item.line_no), item]));
  const mapped = turns.map((turn) => {
    const assignment = assignmentMap.get(turn.line_no) || {};
    return {
      ...turn,
      role: ["interviewer", "respondent", "observer", "uncertain"].includes(assignment.role) ? assignment.role : "uncertain",
      confidence: Math.max(0, Math.min(100, Number(assignment.confidence || 0)))
    };
  });
  const exchanges = [];
  const unpaired = [];
  let current = null;
  const pushCurrent = () => {
    if (!current) return;
    const scores = current.turns.map((turn) => turn.confidence).filter(Number.isFinite);
    const confidence = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
    exchanges.push({
      number: exchanges.length + 1,
      question: current.question.map((turn) => turn.text).join("\n"),
      answer: current.answer.map((turn) => turn.text).join("\n"),
      question_timestamp: current.question[0]?.timestamp || "",
      answer_timestamp: current.answer[0]?.timestamp || "",
      interviewer_speakers: [...new Set(current.question.map((turn) => turn.speaker))],
      respondent_speakers: [...new Set(current.answer.map((turn) => turn.speaker))],
      confidence,
      needs_review: confidence < 70 || !current.question.length || !current.answer.length,
      source_lines: current.turns.map((turn) => turn.line_no)
    });
    current = null;
  };
  for (const turn of mapped) {
    if (turn.role === "interviewer") {
      if (current?.answer.length) pushCurrent();
      current ||= { question: [], answer: [], turns: [] };
      current.question.push(turn);
      current.turns.push(turn);
    } else if (turn.role === "respondent") {
      current ||= { question: [], answer: [], turns: [] };
      current.answer.push(turn);
      current.turns.push(turn);
    } else {
      unpaired.push({ ...turn, display_role: turn.role === "observer" ? "第三方/旁听者" : "待人工确认" });
    }
  }
  pushCurrent();
  return {
    exchanges,
    unpaired,
    respondent_label: respondentLabel,
    average_confidence: exchanges.length ? Math.round(exchanges.reduce((sum, item) => sum + item.confidence, 0) / exchanges.length) : 0,
    review_count: exchanges.filter((item) => item.needs_review).length + unpaired.length
  };
}
