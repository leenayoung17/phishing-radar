// Supabase 호출이 실패했을 때 '어떤 종류의 문제인지'만 분류한다.
// 오류 메시지·상세 내용에는 사용자 입력이나 키가 섞일 수 있어 종류와 오류 코드만 밖으로 내보낸다.

export type SupabaseErrorKind =
  | "network" // 주소가 틀렸거나 서버에 닿지 못함
  | "auth" // 키가 틀렸거나 다른 프로젝트의 키
  | "permission" // 키는 맞지만 이 작업을 할 권한이 없음(RLS·권한 설정)
  | "function_missing" // 표나 함수가 없음(SQL 을 아직 실행하지 않음)
  | "other";

export interface SupabaseErrorInfo {
  kind: SupabaseErrorKind;
  code: string;
  httpStatus: number;
}

export function classifySupabaseError(
  error: { message?: string; code?: string } | null | undefined,
  httpStatus: number | undefined,
): SupabaseErrorInfo {
  const code = (error?.code ?? "").slice(0, 20);
  const message = error?.message ?? "";
  const status = httpStatus ?? 0;
  let kind: SupabaseErrorKind = "other";
  if (["42P01", "42883", "PGRST202", "PGRST205", "PGRST204"].includes(code)) {
    kind = "function_missing";
  } else if (code === "42501") {
    kind = "permission";
  } else if (status === 401 || status === 403 || /invalid api key|jwt/i.test(message)) {
    kind = "auth";
  } else if (status === 0 || /fetch failed|network|enotfound|econn|timeout/i.test(message)) {
    kind = "network";
  }
  return { kind, code, httpStatus: status };
}

export const SUPABASE_KIND_HINTS: Record<SupabaseErrorKind, string> = {
  network: "Supabase 주소(NEXT_PUBLIC_SUPABASE_URL)가 틀렸거나 서버에 닿지 못합니다.",
  auth: "Supabase 키(NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)가 틀렸거나 다른 프로젝트의 키입니다.",
  permission: "키는 맞지만 이 작업을 할 권한이 없습니다(SQL 권한 설정 확인).",
  function_missing: "제보 함수나 표가 없습니다(SQL 을 실행했는지 확인).",
  other: "원인을 분류하지 못했습니다(오류 코드를 확인하세요).",
};
