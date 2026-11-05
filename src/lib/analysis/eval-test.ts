/**
 * 시험용 평가 실행기. scripts/eval_test.py 가 표준입력으로 {id, text} 줄을 넘기면
 * 행마다 규칙만의 등급, 규칙+모델 최종 등급, 모델 단계·점수를 표준출력으로 돌려준다.
 * 메시지 원문은 출력하지 않는다. 화면·API 와 같은 길이 제한(3,000자)을 적용한다.
 */

import * as fs from "fs";
import { analyzeMessage } from "./engine";
import { DEFAULT_MODEL, bandOf, cleanForModel, scoreCleaned } from "./model";
import type { ModelSignal } from "./types";

interface InputRow {
  id: string;
  text: string;
}

const lines = fs
  .readFileSync(0, "utf-8")
  .replace(/^﻿/, "")
  .split("\n")
  .filter((l) => l.trim().length > 0);

const out: string[] = [];
for (const line of lines) {
  const row = JSON.parse(line) as InputRow;
  const rules = analyzeMessage(row.text);
  const text = row.text.slice(0, rules.input.analyzedLength);
  const cleaned = cleanForModel(text);
  const score = scoreCleaned(DEFAULT_MODEL, cleaned);
  const band = bandOf(DEFAULT_MODEL, cleaned, score);
  const model: ModelSignal = { status: "ok", band, modelVersion: DEFAULT_MODEL.version };
  const final = analyzeMessage(text, { model });
  out.push(
    JSON.stringify({
      id: row.id,
      rule: rules.grade,
      final: final.grade,
      text_grade: rules.text.grade,
      url_level: rules.urlSummary.level,
      band,
      score,
      engine: final.engineVersion,
      model_version: DEFAULT_MODEL.version,
    }),
  );
}
process.stdout.write(out.join("\n") + "\n");
