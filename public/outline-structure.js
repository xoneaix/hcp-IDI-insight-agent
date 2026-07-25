function normalizedText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

function cleanedLine(value) {
  return String(value || "").replace(/^\s*[-*•·]\s*/, "").trim();
}

function cleanedQuestion(value) {
  return cleanedLine(value)
    .replace(/^\s*(?:(?:问题|Q(?:uestion)?)\s*\d+\s*[.、):：-]?|[（(]?\d+[）)]\s*)/i, "")
    .trim();
}

function questionKey(value) {
  return cleanedQuestion(value).replace(/\s+/g, "").toLowerCase();
}

export function stripDimensionDuration(value) {
  return String(value || "")
    .replace(/\s*[（(]\s*(?:约\s*)?\d+(?:\s*[-–—~至]\s*\d+)?\s*(?:分钟|mins?|minutes?)\s*[）)]\s*$/i, "")
    .replace(/\s+\d+(?:\s*[-–—~至]\s*\d+)?\s*(?:分钟|mins?|minutes?)\s*$/i, "")
    .trim();
}

function looksLikeQuestion(value) {
  const line = cleanedLine(value);
  if (!line) return false;
  return /[?？]/.test(line)
    || /^(?:问题|Q(?:uestion)?)\s*\d+/i.test(line)
    || /^(?:如何|是否|哪些|什么|为何|为什么|怎样|怎么|谁|何时|哪里|请问|请描述|请介绍|请谈谈|您觉得|您认为|您是否|您最近|您会|有没有|how|what|why|which|when|where|who|do |does |did |is |are |would |could )/i.test(line);
}

function headingTitle(value) {
  const line = cleanedLine(value);
  if (!line || looksLikeQuestion(line)) return "";
  const match = line.match(/^(?:(?:part\s*\d+)|(?:第[一二三四五六七八九十百\d]+[部分章节])|(?:\d+(?:\.\d+)+))\s*[.、:：-]?\s*(.+)$/i);
  if (match?.[1]) return stripDimensionDuration(match[1].trim().replace(/[：:]$/, ""));
  const chinese = line.match(/^[一二三四五六七八九十]+[、.]\s*(.+)$/);
  return stripDimensionDuration(chinese?.[1]?.trim().replace(/[：:]$/, "") || "");
}

function uniqueQuestions(values) {
  const seen = new Set();
  return values.map(cleanedQuestion).filter((question) => {
    const key = questionKey(question);
    if (!question || question.length < 4 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function groupsFromQuestions(questions, title = "通用问题") {
  const values = uniqueQuestions(Array.isArray(questions) ? questions : []);
  return values.length ? [{ title, questions: values }] : [];
}

export function normalizeQuestionGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.map((group) => ({
    title: stripDimensionDuration(String(group?.title || "未命名维度").trim().slice(0, 120)) || "未命名维度",
    questions: uniqueQuestions(Array.isArray(group?.questions) ? group.questions : [])
  })).filter((group) => group.questions.length);
}

export function flattenQuestionGroups(groups) {
  return normalizeQuestionGroups(groups).flatMap((group) => group.questions).slice(0, 50);
}

export function groupOutlineQuestions(text, fallbackQuestions = []) {
  const groups = [];
  let activeTitle = "通用问题";
  const addQuestion = (question) => {
    const clean = cleanedQuestion(question);
    if (!clean || clean.length < 4) return;
    let group = groups.find((item) => item.title === activeTitle);
    if (!group) {
      group = { title: activeTitle, questions: [] };
      groups.push(group);
    }
    if (!group.questions.some((item) => questionKey(item) === questionKey(clean))) group.questions.push(clean);
  };

  for (const rawLine of normalizedText(text).split(/\n+/)) {
    const line = cleanedLine(rawLine);
    if (!line) continue;
    const title = headingTitle(line);
    if (title) {
      activeTitle = title;
      continue;
    }
    if (looksLikeQuestion(line)) addQuestion(line);
  }

  const known = new Set(groups.flatMap((group) => group.questions.map(questionKey)));
  const missing = uniqueQuestions(Array.isArray(fallbackQuestions) ? fallbackQuestions : [])
    .filter((question) => !known.has(questionKey(question)));
  if (missing.length) groups.push({ title: groups.length ? "其他主要问题" : "通用问题", questions: missing });
  return normalizeQuestionGroups(groups).slice(0, 20);
}
