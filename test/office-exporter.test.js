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
  const [xlsx, docx, pptx, roleDocx, strategyDeck] = await Promise.all([
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
    }),
    buildInsightDeck({
      projectName: "玫满院外患者深度访谈",
      guides: [{ title: "院外首购", matrix: [{ document_id: "Patient-001" }] }, { title: "院外复购", matrix: [{ document_id: "Patient-004" }] }],
      deckScript: {
        title: "从首次尝试到持续复购：院外患者决策洞察",
        subtitle: "首购与复购场景的证据驱动市场策略",
        audience: "品牌市场部、医学与研究负责人",
        slides: [
          { title: "从首次尝试到持续复购：院外患者决策洞察", takeaway: "两个研究场景共同揭示患者决策路径中的关键张力。", layout: "封面", method: "跨场景定性综合", content: [], evidence: [], visual_note: "极简封面" },
          { title: "首购依赖信任建立，复购依赖体验确认", takeaway: "市场策略需要分别解决首次选择与持续使用的不同阻力。", layout: "场景对比", method: "跨场景对比", content: [{ heading: "院外首购", body: "患者需要专业背书与清晰的使用预期。" }, { heading: "院外复购", body: "患者依据效果体验、便利性和风险判断决定是否持续。" }], evidence: [{ document_id: "Patient-001", quote: "我会先问医生，再决定是不是去院外购买。" }], visual_note: "左右对照，底部保留一条可追溯原话" }
        ]
      }
    })
  ]);
  for (const buffer of [xlsx, docx, pptx, roleDocx, strategyDeck]) {
    assert.ok(buffer.length > 1000);
    assert.equal(buffer.subarray(0, 2).toString(), "PK");
  }
});
