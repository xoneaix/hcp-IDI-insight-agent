import test from "node:test";
import assert from "node:assert/strict";
import { buildInsightDeck, buildInsightDocx, buildMatrixWorkbook, buildRoleTranscriptDocx } from "../lib/office-exporter.mjs";

const payload = {
  projectName: "验证项目",
  questions: ["当前治疗决策路径是什么？", "主要未满足需求是什么？"],
  matrix: [{
    document_id: "HCP-001",
    name: "interview-01.txt",
    type: "HCP",
    answers: [
      { answer: "由多学科共同决策。", coverage: "完整覆盖", confidence: 90, quotes: [{ quote: "我们会一起讨论。", speaker: "HCP", meaning: "MDT 决策" }] },
      { answer: "随访工具不足。", coverage: "部分覆盖", confidence: 76, quotes: [] }
    ]
  }],
  report: {
    executive_summary: "样本显示治疗决策需要多学科协同。",
    sample_overview: "共分析一份访谈。",
    top_insights: [{ title: "协同影响决策", insight: "多学科意见共同影响方案选择。", implication: "建立跨科室沟通工具。", prevalence: 1, confidence: 90, evidence: [{ document_id: "HCP-001", quote: "我们会一起讨论。" }] }],
    unmet_needs: ["缺少标准化随访工具"],
    strategic_actions: ["验证随访工具需求"],
    caveats: ["定性样本不代表总体发生率"],
    segments: []
  }
};

test("office exporters produce valid OOXML zip buffers", async () => {
  const [xlsx, docx, pptx, roleDocx] = await Promise.all([
    buildMatrixWorkbook(payload),
    buildInsightDocx(payload),
    buildInsightDeck(payload),
    buildRoleTranscriptDocx({
      projectName: "患者体验研究",
      documents: [{
        document_id: "PAT-001",
        name: "patient-interview.txt",
        type: "患者",
        respondent_label: "患者/受访者",
        average_confidence: 92,
        review_count: 0,
        exchanges: [{ number: 1, question: "请介绍一下最近的复诊体验？", answer: "预约等待时间比较长，希望能有更明确的提醒。", question_timestamp: "0:03", answer_timestamp: "0:08", confidence: 92, needs_review: false }],
        unpaired: []
      }]
    })
  ]);
  for (const buffer of [xlsx, docx, pptx, roleDocx]) {
    assert.ok(buffer.length > 1000);
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
  }
});
