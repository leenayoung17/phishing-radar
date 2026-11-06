// GET /api/health — Supabase 연결 상태 진단(키·주소 값은 알려 주지 않고 '있음/형식 맞음/분류'만 알려 준다).
// 제보 저장이 안 될 때 원인을 찾기 위한 임시 진단용이다. 원인을 찾은 뒤에는 지워도 된다.
// 저장되는 것은 없다(제보 함수에 일부러 잘못된 사용자 구분값을 보내 곧바로 거절되게 한다).
import { SUPABASE_KIND_HINTS, classifySupabaseError } from "@/lib/supabase/diagnose";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

const HEADERS = { "Cache-Control": "no-store" };

function keyKind(key: string): string {
  if (key.startsWith("sb_publishable_")) {
    return "publishable(정상)";
  }
  if (key.startsWith("sb_secret_")) {
    return "secret(잘못됨: 비밀 키를 넣으면 안 됩니다)";
  }
  if (key.startsWith("eyJ")) {
    return "legacy(예전 방식 키)";
  }
  return "알 수 없는 형식";
}

export async function GET(): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  const env = {
    urlSet: url.length > 0,
    urlFormatOk: /^https:\/\/[a-z0-9]{15,30}\.supabase\.co$/.test(url),
    urlHasSpaceOrQuoteOrSlash: /^["'\s]|["'\s/]$/.test(url),
    keySet: key.length > 0,
    keyKind: key ? keyKind(key) : "없음",
    keyHasSpaceOrQuote: /^["'\s]|["'\s]$/.test(key),
    reportHashSecretSet: Boolean(process.env.REPORT_HASH_SECRET),
  };

  if (!hasSupabaseEnv()) {
    return Response.json(
      { ok: false, step: "env", env, hint: "Supabase 설정값(환경변수)이 없습니다. Vercel 에 등록하고 다시 배포하세요." },
      { headers: HEADERS },
    );
  }

  try {
    const supabase = await createClient();
    // 일부러 잘못된 사용자 구분값(x)을 보내 함수가 곧바로 'invalid_client' 로 거절하게 한다(저장되지 않음).
    const { data, error, status } = await supabase.rpc("submit_report", {
      p_id: "00000000-0000-4000-8000-000000000000",
      p_report_type: "new_technique",
      p_description: "",
      p_analysis_summary: null,
      p_message_consent: false,
      p_message_text: null,
      p_engine_version: null,
      p_model_version: null,
      p_is_test: true,
      p_client_hash: "x",
      p_reporter_id: null,
    });
    if (error) {
      const info = classifySupabaseError(error, status);
      return Response.json(
        { ok: false, step: "rpc", env, error: info, hint: SUPABASE_KIND_HINTS[info.kind] },
        { headers: HEADERS },
      );
    }
    const expected = data === "invalid_client";
    return Response.json(
      {
        ok: expected,
        step: "rpc",
        env,
        rpcAnswer: typeof data === "string" ? data.slice(0, 30) : "unexpected",
        hint: expected ? "Supabase 연결과 제보 함수가 정상입니다." : "함수가 예상과 다른 값을 돌려줬습니다.",
      },
      { headers: HEADERS },
    );
  } catch {
    return Response.json(
      { ok: false, step: "exception", env, hint: "Supabase 클라이언트를 만드는 중 예외가 났습니다." },
      { headers: HEADERS },
    );
  }
}
