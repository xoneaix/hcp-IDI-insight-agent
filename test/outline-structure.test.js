import test from "node:test";
import assert from "node:assert/strict";
import { flattenQuestionGroups, groupOutlineQuestions, groupsFromQuestions, stripDimensionDuration } from "../public/outline-structure.js";

test("outline questions are grouped under their nearest numbered dimension", () => {
  const groups = groupOutlineQuestions(`
Part2 从“长痘”到“重视”的认知觉醒
2.1 痘痘初次感知
问题1：您最近一次发现自己长痘是什么时候？
问题2：最开始长痘时，您觉得这事严重吗？
2.2 认知升级的触发点
问题1：后来是什么让您开始认真对待长痘？
问题2：那一刻您的想法是什么？
`);

  assert.deepEqual(groups, [
    {
      title: "痘痘初次感知",
      questions: [
        "您最近一次发现自己长痘是什么时候？",
        "最开始长痘时，您觉得这事严重吗？"
      ]
    },
    {
      title: "认知升级的触发点",
      questions: [
        "后来是什么让您开始认真对待长痘？",
        "那一刻您的想法是什么？"
      ]
    }
  ]);
});

test("server fallback questions are retained without duplicating parsed questions", () => {
  const groups = groupOutlineQuestions("2.1 就诊体验\n问题1：您如何选择医院？", [
    "您如何选择医院？",
    "复诊时最希望改善什么？"
  ]);

  assert.equal(groups[0].title, "就诊体验");
  assert.deepEqual(flattenQuestionGroups(groups), [
    "您如何选择医院？",
    "复诊时最希望改善什么？"
  ]);
});

test("legacy flat questions migrate into a compatible general group", () => {
  assert.deepEqual(groupsFromQuestions(["问题1：当前治疗体验如何？"]), [{
    title: "通用问题",
    questions: ["当前治疗体验如何？"]
  }]);
});

test("dimension labels omit interview duration annotations", () => {
  assert.equal(stripDimensionDuration("从“长痘”到“重视”的认知觉醒（15分钟）"), "从“长痘”到“重视”的认知觉醒");
  assert.equal(stripDimensionDuration("购买决策路径 20-25 mins"), "购买决策路径");
  const groups = groupOutlineQuestions("Part2 院外复购体验（15分钟）\n问题1：您为什么再次购买？");
  assert.equal(groups[0].title, "院外复购体验");
});
