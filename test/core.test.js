import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoleExchanges,
  extractOutlineQuestions,
  extractResponseText,
  maskSensitiveText,
  parseTranscriptTurns,
  runWithConcurrency,
  sanitizeText,
  validateAnalysisPayload
} from "../lib/core.js";

test("sanitizeText normalizes line endings and removes null bytes",()=>{
  assert.equal(sanitizeText(" a\r\n\u0000b "),"a\nb");
});

test("maskSensitiveText masks common identifiers",()=>{
  const result=maskSensitiveText("电话 13812345678 身份证 110101199001011234 邮箱 a.b@example.com");
  assert.match(result,/手机号已脱敏/);
  assert.match(result,/身份证号已脱敏/);
  assert.match(result,/邮箱已脱敏/);
  assert.doesNotMatch(result,/13812345678/);
});

test("validateAnalysisPayload keeps patient type and outline questions",()=>{
  const cn=validateAnalysisPayload({outline:"1. 患者如何做出治疗决定？",documents:[{id:"P1",type:"患者",text:"  有效内容  "}]});
  assert.equal(cn.documents[0].type,"Patient");
  assert.equal(cn.documents[0].text,"有效内容");
  assert.equal(cn.questions.length,1);
  const en=validateAnalysisPayload({outline:"1. How does the patient make decisions?",documents:[{id:"Patient-001",type:"Patient",text:"valid text"}]});
  assert.equal(en.documents[0].type,"Patient");
});

test("validateAnalysisPayload rejects empty documents",()=>{
  assert.throws(()=>validateAnalysisPayload({documents:[]}),/至少提供一份/);
});

test("runWithConcurrency preserves input order",async()=>{
  const values=await runWithConcurrency([30,5,10],2,async value=>{
    await new Promise(resolve=>setTimeout(resolve,value));
    return value/5;
  });
  assert.deepEqual(values,[6,1,2]);
});

test("extractResponseText handles Responses API output",()=>{
  assert.equal(extractResponseText({output:[{content:[{type:"output_text",text:"{\"ok\":true}"}]}]}),'{"ok":true}');
});

test("extractOutlineQuestions recognizes Chinese and English questions",()=>{
  const questions=extractOutlineQuestions("1. 当前治疗路径是什么？\n2. How do physicians choose treatment?\n研究目的：内部使用");
  assert.deepEqual(questions,["当前治疗路径是什么？","How do physicians choose treatment?"]);
});

test("role mapper preserves verbatim turns and builds question-answer exchanges",()=>{
  const turns=parseTranscriptTurns("speaker_0 [0:03]：请介绍一下最近的治疗体验？\nspeaker_1 [0:08]：整体还可以，但复诊很不方便。\nspeaker_0 [0:16]：主要是哪方面不方便？\nspeaker_1 [0:20]：预约时间太长。");
  const assignments=turns.map(turn=>({line_no:turn.line_no,role:turn.speaker==="speaker_0"?"interviewer":"respondent",confidence:94}));
  const result=buildRoleExchanges(turns,assignments,"患者/受访者");
  assert.equal(result.exchanges.length,2);
  assert.equal(result.exchanges[0].question,"请介绍一下最近的治疗体验？");
  assert.equal(result.exchanges[0].answer,"整体还可以，但复诊很不方便。");
  assert.equal(result.average_confidence,94);
  assert.equal(result.review_count,0);
});
