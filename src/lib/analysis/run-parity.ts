/**
 * 파이썬(scripts/train_final.py)과 TS(model.ts) 계산이 같은지 검사한다.
 * 사용: node run-parity.js <parity-fixtures.json> [parity_dev.jsonl ...]
 * - 입력 정리 결과는 글자 단위로 완전히 같아야 하고, 점수 차이는 1e-6 이하여야 한다.
 * - 실패해도 메시지 원문은 출력하지 않고 id 만 보여 준다.
 */

import * as fs from "fs";
import { DEFAULT_MODEL, bandOf, cleanForModel, getModelSignal, scoreCleaned } from "./model";

interface Fixture {
  id: string;
  input: string;
  cleaned: string;
  score: number;
  band: string;
}

const TOLERANCE = 1e-6;
let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log("FAIL  " + name + (detail ? "  -> " + detail : ""));
  }
}

function load(path: string): Fixture[] {
  const raw = fs.readFileSync(path, "utf-8");
  if (path.endsWith(".jsonl")) {
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Fixture);
  }
  return JSON.parse(raw) as Fixture[];
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log("사용법: node run-parity.js <parity-fixtures.json> [parity_dev.jsonl ...]");
  process.exit(2);
}

for (const file of files) {
  const fixtures = load(file);
  let maxDiff = 0;
  let cleanedMismatch = 0;
  let bandMismatch = 0;
  for (const fx of fixtures) {
    const cleaned = cleanForModel(fx.input);
    if (cleaned !== fx.cleaned) {
      cleanedMismatch += 1;
      check("cleaned " + fx.id, false, "입력 정리 결과가 파이썬과 다릅니다");
      continue;
    }
    const score = scoreCleaned(DEFAULT_MODEL, cleaned);
    const diff = Math.abs(score - fx.score);
    maxDiff = Math.max(maxDiff, diff);
    check("score " + fx.id, diff <= TOLERANCE, "차이 " + diff);
    const band = bandOf(DEFAULT_MODEL, cleaned, score);
    if (band !== fx.band) {
      bandMismatch += 1;
      check("band " + fx.id, false, band + " vs " + fx.band);
    }
  }
  console.log(
    file.split(/[\\/]/).pop() +
      ": " + fixtures.length + "건, 정리 불일치 " + cleanedMismatch +
      ", 단계 불일치 " + bandMismatch + ", 최대 점수 차이 " + maxDiff.toExponential(2),
  );
}

// 구조 검사
const empty = getModelSignal("");
check("empty -> ok/unreliable", empty.status === "ok" && empty.band === "unreliable");
const sample = getModelSignal("엄마 나 폰이 고장나서 친구 폰으로 문자해. 급하게 송금해줘");
check("version present", sample.status === "ok" && sample.modelVersion === DEFAULT_MODEL.version);
check("deterministic", JSON.stringify(sample) === JSON.stringify(getModelSignal("엄마 나 폰이 고장나서 친구 폰으로 문자해. 급하게 송금해줘")));
check("no raw score exposed", !("rawScore" in sample));

console.log(failures === 0 ? "ALL PASS (" + checks + " checks)" : failures + " FAILED of " + checks + " checks");
process.exit(failures === 0 ? 0 : 1);
