// GET /api/health — Supabase 연결 상태 진단(키·주소 값은 알려 주지 않고 '있음/형식 맞음/분류'만 알려 준다).
// 제보 저장이 안 될 때 원인을 찾기 위한 임시 진단용이다. 원인을 찾은 뒤에는 지워도 된다.
// 저장되는 것은 없다(제보 함수에 일부러 잘못된 사용자 구분값을 보내 곧바로 거절되게 한다).
import { connection } from "next/server";
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

function kst(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) {
    return "알 수 없음";
  }
  return d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }) + " (한국 시간)";
}

export async function GET(): Promise<Response> {
  await connection(); // 요청마다 새로 실행(예전 결과가 고정되지 않게 한다).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  // 주소의 '모양'만 알려 준다(값 자체는 알려 주지 않는다).
  const stripped = url.trim().replace(/^["']+|["']+$/g, "").trim().replace(/\/+$/, "");
  let urlShape: Record<string, unknown>;
  try {
    const parsed = new URL(stripped);
    urlShape = {
      protocol: parsed.protocol,
      hostEndsWithSupabaseCo: parsed.hostname.endsWith(".supabase.co"),
      hostLabelLength: parsed.hostname.split(".")[0].length,
      hasPath: parsed.pathname !== "/" && parsed.pathname !== "",
      pathLength: parsed.pathname.length,
      hasQueryOrHash: parsed.search.length > 0 || parsed.hash.length > 0,
    };
  } catch {
    urlShape = { parseable: false };
  }
  const env = {
    // 어느 배포가 실행 중인지(앞 7자리). GitHub 커밋 번호와 같으면 최신 코드다.
    deployedCommit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
    builtAt: kst(process.env.BUILD_TIME), // 이 코드가 배포(빌드)된 시각
    checkedAt: kst(new Date().toISOString()), // 지금 이 화면을 확인한 시각
    urlShape,
    urlRawLength: url.length,
    urlStartsWithQuoteOrSpace: /^["'\s]/.test(url),
    urlEndsWith: url.length === 0 ? "없음" : /\/$/.test(url) ? "슬래시(/)" : /["']$/.test(url) ? "따옴표" : /\s$/.test(url) ? "공백" : "일반 글자",
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
