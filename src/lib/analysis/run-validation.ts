/**
 * 검증 세트 측정기. 사용: node run-validation.js
 * 세트마다 규칙만 / 규칙+모델의 '주의 이상' 비율과 등급 분포를 출력한다(통과·실패 판정 없음).
 */

import { analyzeMessage } from "./engine";
import { getModelSignal } from "./model";
import type { Grade } from "./types";
import { VALIDATION_SETS } from "./validation-sets";

const FLAG: Grade[] = ["high", "caution"];
const SHORT: Record<Grade, string> = { high: "H", caution: "C", uncertain: "U", no_clear_signal: "-" };

for (const set of VALIDATION_SETS) {
  let rulesFlag = 0;
  let finalFlag = 0;
  const marks: string[] = [];
  set.texts.forEach((text) => {
    const rules = analyzeMessage(text);
    const final = analyzeMessage(text, { model: getModelSignal(text) });
    if (FLAG.includes(rules.grade)) {
      rulesFlag += 1;
    }
    if (FLAG.includes(final.grade)) {
      finalFlag += 1;
    }
    marks.push(SHORT[rules.grade] + SHORT[final.grade]);
  });
  const n = set.texts.length;
  const what = set.kind === "risk" ? "탐지율" : "오탐률";
  console.log(
    "[" + set.title + "] " + n + "개 | " + what +
      " 규칙만 " + rulesFlag + "/" + n + " (" + ((rulesFlag / n) * 100).toFixed(0) + "%)" +
      ", 규칙+모델 " + finalFlag + "/" + n + " (" + ((finalFlag / n) * 100).toFixed(0) + "%)",
  );
  console.log("   문장별 [규칙만|규칙+모델] H=높음 C=주의 U=판단어려움 -=신호없음: " +
    marks.map((m, i) => i + 1 + ":" + m).join(" "));
}
