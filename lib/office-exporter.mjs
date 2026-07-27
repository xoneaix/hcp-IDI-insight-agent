import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType
} from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";

const GREEN = "245C4D";
const GREEN_HEX = "#245C4D";
const LIME_HEX = "#DFF25B";
const TEAL = "279A83";
const BLUE_GREEN = "3C8FA0";
const AMBER = "C78B32";
const INK = "16201E";
const MUTED = "6D7773";
const LIGHT = "F2F4F3";
const MEIMAN_DECK_TITLE = "玫满院外深访：从首购到复购，患者如何决定“该吃药了”";

function safeText(value, limit = 10_000) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, limit);
}

function truncate(value, limit) {
  const text = safeText(value, limit + 1);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function preferredInsightDeckTitle(projectName, fallback = "") {
  return String(projectName || "").includes("玫满")
    ? MEIMAN_DECK_TITLE
    : safeText(fallback || projectName || "研究洞察报告");
}

export async function buildMatrixWorkbook(payload) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MedVoice Insight";
  workbook.created = new Date();
  const matrixSheet = workbook.addWorksheet("逐题分析矩阵", { views: [{ state: "frozen", xSplit: 3, ySplit: 3, showGridLines: false }] });
  const questionSheet = workbook.addWorksheet("问题清单", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  const evidenceSheet = workbook.addWorksheet("证据索引", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  const questions = (payload.questions || []).map((q, i) => safeText(q.question || q, 500) || `问题 ${i + 1}`);
  const rows = payload.matrix || [];
  const lastColumn = Math.max(3, questions.length + 3);
  matrixSheet.mergeCells(1, 1, 1, lastColumn);
  matrixSheet.getCell(1, 1).value = `${safeText(payload.projectName || "HCP 深度访谈")}｜大纲逐题分析矩阵`;
  matrixSheet.getCell(1, 1).fill = solidFill(GREEN);
  matrixSheet.getCell(1, 1).font = { bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
  matrixSheet.getCell(1, 1).alignment = { vertical: "middle" };
  matrixSheet.mergeCells(2, 1, 2, lastColumn);
  matrixSheet.getCell(2, 1).value = `样本数：${rows.length}｜大纲问题数：${questions.length}｜生成时间：${new Date().toISOString().slice(0, 10)}`;
  matrixSheet.getCell(2, 1).fill = solidFill("EAF1ED");
  matrixSheet.getCell(2, 1).font = { color: { argb: `FF${GREEN}` }, size: 10 };
  const headers = ["HCP编号", "受访者/文件", "类型", ...questions.map((q, i) => `Q${i + 1} ${q}`)];
  matrixSheet.addRow(headers);
  styleHeader(matrixSheet.getRow(3), "DCE8E2", "173C32");
  const values = rows.map((row) => [
    safeText(row.document_id || row.id, 100),
    safeText(row.name, 200),
    safeText(row.type || "HCP", 50),
    ...questions.map((_, i) => safeText(row.answers?.[i]?.answer || row.answers?.[i] || "未覆盖", 1500))
  ]);
  values.forEach((value) => matrixSheet.addRow(value));
  for (let rowIndex = 4; rowIndex <= matrixSheet.rowCount; rowIndex += 1) styleBody(matrixSheet.getRow(rowIndex));
  matrixSheet.columns.forEach((column, index) => { column.width = index === 0 ? 13 : index === 1 ? 28 : index === 2 ? 11 : 34; });
  matrixSheet.getRow(1).height = 32;
  matrixSheet.getRow(2).height = 24;
  matrixSheet.getRow(3).height = 58;
  matrixSheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: headers.length } };

  questionSheet.addRow(["编号", "访谈大纲问题", "分析状态"]);
  styleHeader(questionSheet.getRow(1), GREEN, "FFFFFF");
  const questionRows = questions.map((q, i) => [`Q${i + 1}`, q, "已纳入分析"]);
  questionRows.forEach((row) => questionSheet.addRow(row));
  questionSheet.columns = [{ width: 10 }, { width: 70 }, { width: 16 }];
  questionSheet.eachRow((row) => { row.alignment = { wrapText: true, vertical: "top" }; });

  evidenceSheet.addRow(["洞察", "样本编号", "原话证据", "置信度", "人工复核"]);
  styleHeader(evidenceSheet.getRow(1), GREEN, "FFFFFF");
  const evidenceRows = [];
  for (const insight of payload.report?.top_insights || []) {
    for (const evidence of insight.evidence || []) {
      evidenceRows.push([safeText(insight.title, 500), safeText(evidence.document_id, 100), safeText(evidence.quote, 1500), Number(insight.confidence || 0) / 100, "待复核"]);
    }
  }
  evidenceRows.forEach((row) => evidenceSheet.addRow(row));
  evidenceSheet.columns = [{ width: 34 }, { width: 14 }, { width: 70 }, { width: 14 }, { width: 14 }];
  evidenceSheet.eachRow((row, index) => {
    row.alignment = { wrapText: true, vertical: "top" };
    if (index > 1) row.getCell(4).numFmt = "0%";
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function solidFill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb: `FF${String(argb).replace(/^#/, "")}` } };
}

function styleHeader(row, fill, color) {
  row.eachCell((cell) => {
    cell.fill = solidFill(fill);
    cell.font = { bold: true, color: { argb: `FF${color}` } };
    cell.alignment = { wrapText: true, vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFC7D5CE" } } };
  });
}

function styleBody(row) {
  row.eachCell((cell) => {
    cell.alignment = { wrapText: true, vertical: "top" };
    cell.border = { bottom: { style: "hair", color: { argb: "FFE1E7E4" } } };
  });
}

function docParagraph(text, options = {}) {
  return new Paragraph({
    text: safeText(text),
    heading: options.heading,
    spacing: { before: options.before ?? 0, after: options.after ?? 120, line: options.line ?? 276 },
    alignment: options.alignment,
    pageBreakBefore: options.pageBreakBefore
  });
}

function bullet(text) {
  return new Paragraph({
    children: [new TextRun({ text: safeText(text), color: INK, size: 22 })],
    numbering: { reference: "medvoice-bullets", level: 0 },
    spacing: { after: 120, line: 280 }
  });
}

function reportTable(rows) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    rows: rows.map((row, rowIndex) => new TableRow({
      children: row.map((value, colIndex) => new TableCell({
        width: { size: colIndex === 0 ? 2100 : 7260, type: WidthType.DXA },
        shading: rowIndex === 0 ? { fill: LIGHT, type: ShadingType.CLEAR } : undefined,
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
        borders: {
          top: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 },
          bottom: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 },
          left: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 },
          right: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 }
        },
        children: [new Paragraph({ children: [new TextRun({ text: safeText(value), bold: rowIndex === 0 || colIndex === 0, color: INK, size: 20 })], spacing: { after: 0 } })]
      }))
    }))
  });
}

export async function buildInsightDocx(payload) {
  const report = payload.report || {};
  const children = [
    new Paragraph({ children: [new TextRun({ text: "QUALITATIVE INSIGHT REPORT", bold: true, color: GREEN, size: 20, characterSpacing: 120 })], spacing: { before: 1400, after: 260 }, alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: safeText(payload.projectName || "HCP 深度访谈洞察报告"), bold: true, color: INK, size: 52 })], spacing: { after: 180 }, alignment: AlignmentType.CENTER }),
    new Paragraph({ children: [new TextRun({ text: "大纲驱动的多访谈证据综合", color: MUTED, size: 28 })], spacing: { after: 700 }, alignment: AlignmentType.CENTER }),
    reportTable([["项目", safeText(payload.projectName || "未命名项目")], ["样本", `${payload.matrix?.length || 0} 位 HCP / 受访者`], ["大纲", `${payload.questions?.length || 0} 个主要问题`], ["状态", "AI 生成草案，待研究负责人复核"]]),
    new Paragraph({ children: [new PageBreak()] }),
    docParagraph("执行摘要", { heading: HeadingLevel.HEADING_1, after: 180 }),
    docParagraph(report.executive_summary || "分析完成后将在此生成执行摘要。", { after: 220 }),
    docParagraph("研究范围", { heading: HeadingLevel.HEADING_2, after: 120 }),
    docParagraph(report.sample_overview || `基于 ${payload.matrix?.length || 0} 份访谈进行大纲逐题分析。`),
    docParagraph("核心洞察", { heading: HeadingLevel.HEADING_1, after: 180 })
  ];
  (report.top_insights || []).forEach((insight, index) => {
    children.push(docParagraph(`${index + 1}. ${insight.title}`, { heading: HeadingLevel.HEADING_2, after: 90 }));
    children.push(docParagraph(insight.insight, { after: 100 }));
    children.push(new Paragraph({ children: [new TextRun({ text: "策略影响：", bold: true, color: GREEN, size: 22 }), new TextRun({ text: safeText(insight.implication), color: INK, size: 22 })], spacing: { after: 100, line: 276 } }));
    const evidence = insight.evidence?.[0];
    if (evidence) children.push(new Paragraph({ children: [new TextRun({ text: `“${safeText(evidence.quote, 1200)}”`, italics: true, color: MUTED, size: 20 }), new TextRun({ text: `  — ${safeText(evidence.document_id, 100)}`, bold: true, color: GREEN, size: 18 })], shading: { fill: "EEF4F1", type: ShadingType.CLEAR }, spacing: { before: 80, after: 160, line: 276 }, indent: { left: 240, right: 240 } }));
  });
  children.push(docParagraph("未满足需求", { heading: HeadingLevel.HEADING_1 }));
  (report.unmet_needs || []).forEach((item) => children.push(bullet(item)));
  children.push(docParagraph("建议的下一步行动", { heading: HeadingLevel.HEADING_1 }));
  (report.strategic_actions || []).forEach((item) => children.push(bullet(item)));
  children.push(docParagraph("研究边界与人工复核", { heading: HeadingLevel.HEADING_1 }));
  (report.caveats || ["定性样本覆盖不等同于总体发生率。", "所有 AI 结论均需医学、研究与合规人员复核。"] ).forEach((item) => children.push(bullet(item)));

  const document = new Document({
    creator: "MedVoice Insight",
    title: safeText(payload.projectName || "HCP 深度访谈洞察报告"),
    description: "大纲驱动的 HCP 深度访谈洞察报告",
    numbering: { config: [{ reference: "medvoice-bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    styles: {
      default: { document: { run: { font: "Calibri", size: 22, color: INK }, paragraph: { spacing: { after: 120, line: 276 } } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 32, bold: true, color: GREEN }, paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 26, bold: true, color: GREEN }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } }
      ]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "MedVoice Insight · Confidential  |  ", color: MUTED, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: MUTED, size: 16 })] })] }) },
      children
    }]
  });
  return Buffer.from(await Packer.toBuffer(document));
}

function roleMetadataTable(rows) {
  const widths = [1701, 7659];
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    indent: { size: 120, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: rows.map(([label, value]) => new TableRow({
      children: [label, value].map((text, index) => new TableCell({
        width: { size: widths[index], type: WidthType.DXA },
        shading: index === 0 ? { fill: "E8EEF5", type: ShadingType.CLEAR } : undefined,
        margins: { top: 100, bottom: 100, left: 120, right: 120 },
        borders: {
          top: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 },
          bottom: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 },
          left: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 },
          right: { style: BorderStyle.SINGLE, color: "D9E1DD", size: 4 }
        },
        children: [new Paragraph({
          children: [new TextRun({ text: safeText(text, 1000), bold: index === 0, color: index === 0 ? GREEN : INK, font: "Calibri", size: 20 })],
          spacing: { before: 0, after: 0, line: 300 }
        })]
      }))
    }))
  });
}

function qaLabel(text, color = GREEN) {
  return new Paragraph({
    children: [new TextRun({ text: safeText(text, 300), bold: true, color, font: "Calibri", size: 18, characterSpacing: 40 })],
    spacing: { before: 120, after: 60, line: 300 },
    keepNext: true
  });
}

function qaBody(text, answer = false) {
  return new Paragraph({
    children: [new TextRun({ text: safeText(text || "（本段未识别到完整内容）", 12_000), color: INK, font: "Calibri", size: 22 })],
    spacing: { before: 0, after: answer ? 180 : 100, line: 300 },
    indent: answer ? { left: 220, right: 140 } : undefined,
    shading: answer ? { fill: "F2F4F3", type: ShadingType.CLEAR } : undefined
  });
}

function roleHeader() {
  return new Header({ children: [new Paragraph({ children: [new TextRun({ text: "MedVoice Insight｜Role-labeled Transcript", color: MUTED, font: "Calibri", size: 16 })], spacing: { after: 0 } })] });
}

function roleFooter() {
  return new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Confidential · 人工复核后使用  |  ", color: MUTED, font: "Calibri", size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: MUTED, font: "Calibri", size: 16 })] })] });
}

export async function buildRoleTranscriptDocx(payload) {
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const children = [
    new Paragraph({ children: [new TextRun({ text: "SEMANTIC ROLE-LABELED TRANSCRIPT", bold: true, color: GREEN, font: "Calibri", size: 20, characterSpacing: 100 })], spacing: { before: 260, after: 120 } }),
    new Paragraph({ children: [new TextRun({ text: "访谈角色区分逐字稿", bold: true, color: INK, font: "Calibri", size: 46 })], spacing: { before: 0, after: 100 } }),
    new Paragraph({ children: [new TextRun({ text: safeText(payload.projectName || "未命名访谈项目"), color: MUTED, font: "Calibri", size: 26 })], spacing: { after: 280 } }),
    roleMetadataTable([
      ["访谈数量", `${documents.length} 份`],
      ["处理方法", "本地逐行结构化 + AI 语义角色复核 + 本地问答配对"],
      ["内容原则", "保留转录原话；低置信度、缺问或缺答条目需人工复核"],
      ["文档状态", "AI 辅助生成草案，不替代研究负责人判断"]
    ]),
    new Paragraph({ children: [new PageBreak()] })
  ];

  documents.forEach((document, documentIndex) => {
    if (documentIndex > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({ text: `${document.document_id || `INT-${documentIndex + 1}`}｜${safeText(document.name || "访谈逐字稿", 180)}`, heading: HeadingLevel.HEADING_1 }));
    children.push(roleMetadataTable([
      ["受访者类型", safeText(document.respondent_label || document.type || "受访者")],
      ["问答组数", `${document.exchanges?.length || 0} 组`],
      ["平均置信度", `${Number(document.average_confidence || 0)}%`],
      ["待复核项目", `${Number(document.review_count || 0)} 项`]
    ]));
    children.push(new Paragraph({ text: "一问一答逐字稿", heading: HeadingLevel.HEADING_2 }));
    (document.exchanges || []).forEach((exchange, index) => {
      const questionTime = exchange.question_timestamp ? ` · ${safeText(exchange.question_timestamp, 30)}` : "";
      const answerTime = exchange.answer_timestamp ? ` · ${safeText(exchange.answer_timestamp, 30)}` : "";
      const review = exchange.needs_review ? " · 待复核" : "";
      children.push(qaLabel(`Q${String(index + 1).padStart(2, "0")}｜访谈员${questionTime}${review}`));
      children.push(qaBody(exchange.question));
      children.push(qaLabel(`A｜${safeText(document.respondent_label || document.type || "受访者", 80)}${answerTime} · 置信度 ${Number(exchange.confidence || 0)}%`, "2E74B5"));
      children.push(qaBody(exchange.answer, true));
    });
    if (document.unpaired?.length) {
      children.push(new Paragraph({ text: "待人工确认的未配对发言", heading: HeadingLevel.HEADING_2 }));
      document.unpaired.forEach((turn) => {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `${safeText(turn.display_role || "待确认", 40)}${turn.timestamp ? ` · ${safeText(turn.timestamp, 30)}` : ""}：`, bold: true, color: "7A5A00", font: "Calibri", size: 20 }),
            new TextRun({ text: safeText(turn.text, 4000), color: INK, font: "Calibri", size: 20 })
          ],
          spacing: { before: 0, after: 120, line: 300 }
        }));
      });
    }
  });

  const document = new Document({
    creator: "MedVoice Insight",
    title: safeText(`${payload.projectName || "访谈项目"}｜角色区分逐字稿`),
    description: "通过语义角色识别生成的一问一答访谈逐字稿",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22, color: INK }, paragraph: { spacing: { before: 0, after: 120, line: 300 } } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 32, bold: true, color: "2E74B5" }, paragraph: { spacing: { before: 360, after: 200, line: 300 }, outlineLevel: 0, keepNext: true } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 26, bold: true, color: "2E74B5" }, paragraph: { spacing: { before: 280, after: 140, line: 300 }, outlineLevel: 1, keepNext: true } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 24, bold: true, color: "1F4D78" }, paragraph: { spacing: { before: 200, after: 100, line: 300 }, outlineLevel: 2, keepNext: true } }
      ]
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 } } },
      headers: { default: roleHeader(), even: roleHeader(), first: roleHeader() },
      footers: { default: roleFooter(), even: roleFooter(), first: roleFooter() },
      children
    }]
  });
  return Buffer.from(await Packer.toBuffer(document));
}

function addText(slide, text, position, style = {}) {
  const options = {
    ...position,
    fontFace: "Aptos",
    fontSize: style.fontSize || 20,
    bold: Boolean(style.bold),
    color: String(style.color || INK).replace(/^#/, ""),
    align: style.alignment || "left",
    valign: style.verticalAlignment || "top",
    margin: style.margin ?? 0,
    breakLine: false,
    fit: style.fit || "shrink"
  };
  if (style.fit === false) delete options.fit;
  slide.addText(truncate(text, style.limit || 700), options);
}

function addFooter(slide, page) {
  addText(slide, "MEDVOICE INSIGHT · HUMAN REVIEW REQUIRED", { x: 0.62, y: 7.12, w: 6.4, h: 0.18 }, { fontSize: 8, color: MUTED });
  addText(slide, String(page).padStart(2, "0"), { x: 12.15, y: 7.08, w: 0.45, h: 0.2 }, { fontSize: 9, color: MUTED, alignment: "right" });
}

function deckScriptNotes(item = {}) {
  const sources = (item.evidence || []).map((evidence) => `${safeText(evidence.document_id, 80)}：${safeText(evidence.quote, 800)}`);
  const visual = item.visual_blueprint || {};
  return [
    `[Purpose]\n${safeText(item.purpose || item.takeaway || "本页服务于整体研究叙事", 800)}`,
    `[Audience question]\n${safeText(item.audience_question || "这页希望受众理解并决定什么？", 800)}`,
    `[Narrative]\n${safeText(item.narrative || item.takeaway || "", 1800)}`,
    `[Framework]\n${safeText(item.framework || "定性证据综合", 600)}`,
    `[Method]\n${safeText(item.method || "基于访谈证据的定性综合", 600)}`,
    `[Evidence logic]\n${safeText(item.evidence_logic || "基于输入样本与逐字证据，需人工复核证据强度。", 1000)}`,
    `[Visual blueprint]\n${safeText([visual.composition, visual.primary_visual, visual.iconography, visual.emphasis, item.visual_note].filter(Boolean).join("；") || item.layout || "按页面信息层级呈现", 1200)}`,
    `[Management decisions]\n${(item.management_decisions || []).map((value) => `- ${safeText(value, 500)}`).join("\n") || "无指定决策请求"}`,
    `[Speaker note]\n${safeText(item.speaker_note || "先讲结论，再说明证据、策略含义和需要的决策。", 1200)}`,
    `[Sources]\n${sources.length ? sources.join("\n") : "本页未指定逐字引文；需研究负责人复核。"}`
  ].join("\n\n");
}

function addScriptDeckFooter(presentation, slide, page) {
  slide.addShape(presentation.ShapeType.line, { x: 0.62, y: 6.96, w: 12.06, h: 0, line: { color: "DDE7E2", width: 0.8 } });
  addText(slide, "MEDVOICE INSIGHT · EVIDENCE-LED STRATEGY", { x: 0.62, y: 7.08, w: 5.8, h: 0.16 }, { fontSize: 8, bold: true, color: "6F837B" });
  addText(slide, String(page).padStart(2, "0"), { x: 12.1, y: 7.06, w: 0.5, h: 0.18 }, { fontSize: 9, bold: true, color: GREEN, alignment: "right" });
}

function scriptBlockText(block, limit = 430) {
  const points = (block.supporting_points || []).slice(0, 4).map((point) => `• ${safeText(point, 150)}`);
  return truncate([safeText(block.body, limit), ...points].filter(Boolean).join("\n"), limit);
}

function addEvidenceStrip(presentation, slide, item, y = 5.72) {
  const evidence = item.evidence?.[0];
  const implication = item.implications?.[0];
  if (!evidence && !implication) return;
  slide.addShape(presentation.ShapeType.roundRect, { x: 0.62, y, w: 12.06, h: 0.88, rectRadius: 0.05, fill: { color: "EAF3EE" }, line: { color: "D3E4DB", width: 0.8 } });
  addText(slide, evidence ? `“${safeText(evidence.quote, 210)}”` : safeText(implication, 210), { x: 0.88, y: y + 0.16, w: 10.2, h: 0.48 }, { fontSize: 16, color: "385B4F", limit: 210 });
  addText(slide, evidence ? safeText(evidence.document_id || "证据待复核", 80) : "STRATEGIC IMPLICATION", { x: 11.05, y: y + 0.25, w: 1.34, h: 0.2 }, { fontSize: 8, bold: true, color: GREEN, alignment: "right" });
}

function deckLayoutGlyph(layout) {
  return { "执行摘要": "◫", "跨场景全景": "◎", "场景对比": "⇄", "洞察证据": "“", "证据链": "⟿", "旅程地图": "↗", "策略框架": "⌘", "机会优先级": "◇", "行动路线图": "→", "研究边界": "△" }[layout] || "•";
}

function addComparisonLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 2);
  ["EAF3EE", "F5F0E6"].forEach((color, index) => {
    const x = 0.62 + index * 6.22;
    const block = blocks[index] || {};
    slide.addShape(presentation.ShapeType.roundRect, { x, y: 2.18, w: 5.84, h: 3.2, rectRadius: 0.06, fill: { color }, line: { color: index ? "E8DCC4" : "D2E3DA", width: 0.8 } });
    addText(slide, index ? "SCENARIO B" : "SCENARIO A", { x: x + 0.28, y: 2.43, w: 1.8, h: 0.22 }, { fontSize: 9, bold: true, color: index ? "9B742E" : GREEN });
    addText(slide, block.heading || `研究场景 ${index + 1}`, { x: x + 0.28, y: 2.79, w: 5.2, h: 0.55 }, { fontSize: 22, bold: true, color: INK, limit: 80 });
    addText(slide, scriptBlockText(block, 430), { x: x + 0.28, y: 3.5, w: 5.2, h: 1.48 }, { fontSize: 16, color: "40544C", limit: 430 });
  });
  addEvidenceStrip(presentation, slide, item, 5.58);
}

function addJourneyLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 4);
  slide.addShape(presentation.ShapeType.line, { x: 1.1, y: 3.15, w: 10.9, h: 0, line: { color: "A9C3B8", width: 2 } });
  blocks.forEach((block, index) => {
    const x = 0.72 + index * 3.05;
    slide.addShape(presentation.ShapeType.ellipse, { x, y: 2.77, w: 0.76, h: 0.76, fill: { color: index === 0 ? "DFF25B" : "E4F0EA" }, line: { color: GREEN, width: 1 } });
    addText(slide, String(index + 1).padStart(2, "0"), { x, y: 3.01, w: 0.76, h: 0.2 }, { fontSize: 10, bold: true, color: GREEN, alignment: "center" });
    addText(slide, block.heading || `阶段 ${index + 1}`, { x: x - 0.08, y: 3.72, w: 2.65, h: 0.52 }, { fontSize: 18, bold: true, color: INK, limit: 55 });
    addText(slide, scriptBlockText(block, 190), { x: x - 0.08, y: 4.34, w: 2.65, h: 1.05 }, { fontSize: 16, color: "53665E", limit: 190 });
  });
  addEvidenceStrip(presentation, slide, item, 5.66);
}

function addFrameworkLayout(presentation, slide, item, roadmap = false) {
  const blocks = (item.content || []).slice(0, roadmap ? 4 : 3);
  const width = roadmap ? 2.83 : blocks.length === 2 ? 5.86 : 3.78;
  const gap = roadmap ? 0.25 : 0.36;
  blocks.forEach((block, index) => {
    const x = 0.62 + index * (width + gap);
    if (roadmap && index < blocks.length - 1) {
      slide.addShape(presentation.ShapeType.chevron, { x: x + width - 0.11, y: 3.08, w: 0.44, h: 0.62, fill: { color: "C9DCD3" }, line: { color: "C9DCD3", transparency: 100 } });
    }
    slide.addShape(presentation.ShapeType.roundRect, { x, y: 2.2, w: width, h: 3.18, rectRadius: 0.06, fill: { color: index === 0 ? "E9F3EE" : index === 1 ? "F4F6F4" : index === 2 ? "F7F2E8" : "EEF2F0" }, line: { color: "D9E5DF", width: 0.8 } });
    addText(slide, String(index + 1).padStart(2, "0"), { x: x + 0.24, y: 2.45, w: 0.45, h: 0.25 }, { fontSize: 10, bold: true, color: GREEN });
    const heading = safeText(String(block.heading || `优先级 ${index + 1}`).replace(/^优先级\s*\d+\s*[:：]\s*/u, ""), roadmap ? 44 : 34);
    const body = roadmap ? scriptBlockText(block, 170) : safeText(block.body || block.supporting_points?.[0] || "", 118);
    addText(slide, heading, { x: x + 0.24, y: 2.82, w: width - 0.48, h: 0.62 }, { fontSize: roadmap ? 17 : 20, bold: true, color: INK, limit: roadmap ? 44 : 34 });
    addText(slide, body, { x: x + 0.24, y: 3.55, w: width - 0.48, h: 1.18 }, { fontSize: 16, color: "4C6158", limit: roadmap ? 170 : 118 });
  });
  addEvidenceStrip(presentation, slide, item, 5.62);
}

function addEvidenceLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 3);
  slide.addShape(presentation.ShapeType.roundRect, { x: 0.62, y: 2.16, w: 7.48, h: 3.86, rectRadius: 0.06, fill: { color: "FFFFFF" }, line: { color: "DCE6E1", width: 0.8 } });
  blocks.forEach((block, index) => {
    const y = 2.48 + index * 1.08;
    addText(slide, block.heading || `证据 ${index + 1}`, { x: 0.94, y, w: 2.15, h: 0.3 }, { fontSize: 16, bold: true, color: GREEN, limit: 70 });
    addText(slide, scriptBlockText(block, 210), { x: 3.18, y, w: 4.45, h: 0.74 }, { fontSize: 16, color: "475B53", limit: 210 });
    if (index < blocks.length - 1) slide.addShape(presentation.ShapeType.line, { x: 0.94, y: y + 0.86, w: 6.68, h: 0, line: { color: "E5ECE8", width: 0.8 } });
  });
  const evidence = item.evidence?.[0];
  slide.addShape(presentation.ShapeType.roundRect, { x: 8.38, y: 2.16, w: 4.3, h: 3.86, rectRadius: 0.06, fill: { color: GREEN }, line: { color: GREEN, transparency: 100 } });
  addText(slide, "VERBATIM EVIDENCE", { x: 8.75, y: 2.58, w: 2.7, h: 0.22 }, { fontSize: 9, bold: true, color: "DFF25B" });
  addText(slide, evidence ? `“${safeText(evidence.quote, 420)}”` : "本页证据需由研究负责人复核后补充。", { x: 8.75, y: 3.15, w: 3.5, h: 1.72 }, { fontSize: 18, color: "FFFFFF", limit: 420 });
  addText(slide, evidence?.document_id || "证据待复核", { x: 8.75, y: 5.28, w: 3.5, h: 0.25 }, { fontSize: 10, bold: true, color: "C7DDD4" });
}

function addPanoramaLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 3);
  const accents = [GREEN, TEAL, AMBER];
  blocks.forEach((block, index) => {
    const x = 0.62 + index * 4.04;
    slide.addShape(presentation.ShapeType.rect, { x, y: 2.15, w: 3.86, h: 3.45, fill: { color: index === 0 ? "EAF3EE" : index === 1 ? "E9F4F3" : "FBF3E6" }, line: { color: "FFFFFF", transparency: 100 } });
    slide.addShape(presentation.ShapeType.rect, { x, y: 2.15, w: 3.86, h: 0.12, fill: { color: accents[index] }, line: { color: accents[index], transparency: 100 } });
    addText(slide, ["01 / 共性", "02 / 差异", "03 / 机会"][index], { x: x + 0.28, y: 2.48, w: 1.4, h: 0.24 }, { fontSize: 10, bold: true, color: accents[index] });
    addText(slide, block.heading || ["跨场景共性", "场景关键差异", "策略机会"][index], { x: x + 0.28, y: 2.9, w: 3.25, h: 0.62 }, { fontSize: 24, bold: true, color: INK, limit: 62 });
    addText(slide, scriptBlockText(block, 280), { x: x + 0.28, y: 3.72, w: 3.25, h: 1.48 }, { fontSize: 16, color: "465B53", limit: 280 });
  });
  addEvidenceStrip(presentation, slide, item, 5.78);
}

function addEvidenceChainLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 4);
  const labels = ["原话证据", "行为解释", "跨场景洞察", "策略行动"];
  const colors = ["E7F3ED", "E8F3F4", "F5F0E7", "E4EDE9"];
  blocks.forEach((block, index) => {
    const x = 0.62 + index * 3.05;
    if (index < blocks.length - 1) {
      slide.addShape(presentation.ShapeType.chevron, { x: x + 2.72, y: 3.26, w: 0.45, h: 0.72, fill: { color: index === 1 ? AMBER : TEAL }, line: { color: "FFFFFF", transparency: 100 } });
    }
    slide.addShape(presentation.ShapeType.roundRect, { x, y: 2.25, w: 2.76, h: 3.18, rectRadius: 0.05, fill: { color: colors[index] }, line: { color: "D4E1DB", width: 0.7 } });
    addText(slide, String(index + 1).padStart(2, "0"), { x: x + 0.22, y: 2.51, w: 0.42, h: 0.24 }, { fontSize: 10, bold: true, color: index === 2 ? AMBER : GREEN });
    addText(slide, labels[index], { x: x + 0.68, y: 2.49, w: 1.72, h: 0.27 }, { fontSize: 10, bold: true, color: "61756D" });
    addText(slide, block.heading || labels[index], { x: x + 0.22, y: 2.97, w: 2.28, h: 0.66 }, { fontSize: 20, bold: true, color: INK, limit: 56 });
    addText(slide, scriptBlockText(block, 190), { x: x + 0.22, y: 3.78, w: 2.28, h: 1.18 }, { fontSize: 16, color: "4C6158", limit: 190 });
  });
  addEvidenceStrip(presentation, slide, item, 5.72);
}

function addPriorityLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 4);
  if (blocks.length === 3) {
    blocks.push({
      heading: safeText(item.management_decisions?.[0] || "建立行动验证闭环", 28),
      body: "明确责任团队、适用场景、验证指标与复盘周期。"
    });
  }
  slide.addShape(presentation.ShapeType.line, { x: 1.34, y: 5.55, w: 10.42, h: 0, line: { color: "78998C", width: 1.4, endArrowType: "triangle" } });
  slide.addShape(presentation.ShapeType.line, { x: 1.34, y: 5.55, w: 0, h: -3.25, line: { color: "78998C", width: 1.4, endArrowType: "triangle" } });
  addText(slide, "证据确定性", { x: 10.3, y: 5.68, w: 1.42, h: 0.28 }, { fontSize: 10, bold: true, color: "61786F", alignment: "right" });
  addText(slide, "策略价值", { x: 0.64, y: 2.18, w: 0.5, h: 0.76 }, { fontSize: 10, bold: true, color: "61786F" });
  slide.addShape(presentation.ShapeType.line, { x: 6.55, y: 2.54, w: 0, h: 2.77, line: { color: "D6E1DC", width: 0.8, dash: "dash" } });
  slide.addShape(presentation.ShapeType.line, { x: 1.58, y: 4.02, w: 9.95, h: 0, line: { color: "D6E1DC", width: 0.8, dash: "dash" } });
  const positions = [
    { x: 7.15, y: 2.72, color: GREEN, label: "优先启动" },
    { x: 3.1, y: 2.78, color: TEAL, label: "定向验证" },
    { x: 7.42, y: 4.22, color: AMBER, label: "谨慎放大" },
    { x: 3.18, y: 4.34, color: "82958D", label: "持续观察" }
  ];
  blocks.forEach((block, index) => {
    const pos = positions[index];
    slide.addShape(presentation.ShapeType.roundRect, { x: pos.x, y: pos.y, w: 2.8, h: 1.05, rectRadius: 0.05, fill: { color: pos.color, transparency: index === 3 ? 8 : 0 }, line: { color: "FFFFFF", transparency: 100 } });
    addText(slide, pos.label, { x: pos.x + 0.18, y: pos.y + 0.14, w: 0.92, h: 0.22 }, { fontSize: 9, bold: true, color: "FFFFFF" });
    const heading = safeText(String(block.heading || `机会 ${index + 1}`).replace(/^优先级\s*\d+\s*[:：]\s*/u, ""), 26);
    addText(slide, heading, { x: pos.x + 0.18, y: pos.y + 0.43, w: 2.38, h: 0.48 }, { fontSize: 16, bold: true, color: "FFFFFF", limit: 26, fit: false });
  });
  addEvidenceStrip(presentation, slide, item, 5.98);
}

function addExecutiveLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 3);
  slide.addShape(presentation.ShapeType.rect, { x: 0.62, y: 2.14, w: 12.06, h: 0.72, fill: { color: GREEN }, line: { color: GREEN, transparency: 100 } });
  addText(slide, safeText(item.narrative || item.takeaway, 180), { x: 0.9, y: 2.33, w: 11.45, h: 0.34 }, { fontSize: 18, bold: true, color: "FFFFFF", limit: 180 });
  const accents = [TEAL, BLUE_GREEN, AMBER];
  blocks.forEach((block, index) => {
    const x = 0.62 + index * 4.12;
    addText(slide, String(index + 1).padStart(2, "0"), { x, y: 3.22, w: 0.58, h: 0.38 }, { fontSize: 17, bold: true, color: accents[index] });
    slide.addShape(presentation.ShapeType.line, { x, y: 3.73, w: 3.75, h: 0, line: { color: accents[index], width: 2.5 } });
    addText(slide, block.heading || `核心结论 ${index + 1}`, { x, y: 3.98, w: 3.62, h: 0.7 }, { fontSize: 22, bold: true, color: INK, limit: 62 });
    addText(slide, scriptBlockText(block, 230), { x, y: 4.78, w: 3.62, h: 1.02 }, { fontSize: 16, color: "4C6158", limit: 230 });
  });
  addEvidenceStrip(presentation, slide, item, 5.92);
}

function addBoundaryLayout(presentation, slide, item) {
  const blocks = (item.content || []).slice(0, 4);
  const left = blocks.filter((_, index) => index % 2 === 0);
  const right = blocks.filter((_, index) => index % 2 === 1);
  [
    { x: 0.62, title: "本研究可以支持", color: GREEN, fill: "E9F3EE", blocks: left },
    { x: 6.82, title: "本研究不能替代", color: AMBER, fill: "FBF3E6", blocks: right }
  ].forEach((column) => {
    slide.addShape(presentation.ShapeType.rect, { x: column.x, y: 2.2, w: 5.86, h: 0.65, fill: { color: column.color }, line: { color: column.color, transparency: 100 } });
    addText(slide, column.title, { x: column.x + 0.27, y: 2.39, w: 3.2, h: 0.26 }, { fontSize: 18, bold: true, color: "FFFFFF" });
    slide.addShape(presentation.ShapeType.rect, { x: column.x, y: 2.85, w: 5.86, h: 3.25, fill: { color: column.fill }, line: { color: "FFFFFF", transparency: 100 } });
    column.blocks.forEach((block, index) => {
      const y = 3.22 + index * 1.31;
      addText(slide, index === 0 ? "✓" : "•", { x: column.x + 0.28, y, w: 0.38, h: 0.32 }, { fontSize: 18, bold: true, color: column.color, alignment: "center" });
      addText(slide, block.heading || "研究边界", { x: column.x + 0.78, y, w: 4.62, h: 0.36 }, { fontSize: 18, bold: true, color: INK, limit: 58 });
      addText(slide, scriptBlockText(block, 180), { x: column.x + 0.78, y: y + 0.43, w: 4.62, h: 0.62 }, { fontSize: 16, color: "51655D", limit: 180 });
    });
  });
}

function addScriptContentBlocks(presentation, slide, item) {
  if (item.layout === "执行摘要") return addExecutiveLayout(presentation, slide, item);
  if (item.layout === "跨场景全景") return addPanoramaLayout(presentation, slide, item);
  if (item.layout === "场景对比") return addComparisonLayout(presentation, slide, item);
  if (item.layout === "证据链") return addEvidenceChainLayout(presentation, slide, item);
  if (item.layout === "旅程地图") return addJourneyLayout(presentation, slide, item);
  if (item.layout === "策略框架") return addFrameworkLayout(presentation, slide, item);
  if (item.layout === "机会优先级") return addPriorityLayout(presentation, slide, item);
  if (item.layout === "行动路线图") return addFrameworkLayout(presentation, slide, item, true);
  if (item.layout === "洞察证据") return addEvidenceLayout(presentation, slide, item);
  if (item.layout === "研究边界") return addBoundaryLayout(presentation, slide, item);
  const blocks = (item.content || []).slice(0, 3);
  return addFrameworkLayout(presentation, slide, { ...item, content: blocks });
}

async function buildDeckScriptPresentation(payload) {
  const script = payload.deckScript || {};
  const slides = Array.isArray(script.slides) ? script.slides : [];
  const deckTitle = preferredInsightDeckTitle(payload.projectName, script.title);
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "MedVoice Insight";
  presentation.subject = "跨访谈场景的证据驱动市场策略";
  presentation.title = deckTitle;
  presentation.company = "MedVoice Insight";
  presentation.lang = "zh-CN";
  presentation.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "zh-CN" };
  presentation.defineSlideMaster({
    title: "MEDVOICE_LIGHT",
    background: { color: "F7F9F7" },
    objects: [
      { rect: { x: 0, y: 0, w: 0.12, h: 7.5, fill: { color: GREEN }, line: { color: GREEN, transparency: 100 } } }
    ]
  });

  slides.forEach((item, index) => {
    const cover = index === 0 || item.layout === "封面";
    const slide = cover ? presentation.addSlide() : presentation.addSlide("MEDVOICE_LIGHT");
    slide.addNotes(deckScriptNotes(item));
    if (cover) {
      slide.background = { color: GREEN };
      slide.addShape(presentation.ShapeType.roundRect, { x: 0.72, y: 0.62, w: 0.74, h: 0.74, rectRadius: 0.08, fill: { color: "DFF25B" }, line: { color: "DFF25B", transparency: 100 } });
      addText(slide, "✦", { x: 0.72, y: 0.73, w: 0.74, h: 0.34 }, { fontSize: 20, bold: true, color: GREEN, alignment: "center" });
      addText(slide, "MEDVOICE · QUALITATIVE INSIGHT", { x: 1.72, y: 0.78, w: 5.4, h: 0.3 }, { fontSize: 12, bold: true, color: "DFF25B" });
      addText(slide, deckTitle, { x: 0.72, y: 2.05, w: 11.2, h: 1.54 }, { fontSize: 50, bold: true, color: "FFFFFF", limit: 76 });
      addText(slide, item.takeaway || script.subtitle || "", { x: 0.76, y: 4.03, w: 9.8, h: 1.0 }, { fontSize: 24, color: "D7E6DF", limit: 150 });
      addText(slide, `${(payload.guides || []).length || 1} 个研究场景 · ${safeText(script.audience || "市场部 / 洞察团队", 80)}`, { x: 0.76, y: 6.34, w: 8.2, h: 0.38 }, { fontSize: 16, color: "FFFFFF" });
      addText(slide, String(index + 1).padStart(2, "0"), { x: 11.95, y: 6.92, w: 0.62, h: 0.22 }, { fontSize: 10, bold: true, color: "DFF25B", alignment: "right" });
      return;
    }
    addText(slide, String(index + 1).padStart(2, "0"), { x: 0.62, y: 0.43, w: 0.48, h: 0.28 }, { fontSize: 11, bold: true, color: GREEN });
    addText(slide, safeText(item.layout || "策略洞察", 30).toUpperCase(), { x: 1.18, y: 0.44, w: 3.5, h: 0.27 }, { fontSize: 10, bold: true, color: "799087" });
    slide.addShape(presentation.ShapeType.roundRect, { x: 12.04, y: 0.38, w: 0.56, h: 0.56, rectRadius: 0.08, fill: { color: "E5F0EA" }, line: { color: "D3E3DB", width: 0.7 } });
    addText(slide, deckLayoutGlyph(item.layout), { x: 12.04, y: 0.54, w: 0.56, h: 0.2 }, { fontSize: 12, bold: true, color: GREEN, alignment: "center" });
    const slideTitle = safeText(item.title || "洞察页面", 82);
    const longTitle = slideTitle.length > 24;
    addText(slide, slideTitle, { x: 0.62, y: 0.82, w: 11.25, h: longTitle ? 1.12 : 0.68 }, { fontSize: 35, bold: true, color: INK, limit: 82 });
    if (!longTitle) addText(slide, item.takeaway || "", { x: 0.62, y: 1.55, w: 11.9, h: 0.42 }, { fontSize: 18, color: "4E665D", limit: 150 });
    addScriptContentBlocks(presentation, slide, item);
    addScriptDeckFooter(presentation, slide, index + 1);
  });
  return Buffer.from(await presentation.write({ outputType: "nodebuffer" }));
}

export async function buildInsightDeck(payload) {
  if (payload.deckScript?.slides?.length) return buildDeckScriptPresentation(payload);
  const report = payload.report || {};
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "MedVoice Insight";
  presentation.subject = "大纲驱动的多访谈证据综合";
  presentation.title = safeText(payload.projectName || "HCP 深度访谈洞察报告");
  presentation.company = "MedVoice Insight";
  presentation.lang = "zh-CN";
  presentation.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "zh-CN" };
  let page = 1;
  const cover = presentation.addSlide();
  cover.background = { color: "FFFFFF" };
  cover.addShape(presentation.ShapeType.rect, { x: 0, y: 0, w: 0.26, h: 7.5, fill: { color: GREEN }, line: { color: GREEN, transparency: 100 } });
  addText(cover, "QUALITATIVE INSIGHT REPORT", { x: 0.72, y: 0.78, w: 6.2, h: 0.34 }, { fontSize: 12, bold: true, color: GREEN });
  addText(cover, payload.projectName || "HCP 深度访谈洞察报告", { x: 0.72, y: 1.7, w: 10.2, h: 1.8 }, { fontSize: 34, bold: true, color: "000000", limit: 90 });
  addText(cover, "大纲驱动的多访谈证据综合", { x: 0.72, y: 3.72, w: 7.2, h: 0.6 }, { fontSize: 18, color: "555555" });
  addText(cover, `${payload.matrix?.length || 0} 份访谈  ·  ${payload.questions?.length || 0} 个研究问题`, { x: 0.72, y: 5.52, w: 6.8, h: 0.44 }, { fontSize: 15, color: GREEN });
  addFooter(cover, page++);

  const summary = presentation.addSlide();
  summary.background = { color: "FFFFFF" };
  addText(summary, "研究结论必须同时回答“发现了什么”与“为什么重要”", { x: 0.58, y: 0.44, w: 11.1, h: 0.86 }, { fontSize: 26, bold: true, color: "000000", limit: 80 });
  summary.addShape(presentation.ShapeType.roundRect, { x: 0.58, y: 1.64, w: 7.7, h: 4.3, rectRadius: 0.08, fill: { color: "EDEDED" }, line: { color: "EDEDED", transparency: 100 } });
  addText(summary, report.executive_summary || "分析完成后生成执行摘要。", { x: 0.92, y: 2.05, w: 7, h: 3.3 }, { fontSize: 17, color: "222222", limit: 650 });
  addText(summary, `${payload.matrix?.length || 0}`, { x: 8.95, y: 1.9, w: 2.5, h: 0.78 }, { fontSize: 36, bold: true, color: "000000" });
  addText(summary, "份访谈样本", { x: 8.95, y: 2.68, w: 2.5, h: 0.38 }, { fontSize: 13, color: "555555" });
  addText(summary, `${payload.questions?.length || 0}`, { x: 8.95, y: 3.86, w: 2.5, h: 0.78 }, { fontSize: 36, bold: true, color: "000000" });
  addText(summary, "个研究问题", { x: 8.95, y: 4.64, w: 2.5, h: 0.38 }, { fontSize: 13, color: "555555" });
  addFooter(summary, page++);

  const insights = (report.top_insights || []).slice(0, 8);
  if (insights.length) {
    const chartSlide = presentation.addSlide();
    chartSlide.background = { color: "FFFFFF" };
    addText(chartSlide, "高价值洞察由样本覆盖和证据质量共同决定", { x: 0.58, y: 0.4, w: 11.2, h: 0.8 }, { fontSize: 26, bold: true, color: "000000" });
    chartSlide.addChart(presentation.ChartType.bar, [{ name: "样本覆盖", labels: insights.slice(0, 5).map((x, i) => `洞察 ${i + 1}`), values: insights.slice(0, 5).map((x) => Number(x.prevalence || 0)) }], {
      x: 0.58, y: 1.6, w: 7, h: 4.5, showLegend: false, showValue: true, showTitle: false,
      chartColors: [GREEN], catAxisLabelFontSize: 12, valAxisLabelFontSize: 10, showCatName: false,
      valGridLine: { color: "D8DDDA", width: 1 }
    });
    addText(chartSlide, insights[0].title, { x: 8.3, y: 1.88, w: 3.5, h: 1.2 }, { fontSize: 19, bold: true, color: "000000", limit: 100 });
    addText(chartSlide, insights[0].implication, { x: 8.3, y: 3.38, w: 3.5, h: 1.9 }, { fontSize: 14, color: "555555", limit: 260 });
    addFooter(chartSlide, page++);
  }

  insights.forEach((insight, index) => {
    const slide = presentation.addSlide();
    slide.background = { color: "FFFFFF" };
    addText(slide, `洞察 ${String(index + 1).padStart(2, "0")}`, { x: 0.58, y: 0.42, w: 1.8, h: 0.34 }, { fontSize: 11, bold: true, color: GREEN });
    addText(slide, insight.title, { x: 0.58, y: 1.02, w: 11.4, h: 1.04 }, { fontSize: 26, bold: true, color: "000000", limit: 90 });
    addText(slide, insight.insight, { x: 0.58, y: 2.42, w: 6.5, h: 2.5 }, { fontSize: 16, color: "222222", limit: 500 });
    slide.addShape(presentation.ShapeType.roundRect, { x: 7.66, y: 2.44, w: 4.3, h: 2.7, fill: { color: "EDEDED" }, line: { color: "EDEDED", transparency: 100 } });
    const evidence = insight.evidence?.[0];
    addText(slide, evidence ? `“${evidence.quote}”` : "尚无可展示的逐字引文。", { x: 8, y: 2.82, w: 3.6, h: 1.5 }, { fontSize: 14, color: "222222", limit: 280 });
    addText(slide, evidence?.document_id || "证据待复核", { x: 8, y: 4.52, w: 3.6, h: 0.3 }, { fontSize: 10, bold: true, color: GREEN });
    addText(slide, `策略影响  ${insight.implication}`, { x: 0.58, y: 5.4, w: 11.1, h: 0.9 }, { fontSize: 14, bold: true, color: GREEN, limit: 360 });
    addFooter(slide, page++);
  });

  const actionSlide = presentation.addSlide();
  actionSlide.background = { color: "FFFFFF" };
  addText(actionSlide, "下一步行动必须可以被验证、被分工、被复盘", { x: 0.58, y: 0.44, w: 11.2, h: 0.86 }, { fontSize: 26, bold: true, color: "000000" });
  (report.strategic_actions || []).slice(0, 4).forEach((action, i) => {
    addText(actionSlide, String(i + 1).padStart(2, "0"), { x: 0.7, y: 1.75 + i * 1.05, w: 0.52, h: 0.45 }, { fontSize: 14, bold: true, color: GREEN });
    addText(actionSlide, action, { x: 1.45, y: 1.7 + i * 1.05, w: 9.8, h: 0.75 }, { fontSize: 16, color: "222222", limit: 260 });
    actionSlide.addShape(presentation.ShapeType.line, { x: 1.45, y: 2.45 + i * 1.05, w: 9.8, h: 0, line: { color: "B8BCC4", width: 1 } });
  });
  addFooter(actionSlide, page++);
  return Buffer.from(await presentation.write({ outputType: "nodebuffer" }));
}
