-- 피싱 탐지 레이더: 사용자 제보 테이블
-- 실행 방법: Supabase 대시보드 > SQL Editor 에 이 파일 내용을 붙여 넣고 Run (한 번만 실행)
--
-- 개인정보 원칙
--  - 메시지 원문(message_text)은 사용자가 동의(message_consent = true)한 경우에만 저장된다(DB 제약으로도 막음).
--  - analysis_summary 에는 메시지 글자·주소 문자열을 넣지 않는다(등급, 유형, 규칙 이름, 링크 특징만).
-- 보안 원칙
--  - 로그인하지 않은 사용자(anon)는 정해진 칸에 '쓰기'만 할 수 있고, 읽기·수정·삭제는 할 수 없다.
--  - 검토 상태(status)·검토 메모는 사용자가 넣을 수 없다. 추후 관리자 기능에서 별도 권한으로 다룬다.

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null
    check (report_type in ('analysis_failure', 'missed_detection', 'false_positive', 'new_technique')),
  description text not null default ''
    check (char_length(description) <= 1000),
  analysis_summary jsonb
    check (analysis_summary is null or pg_column_size(analysis_summary) <= 16000),
  message_consent boolean not null default false,
  message_text text
    check (message_text is null or char_length(message_text) <= 3000),
  engine_version text
    check (engine_version is null or char_length(engine_version) <= 40),
  model_version text
    check (model_version is null or char_length(model_version) <= 40),
  is_test boolean not null default false,
  status text not null default 'new'
    check (status in ('new', 'reviewing', 'resolved', 'rejected')),
  reviewer_note text
    check (reviewer_note is null or char_length(reviewer_note) <= 2000),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reports_message_requires_consent check (message_text is null or message_consent)
);

comment on table public.reports is '사용자 제보(분석 실패·미탐·오탐·신종 수법). 원문은 동의한 경우에만 저장.';
comment on column public.reports.report_type is 'analysis_failure=분석 실패, missed_detection=미탐, false_positive=오탐, new_technique=신종 수법';
comment on column public.reports.status is 'new=접수, reviewing=검토 중, resolved=반영, rejected=반려';
comment on column public.reports.is_test is '개발 중 확인용으로 넣은 제보(실제 제보와 구분)';

create index if not exists reports_status_created_at_idx on public.reports (status, created_at desc);

-- 행 단위 보안(RLS) 켜기: 정책으로 허용한 것만 할 수 있게 된다.
alter table public.reports enable row level security;

-- 기본 권한을 모두 거두고, 쓰기에 필요한 칸만 허용한다.
revoke all on public.reports from anon, authenticated;
grant insert (id, report_type, description, analysis_summary, message_consent, message_text,
              engine_version, model_version, is_test)
  on public.reports to anon, authenticated;

drop policy if exists "reports_insert_anyone" on public.reports;
create policy "reports_insert_anyone" on public.reports
  for insert to anon, authenticated
  with check (true);
