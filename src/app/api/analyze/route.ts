// POST /api/analyze — 메시지를 받아 분석 결과를 돌려준다.
// 개인정보 보호: 입력 원문과 URL 은 저장하지 않고, 로그에도 남기지 않는다(오류 로그 포함).
import { analyzeMessage, DEFAULT_MAX_LENGTH } from "@/lib/analysis";
import { getModelSignal } from "@/lib/analysis/model";

const MAX_BODY_BYTES = 20_000;

const HEADERS = { "Cache-Control": "no-store" };

type ErrorCode =
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_json"
  | "invalid_input"
  | "empty_input"
  | "text_too_long"
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

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "invalid_json", "요청 형식이 올바르지 않습니다.");
    }

    const text =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).text
        : undefined;
    if (typeof text !== "string") {
      return fail(400, "invalid_input", "text 항목에 문자열을 넣어 주세요.");
    }
    if (text.trim().length === 0) {
      return fail(400, "empty_input", "분석할 내용을 입력해 주세요.");
    }
    if (text.length > DEFAULT_MAX_LENGTH) {
      return fail(
        413,
        "text_too_long",
        "내용이 너무 깁니다. " + DEFAULT_MAX_LENGTH + "자 이내로 줄여 주세요.",
      );
    }

    // 통계 모델은 참고 신호다. 엔진은 모델이 '높음'이어도 등급을 '주의'까지만 올린다.
    const result = analyzeMessage(text, { model: getModelSignal(text) });
    return Response.json({ ok: true, result }, { headers: HEADERS });
  } catch {
    // 입력 내용이 섞일 수 있으므로 오류 객체를 로그에 남기지 않는다.
    return fail(500, "internal_error", "분석 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
}
