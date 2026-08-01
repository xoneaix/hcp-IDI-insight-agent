import test from "node:test";
import assert from "node:assert/strict";
import { buildMedicalTranscriptionContext, parseTranscriptionKeywords } from "../lib/transcription-context.mjs";

test("medical transcription context includes safe default and user terminology", () => {
  const context = buildMedicalTranscriptionContext({ terms: "GLP-1、细胞靶点、PD-1" });
  assert.deepEqual(context.languages, ["zh-cn", "en"]);
  assert.ok(context.keywords.includes("GLP-1"));
  assert.ok(context.keywords.includes("细胞靶点"));
  assert.ok(context.keywords.includes("PD-1"));
  assert.match(context.prompt, /医疗深度访谈/);
});

test("medical terminology is deduplicated and unsafe multiline characters are removed", () => {
  const terms = parseTranscriptionKeywords(["GLP-1", "<EGFR>", "EGFR\nmutation", "GLP-1"]);
  assert.equal(terms.filter((term) => term === "GLP-1").length, 1);
  assert.ok(terms.includes("EGFR"));
  assert.ok(terms.every((term) => !/[<>\r\n]/.test(term)));
});

test("previous chunk tail is carried into the next transcription prompt", () => {
  const context = buildMedicalTranscriptionContext({ previousTranscript: "前文讨论了 GLP-1 受体和细胞靶点。" });
  assert.match(context.prompt, /上一音频分片/);
  assert.match(context.prompt, /GLP-1/);
});

