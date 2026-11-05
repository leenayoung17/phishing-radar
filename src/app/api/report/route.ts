// POST /api/report — 사용자 제보를 Supabase(reports 테이블)에 저장한다. 로그인 없이 가능.
// 개인정보 보호
//  - 메시지 원문은 사용자가 동의(consent=true)한 경우에만 저장한다.
//  - 분석 결과는 글자 정보를 뺀 요약만 저장한다(src/lib/reports.ts 의 buildAnalysisSummary).
//  - 제보 내용·원문을 서버 로그에 남기지 않는다(오류 로그 포함).
//  - 전화번호·계좌번호 등은 저장 전에 가린다(maskPersonalInfo).
// 횟수 제한
//  - 같은 서버 안에서 먼저 한 번 막고(빠른 1차 제한), DB 함수 submit_report 가 최종으로 센다
//    (같은 사용자 10분 5건, 전체 1분 30건). 사용자 구분값은 IP 를 비밀값으로 섞은 해시이며 IP 원문은 저장하지 않는다.
import { createHmac, randomBytes, randomUUID } from "crypto";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import {
  DESCRIPTION_MAX,
  MESSAGE_MAX,
  REPORT_TYPES,
  buildAnalysisSummary,
  maskPersonalInfo,
  normalizeReporterId,
  type ReportType,
} from "@/lib/reports";

const MAX_BODY_BYTES = 120_000;
const HEADERS = { "Cache-Control": "no-store" };

// 사용자 구분용 비밀값. 서버 전용 환경변수(REPORT_HASH_SECRET)가 없으면 서버가 켜질 때마다 새로 만든다.
const HASH_SECRET = process.env.REPORT_HASH_SECRET || randomBytes(32).toString("hex");

function clientHash(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const day = new Date().toISOString().slice(0, 10); // 날마다 값이 바뀌어 장기 추적이 안 되게 한다.
  return createHmac("sha256", HASH_SECRET).update(ip + "|" + day).digest("hex");
}

// 1차 제한(서버 메모리): 같은 사용자 10분 5건
const LOCAL_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_LIMIT = 5;
const localHits = new Map<string, number[]>();

/** 최근 10분 동안 성공한 제보가 한도에 닿았는지(세기만 하고 기록하지 않음) */
function locallyLimited(hash: string): boolean {
  const now = Date.now();
  const recent = (localHits.get(hash) ?? []).filter((t) => now - t < LOCAL_WINDOW_MS);
  localHits.set(hash, recent);
  return recent.length >= LOCAL_LIMIT;
}

/** 저장에 성공한 제보만 횟수에 넣는다(저장소 오류로 실패한 시도는 세지 않음). */
function recordLocalHit(hash: string): void {
  const now = Date.now();
  const recent = (localHits.get(hash) ?? []).filter((t) => now - t < LOCAL_WINDOW_MS);
  recent.push(now);
  localHits.set(hash, recent);
  if (localHits.size > 5000) {
    for (const [k, v] of localHits) {
      if (v.every((t) => now - t >= LOCAL_WINDOW_MS)) {
        localHits.delete(k);
      }
    }
  }
}

type ErrorCode =
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_type"
  | "invalid_input"
  | "rate_limited"
  | "busy"
  | "storage_not_ready"
  | "storage_unavailable"
  | "internal_error";

function fail(status: number, code: ErrorCode, message: string): Response {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: HEADERS });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return fail(415, "unsupported_media_type", "JSON 형식으로 보내 주세요.");
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return fail(413, "payload_too_large", "요청이 너무 큽니다.");
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return fail(413, "payload_too_large", "요청이 너무 큽니다.");
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return fail(400, "invalid_input", "요청 형식이 올바르지 않습니다.");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return fail(400, "invalid_json", "요청 형식이 올바르지 않습니다.");
    }

    const type = body.type;
    if (typeof type !== "string" || !(REPORT_TYPES as readonly string[]).includes(type)) {
      return fail(400, "invalid_type", "제보 유형을 선택해 주세요.");
    }
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (description.length > DESCRIPTION_MAX) {
      return fail(400, "invalid_input", "추가 설명은 " + DESCRIPTION_MAX + "자 이내로 적어 주세요.");
    }
    const consent = body.consent === true;
    let messageText: string | null = null;
    if (consent) {
      if (typeof body.message !== "string" || body.message.trim().length === 0) {
        return fail(400, "invalid_input", "원문을 함께 보내려면 분석한 메시지가 있어야 합니다.");
      }
      if (body.message.length > MESSAGE_MAX) {
        return fail(400, "invalid_input", "원문은 " + MESSAGE_MAX + "자 이내만 보낼 수 있습니다.");
      }
      messageText = maskPersonalInfo(body.message);
    }
    // 동의하지 않았으면 원문이 함께 와도 쓰지 않는다.
    const summary = buildAnalysisSummary(body.analysis);

    if (!hasSupabaseEnv()) {
      return fail(503, "storage_unavailable", "제보 저장소가 연결되지 않아 지금은 제보를 받을 수 없습니다.");
    }

    const hash = clientHash(request);
    if (locallyLimited(hash)) {
      return fail(429, "rate_limited", "제보를 너무 자주 보내셨습니다. 10분 뒤에 다시 시도해 주세요.");
    }

    const id = randomUUID();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("submit_report", {
      p_id: id,
      p_report_type: type as ReportType,
      p_description: maskPersonalInfo(description),
      p_analysis_summary: summary,
      p_message_consent: consent,
      p_message_text: messageText,
      p_engine_version: summary?.engineVersion ?? null,
      p_model_version: summary?.model?.modelVersion ?? null,
      p_is_test: body.isTest === true,
      p_client_hash: hash,
      // 브라우저가 만든 익명 번호. 형식이 맞지 않으면 저장하지 않는다.
      p_reporter_id: normalizeReporterId(body.reporterId),
    });
    if (error) {
      // 내용이 섞일 수 있으므로 오류 내용은 로그에 남기지 않는다.
      const notReady = ["42P01", "42883", "PGRST202", "PGRST205", "PGRST204"].includes(error.code ?? "");
      return notReady
        ? fail(503, "storage_not_ready", "제보 저장소가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.")
        : fail(503, "storage_unavailable", "제보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    if (data === "rate_limited") {
      return fail(429, "rate_limited", "제보를 너무 자주 보내셨습니다. 10분 뒤에 다시 시도해 주세요.");
    }
    if (data === "busy") {
      return fail(503, "busy", "지금 제보가 몰리고 있습니다. 1분 뒤에 다시 시도해 주세요.");
    }
    if (data !== "ok") {
      return fail(503, "storage_unavailable", "제보를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
    recordLocalHit(hash);
    return Response.json({ ok: true, reportId: id }, { headers: HEADERS });
  } catch {
    return fail(500, "internal_error", "제보 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
