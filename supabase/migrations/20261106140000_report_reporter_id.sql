-- 피싱 탐지 레이더: 제보자 목록(reporters)과 제보의 보낸 사람(reporter_id) 연결
-- 실행 방법: Supabase 대시보드 > SQL Editor 에 붙여 넣고 Run (한 번만 실행)
--
-- 구조
--   reporters  : 보낸 사람 목록(한 사람 = 한 줄). id 는 제보자 브라우저가 처음 제보할 때 만든 임의의 번호(UUID).
--   reports    : 제보 내용. reporter_id 칸이 reporters.id 를 가리킨다(이 번호로 "누가 쓴 내용인지" 연결).
--   report_rate: 누가(reporter_id) 언제 어떤 제보(report_id)를 보냈는지 남기는 기록(계속 보관).
--                IP 에서 만든 값(client_hash)만 하루가 지나면 비운다.
-- 익명 번호는 이름·전화번호·IP 와 연결되지 않는다. 기존 reports 표와 저장된 제보는 그대로 남는다.

-- 1) 보낸 사람 목록
create table if not exists public.reporters (
  id uuid primary key,
  first_report_at timestamptz not null default now(),
  last_report_at timestamptz not null default now(),
  report_count integer not null default 0 check (report_count >= 0)
);
comment on table public.reporters is '제보자 목록(브라우저 익명 번호 기준, 이름·전화번호·IP 와 무관)';
comment on column public.reporters.id is '제보자 브라우저가 만든 임의의 번호';
comment on column public.reporters.report_count is '이 제보자가 보낸 제보 수';

alter table public.reporters enable row level security;
revoke all on public.reporters from anon, authenticated;

-- 2) 제보 내용에 보낸 사람 칸 추가(reporters 를 가리킴)
alter table public.reports
  add column if not exists reporter_id uuid references public.reporters (id) on delete set null;
comment on column public.reports.reporter_id is '보낸 사람(reporters.id). 같은 번호의 제보는 같은 브라우저에서 보낸 것';
create index if not exists reports_reporter_created_idx on public.reports (reporter_id, created_at desc);

-- 3) 횟수 기록(report_rate)에도 보낸 사람과 제보 번호를 남겨, reports 와 같은 번호로 이어지게 한다.
--    기록(줄)은 지우지 않고 계속 남긴다. 다만 IP 에서 만든 값(client_hash)은 횟수 제한(최근 10분)에만
--    필요하므로 하루가 지나면 그 칸만 비운다.
alter table public.report_rate alter column client_hash drop not null;
comment on column public.report_rate.client_hash is 'IP 를 비밀값으로 섞은 횟수 제한용 값. 하루가 지나면 비워진다';
alter table public.report_rate
  add column if not exists reporter_id uuid references public.reporters (id) on delete set null;
alter table public.report_rate
  add column if not exists report_id uuid references public.reports (id) on delete cascade;
comment on column public.report_rate.reporter_id is '보낸 사람(reporters.id, reports.reporter_id 와 같은 번호)';
comment on column public.report_rate.report_id is '이 기록에 해당하는 제보(reports.id)';

-- 4) 제보 함수: 횟수 확인 → 제보자 목록 갱신 → 제보 저장 → 횟수 기록
drop function if exists public.submit_report(uuid, text, text, jsonb, boolean, text, text, text, boolean, text);
drop function if exists public.submit_report(uuid, text, text, jsonb, boolean, text, text, text, boolean, text, text);
drop function if exists public.submit_report(uuid, text, text, jsonb, boolean, text, text, text, boolean, text, uuid);

create function public.submit_report(
  p_id uuid,
  p_report_type text,
  p_description text,
  p_analysis_summary jsonb,
  p_message_consent boolean,
  p_message_text text,
  p_engine_version text,
  p_model_version text,
  p_is_test boolean,
  p_client_hash text,
  p_reporter_id uuid
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

  -- 하루 지난 기록은 지우지 않고, IP 에서 만든 값만 비운다.
  update public.report_rate
     set client_hash = null
   where client_hash is not null and created_at < now() - interval '1 day';

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

  -- 보낸 사람 목록에 추가하거나(처음) 마지막 제보 시각·제보 수를 갱신한다.
  if p_reporter_id is not null then
    insert into public.reporters (id, first_report_at, last_report_at, report_count)
    values (p_reporter_id, now(), now(), 1)
    on conflict (id) do update
      set last_report_at = now(),
          report_count = public.reporters.report_count + 1;
  end if;

  insert into public.reports (id, report_type, description, analysis_summary, message_consent,
                              message_text, engine_version, model_version, is_test, reporter_id)
  values (p_id, p_report_type, coalesce(p_description, ''), p_analysis_summary, coalesce(p_message_consent, false),
          p_message_text, p_engine_version, p_model_version, coalesce(p_is_test, false), p_reporter_id);

  insert into public.report_rate (client_hash, reporter_id, report_id) values (p_client_hash, p_reporter_id, p_id);
  return 'ok';
end;
$$;

revoke all on function public.submit_report(uuid, text, text, jsonb, boolean, text, text, text, boolean, text, uuid) from public;
grant execute on function public.submit_report(uuid, text, text, jsonb, boolean, text, text, text, boolean, text, uuid)
  to anon, authenticated;
