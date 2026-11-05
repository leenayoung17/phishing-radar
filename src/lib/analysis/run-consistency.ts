/**
 * 결과 일관성 점검기. 화면에서 서로 어긋나 보이는 결과가 있는지 찾는다(통계 모델 포함, API 와 같은 방식).
 * 사용: node run-consistency.js [데이터.jsonl ...]   (데이터 파일은 원문을 출력하지 않는다)
 *
 * 점검 규칙
 *  R1 종합이 '주의' 이상이면, 문장 카드가 '주의' 이상이거나 링크 카드가 '의심'이거나, 이유에 '링크와 함께'가 설명돼 있어야 한다.
 *  R2 문장 카드가 '주의' 이상이면 종합도 그 이상이어야 한다(종합이 문장 판단보다 낮으면 안 됨).
 *  R3 유형 표시(스미싱/스팸 등)는 종합이 '주의' 이상일 때만 있어야 하고, '주의' 이상이면 반드시 있어야 한다.
 *  R4 '스팸'으로 표시됐는데 사칭·금전·인증·원격앱 근거가 있으면 안 된다(그러면 스미싱으로 표시해야 함).
 *  R5 종합이 '주의' 이상인데 이유가 비어 있으면 안 된다.
 */
import * as fs from "fs";
import { analyzeMessage } from "./engine";
import { ANALYSIS_CASES } from "./cases";
import { getModelSignal } from "./model";
import type { AnalysisResult, Grade } from "./types";
import { VALIDATION_SETS } from "./validation-sets";

const RANK: Record<Grade, number> = { no_clear_signal: 0, uncertain: 1, caution: 2, high: 3 };
const SMISHING = ["family_impersonation", "money_request", "institution_impersonation", "credential_request", "remote_app"];

function flagged(g: Grade): boolean {
  return g === "high" || g === "caution";
}

function violations(r: AnalysisResult): string[] {
  const out: string[] = [];
  const explainedByLink =
    r.urlSummary.level === "elevated" || (r.urlSummary.count > 0 && r.reasons.some((x) => x.includes("링크")));
  if (flagged(r.grade) && !flagged(r.text.grade) && !explainedByLink) {
    out.push("R1");
  }
  if (flagged(r.text.grade) && RANK[r.grade] < RANK[r.text.grade]) {
    out.push("R2");
  }
  if (flagged(r.grade) !== (r.messageType !== "none")) {
    out.push("R3");
  }
  if (r.messageType === "spam" && r.categories.some((c) => SMISHING.includes(c.category) && c.points > 0)) {
    out.push("R4");
  }
  if (flagged(r.grade) && r.reasons.length === 0) {
    out.push("R5");
  }
  // R6 종합은 '주의' 이상인데 문장 카드가 아니면, 문장 카드에 그 이유(링크 때문)가 표시돼야 하고
  //    문장 카드 이름이 '판단 어려움'·'뚜렷한 위험 신호 없음'처럼 종합과 모순돼 보이는 이름이면 안 된다.
  if (flagged(r.grade) && !flagged(r.text.grade)) {
    const contradictory = r.text.displayLabel === "판단 어려움" || r.text.displayLabel === "뚜렷한 위험 신호 없음";
    if (!r.text.note || contradictory) {
      out.push("R6");
    }
  }
  // R7 유형이 스미싱·스팸이면 문장 카드나 링크 카드 중 하나는 그 근거를 보여 줘야 한다.
  const styleReason = r.reasons.some((x) => x.includes("스팸 문자의 특징"));
  if (
    (r.messageType === "smishing" || r.messageType === "spam") &&
    r.evidence.length === 0 &&
    r.urlSummary.level !== "elevated" &&
    !styleReason
  ) {
    out.push("R7");
  }
  return out;
}

function analyze(text: string): AnalysisResult {
  return analyzeMessage(text, { model: getModelSignal(text) });
}

let total = 0;
let bad = 0;
const counts: Record<string, number> = {};

function record(name: string, r: AnalysisResult, showText: string | null): void {
  total += 1;
  const v = violations(r);
  if (v.length > 0) {
    bad += 1;
    v.forEach((x) => (counts[x] = (counts[x] ?? 0) + 1));
    if (showText !== null && bad <= 20) {
      console.log("  위반 " + v.join(",") + " | " + name + " | 종합 " + r.grade + " 문장 " + r.text.grade + " 링크 " + r.urlSummary.level + " | " + showText.slice(0, 60));
    }
  }
}

// 점검기 자체 확인: 일부러 어긋나게 만든 결과를 각 규칙이 잡아내는지 본다.
{
  const base = analyzeMessage("오늘 저녁에 같이 밥 먹을래? 6시에 강남역에서 보자");
  const r1 = { ...base, grade: "caution" as Grade, messageType: "suspicious" as const, reasons: ["x"] };
  const r2 = { ...base, text: { ...base.text, grade: "high" as Grade } };
  const r3 = { ...base, messageType: "spam" as const };
  const r6 = {
    ...base,
    grade: "high" as Grade,
    messageType: "smishing" as const,
    reasons: ["x"],
    urlSummary: { ...base.urlSummary, count: 1, level: "elevated" as const },
    text: { ...base.text, grade: "uncertain" as Grade, displayLabel: "판단 어려움", note: null },
  };
  const ok =
    violations(r1).includes("R1") &&
    violations(r2).includes("R2") &&
    violations(r3).includes("R3") &&
    violations(r6).includes("R6") &&
    violations(base).length === 0;
  console.log("점검기 자체 확인: " + (ok ? "통과(어긋난 결과를 잡아냄)" : "실패"));
  if (!ok) {
    process.exit(1);
  }
}

ANALYSIS_CASES.forEach((c) => record(c.id, analyze(c.text), c.text));
VALIDATION_SETS.forEach((s) => s.texts.forEach((t, i) => record(s.id + ":" + (i + 1), analyze(t), t)));
const handTotal = total;
const handBad = bad;
console.log("직접 쓴 문장 " + handTotal + "건: 위반 " + handBad + "건");

for (const file of process.argv.slice(2)) {
  const before = { total, bad };
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  lines.forEach((l, i) => {
    const row = JSON.parse(l) as { text: string };
    record(file + ":" + i, analyze(row.text), null);
  });
  console.log(file.split(/[\\/]/).pop() + " " + (total - before.total) + "건: 위반 " + (bad - before.bad) + "건");
}
console.log("규칙별 위반: " + JSON.stringify(counts));
process.exit(bad === 0 ? 0 : 1);
