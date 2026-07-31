import test from "node:test";
import assert from "node:assert/strict";
import {
  containsProductBrandName,
  redactProductNames,
  redactProductReferences
} from "../public/compliance-redaction.js";

test("compliance redaction normalizes scenario filenames to 产品X", () => {
  const names = [
    "20260417-痤疮玫满-院外首购-共享屏.m4a",
    "20260420-本品痤疮-院外复购-共享屏.m4a",
    "20260416-泰尔丝痤疮-院外复购-共享屏.m4a",
    "20260416-痤疮泰尔丝-院外复购-共享屏.m4a"
  ];
  for (const name of names) {
    assert.match(redactProductNames(name), /产品X-(?:院外首购|院外复购)/u);
    assert.equal(containsProductBrandName(redactProductNames(name)), false);
  }
});

test("compliance redaction recursively masks transcript and role content", () => {
  const result = redactProductReferences({
    name: "Patient-001 · 痤疮玫满-院外首购.m4a",
    text: "受访者：之前吃过玫满，也了解过泰尔丝。",
    roleResult: {
      exchanges: [{ question: "为什么选择海正玫满？", answer: "医生建议继续使用玫满。" }]
    }
  });
  assert.equal(result.name, "Patient-001 · 产品X-院外首购.m4a");
  assert.equal(result.text, "受访者：之前吃过产品X，也了解过泰尔丝。");
  assert.equal(result.roleResult.exchanges[0].question, "为什么选择产品X？");
  assert.equal(containsProductBrandName(JSON.stringify(result)), false);
});

test("compliance redaction removes company and compound identifiers from outline content", () => {
  const outline = redactProductReferences({
    title: "访谈大纲1",
    text: "海正药业 产品X（盐酸米诺环素）\n院外患者深度访谈\n药品通用名：盐酸米诺环素",
    questions: ["您对海正药业的产品了解多少？", "是否了解（盐酸米诺环素）的注意事项？"]
  });
  assert.equal(outline.text, "产品X\n院外患者深度访谈\n药品通用名：");
  assert.deepEqual(outline.questions, ["您对产品了解多少？", "是否了解注意事项？"]);
  assert.equal(containsProductBrandName(JSON.stringify(outline)), false);
});
