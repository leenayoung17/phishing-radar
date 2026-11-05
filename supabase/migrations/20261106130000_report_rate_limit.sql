-- 피싱 탐지 레이더: 제보 횟수 제한
-- 실행 방법: Supabase 대시보드 > SQL Editor 에 붙여 넣고 Run (한 번만 실행)
--
-- 바뀌는 점
--  1) 제보는 이제 submit_report 함수로만 넣을 수 있다(표에 직접 넣는 길은 막는다).
--  2) 함수 안에서 횟수를 센다: 같은 사용자 10분에 5건, 전체 1분에 30건까지.
--  3) 사용자 구분값(client_hash)은 서버가 IP 를 비밀값으로 섞어 만든 값이다(IP 원문은 저장하지 않음).
--     구분값은 하루가 지나면 자동으로 지운다.

create table if not exists public.report_rate (
  id bigserial primary key,
  client_hash text not null check (char_length(client_hash) = 64),
  created_at timestamptz not null default now()
);
create index if not exists report_rate_client_idx on public.report_rate (client_hash, created_at desc);
create index if not exists report_rate_created_idx on public.report_rate (created_at);

alter table public.report_rate enable row level security;
revoke all on public.report_rate from anon, authenticated;

create or replace function public.submit_report(
  p_id uuid,
  p_report_type text,
  p_description text,
  p_analysis_summary jsonb,
  p_message_consent boolean,
  p_message_text text,
  p_engine_version text,
  p_model_version text,
  p_is_test boolean,
  p_client_hash text
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recent_client integer;
  recent_all integer;
begin
  if p_client_hash is null or char_length(p_client_hash) <> 64 then
    return 'invalid_client';
  end if;

  -- 하루 지난 구분값은 지운다.
  delete from public.report_rate where created_at < now() - interval '1 day';

  select count(*) into recent_client
    from public.report_rate
   where client_hash = p_client_hash and created_at > now() - interval '10 minutes';
  if recent_client >= 5 then
    return 'rate_limited';
  end if;

  select count(*) into recent_all
    from public.report_rate
   where created_at > now() - interval '1 minute';
  if recent_all >= 30 then
    return 'busy';
  end if;

  -- reports 표의 검사 규칙(유형·글자 수·원문 동의)은 그대로 적용된다.
  insert into public.reports (id, report_type, description, analysis_summary, message_consent,
                              message_text, engine_version, model_version, is_test)
  values (p_id, p_report_type, coalesce(p_description, ''), p_analysis_summary, coalesce(p_message_consent, false),
          p_message_text, p_engine_version, p_model_version, coalesce(p_is_test, false));

  insert into public.report_rate (client_hash) values (p_client_hash);
  return 'ok';
end;
$$;

revoke all on function public.submit_report(uuid, text, text, jsonb, boolean, text, text, text, boolean, text) from public;
grant execute on function public.submit_report(uuid, text, text, jsonb, boolean, text, text, text, boolean, text)
  to anon, authenticated;

-- 표에 직접 넣는 길을 막는다(이제 함수로만 제보 가능).
revoke insert on public.reports from anon, authenticated;
drop policy if exists "reports_insert_anyone" on public.reports;
