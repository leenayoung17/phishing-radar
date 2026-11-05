/**
 * 분석 엔진 본체: 규칙 일치 -> 정상 맥락·부정 문맥 억제 -> 유형별 점수 -> 등급 결정.
 *
 * - 순수 함수다. 외부 접속, 저장, 로그 출력을 하지 않는다.
 * - 어떤 등급도 "안전" 또는 "위험 확정"을 뜻하지 않는다.
 * - 통계 모델 신호는 호출하는 쪽이 넘겨 준 경우에만 반영한다. 모델 신호로
 *   "높음"이 되거나 "주의"보다 낮아지는 일은 없다(높음 -> 주의 상향까지만 허용).
 */

import { buildView, toOriginalSpan, type NormalizedView } from "./normalize";
import { BENIGN_DEFS, NEGATION_RE, RULES } from "./rules";
import {
  CATEGORY_LABELS,
  GRADE_LABELS,
  MESSAGE_TYPE_LABELS,
  MAIN_CATEGORIES,
  RISK_CATEGORIES,
  type AnalysisOptions,
  type AnalysisResult,
  type BenignContext,
  type CategorySummary,
  type Evidence,
  type Grade,
  type MessageType,
  type ModelSignal,
  type RiskCategory,
  type SuppressedEvidence,
  type UrlFinding,
  type UrlLevel,
} from "./types";
import { analyzeUrls, isOfficialDomain, maxUrlLevel } from "./url";

export const ENGINE_VERSION = "rules-0.3.0";
export const DEFAULT_MAX_LENGTH = 3000;

const MAX_PER_RULE = 3;
const SHORT_LIMIT = 6;

interface RawMatch {
  evidence: Evidence;
  /** compact 문자열 기준 일치 끝 위치(부정 문맥 검사용) */
  compactEnd: number;
  negatable: boolean;
}

function zeroPoints(): Record<RiskCategory, number> {
  return {
    family_impersonation: 0,
    money_request: 0,
    institution_impersonation: 0,
    credential_request: 0,
    remote_app: 0,
    illegal_gambling: 0,
    evasion: 0,
    pressure: 0,
  };
}

function falseFlags(): Record<RiskCategory, boolean> {
  return {
    family_impersonation: false,
    money_request: false,
    institution_impersonation: false,
    credential_request: false,
    remote_app: false,
    illegal_gambling: false,
    evasion: false,
    pressure: false,
  };
}

function clip(input: string, maxLength: number): { text: string; truncated: boolean } {
  if (input.length <= maxLength) {
    return { text: input, truncated: false };
  }
  let end = maxLength;
  if (end > 0) {
    const code = input.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      end -= 1; // 서로게이트 쌍이 잘리지 않게 한다.
    }
  }
  return { text: input.slice(0, end), truncated: true };
}

// ---------------------------------------------------------------- 규칙 일치
function collectMatches(text: string, compact: NormalizedView): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const rule of RULES) {
    const seen = new Set<string>();
    let count = 0;
    for (const pattern of rule.patterns) {
      for (const m of compact.text.matchAll(new RegExp(pattern.source, "g"))) {
        if (count >= MAX_PER_RULE) {
          break;
        }
        const index = m.index ?? 0;
        const length = m[0].length;
        const key = index + ":" + length;
        if (length === 0 || seen.has(key)) {
          continue;
        }
        seen.add(key);
        const span = toOriginalSpan(compact, index, index + length);
        matches.push({
          evidence: {
            ruleId: rule.id,
            category: rule.category,
            label: rule.label,
            reason: rule.reason,
            weight: rule.weight,
            kind: rule.kind,
            start: span.start,
            end: span.end,
            text: text.slice(span.start, span.end),
            normalized: m[0],
          },
          compactEnd: index + length,
          negatable: rule.negatable,
        });
        count += 1;
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------- 위장 문자(원문 기준)
/**
 * 글자·숫자를 흉내 낸 기호(동그라미 문자, 전각 문자 등). ①② 같은 목록 번호만으로는 쓰지 않고,
 * 영숫자와 붙어 있거나 도메인 안에 있을 때만 본다. 분석용 정규화(NFKC)가 이런 기호를 평범한
 * 글자로 바꿔 버리므로 정규화 전의 원문에서 직접 찾는다.
 */
const LOOKALIKE =
  "\\u24b6-\\u24e9\\u2460-\\u2473\\u2474-\\u249b\\uff21-\\uff3a\\uff41-\\uff5a\\uff10-\\uff19\\u2102\\u210d\\u2113\\u2115\\u2119\\u211a\\u211d\\u2124\\u2133";

/** 글자 조각을 끊는 데 쓰이는 기호(조정용 데이터에서 정상 0건, 스미싱 40건) */
const SEPARATORS = "▶►▷→◀◁◆◇■□●○★☆♥♡♠♣※";

interface EvasionRule {
  id: string;
  label: string;
  reason: string;
  weight: 2 | 3;
  source: string;
}

const EVASION_RULES: readonly EvasionRule[] = [
  {
    id: "evade.glyph_domain",
    label: "특수 문자로 위장한 도메인",
    reason: "주소에 동그라미 문자·전각 문자 같은 흉내 글자를 섞어 단속과 필터를 피하려는 모양입니다. 정상 주소에는 쓰지 않습니다.",
    weight: 3,
    source:
      "[A-Za-z0-9*\\-]*[" + LOOKALIKE + "][A-Za-z0-9*\\-" + LOOKALIKE + "]*\\.(?:com|net|org|kr|cc|vip|xyz|top|co)",
  },
  {
    id: "evade.glyph_run",
    label: "동그라미 영문자 연속",
    reason: "ⓩⓟⓩ처럼 동그라미 영문자를 이어 써서 글자 검사를 피하려는 모양입니다.",
    weight: 2,
    source: "[\\u24b6-\\u24e9]{2,}",
  },
  {
    id: "evade.separator_chain",
    label: "기호로 잘게 끊은 문구",
    reason:
      "'소▶봉구울▶신규'처럼 짧은 글자 조각을 기호로 잘게 끊어 이어 쓴 모양입니다. 단어 검사를 피하려는 불법 광고에서 자주 쓰입니다.",
    weight: 2,
    // 조각마다 실제 글자 1~4개. '*'(가림 표시)는 글자 수에 세지 않는다.
    source: "(?:\\**(?:[^\\s*" + SEPARATORS + "]\\**){1,4}[" + SEPARATORS + "]){3,}",
  },
  {
    id: "evade.glyph_inside",
    label: "영문·숫자에 섞인 흉내 글자",
    reason: "gh③7c처럼 영문·숫자 사이에 비슷하게 생긴 특수 문자를 끼워 넣은 모양입니다.",
    weight: 2,
    source: "[A-Za-z0-9][" + LOOKALIKE + "]|[" + LOOKALIKE + "][A-Za-z0-9]",
  },
];

function collectEvasion(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const rule of EVASION_RULES) {
    let count = 0;
    for (const m of text.matchAll(new RegExp(rule.source, "g"))) {
      if (count >= MAX_PER_RULE) {
        break;
      }
      const start = m.index ?? 0;
      const end = start + m[0].length;
      matches.push({
        evidence: {
          ruleId: rule.id,
          category: "evasion",
          label: rule.label,
          reason: rule.reason,
          weight: rule.weight,
          kind: "signal",
          start,
          end,
          text: text.slice(start, end),
          normalized: m[0].normalize("NFKC").toLowerCase(),
        },
        compactEnd: end,
        negatable: false,
      });
      count += 1;
    }
  }
  return matches;
}

function isNegated(compactText: string, compactEnd: number): boolean {
  let tail = compactText.slice(compactEnd, compactEnd + 14);
  const cut = tail.search(/[.!?。…]/);
  if (cut !== -1) {
    tail = tail.slice(0, cut);
  }
  return NEGATION_RE.test(tail);
}

function detectBenign(
  text: string,
  compact: NormalizedView,
  urls: readonly UrlFinding[],
): { contexts: BenignContext[]; suppress: Map<string, string>; blocksModel: boolean } {
  const contexts: BenignContext[] = [];
  const suppress = new Map<string, string>();
  let blocksModel = false;
  // 공식 목록에 없는 링크가 하나라도 있으면 '정상 안내'로 단정하지 않는다(정상 안내를 흉내 낸 사기 문자 대비).
  const unofficialUrl = urls.some((u) => !isOfficialDomain(u.registrableDomain));
  for (const def of BENIGN_DEFS) {
    if (def.requiresCleanUrl && unofficialUrl) {
      continue;
    }
    const found = def.find(compact.text);
    if (!found) {
      continue;
    }
    if (def.blocksModel && !unofficialUrl) {
      blocksModel = true;
    }
    const span = toOriginalSpan(compact, found.start, found.end);
    contexts.push({
      id: def.id,
      label: def.label,
      reason: def.reason,
      start: span.start,
      end: span.end,
      text: text.slice(span.start, span.end),
    });
    for (const ruleId of def.suppresses) {
      if (!suppress.has(ruleId)) {
        suppress.set(ruleId, def.id);
      }
    }
  }
  return { contexts, suppress, blocksModel };
}

/** 유형별 점수: 같은 규칙은 한 번만 센다. signal 이 없는 유형은 0점. */
function scoreEvidence(list: Evidence[]): {
  points: Record<RiskCategory, number>;
  present: Record<RiskCategory, boolean>;
} {
  const firstByRule = new Map<string, Evidence>();
  for (const e of list) {
    if (!firstByRule.has(e.ruleId)) {
      firstByRule.set(e.ruleId, e);
    }
  }
  const signalPoints = zeroPoints();
  const contextPoints = zeroPoints();
  for (const e of firstByRule.values()) {
    if (e.kind === "signal") {
      signalPoints[e.category] += e.weight;
    } else {
      contextPoints[e.category] += e.weight;
    }
  }
  const points = zeroPoints();
  const present = falseFlags();
  for (const category of RISK_CATEGORIES) {
    points[category] = signalPoints[category] > 0 ? signalPoints[category] + contextPoints[category] : 0;
    present[category] = list.some((e) => e.category === category);
  }
  return { points, present };
}

// ---------------------------------------------------------------- 등급 결정
interface DecisionInput {
  points: Record<RiskCategory, number>;
  present: Record<RiskCategory, boolean>;
  urlCount: number;
  urlLevel: UrlLevel;
  onlyUrl: boolean;
  tooShort: boolean;
  hasBenignContext: boolean;
}

function decide(d: DecisionInput): { grade: Grade; reasons: string[] } {
  const p = d.points;
  const has = d.present;
  const urlPresent = d.urlCount > 0;

  // 1) 높음: 서로 다른 위험 신호가 겹친 경우
  const high: string[] = [];
  if (p.family_impersonation >= 3 && p.money_request >= 2) {
    high.push("가족·지인 사칭 표현과 송금·금전 요구 표현이 함께 있습니다.");
  }
  if (p.credential_request >= 3 && (has.institution_impersonation || urlPresent || p.family_impersonation >= 3)) {
    high.push("인증번호·개인정보를 요구하는 표현이 기관 사칭, 링크 또는 가족 사칭과 함께 있습니다.");
  }
  if (p.remote_app >= 5) {
    high.push("원격제어 앱 이름과 설치·연결을 유도하는 표현이 함께 있습니다.");
  } else if (
    p.remote_app >= 2 &&
    (has.institution_impersonation || p.credential_request >= 2 || p.money_request >= 2 || urlPresent)
  ) {
    high.push("원격제어·앱 설치 유도 표현이 기관 사칭, 인증·개인정보 요구, 금전 요구 또는 링크와 함께 있습니다.");
  }
  if (p.institution_impersonation >= 2 && d.urlLevel === "elevated") {
    high.push("기관·기업 사칭 표현과 구조상 의심스러운 링크가 함께 있습니다.");
  }
  if (p.institution_impersonation >= 2 && d.urlLevel !== "none" && has.pressure) {
    high.push("기관·기업 사칭, 의심 요소가 있는 링크, 재촉·협박 표현이 함께 있습니다.");
  }
  if (p.money_request >= 3 && has.pressure && (p.family_impersonation >= 3 || has.institution_impersonation)) {
    high.push("금전 요구에 재촉·협박 표현과 사칭 표현이 함께 있습니다.");
  }
  if (
    p.institution_impersonation >= 3 &&
    (p.money_request >= 2 || p.credential_request >= 2 || p.remote_app >= 2 || d.urlLevel !== "none")
  ) {
    high.push("기관 사칭 표현이 금전·인증 요구, 원격 앱 유도 또는 의심 요소가 있는 링크와 함께 있습니다.");
  }
  if (p.evasion >= 4) {
    high.push("글자를 바꿔 쓰는 위장 방식이 여러 곳에서 함께 쓰였습니다.");
  }
  if (p.evasion + p.illegal_gambling >= 2 && d.urlLevel === "elevated") {
    high.push("글자를 숨기거나 바꾼 광고 표현과 구조상 의심스러운 링크가 함께 있습니다.");
  }
  if (p.illegal_gambling >= 3 && (urlPresent || p.illegal_gambling >= 4)) {
    high.push("불법 도박 사이트로 유도하는 표현이 링크 또는 가입·입금 혜택 문구와 함께 있습니다.");
  }
  if (high.length > 0) {
    return { grade: "high", reasons: high };
  }

  // 2) 주의: 한 가지 강한 신호 또는 약한 신호의 조합
  const caution: string[] = [];
  for (const category of MAIN_CATEGORIES) {
    if (p[category] >= 3) {
      caution.push(CATEGORY_LABELS[category] + " 표현이 뚜렷하게 나타납니다.");
    }
  }
  const moderate = MAIN_CATEGORIES.filter((c) => p[c] >= 2);
  if (moderate.length >= 2) {
    caution.push("서로 다른 두 가지 이상의 위험 유형 표현이 함께 있습니다.");
  }
  if (d.urlLevel === "elevated") {
    caution.push("링크 주소 구조에 의심스러운 특징이 있습니다.");
  }
  if (p.institution_impersonation >= 2 && urlPresent) {
    caution.push("기관·기업 관련 위험 표현과 링크가 함께 있습니다.");
  }
  if (caution.length > 0) {
    return { grade: "caution", reasons: caution };
  }

  // 3) 판단 어려움 / 뚜렷한 위험 신호 없음
  const maxPoints = Math.max(...MAIN_CATEGORIES.map((c) => p[c]));
  if (d.tooShort) {
    return { grade: "uncertain", reasons: ["분석할 내용이 너무 짧아 판단하기 어렵습니다."] };
  }
  if (maxPoints >= 1) {
    return {
      grade: "uncertain",
      reasons: ["약한 위험 신호가 하나 있지만 다른 근거와 겹치지 않아 판단하기 어렵습니다."],
    };
  }
  if (d.onlyUrl) {
    return { grade: "uncertain", reasons: ["링크만 있어 메시지 내용으로는 판단하기 어렵습니다."] };
  }
  const reasons = ["알려진 위험 표현과 링크 주소 구조에서 뚜렷한 위험 신호를 찾지 못했습니다."];
  if (d.hasBenignContext) {
    reasons.push("정상 안내(인증번호·거래·배송 알림 등)의 형태로 보이는 표현이 있어 해당 표현은 위험 근거에서 뺐습니다.");
  }
  return { grade: "no_clear_signal", reasons };
}

/**
 * 일반 문장에 잘 쓰지 않는 장식·도형 기호, 동그라미 문자, 이모지.
 * 이것만으로는 위험 근거가 아니다(하트는 정상 문자에도 흔함). 통계 모델이 스팸과 비슷하다고 볼 때만 함께 쓴다.
 * 검증 행에서 '모델만 의심' + 이 기호 1개 이상: 스미싱·스팸 190건, 정상 0건(직접 쓴 정상 문장도 0건).
 */
const ODD_SYMBOLS = /[♥♡★☆▶◀►◄▷◁◆◇■□●○◎※→←↑↓↔♠♣♤♧♦♢☞☜✔✓✚✦✧❤❣☎℡™®©ⓐ-ⓩⒶ-Ⓩ①-⑳㉠-㉻\u{1F300}-\u{1FAFF}]/gu;

function countOddSymbols(text: string): number {
  return (text.match(ODD_SYMBOLS) ?? []).length;
}

function applyModel(
  decision: { grade: Grade; reasons: string[] },
  model: ModelSignal,
  blockedByBenign: boolean,
  spamStyle = false,
): { grade: Grade; reasons: string[] } {
  if (
    model.status === "ok" &&
    model.band === "high" &&
    (decision.grade === "no_clear_signal" || decision.grade === "uncertain")
  ) {
    if (blockedByBenign) {
      return {
        grade: decision.grade,
        reasons: [
          ...decision.reasons,
          "통계 모델의 참고 신호는 높았지만, 정상 안내 문자의 형태가 확인되고 의심스러운 링크가 없어 등급에는 반영하지 않았습니다.",
        ],
      };
    }
    // 모델이 높게 보고 이상한 기호까지 섞여 있으면 스팸 문자의 특징과 맞으므로 '주의'로 올린다.
    if (spamStyle) {
      return {
        grade: "caution",
        reasons: [
          ...decision.reasons.filter((r) => !r.startsWith("알려진 위험 표현과")),
          "통계 모델이 알려진 스팸 문자와 비슷하다고 봤고, 일반 문장에 잘 쓰지 않는 기호(♥, ▶ 같은 것)가 섞여 있어 스팸 문자의 특징과 맞습니다.",
        ],
      };
    }
    // 모델 혼자서는 '판단 어려움'까지만 올린다. 직접 쓴 정상 가족 대화의 35% 를 모델이 높게 보는 등
    // 일상 문장 오탐이 커서, 규칙 근거 없이 '주의'로 겁주지 않기 위해서다(사용자 결정, 중간안).
    return {
      grade: "uncertain",
      reasons: [
        ...decision.reasons.filter((r) => !r.startsWith("알려진 위험 표현과")),
        "통계 모델은 이 문장이 알려진 스팸·스미싱 문자와 비슷하다고 봤지만, 위험 표현 근거는 찾지 못해 판단하기 어렵습니다. 링크·송금·정보 입력은 하지 말고 다른 방법으로 확인해 보세요.",
      ],
    };
  }
  return decision;
}

/** 돈이나 정보를 노리는 유형(스미싱·피싱) */
const SMISHING_CATEGORIES: readonly RiskCategory[] = [
  "family_impersonation",
  "money_request",
  "institution_impersonation",
  "credential_request",
  "remote_app",
];
/** 원치 않는 불법·광고성 유형(스팸) */
const SPAM_CATEGORIES: readonly RiskCategory[] = ["illegal_gambling", "evasion"];
/** 링크 자체가 다른 곳을 사칭하는 구조(피싱 쪽 신호) */
const PHISHING_URL_FLAGS = new Set(["brand_mismatch", "brand_lookalike", "ip_host", "userinfo_at", "punycode"]);

function classifyMessage(
  grade: Grade,
  points: Record<RiskCategory, number>,
  urls: readonly UrlFinding[],
  spamStyle = false,
): MessageType {
  // '판단 어려움'·'뚜렷한 위험 신호 없음'에는 유형을 붙이지 않는다(등급과 유형 표시가 어긋나지 않게).
  if (grade !== "high" && grade !== "caution") {
    return "none";
  }
  if (SMISHING_CATEGORIES.some((c) => points[c] > 0)) {
    return "smishing";
  }
  if (urls.some((u) => u.flags.some((f) => PHISHING_URL_FLAGS.has(f.id)))) {
    return "smishing";
  }
  if (SPAM_CATEGORIES.some((c) => points[c] > 0) || spamStyle) {
    return "spam";
  }
  return "suspicious";
}

function buildLimitations(model: ModelSignal, truncated: boolean, analyzedLength: number): string[] {
  const list = [
    "어떤 등급도 메시지가 안전하다거나 사기라고 확정하지 않습니다.",
    "발신자 인증 정보가 없어 실제 발신자가 누구인지는 확인할 수 없습니다.",
    "미리 정의한 표현 규칙과 링크 주소 모양만 검사합니다. 새로운 수법이나 변형된 표현은 놓칠 수 있고, 정상 메시지가 '주의'로 표시될 수도 있습니다.",
    "링크는 접속하거나 실시간으로 조회하지 않고 주소 모양만 분석했습니다.",
  ];
  if (model.status === "ok") {
    list.push(
      "통계 모델 신호는 학습 데이터에 있던 스팸·스미싱 유형과 비슷한지 본 참고용이며 피싱 확률이 아닙니다. 처음 보는 수법에는 약하고, 업무 안내 같은 정상 문장을 높게 볼 때도 있습니다.",
    );
  } else {
    list.push("통계 모델 신호는 아직 연결되지 않았습니다.");
  }
  if (truncated) {
    list.push("입력이 길어 앞부분 " + analyzedLength + "자만 분석했습니다.");
  }
  return list;
}

// ---------------------------------------------------------------- 공개 함수
export function analyzeMessage(input: string, options: AnalysisOptions = {}): AnalysisResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const model: ModelSignal = options.model ?? {
    status: "unavailable",
    reason: "통계 모델이 아직 연결되지 않았습니다.",
  };

  const clipped = clip(input, maxLength);
  const text = clipped.text;
  const compact = buildView(text, true);
  const spaced = buildView(text, false);
  const urlAnalysis = analyzeUrls(text, spaced);
  const urlLevel = maxUrlLevel(urlAnalysis.findings);

  // 규칙 일치를 모으고, 정상 맥락·부정 문맥이면 점수에서 뺀다.
  const benign = detectBenign(text, compact, urlAnalysis.findings);
  const active: Evidence[] = [];
  const suppressed: SuppressedEvidence[] = [];
  for (const match of [...collectMatches(text, compact), ...collectEvasion(text)]) {
    const benignId = benign.suppress.get(match.evidence.ruleId);
    if (benignId) {
      suppressed.push({ ...match.evidence, suppressedBy: benignId });
      continue;
    }
    if (match.negatable && isNegated(compact.text, match.compactEnd)) {
      suppressed.push({ ...match.evidence, suppressedBy: "negation" });
      continue;
    }
    active.push(match.evidence);
  }

  // 인증번호·개인정보 입력 안내가 의심 요소 있는 링크와 함께 오면 위험 근거로 올린다.
  if (urlLevel !== "none") {
    const entry = active.find(
      (e) => e.ruleId === "cred.entry_request" || e.ruleId === "cred.personal_info_entry",
    );
    if (entry) {
      active.push({
        ...entry,
        ruleId: "cred.entry_with_link",
        label: "링크로 인증·정보 입력 유도",
        reason: "인증번호·카드번호·개인정보 입력을 요구하면서 의심 요소가 있는 링크가 함께 있습니다.",
        weight: 2,
        kind: "signal",
      });
    }
  }

  active.sort((a, b) => a.start - b.start || a.end - b.end);
  suppressed.sort((a, b) => a.start - b.start || a.end - b.end);

  const { points, present } = scoreEvidence(active);

  const categories: CategorySummary[] = RISK_CATEGORIES.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    points: points[category],
    evidenceCount: active.filter((e) => e.category === category).length,
    suppressedCount: suppressed.filter((e) => e.category === category).length,
  }));

  const tooShort = compact.text.length < SHORT_LIMIT;
  const hasBenignContext = benign.contexts.length > 0;
  // 통계 모델이 높게 보고, 일반 문장에 잘 쓰지 않는 기호가 섞여 있으면 스팸 문체로 본다(정상 안내 문맥이면 제외).
  const spamStyle =
    model.status === "ok" && model.band === "high" && !benign.blocksModel && countOddSymbols(text) >= 1;
  const decision = applyModel(
    decide({
      points,
      present,
      urlCount: urlAnalysis.count,
      urlLevel,
      onlyUrl: urlAnalysis.onlyUrl,
      tooShort,
      hasBenignContext,
    }),
    model,
    benign.blocksModel,
    spamStyle,
  );

  // 문장만의 판단: 링크와 링크 때문에 생긴 근거를 빼고 같은 표로 다시 판단한다.
  let textDecision: { grade: Grade; reasons: string[] };
  if (urlAnalysis.onlyUrl) {
    textDecision = { grade: "uncertain", reasons: ["링크만 있어 문장 내용으로는 판단할 수 없습니다."] };
  } else {
    const textOnly = scoreEvidence(active.filter((e) => e.ruleId !== "cred.entry_with_link"));
    // 통계 모델은 링크를 지우고 문장만 보므로, 모델 신호는 문장 판단에도 같은 방식으로 반영한다.
    textDecision = applyModel(
      decide({
        points: textOnly.points,
        present: textOnly.present,
        urlCount: 0,
        urlLevel: "none",
        onlyUrl: false,
        tooShort,
        hasBenignContext,
      }),
      model,
      benign.blocksModel,
      spamStyle,
    );
  }

  const messageType = classifyMessage(decision.grade, points, urlAnalysis.findings, spamStyle);

  // 종합은 '주의' 이상인데 문장만으로는 아닐 때: 위험 판단이 링크 때문임을 문장 카드에 밝힌다.
  // (모델 신호와 정상 문맥 처리는 종합·문장에 똑같이 적용되므로 차이는 링크에서만 생긴다.)
  const isFlagged = (g: Grade) => g === "high" || g === "caution";
  let textDisplay = GRADE_LABELS[textDecision.grade];
  let textNote: string | null = null;
  if (isFlagged(decision.grade) && !isFlagged(textDecision.grade)) {
    if (urlAnalysis.onlyUrl) {
      textDisplay = "링크만 있음";
      textNote = "메시지에 링크만 있어 문장으로는 판단할 수 없고, 위험 판단은 링크 분석 결과 때문이에요.";
    } else if (textDecision.grade === "uncertain") {
      textDisplay = "약한 위험 표현 있음";
      textNote = "문장만 보면 근거가 약하지만, 의심스러운 링크와 함께 있어 종합적으로 위험하다고 판단했어요.";
    } else {
      textDisplay = "위험 표현 없음";
      textNote = "문장에서는 위험 표현을 찾지 못했고, 위험 판단은 링크 분석 결과 때문이에요.";
    }
  }

  return {
    engineVersion: ENGINE_VERSION,
    input: { length: input.length, analyzedLength: text.length, truncated: clipped.truncated },
    grade: decision.grade,
    gradeLabel: GRADE_LABELS[decision.grade],
    reasons: decision.reasons,
    text: {
      grade: textDecision.grade,
      gradeLabel: GRADE_LABELS[textDecision.grade],
      reasons: textDecision.reasons,
      displayLabel: textDisplay,
      note: textNote,
    },
    messageType,
    messageTypeLabel: MESSAGE_TYPE_LABELS[messageType],
    categories,
    evidence: active,
    suppressed,
    benignContexts: benign.contexts,
    urls: urlAnalysis.findings,
    urlSummary: { count: urlAnalysis.count, level: urlLevel, onlyUrl: urlAnalysis.onlyUrl },
    model,
    limitations: buildLimitations(model, clipped.truncated, text.length),
  };
}
