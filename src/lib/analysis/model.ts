/**
 * 통계 모델(문자 n-gram TF-IDF + 로지스틱 회귀) 추론. 서버(API)에서만 쓴다.
 *
 * - scripts/train_final.py 가 내보낸 model/model.json 을 읽는다.
 * - 입력 정리(cleanForModel)는 scripts/train_final.py 의 clean_final() 과 글자 단위까지 같아야 한다.
 *   run-parity.ts 로 파이썬 계산값과 비교해 검증한다.
 * - 점수는 피싱 확률이 아니다. 화면에는 높음/보통/낮음 같은 참고 단계로만 보여 준다.
 * - 이 모델은 학습 데이터에 있던 유형을 알아보는 용도라 처음 보는 수법에는 약할 수 있다.
 */

import bundleJson from "./model/model.json";
import type { ModelBand, ModelSignal } from "./types";

export interface ModelBundle {
  version: string;
  ngram: number[];
  min_chars: number;
  thresholds: { high: number; medium: number };
  intercept: number;
  vocab: string[];
  idf: number[];
  coef: number[];
}

export const DEFAULT_MODEL: ModelBundle = bundleJson as ModelBundle;

// ---------------------------------------------------------------- 파이썬과 같은 정규식
// scripts/train_model.py 의 _WS, _LOCAL, _URL_RE, _BARE_RE 와 같은 문자열로 만든다.
// 뒤를 보는 조건(lookbehind)이 있어 정규식 리터럴 대신 문자열로 만든다.
const WS = " \\t\\n\\r\\f\\v\\u00a0\\u3000";
const LOCAL = "a-z0-9._%+!#$&'*=^`{|}~-";
const EMAIL_GUARD = "(?![" + LOCAL + "]*@)";
const TLDS =
  "com|net|org|kr|co|me|ly|xyz|top|in|cc|io|gl|app|link|site|online|info|biz|vip|club|shop|store|ae|ml|tk|ga|cf|gq|pw|ws";

const EMAIL_RE = new RegExp("[" + LOCAL + "]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)+", "g");
const URL_RE = new RegExp("(?:https?://|(?<![a-z0-9@.-])www\\." + EMAIL_GUARD + ")[^" + WS + "]+", "g");
const BARE_RE = new RegExp(
  "(?<![a-z0-9.@-])" + EMAIL_GUARD + "(?:[a-z0-9-]+\\.)+(?:" + TLDS + ")(?![a-z0-9-])(?:/[^" + WS + "]*)?",
  "g",
);
const WS_RUN = new RegExp("[" + WS + "]+", "g");

/** 파이썬 str.isspace() 가 공백으로 보는 문자(str.strip() 과 정규식 \s 의 기준). */
const PY_SPACE =
  "\\t\\n\\u000b\\u000c\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_SPACE_RUN = new RegExp("[" + PY_SPACE + "]{2,}", "g");
const PY_LEAD = new RegExp("^[" + PY_SPACE + "]+");
const PY_TRAIL = new RegExp("[" + PY_SPACE + "]+$");

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** 모델 입력 정리: NFKC, 영문 소문자, '*' 제거, 이메일·URL 제거, 숫자 0, 공백 정리. */
export function cleanForModel(content: string): string {
  let t = asciiLower(content.normalize("NFKC")).split("*").join("");
  t = t.replace(EMAIL_RE, " ");
  t = t.replace(URL_RE, " ");
  t = t.replace(BARE_RE, " ");
  t = t.replace(/[0-9]/g, "0");
  t = t.replace(WS_RUN, " ");
  return t.replace(PY_LEAD, "").replace(PY_TRAIL, "");
}

// ---------------------------------------------------------------- 점수 계산
const indexCache = new WeakMap<ModelBundle, Map<string, number>>();

function termIndex(bundle: ModelBundle): Map<string, number> {
  let index = indexCache.get(bundle);
  if (!index) {
    index = new Map<string, number>();
    bundle.vocab.forEach((term, i) => index?.set(term, i));
    indexCache.set(bundle, index);
  }
  return index;
}

/** sklearn TfidfVectorizer(analyzer="char", sublinear_tf, l2) + 로지스틱 회귀 decision_function 과 같은 계산. */
export function scoreCleaned(bundle: ModelBundle, cleaned: string): number {
  const index = termIndex(bundle);
  // sklearn 의 문자 n-gram 은 연속 공백을 하나로 줄이고 '코드포인트' 단위로 자른다.
  const chars = Array.from(cleaned.replace(PY_SPACE_RUN, " "));
  const counts = new Map<number, number>();
  const [minN, maxN] = bundle.ngram;
  for (let n = minN; n <= maxN; n += 1) {
    for (let i = 0; i + n <= chars.length; i += 1) {
      const j = index.get(chars.slice(i, i + n).join(""));
      if (j !== undefined) {
        counts.set(j, (counts.get(j) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) {
    return bundle.intercept;
  }
  let squares = 0;
  let dot = 0;
  for (const [j, c] of counts) {
    const w = (1 + Math.log(c)) * bundle.idf[j];
    squares += w * w;
    dot += w * bundle.coef[j];
  }
  return bundle.intercept + dot / Math.sqrt(squares);
}

export function bandOf(bundle: ModelBundle, cleaned: string, score: number): ModelBand {
  if (Array.from(cleaned).length < bundle.min_chars) {
    return "unreliable";
  }
  if (score > bundle.thresholds.high) {
    return "high";
  }
  if (score > bundle.thresholds.medium) {
    return "medium";
  }
  return "low";
}

/** API 에서 쓰는 진입점. 오류가 나면 '연결 안 됨'으로 돌려준다(입력 내용은 남기지 않는다). */
export function getModelSignal(text: string, bundle: ModelBundle = DEFAULT_MODEL): ModelSignal {
  try {
    const cleaned = cleanForModel(text);
    const score = scoreCleaned(bundle, cleaned);
    if (!Number.isFinite(score)) {
      return { status: "unavailable", reason: "통계 모델 계산에 실패했습니다." };
    }
    return { status: "ok", band: bandOf(bundle, cleaned, score), modelVersion: bundle.version };
  } catch {
    return { status: "unavailable", reason: "통계 모델 계산에 실패했습니다." };
  }
}
