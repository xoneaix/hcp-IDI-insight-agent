import test from "node:test";
import assert from "node:assert/strict";
import { flattenQuestionGroups, groupOutlineQuestions, groupsFromQuestions } from "../public/outline-structure.js";

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
