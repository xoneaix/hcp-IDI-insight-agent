import { mkdir, writeFile } from "node:fs/promises";
import { buildInsightDeck, buildInsightDocx, buildMatrixWorkbook } from "../lib/office-exporter.mjs";

const outputDir = process.argv[2];
await mkdir(outputDir, { recursive: true });

const questions = [
  "当前治疗决策路径与关键参与者是什么？",
  "选择一线治疗方案时最重要的驱动因素是什么？",
  "生物标志物检测有哪些现实障碍？",
  "对目标产品临床证据的认知如何？",
  "处方转换的触发条件与关键顾虑是什么？"
];
const matrix = ["HCP-001", "HCP-002", "HCP-003"].map((id, rowIndex) => ({
  document_id: id,
  name: `interview-${rowIndex + 1}.txt`,
  type: "HCP",
  answers: questions.map((question, index) => ({
    question_id: `Q${index + 1}`,
    question,
    answer: index === 2 && rowIndex === 2 ? "本次访谈未覆盖该问题。" : "受访者强调临床证据、患者特征与院内路径需要共同纳入决策。",
    coverage: index === 2 && rowIndex === 2 ? "未覆盖" : index === 4 ? "部分覆盖" : "完整覆盖",
    confidence: 86,
    quotes: index === 2 && rowIndex === 2 ? [] : [{ quote: "真正做决定时，我们会把证据和患者实际情况放在一起看。", speaker: "HCP", meaning: "综合决策" }]
  }))
}));
const report = {
  executive_summary: "三份访谈共同显示，HCP 的治疗选择并非由单一疗效指标决定，而是同时受到患者特征、检测可及性、院内流程与长期管理负担影响。策略重点应从单点信息传递转向可落地的诊疗路径支持。",
  sample_overview: "共分析三位 HCP 的深度访谈，并依据五个主要研究问题完成逐题对齐。",
  top_insights: [
    { title: "治疗选择是证据与真实路径的共同结果", insight: "HCP 会把临床证据、患者状态和院内可执行性放在同一决策框架中。", implication: "医学沟通需要连接证据与临床场景。", prevalence: 3, confidence: 91, evidence: [{ document_id: "HCP-001", quote: "真正做决定时，我们会把证据和患者实际情况放在一起看。" }] },
    { title: "检测障碍集中在流程衔接", insight: "检测认知不是主要问题，样本处理与结果回传更容易影响治疗时机。", implication: "优先提供流程工具而不是重复疾病教育。", prevalence: 2, confidence: 87, evidence: [{ document_id: "HCP-002", quote: "报告回来得晚，病人和家属都会更焦虑。" }] }
  ],
  unmet_needs: ["缺少检测结果等待期的标准沟通工具", "院外随访缺少明确的责任与触发条件"],
  strategic_actions: ["建立检测路径诊断工具并在不同医院层级验证", "设计首月随访试点并跟踪失访与停药"],
  caveats: ["定性样本用于探索机制，不用于估计总体发生率。", "所有 AI 洞察需由研究、医学与合规人员复核。"],
  segments: []
};
const payload = { projectName: "晚期肿瘤治疗决策研究", questions, matrix, report };

await writeFile(`${outputDir}/matrix.xlsx`, await buildMatrixWorkbook(payload));
await writeFile(`${outputDir}/report.docx`, await buildInsightDocx(payload));
await writeFile(`${outputDir}/deck.pptx`, await buildInsightDeck(payload));
