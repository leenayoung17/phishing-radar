// 사용자 제보 공통 정의(화면과 API 가 함께 쓴다).
// 분석 요약에는 메시지 글자·주소 문자열을 넣지 않는다(등급, 유형, 규칙 이름, 링크 특징만).
import { RISK_CATEGORIES, type Grade, type MessageType, type ModelBand, type UrlLevel } from "./analysis/types";

export const REPORT_TYPES = ["analysis_failure", "missed_detection", "false_positive", "new_technique"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_INFO: Record<ReportType, { label: string; help: string }> = {
  analysis_failure: { label: "분석 실패", help: "메시지 분석이 제대로 되지 않았어요" },
  missed_detection: { label: "미탐", help: "실제 피싱·스미싱인데 탐지하지 못했어요" },
  false_positive: { label: "오탐", help: "정상 메시지를 피싱·스미싱으로 잘못 판단했어요" },
  new_technique: { label: "신종 수법", help: "기존 유형으로 분류하기 어려운 새로운 수법이에요" },
};

/** 제보자 브라우저 익명 번호를 브라우저에 기억해 둘 때 쓰는 이름 */
export const REPORTER_ID_STORAGE_KEY = "phishing-radar.reporter-id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 익명 번호 형식(UUID, 소문자)이 맞으면 그대로, 아니면 null. 이름·전화번호 같은 값이 들어오지 못하게 한다. */
export function normalizeReporterId(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const id = v.trim().toLowerCase();
  return UUID_RE.test(id) ? id : null;
}

export const DESCRIPTION_MAX = 1000;
export const MESSAGE_MAX = 3000;

/**
 * 저장 전에 개인정보로 보이는 숫자·주소를 가린다(추가 설명과 동의한 원문 모두).
 * 형식은 남겨 두어(예: 010-****-****) 어떤 정보가 있었는지는 알 수 있게 한다. 링크 주소는 분석에 필요해 남긴다.
 * 완벽하지 않으므로 화면에서도 '개인정보를 적지 마세요'라고 안내한다.
 */
export function maskPersonalInfo(text: string): string {
  return (
    text
      // 주민등록번호
      .replace(/\b\d{6}\s?-\s?[1-8]\d{6}\b/g, "******-*******")
      // 카드번호(4-4-4-4)
      .replace(/\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/g, "****-****-****-****")
      // 휴대전화
      .replace(/\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g, "010-****-****")
      // 일반 전화(지역번호·대표번호)
      .replace(/\b0\d{1,2}[-. )]\d{3,4}[-. ]\d{4}\b/g, "0**-****-****")
      // 계좌번호처럼 보이는 하이픈 숫자 묶음
      .replace(/\b\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,6})?\b/g, "***-***-****")
      // 이메일
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***")
  );
}

export interface AnalysisSummary {
  engineVersion: string | null;
  grade: Grade | null;
  textGrade: Grade | null;
  messageType: MessageType | null;
  categories: { category: string; points: number }[];
  ruleIds: string[];
  urls: { level: UrlLevel; flags: string[]; length: number; subdomainDepth: number }[];
  model: { status: "ok" | "unavailable"; band: ModelBand | null; modelVersion: string | null } | null;
  inputLength: number | null;
}

const GRADES: Grade[] = ["high", "caution", "uncertain", "no_clear_signal"];
const TYPES: MessageType[] = ["smishing", "spam", "suspicious", "none"];
const LEVELS: UrlLevel[] = ["none", "low", "elevated"];
const BANDS: ModelBand[] = ["high", "medium", "low", "unreliable"];

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function shortId(v: unknown, max = 40): string | null {
  return typeof v === "string" && v.length <= max && /^[A-Za-z0-9._-]+$/.test(v) ? v : null;
}

function int(v: unknown, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0;
}

/**
 * 화면이 보낸 분석 결과에서 허용된 정보만 골라 낸다. 원문 조각(evidence.text), 주소(url.text·host),
 * 정상 문맥 문구 같은 글자 정보는 버린다. 형식이 맞지 않으면 null.
 */
export function buildAnalysisSummary(input: unknown): AnalysisSummary | null {
  const r = obj(input);
  if (!r) {
    return null;
  }
  const text = obj(r.text);
  const model = obj(r.model);
  const inputInfo = obj(r.input);
  const categories = Array.isArray(r.categories)
    ? r.categories
        .map(obj)
        .filter((c): c is Record<string, unknown> => c !== null)
        .filter((c) => (RISK_CATEGORIES as readonly string[]).includes(String(c.category)))
        .map((c) => ({ category: String(c.category), points: int(c.points, 99) }))
        .slice(0, RISK_CATEGORIES.length)
    : [];
  const ruleIds = Array.isArray(r.evidence)
    ? Array.from(
        new Set(
          r.evidence
            .map(obj)
            .map((e) => (e ? shortId(e.ruleId, 60) : null))
            .filter((id): id is string => id !== null),
        ),
      ).slice(0, 80)
    : [];
  const urls = Array.isArray(r.urls)
    ? r.urls
        .map(obj)
        .filter((u): u is Record<string, unknown> => u !== null)
        .slice(0, 10)
        .map((u) => ({
          level: pick(u.level, LEVELS) ?? "none",
          flags: Array.isArray(u.flags)
            ? u.flags
                .map(obj)
                .map((f) => (f ? shortId(f.id) : null))
                .filter((id): id is string => id !== null)
                .slice(0, 20)
            : [],
          length: int(u.length, 5000),
          subdomainDepth: int(u.subdomainDepth, 50),
        }))
    : [];
  return {
    engineVersion: shortId(r.engineVersion),
    grade: pick(r.grade, GRADES),
    textGrade: text ? pick(text.grade, GRADES) : null,
    messageType: pick(r.messageType, TYPES),
    categories,
    ruleIds,
    urls,
    model: model
      ? {
          status: model.status === "ok" ? "ok" : "unavailable",
          band: pick(model.band, BANDS),
          modelVersion: shortId(model.modelVersion),
        }
      : null,
    inputLength: inputInfo ? int(inputInfo.length, 100000) : null,
  };
}
