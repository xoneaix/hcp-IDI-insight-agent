const patientNames = [
  "20260417193555-No.6-4_17-院外首购-华东-视频-1.m4a",
  "20260420144350-No.8-4_20-院外首购-华中-视频-1.m4a",
  "20260415183845-No.2-4_15-院外首购-华南-视频-1.m4a",
  "20260416094220-No.3-4_16-院外复购-华北-视频-1.m4a",
  "20260416124056-No.4-4_16-院外复购-华东-视频-1.m4a",
  "20260416163542-No.5-4_16-院外复购-华南-视频-1.m4a"
];

const roleQuestions = [
  "您第一次意识到需要使用口服药，是在什么情境下？",
  "决定院外购买时，最重要的推动因素是什么？",
  "对疗效和安全性，您最希望得到怎样的解释？"
];

const roleAnswers = [
  ["最初只是反复发作，后来影响到工作和社交，才觉得不能只靠护肤。", "医生把为什么要用药、怎么复诊讲清楚后，我才愿意行动。", "我希望知道多久能看到变化，以及出现不适时应该怎么办。"],
  ["开始觉得不严重，但反复出现让我意识到需要更规范地处理。", "真实案例和专业建议比单纯强调方便更能让我放心。", "疗效要有预期，安全性也要说得具体，不能只说没有问题。"],
  ["当外用方法效果有限时，我才认真考虑口服治疗。", "能够在线上确认、院外方便获得，是我采取行动的重要条件。", "我会关注副作用、复查节点和什么时候需要停止用药。"],
  ["复购前我会重新判断症状有没有反复，以及上次体验是否可接受。", "提醒、随访和清晰的疗程管理会让我更愿意继续。", "希望知道长期使用的边界，以及漏服后应该怎么处理。"],
  ["症状重新出现时会考虑复购，但也会担心是不是需要再次问医生。", "如果药师能核对疗程并提供复诊提示，我会更安心。", "不喜欢绝对化的快效承诺，更想看到真实、可验证的信息。"],
  ["便利只是基础，最终还是看上一次有没有效果、是否有不舒服。", "复购入口、用药记录和复诊路径连起来，体验会好很多。", "要把不同人可能出现的反应说明白，并告诉我如何处理。"]
];

const guideDefinitions = [
  {
    id: "preview-guide-first",
    title: "【院外首购】患者治疗启动与信任建立",
    source: "功能导览示例-院外首购访谈大纲.docx",
    sampleIndexes: [0, 1, 2],
    groups: [
      { title: "治疗启动", questions: ["您第一次意识到需要口服治疗是在什么情境下？", "外用方法效果有限时，什么会推动您升级治疗？"] },
      { title: "信任与决策", questions: ["决定院外购买时，哪些信息最能建立信任？", "医生、药师、社交媒体分别扮演什么角色？"] },
      { title: "疗效与安全", questions: ["您对疗效速度和持续改善有哪些期待？", "哪些安全性问题会阻碍您开始治疗？"] }
    ],
    insightTitles: [
      ["治疗启动并非由诊断标签触发，而由“反复影响生活”推动", "首购决策从症状忍耐转向规范治疗，往往发生在外用效果有限、反复发作或生活受扰之后。", 94],
      ["医生背书、真实案例与安全 FAQ 共同构成信任链", "单一渠道难以完成首购说服；专业解释、同类经验和可回答的风险信息需要协同出现。", 92],
      ["安全沟通必须具体到场景和处理方式", "患者需要知道可能发生什么、何时需要复诊以及出现不适后如何行动。", 90]
    ]
  },
  {
    id: "preview-guide-repeat",
    title: "【院外复购】患者疗程延续与体验闭环",
    source: "功能导览示例-院外复购访谈大纲.docx",
    sampleIndexes: [3, 4, 5],
    groups: [
      { title: "复购触发", questions: ["什么情境会让您考虑再次购买？", "上一次疗效和不适体验如何影响复购？"] },
      { title: "疗程管理", questions: ["哪些提醒或随访能帮助您坚持疗程？", "您希望药师或医生提供哪些复购支持？"] },
      { title: "风险与体验", questions: ["哪些信息会降低长期使用的顾虑？", "什么会导致自行减量、停药或放弃复购？"] }
    ],
    insightTitles: [
      ["复购是一次新的风险—收益判断，不是首购的自然延续", "患者会重新衡量疗效、不适、症状变化与获取成本，便利无法替代信任。", 96],
      ["随访、复诊提醒与用药记录决定疗程能否延续", "把复购入口与专业支持连接起来，比单纯提高购买便利更能减少流失。", 93],
      ["绝对快效和无来源数字会放大话术风险", "真实可验证的疗效预期与清晰来源，更有助于建立长期信任。", 91]
    ]
  }
];

function makeRoleResult(index) {
  return {
    document_id: `Patient-${String(index + 1).padStart(3, "0")}`,
    name: patientNames[index],
    type: "Patient",
    respondent_label: "Patient",
    average_confidence: 94 - (index % 3),
    exchanges: roleQuestions.map((question, questionIndex) => ({
      question,
      answer: roleAnswers[index][questionIndex],
      question_timestamp: `0${questionIndex + 1}:10`,
      answer_timestamp: `0${questionIndex + 1}:24`,
      confidence: 92 + ((index + questionIndex) % 5),
      needs_review: false
    }))
  };
}

function makeInterview(index) {
  const id = `Patient-${String(index + 1).padStart(3, "0")}`;
  const roleResult = makeRoleResult(index);
  return {
    projectId: "preview-study",
    projectName: "功能导览 · 脱敏示例研究",
    id,
    serverId: `preview-${index + 1}`,
    name: patientNames[index],
    type: "Patient",
    duration: `${58 + index * 4}:${String(12 + index * 5).padStart(2, "0")}`,
    durationSeconds: 3500 + index * 260,
    status: "已转录",
    progressText: "",
    text: roleResult.exchanges.map((exchange) => `访谈员：${exchange.question}\n受访者：${exchange.answer}`).join("\n\n"),
    roleResult,
    file: null,
    fileName: patientNames[index],
    fileSize: 18_000_000 + index * 900_000,
    mimeType: "audio/mp4",
    hasFile: true,
    source: "脱敏演示资料",
    persisted: true,
    selected: false,
    roleSelected: false,
    roleExpanded: index === 0
  };
}

function makeMatrixRow(interview, questions, rowOffset) {
  return {
    document_id: interview.id,
    name: interview.name,
    type: "Patient",
    answers: questions.map((question, questionIndex) => {
      const mode = (rowOffset + questionIndex) % 5;
      const coverage = mode === 4 ? "未覆盖" : mode === 3 ? "部分覆盖" : "完整覆盖";
      const quote = roleAnswers[rowOffset][questionIndex % roleAnswers[rowOffset].length];
      return {
        question,
        answer: coverage === "未覆盖" ? "该样本未形成可核验的直接回答。" : quote,
        coverage,
        quotes: coverage === "未覆盖" ? [] : [{ quote, document_id: interview.id }]
      };
    })
  };
}

function makeReport(definition, sampleInterviews) {
  return {
    executive_summary: `${definition.title}显示，患者决策不是单一触点的结果，而是症状体验、专业信任、疗效预期与安全顾虑共同作用的过程。`,
    top_insights: definition.insightTitles.map(([title, insight, confidence], index) => ({
      title,
      insight,
      implication: index === 0 ? "围绕真实决策触发设计教育内容与转化路径。" : index === 1 ? "将专业解释、原话证据与可执行支持串成连续体验。" : "把泛化承诺改写为可核验、可追问的沟通。",
      confidence,
      evidence: sampleInterviews.slice(0, 2).map((item, evidenceIndex) => ({
        document_id: item.id,
        quote: roleAnswers[Number(item.id.split("-")[1]) - 1][(index + evidenceIndex) % 3]
      }))
    }))
  };
}

function makeGuide(definition, interviews) {
  const questions = definition.groups.flatMap((group) => group.questions);
  const samples = definition.sampleIndexes.map((index) => interviews[index]);
  const matrix = samples.map((interview, index) => makeMatrixRow(interview, questions, definition.sampleIndexes[index]));
  return {
    id: definition.id,
    title: definition.title,
    outlineText: definition.groups.map((group, index) => `${index + 1}. ${group.title}\n${group.questions.map((question, questionIndex) => `问题${questionIndex + 1}：${question}`).join("\n")}`).join("\n\n"),
    outlineSource: definition.source,
    outlineFileMeta: { name: definition.source, size: 148_000, type: "DOCX" },
    questionGroups: definition.groups,
    questions,
    sampleIds: samples.map((item) => item.serverId),
    analyses: questions.map((question, index) => ({ question, contradictions: index % 3 === 1 ? ["不同受访者对信息来源的信任存在差异"] : [] })),
    matrix,
    report: makeReport(definition, samples),
    createdAt: 1_722_000_000_000 + definition.sampleIndexes[0]
  };
}

function makeDeckScript(guides) {
  const crossInsights = [
    { dimension: "决策路径", theme: "从被动忍耐到主动治疗", finding: "首购由生活影响触发，复购则是对上次疗效与风险的重新判断。", scenario_contrast: "首购强调启动信任，复购强调体验验证。", implication: "分别设计治疗启动教育与疗程延续支持。", evidence: [] },
    { dimension: "核心阻碍", theme: "安全顾虑与路径不确定性", finding: "患者担心副作用，也担心不知道何时复诊、向谁求助。", scenario_contrast: "首购担心开始，复购担心长期使用。", implication: "形成分场景安全 FAQ 和升级路径。", evidence: [] },
    { dimension: "疗效诉求", theme: "快效期待需要被合理校准", finding: "患者期待可感知改善，但更信任有边界、有验证方式的承诺。", scenario_contrast: "首购看启动速度，复购看稳定与复发管理。", implication: "以阶段性目标代替绝对快效。", evidence: [] },
    { dimension: "话术风险", theme: "无来源比例和绝对承诺降低可信度", finding: "受访者会对“快速”“一定有效”等表达保持警惕。", scenario_contrast: "复购人群对不一致体验更敏感。", implication: "所有数字注明来源、样本与适用边界。", evidence: [] },
    { dimension: "院外复购风险", theme: "便利之外仍需要专业闭环", finding: "自行减量、停药和失访会削弱长期价值。", scenario_contrast: "复购场景更依赖提醒、随访和复诊入口。", implication: "建立院外复购安全闭环。", evidence: [] }
  ];
  const priorities = [
    { title: "围绕炎性痤疮的规范口服治疗建立场景认知", rationale: "两个场景都显示症状反复与生活影响是行动触发点。", action: "建立分层识别内容并验证问诊转化。" },
    { title: "搭建医生背书、真实案例与安全 FAQ 的信任链", rationale: "专业判断与同类经验需要共同出现。", action: "形成可追溯的内容资产和复核流程。" },
    { title: "把安全可靠改写为具体可回答的问题清单", rationale: "泛化安全承诺不足以缓解顾虑。", action: "覆盖适用人群、不适处理、复诊和停药边界。" },
    { title: "建立院外复购安全闭环", rationale: "复购存在减量、停药与失访风险。", action: "连接复购入口、药师随访、用药记录与复诊提醒。" }
  ];
  const slides = [
    { layout: "封面", title: "功能导览 · 脱敏示例洞察报告", takeaway: "从首购到复购，患者如何决定“该吃药了”", content: [{ heading: "研究范围", body: "2 份 Discussion Guide · 6 份脱敏样本 · 12 个核心问题" }] },
    { layout: "执行摘要", title: "患者行动由症状影响、专业信任与可管理风险共同驱动", takeaway: "便利是基础，能够解释并管理治疗风险才是持续转化的关键。", content: [{ heading: "首购", body: "从反复忍耐走向规范治疗。" }, { heading: "复购", body: "对疗效、安全与体验重新判断。" }, { heading: "策略命题", body: "用证据链和服务闭环连接两种场景。" }] },
    { layout: "场景对比", title: "两份 Discussion Guide 对应两个独立决策场景", takeaway: "样本边界必须保留，不能把首购与复购平均成同一种患者。", content: [{ heading: "DG-01 院外首购", body: "治疗启动、信息搜寻与首次信任。" }, { heading: "DG-02 院外复购", body: "疗效复盘、长期顾虑与疗程延续。" }] },
    { layout: "旅程地图", title: "决策路径：从症状反复走向可持续治疗", takeaway: "每个阶段都有不同的信息缺口和行动支持需求。", content: [{ heading: "感知问题", body: "反复、影响生活。" }, { heading: "建立信任", body: "专业解释与真实证据。" }, { heading: "采取行动", body: "院外可及与清晰路径。" }, { heading: "持续管理", body: "提醒、随访和复诊。" }] },
    { layout: "洞察证据", title: "核心阻碍：不是只怕副作用，而是不知道如何管理风险", takeaway: "安全沟通必须回答具体场景、处理方式和求助路径。", content: [{ heading: "开始前", body: "是否适合、可能出现什么。" }, { heading: "使用中", body: "如何监测与处理不适。" }, { heading: "疗程后", body: "何时复诊、减量或停止。" }] },
    { layout: "机会优先级", title: "四项市场策略优先级", takeaway: "从场景认知、信任链、安全 FAQ 到复购闭环形成连续策略。", content: priorities.map((item) => ({ heading: item.title, body: item.action })) },
    { layout: "行动路线图", title: "90 天验证路线图", takeaway: "先验证内容和路径，再扩展为跨渠道服务闭环。", content: [{ heading: "0–30 天", body: "完成内容分层与合规复核。" }, { heading: "31–60 天", body: "小范围验证问诊与复购触点。" }, { heading: "61–90 天", body: "根据行为数据优化并扩展。" }] },
    { layout: "研究边界", title: "定性研究用于形成策略假设，不替代疗效或人群比例结论", takeaway: "所有 AI 结论均需研究、医学与合规人员复核。", content: [{ heading: "可用于", body: "理解行为、语言、障碍与机会。" }, { heading: "不可用于", body: "推断总体比例或替代临床证据。" }] }
  ];
  return {
    title: "功能导览 · 脱敏示例洞察报告",
    subtitle: "两个患者场景的证据驱动策略综合",
    executive_summary: "本示例演示 MedVoice 如何保留场景边界，将访谈原话、逐题矩阵、跨场景洞察与策略优先级连接为可复核的研究交付。",
    cross_scenario_insights: crossInsights,
    strategic_priorities: priorities,
    caveats: ["所有人物、文件名和引文均为脱敏演示内容。", "定性研究用于形成和解释策略假设，不用于推断总体比例。", "AI 草案必须由研究、医学与合规人员复核。"],
    slides
  };
}

export function createPreviewWorkspace() {
  const interviews = patientNames.map((_, index) => makeInterview(index));
  const guides = guideDefinitions.map((definition) => makeGuide(definition, interviews));
  return {
    project: { id: "preview-study", name: "功能导览 · 脱敏示例研究" },
    interviews,
    guides,
    reportWorkspace: {
      deckScript: makeDeckScript(guides),
      instructions: "功能导览使用脱敏示例数据，展示证据驱动的研究洞察与商业 Deck 工作流。",
      supplementalFiles: [],
      slideIndex: 0,
      generatedAt: 1_722_000_000_000,
      sourceFingerprint: "",
      sourceSummary: { demo: true },
      engine: { mode: "preview" }
    }
  };
}
