/**
 * 피싱 탐지 레이더 - 분석 엔진의 입출력 타입.
 *
 * 설계 원칙
 * - 엔진은 순수 함수다. 외부 접속, 저장, 로그 출력을 하지 않는다.
 * - 위치(start, end)는 항상 "사용자가 넣은 원문"의 UTF-16 오프셋이다.
 * - 규칙 근거와 URL 구조 분석, 통계 모델 신호를 서로 다른 필드에 분리해 담는다.
 * - 통계 모델(model.ts)은 엔진과 분리돼 있다. 모델 결과는 호출하는 쪽(API)이 넘겨줄 때만 반영하고,
 *   엔진이 임의로 만들어 내지 않는다. 모델 점수는 피싱 확률이 아니다.
 */

// ---------------------------------------------------------------- 위험 유형
export const RISK_CATEGORIES = [
  "family_impersonation",
  "money_request",
  "institution_impersonation",
  "credential_request",
  "remote_app",
  "illegal_gambling",
  "evasion",
  "pressure",
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/** 등급 판단의 중심이 되는 5가지 유형. pressure(재촉·협박)는 보조 신호다. */
export const MAIN_CATEGORIES: readonly RiskCategory[] = [
  "family_impersonation",
  "money_request",
  "institution_impersonation",
  "credential_request",
  "remote_app",
  "illegal_gambling",
  "evasion",
];

export const CATEGORY_LABELS: Record<RiskCategory, string> = {
  family_impersonation: "가족·지인 사칭",
  money_request: "송금·금전 요구",
  institution_impersonation: "금융기관·공공기관·기업 사칭",
  credential_request: "인증번호·개인정보 요구",
  remote_app: "원격제어 앱 설치 유도",
  illegal_gambling: "불법 도박·불법 사이트 유도",
  evasion: "탐지를 피하려는 위장 문자",
  pressure: "재촉·협박 표현(보조 신호)",
};

// ---------------------------------------------------------------- 등급
export type Grade = "high" | "caution" | "no_clear_signal" | "uncertain";

export const GRADE_LABELS: Record<Grade, string> = {
  high: "높음",
  caution: "주의",
  no_clear_signal: "뚜렷한 위험 신호 없음",
  uncertain: "판단 어려움",
};

// ---------------------------------------------------------------- 규칙 근거
/** signal: 위험 근거로 점수에 반영, context: 같은 유형의 signal 이 있을 때만 보조 반영 */
export type RuleKind = "signal" | "context";

export interface Evidence {
  ruleId: string;
  category: RiskCategory;
  /** 화면에 보여 줄 짧은 이름 */
  label: string;
  /** 왜 위험 신호로 봤는지에 대한 설명 */
  reason: string;
  weight: number;
  kind: RuleKind;
  /** 원문에서의 시작 위치(포함) */
  start: number;
  /** 원문에서의 끝 위치(제외) */
  end: number;
  /** 원문에서 잘라 낸 문구. 항상 원문.slice(start, end) 와 같다. */
  text: string;
  /** 공백 제거·NFKC·소문자 정규화된 일치 문자열(디버깅과 검증용) */
  normalized: string;
}

/** 일치했지만 부정·주의 문맥이나 정상 안내 문맥 때문에 점수에서 뺀 근거 */
export interface SuppressedEvidence extends Evidence {
  /** "negation" 또는 정상 맥락 ID */
  suppressedBy: string;
}

export interface BenignContext {
  id: string;
  label: string;
  reason: string;
  start: number;
  end: number;
  text: string;
}

export interface CategorySummary {
  category: RiskCategory;
  label: string;
  /** 유형별 점수. signal 근거가 없으면 0 */
  points: number;
  evidenceCount: number;
  suppressedCount: number;
}

// ---------------------------------------------------------------- URL 분석
export type UrlLevel = "none" | "low" | "elevated";

export interface UrlFlag {
  id: string;
  label: string;
  reason: string;
  points: number;
}

export interface UrlFinding {
  /** 원문에서 잘라 낸 주소 문자열 */
  text: string;
  start: number;
  end: number;
  scheme: "http" | "https" | null;
  host: string;
  registrableDomain: string;
  /** 주소 글자 수(표시용). 데이터상 긴 주소는 정상 안내에 더 많아 점수에는 넣지 않는다. */
  length: number;
  /** 등록 도메인 앞의 하위 도메인 단계 수(예: a.b.example.com -> 2). IP 주소는 0. */
  subdomainDepth: number;
  flags: UrlFlag[];
  points: number;
  level: UrlLevel;
}

export interface UrlSummary {
  count: number;
  level: UrlLevel;
  /** 링크를 빼고 나면 거의 아무 내용도 남지 않는 메시지 */
  onlyUrl: boolean;
}

// ---------------------------------------------------------------- 통계 모델 신호
export type ModelBand = "high" | "medium" | "low" | "unreliable";

/**
 * 학습 모델이 만든 신호. 아직 모델이 없으므로 엔진은 기본값으로 unavailable 을 돌려준다.
 * rawScore 는 내부 확인용이며 피싱 확률로 표시하면 안 된다.
 */
export type ModelSignal =
  | { status: "unavailable"; reason: string }
  | { status: "ok"; band: ModelBand; modelVersion: string; rawScore?: number };

// ---------------------------------------------------------------- 입력 옵션과 최종 결과
export interface AnalysisOptions {
  /** 호출하는 쪽이 계산해 넘기는 모델 신호. 없으면 unavailable 로 처리한다. */
  model?: ModelSignal;
  /** 분석할 최대 길이(UTF-16 단위). 기본 3000 */
  maxLength?: number;
}

/** 링크를 빼고 문장 표현만으로 본 판단. 링크 판단은 urlSummary 와 urls 에 따로 있다. */
export interface TextAssessment {
  grade: Grade;
  gradeLabel: string;
  reasons: string[];
  /**
   * 화면에 보여 줄 문장 카드 이름. 보통 gradeLabel 과 같지만, 종합은 위험한데 문장만으로는 위험하지 않을 때
   * '약한 위험 표현 있음' / '위험 표현 없음' 처럼 바꿔 종합 판단과 모순처럼 보이지 않게 한다.
   */
  displayLabel: string;
  /** 종합 판단과 문장 판단이 다른 이유(위험 판단이 링크 때문일 때). 없으면 null */
  note: string | null;
}

// ---------------------------------------------------------------- 메시지 유형(스미싱 vs 스팸)
/**
 * smishing: 사칭·금전·인증정보·원격앱처럼 돈이나 정보를 빼내려는 표현이 있음(스미싱·피싱 의심)
 * spam: 불법 도박·위장 광고처럼 원치 않는 광고성 표현이 있음(불법·광고성 스팸 의심)
 * suspicious: 위험 신호는 있지만 어느 쪽인지 가리기 어려움(통계 모델·링크 구조만으로 의심)
 * none: 뚜렷한 위험 신호 없음
 * 어떤 유형도 확정이 아니라 '의심'이다.
 */
export type MessageType = "smishing" | "spam" | "suspicious" | "none";

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  smishing: "스미싱·피싱으로 의심돼요",
  spam: "불법·광고성 스팸으로 보여요",
  suspicious: "스팸이나 스미싱일 수 있어요",
  none: "",
};

export interface AnalysisResult {
  engineVersion: string;
  input: { length: number; analyzedLength: number; truncated: boolean };
  grade: Grade;
  gradeLabel: string;
  /** 등급을 정한 이유(사람이 읽을 수 있는 문장) */
  reasons: string[];
  /** 문장 표현만의 판단(링크 영향 제외). 문장만 보는 통계 모델 신호는 여기에도 반영한다. */
  text: TextAssessment;
  /** 스미싱인지 스팸인지(의심 수준) */
  messageType: MessageType;
  messageTypeLabel: string;
  categories: CategorySummary[];
  /** 점수에 반영된 규칙 근거(원문 위치 오름차순) */
  evidence: Evidence[];
  suppressed: SuppressedEvidence[];
  benignContexts: BenignContext[];
  urls: UrlFinding[];
  urlSummary: UrlSummary;
  model: ModelSignal;
  /** 결과를 해석할 때 알아야 할 한계 */
  limitations: string[];
}
