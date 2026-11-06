// Supabase 공개 환경변수를 읽는 공통 함수.
// 값이 없으면 어떤 변수가 빠졌는지 알려 주는 오류를 던진다.

// 배포 화면에 값을 붙여 넣을 때 앞뒤 공백·따옴표, 주소 끝의 '/' 가 섞이기 쉽다.
// 그대로 쓰면 요청 경로가 '//rest/v1' 처럼 깨져 404 가 나므로 여기서 정리한다.
function cleanEnvValue(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
}

// 주소는 'https://프로젝트.supabase.co' 까지만 쓴다.
// 'REST 주소'(…/rest/v1/)를 복사해 넣어도 도메인 부분만 남겨, 코드가 붙이는 /rest/v1 과 겹치지 않게 한다.
function normalizeSupabaseUrl(value: string | undefined): string {
  const cleaned = cleanEnvValue(value);
  try {
    return new URL(cleaned).origin;
  } catch {
    return cleaned.replace(/\/+$/, "");
  }
}

export function getSupabaseEnv() {
  const url = normalizeSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const publishableKey = cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

  if (!url || !publishableKey) {
    throw new Error(
      "Supabase 환경변수가 없습니다. .env.local에 NEXT_PUBLIC_SUPABASE_URL과 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY를 설정하세요.",
    );
  }

  return { url, publishableKey };
}

export function hasSupabaseEnv() {
  return Boolean(
    cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      cleanEnvValue(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  );
}
