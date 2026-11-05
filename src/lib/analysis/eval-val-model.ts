/**
 * 검증 행(모델이 학습하지 않은 행)에서 규칙+모델 결과와, 정상 안내 문맥 때문에 모델 반영이 막힌 건수를 센다.
 * 사용: node eval-val-model.js <val_combined.jsonl>   (출력에 원문 없음)
 */
import * as fs from "fs";
import { analyzeMessage } from "./engine";
import { getModelSignal } from "./model";

interface Row {
  ds: string;
  label: number;
  text: string;
}

const rows = fs
  .readFileSync(process.argv[2], "utf-8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Row);

for (const ds of ["orig", "lga"]) {
  const sub = rows.filter((r) => r.ds === ds);
  let spam = 0;
  let normal = 0;
  let spamFlag = 0;
  let normalFlag = 0;
  let spamBlocked = 0;
  let normalBlocked = 0;
  let spamWarned = 0;
  let normalWarned = 0;
  for (const r of sub) {
    const res = analyzeMessage(r.text, { model: getModelSignal(r.text) });
    const flagged = res.grade === "high" || res.grade === "caution";
    const blocked = res.reasons.some((x) => x.includes("등급에는 반영하지 않았습니다"));
    // '판단 어려움' 이상 = 사용자에게 어떤 식으로든 경고가 보이는 경우
    const warned = flagged || res.grade === "uncertain";
    if (r.label === 1) {
      spamWarned += warned ? 1 : 0;
    } else {
      normalWarned += warned ? 1 : 0;
    }
    if (r.label === 1) {
      spam += 1;
      spamFlag += flagged ? 1 : 0;
      spamBlocked += blocked ? 1 : 0;
      if (blocked && process.argv[3] === "--show-blocked") {
        console.log("  막힘: " + res.benignContexts.map((b) => b.id).join(",") + " | " + r.text.replace(/\s+/g, " ").slice(0, 70));
      }
    } else {
      normal += 1;
      normalFlag += flagged ? 1 : 0;
      normalBlocked += blocked ? 1 : 0;
    }
  }
  console.log(
    ds + " 검증 " + sub.length + "행 | 규칙+모델 재현율 " + ((spamFlag / spam) * 100).toFixed(1) + "% 오탐률 " +
      ((normalFlag / normal) * 100).toFixed(1) + "% | 정상 문맥으로 모델 반영이 막힌 행: 스미싱 " + spamBlocked +
      "건, 정상 " + normalBlocked + "건",
  );
  console.log(
    "   '판단 어려움' 이상(경고가 보이는 경우): 스미싱 " + ((spamWarned / spam) * 100).toFixed(1) + "%, 정상 " +
      ((normalWarned / normal) * 100).toFixed(1) + "%",
  );
}
