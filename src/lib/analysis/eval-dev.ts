/**
 * 규칙 엔진 평가(조정용 데이터 전용). 사용: node eval-dev.js <dev_eval.jsonl> <errors.json>
 * 입력에는 학습+검증 행만 있어야 한다(테스트 행은 넣지 않는다). 출력에는 메시지 원문을 쓰지 않는다.
 * 이 수치는 규칙을 조정하는 데 쓴 데이터에서의 값이라 최종 성능이 아니다.
 */

import * as fs from "fs";
import { analyzeMessage } from "./engine";
import type { Grade } from "./types";

interface Row {
  source_row: number;
  label: number;
  has_url: number;
  split: string;
  text: string;
  /** 원본 파일의 클래스 표기(있을 때만 클래스별로 나눠 집계) */
  cls?: string;
}

const GRADES: Grade[] = ["high", "caution", "uncertain", "no_clear_signal"];

function emptyCounts(): Record<Grade, number> {
  return { high: 0, caution: 0, uncertain: 0, no_clear_signal: 0 };
}

const inPath = process.argv[2];
const outPath = process.argv[3];
if (!inPath || !outPath) {
  console.log("사용법: node eval-dev.js <dev_eval.jsonl> <errors.json>");
  process.exit(2);
}

const rows: Row[] = fs
  .readFileSync(inPath, "utf-8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Row);

if (rows.some((r) => r.split === "test")) {
  console.log("중단: 입력에 테스트 행이 있습니다. 조정용 평가에는 테스트 행을 쓰지 않습니다.");
  process.exit(2);
}

const groups: Record<string, Record<Grade, number>> = {};
const ruleHits: Record<string, { spam: number; normal: number }> = {};
const reasonHits: Record<string, { spam: number; normal: number }> = {};
const urlFlagHits: Record<string, { spam: number; normal: number }> = {};
const missed: number[] = [];
const falsePositive: number[] = [];
const started = Date.now();

for (const r of rows) {
  const res = analyzeMessage(r.text);
  const key =
    (r.label === 1 ? "스미싱" : "정상") + (r.cls ? "(클래스" + r.cls + ")" : "") + "/" + (r.has_url ? "URL있음" : "URL없음");
  if (!groups[key]) {
    groups[key] = emptyCounts();
  }
  groups[key][res.grade] += 1;
  const flagged = res.grade === "high" || res.grade === "caution";
  if (r.label === 1 && !flagged) {
    missed.push(r.source_row);
  }
  if (r.label === 0 && flagged) {
    falsePositive.push(r.source_row);
  }
  const side = r.label === 1 ? "spam" : "normal";
  if (flagged) {
    for (const reason of res.reasons) {
      reasonHits[reason] = reasonHits[reason] ?? { spam: 0, normal: 0 };
      reasonHits[reason][side] += 1;
    }
  }
  const flagIds = new Set<string>();
  for (const u of res.urls) {
    for (const f of u.flags) {
      flagIds.add(f.id);
    }
  }
  for (const id of flagIds) {
    urlFlagHits[id] = urlFlagHits[id] ?? { spam: 0, normal: 0 };
    urlFlagHits[id][side] += 1;
  }
  const seen = new Set(res.evidence.map((e) => e.ruleId));
  for (const id of seen) {
    if (!ruleHits[id]) {
      ruleHits[id] = { spam: 0, normal: 0 };
    }
    if (r.label === 1) {
      ruleHits[id].spam += 1;
    } else {
      ruleHits[id].normal += 1;
    }
  }
}

function pct(a: number, b: number): string {
  return b === 0 ? "-" : ((a / b) * 100).toFixed(1) + "%";
}

console.log("행 수: " + rows.length + " (" + ((Date.now() - started) / 1000).toFixed(1) + "초)");
let spamN = 0;
let spamFlag = 0;
let spamHigh = 0;
let normN = 0;
let normFlag = 0;
let normHigh = 0;
for (const key of Object.keys(groups).sort()) {
  const c = groups[key];
  const n = GRADES.reduce((s, g) => s + c[g], 0);
  const flag = c.high + c.caution;
  console.log(
    key.padEnd(12) + " n=" + String(n).padStart(6) +
      " 높음 " + pct(c.high, n) + " 주의 " + pct(c.caution, n) +
      " 판단어려움 " + pct(c.uncertain, n) + " 신호없음 " + pct(c.no_clear_signal, n) +
      " | 주의이상 " + pct(flag, n),
  );
  if (key.startsWith("스미싱")) {
    spamN += n;
    spamFlag += flag;
    spamHigh += c.high;
  } else {
    normN += n;
    normFlag += flag;
    normHigh += c.high;
  }
}
console.log("스미싱 재현율(주의 이상): " + pct(spamFlag, spamN) + " / 높음만: " + pct(spamHigh, spamN));
console.log("정상 오탐률(주의 이상): " + pct(normFlag, normN) + " / 높음만: " + pct(normHigh, normN));

console.log("규칙별 발동 건수 (스미싱 / 정상):");
for (const id of Object.keys(ruleHits).sort((a, b) => ruleHits[b].spam + ruleHits[b].normal - ruleHits[a].spam - ruleHits[a].normal)) {
  console.log("  " + id.padEnd(26) + String(ruleHits[id].spam).padStart(6) + " /" + String(ruleHits[id].normal).padStart(6));
}

console.log("주의 이상으로 표시한 이유 (스미싱 / 정상):");
for (const k of Object.keys(reasonHits).sort((a, b) => reasonHits[b].normal + reasonHits[b].spam - reasonHits[a].normal - reasonHits[a].spam)) {
  console.log("  " + String(reasonHits[k].spam).padStart(5) + " /" + String(reasonHits[k].normal).padStart(5) + "  " + k);
}
console.log("링크 특징별 건수 (스미싱 / 정상):");
for (const k of Object.keys(urlFlagHits).sort()) {
  console.log("  " + k.padEnd(18) + String(urlFlagHits[k].spam).padStart(6) + " /" + String(urlFlagHits[k].normal).padStart(6));
}

fs.writeFileSync(outPath, JSON.stringify({ missed_spam: missed, false_positive_normal: falsePositive }));
console.log("놓친 스미싱 " + missed.length + "건, 오탐 정상 " + falsePositive.length + "건의 행 번호를 저장: " + outPath);
