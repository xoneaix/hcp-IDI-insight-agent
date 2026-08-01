const DEFAULT_TERMS = ["GLP-1", "细胞靶点", "HCP"];
const MAX_KEYWORDS = 40;
const MAX_KEYWORD_LENGTH = 80;
const MAX_PROMPT_LENGTH = 1800;

function cleanKeyword(value) {
  const keyword = String(value || "").trim().replace(/[<>\r\n]/g, "").slice(0, MAX_KEYWORD_LENGTH);
  return keyword || "";
}

export function parseTranscriptionKeywords(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[，,、;；\n]+/u);
  return [...new Set([...DEFAULT_TERMS, ...source].map(cleanKeyword).filter(Boolean))].slice(0, MAX_KEYWORDS);
}

export function buildMedicalTranscriptionContext(options = {}) {
  const keywords = parseTranscriptionKeywords(options.terms);
  const previousTranscript = String(options.previousTranscript || "").replace(/\s+/g, " ").trim().slice(-700);
  const parts = [
    "中文为主、可能夹杂英文缩写的医疗深度访谈，涉及疾病认知、治疗路径、细胞或分子靶点、作用机制、疗效与安全性。请准确保留医学术语、英文缩写、数字、连字符和大小写。",
    keywords.length ? `可能出现的专业术语包括：${keywords.join("、")}。` : ""
  ];
  if (previousTranscript) parts.push(`上一音频分片的结尾是：${previousTranscript}`);
  return {
    prompt: parts.filter(Boolean).join(" ").slice(0, MAX_PROMPT_LENGTH),
    keywords,
    languages: ["zh-cn", "en"]
  };
}

