// 요청마다 Supabase 로그인 세션(쿠키)을 갱신하는 Proxy.
// Next.js 16에서는 middleware 대신 proxy 파일 규칙을 사용한다.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv, hasSupabaseEnv } from "@/lib/supabase/env";

export async function proxy(request: NextRequest) {
  // 환경변수가 아직 없으면 사이트가 멈추지 않도록 그대로 통과시킨다.
  if (!hasSupabaseEnv()) {
    return NextResponse.next({ request });
  }

  const { url, publishableKey } = getSupabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // 토큰 갱신을 트리거한다. createServerClient와 이 호출 사이에 다른 코드를 넣지 말 것.
  await supabase.auth.getClaims();

  return response;
}

export const config = {
  matcher: [
    // 정적 파일과 이미지는 제외한다.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
