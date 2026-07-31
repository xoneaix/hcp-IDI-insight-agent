const PRODUCT_ALIAS = "产品X";

const SCENARIO_PRODUCT_PREFIX =
  /(?:痤疮玫满|本品痤疮|泰尔丝痤疮|痤疮泰尔丝)(?=[\s·_—-]*(?:院外首购|院外复购))/gu;
const PRODUCT_BRAND_NAMES = /(?:海正玫满|玫满)/gu;
const SENSITIVE_RESEARCH_IDENTIFIERS =
  /(?:海正药业(?:的)?|[（(]\s*盐酸米诺环素\s*[）)](?:的)?|盐酸米诺环素(?:的)?)/gu;

export function redactProductNames(value) {
  return String(value ?? "")
    .replace(SCENARIO_PRODUCT_PREFIX, PRODUCT_ALIAS)
    .replace(PRODUCT_BRAND_NAMES, PRODUCT_ALIAS)
    .replace(SENSITIVE_RESEARCH_IDENTIFIERS, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}

export function redactProductReferences(value) {
  if (typeof value === "string") return redactProductNames(value);
  if (Array.isArray(value)) return value.map(redactProductReferences);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactProductReferences(entry)])
  );
}

export function containsProductBrandName(value) {
  return /(?:(?:痤疮玫满|本品痤疮|泰尔丝痤疮|痤疮泰尔丝)(?=[\s·_—-]*(?:院外首购|院外复购))|海正玫满|玫满|海正药业|盐酸米诺环素)/u
    .test(String(value ?? ""));
}
