"use client";

// 메시지 입력 -> /api/analyze 호출 -> 결과 표시. 입력 원문은 브라우저 메모리에만 있고 저장하지 않는다.
import { useRef, useState, type ReactNode } from "react";
import ReportForm from "@/components/ReportForm";
import StatusImage from "@/components/StatusImage";
import type { ImageKey } from "@/lib/assets";
import {
  DONE_STAGES,
  HELP_LINES,
  SPAM_ACTIONS,
  SPAM_SUMMARY,
  TYPE_EXPLAINER,
  buildGuidance,
  getStageSteps,
  type DoneStage,
} from "@/lib/guidance";
import type { AnalysisResult, Grade, ModelBand, UrlLevel } from "@/lib/analysis/types";

const MAX_LENGTH = 3000;

/** '이런 문자는 조심하세요' 칸의 예시. 실제 수법을 바탕으로 직접 만든 가상의 문장이며 주소도 가짜다. */
const CAUTION_EXAMPLES: { kind: "스미싱" | "스팸"; title: string; text: string; why: string }[] = [
  {
    kind: "스미싱",
    title: "가족·지인 사칭",
    text: "엄마 나 폰이 고장나서 친구 폰으로 문자해. 급하게 300만원만 이 계좌로 송금해줘. 110-123-456789",
    why: "휴대폰 고장을 핑계로 평소 번호가 아닌 곳에서 연락해 급하게 돈을 요구합니다.",
  },
  {
    kind: "스미싱",
    title: "금융기관 사칭",
    text: "[국민은행] 고객님 계좌가 보안 위반으로 정지되었습니다. 즉시 http://kb-secure-login.xyz/verify 접속 후 인증번호와 계좌 비밀번호를 입력하세요",
    why: "계좌 정지로 겁을 준 뒤 가짜 주소에서 인증번호·비밀번호를 입력하게 합니다.",
  },
  {
    kind: "스미싱",
    title: "택배 사칭",
    text: "[CJ대한통운] 주소 불일치로 배송이 보류되었습니다. 24시간 내 확인하지 않으면 반송됩니다 cj-deliver-check.xyz/a1",
    why: "배송 문제를 핑계로 링크를 누르게 해 개인정보 입력이나 악성 앱 설치로 이어집니다.",
  },
  {
    kind: "스팸",
    title: "불법 도박 광고",
    text: "[국제발신] ★신규 가입 첫충 30%★ 매일 페이백 지급 기존 주소 이용 불가 시 c4sino-ex . com 으로 이용",
    why: "주소에 띄어쓰기를 넣어 차단을 피하고, 가입·입금을 유도하는 불법 도박 광고입니다.",
  },
];

interface GradeStyle {
  image: ImageKey;
  box: string;
  badge: string;
  title: string;
  summary: string;
  actions: string[];
}

const GRADE_STYLES: Record<Grade, GradeStyle> = {
  high: {
    image: "risk",
    box: "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/40",
    badge: "bg-red-600 text-white",
    title: "위험 신호가 많이 보여요",
    summary: "피싱일 가능성을 의심할 만한 표현이 여러 개 겹쳐 있습니다. 확정은 아니지만 아래 행동은 하지 마세요.",
    actions: [
      "링크를 누르거나 앱을 설치하지 마세요.",
      "인증번호, 비밀번호, 카드·계좌 정보를 알려 주지 마세요.",
      "송금하지 마세요. 가족·지인이라면 기존에 알던 번호로 직접 전화해 확인하세요.",
      "기관이라면 문자에 적힌 번호가 아니라 공식 앱·공식 대표번호로 직접 문의하세요.",
    ],
  },
  caution: {
    image: "risk",
    box: "border-orange-300 bg-orange-50 dark:border-orange-800 dark:bg-orange-950/40",
    badge: "bg-orange-500 text-white",
    title: "주의가 필요해요",
    summary: "의심스러운 표현이나 링크 특징이 있습니다. 바로 응하지 말고 다른 방법으로 먼저 확인하세요.",
    actions: [
      "링크는 누르지 말고, 공식 앱이나 직접 검색한 공식 사이트로 확인하세요.",
      "돈이나 개인정보를 요구하면 보낸 사람에게 다른 연락 수단으로 확인하세요.",
      "의심이 풀리지 않으면 가족이나 주변 사람에게 먼저 보여 주세요.",
    ],
  },
  no_clear_signal: {
    image: "clear",
    box: "border-teal-300 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/40",
    badge: "bg-teal-600 text-white",
    title: "뚜렷한 위험 신호는 찾지 못했어요",
    summary: "이 도구가 아는 표현과 링크 모양에서는 위험 신호가 없었습니다. 그렇다고 안전하다는 뜻은 아닙니다.",
    actions: [
      "그래도 모르는 사람이 보낸 링크나 앱 설치 요구는 조심하세요.",
      "돈·인증번호·개인정보를 요구받으면 공식 경로로 한 번 더 확인하세요.",
    ],
  },
  uncertain: {
    image: "uncertain",
    box: "border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/60",
    badge: "bg-slate-600 text-white",
    title: "이 내용만으로는 판단이 어려워요",
    summary: "판단할 근거가 부족합니다. 앞뒤 대화나 보낸 사람 정보까지 함께 고려해야 합니다.",
    actions: [
      "메시지 전체(앞뒤 내용 포함)를 붙여 넣어 다시 분석해 보세요.",
      "링크나 요구 사항이 있다면 보낸 사람에게 다른 방법으로 확인하세요.",
    ],
  },
};

const MODEL_BAND_TEXT: Record<ModelBand, string> = {
  high: "알려진 스팸과 많이 비슷함",
  medium: "알려진 스팸과 조금 비슷함",
  low: "알려진 스팸과 비슷하지 않음",
  unreliable: "내용이 짧아 판단하지 않음",
};

const MODEL_BAND_BADGE: Record<ModelBand, string> = {
  high: "bg-orange-600 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-slate-500 text-white",
  unreliable: "bg-slate-400 text-white",
};

const URL_LEVEL_BADGE: Record<UrlLevel, string> = {
  none: "bg-slate-500 text-white",
  low: "bg-amber-500 text-white",
  elevated: "bg-orange-600 text-white",
};

const URL_LEVEL_TEXT: Record<UrlLevel, string> = {
  none: "주소 모양만으로는 의심 요소를 찾지 못함",
  low: "약간 의심되는 특징",
  elevated: "의심되는 특징 있음",
};

interface ApiOk {
  ok: true;
  result: AnalysisResult;
}
interface ApiFail {
  ok: false;
  error: { code: string; message: string };
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; result: AnalysisResult; submitted: string };

/** 근거 구간을 합쳐 하이라이트할 조각으로 나눈다. */
function buildSegments(text: string, ranges: { start: number; end: number }[]) {
  const valid = ranges
    .filter((r) => r.start >= 0 && r.end <= text.length && r.start < r.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  const segments: { text: string; mark: boolean }[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) {
      segments.push({ text: text.slice(cursor, m.start), mark: false });
    }
    segments.push({ text: text.slice(m.start, m.end), mark: true });
    cursor = m.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), mark: false });
  }
  return segments;
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      {/* 그림은 오른쪽에 띄워서, 제목과 내용 사이가 벌어지지 않고 글이 그림 옆으로 흐르게 한다. */}
      {aside && <div className="float-right mb-2 ml-4">{aside}</div>}
      <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {children}
      {aside && <div className="clear-both" />}
    </section>
  );
}

function ResultView({ result, submitted }: { result: AnalysisResult; submitted: string }) {
  const style = GRADE_STYLES[result.grade];
  // 점수가 있는 유형만 위험 근거로 보여 준다(보조 근거만 있는 유형은 표시하지 않는다).
  const activeCategories = result.categories.filter((c) => c.points > 0);
  const activeSet = new Set(activeCategories.map((c) => c.category));
  const ranges = [
    ...result.evidence.filter((e) => activeSet.has(e.category)).map((e) => ({ start: e.start, end: e.end })),
    ...result.urls.map((u) => ({ start: u.start, end: u.end })),
  ];
  const segments = buildSegments(submitted, ranges);
  const guidance = buildGuidance(result);
  const [stage, setStage] = useState<DoneStage | null>(null);
  const flagged = result.grade === "high" || result.grade === "caution";
  const isSpam = result.messageType === "spam" && flagged;
  const summary = isSpam ? SPAM_SUMMARY : style.summary;
  const actions = isSpam ? SPAM_ACTIONS : style.actions;

  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <div className={"rounded-2xl border-2 p-5 " + style.box}>
        <div className="flex items-center gap-3">
          <StatusImage name={style.image} size={56} />
          <span className={"inline-block rounded-full px-3 py-1 text-sm font-bold " + style.badge}>
            {result.gradeLabel}
          </span>
        </div>
        {result.messageType !== "none" && (
          <div className="mt-3">
            <p className="text-lg font-bold text-slate-900 dark:text-slate-50">{result.messageTypeLabel}</p>
            <details className="group mt-1">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden="true"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-bold"
                >
                  ?
                </span>
                스팸과 스미싱은 어떻게 다른가요?
              </summary>
              <div className="mt-2 space-y-2 rounded-xl bg-white/70 p-3 text-xs leading-5 text-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                {TYPE_EXPLAINER.map((item) => (
                  <p key={item.title}>
                    <span className="font-semibold">{item.title}</span> — {item.body}
                  </p>
                ))}
              </div>
            </details>
          </div>
        )}
        <h2 className="mt-3 text-xl font-bold text-slate-900 dark:text-slate-50">{style.title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">{summary}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700 dark:text-slate-300">
          {result.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">문장 분석</h3>
          <span
            className={
              "mt-2 inline-block rounded-full px-3 py-1 text-xs font-bold " +
              (result.text.note
                ? result.text.grade === "uncertain"
                  ? "bg-amber-500 text-white"
                  : "bg-slate-500 text-white"
                : GRADE_STYLES[result.text.grade].badge)
            }
          >
            {result.text.displayLabel}
          </span>
          {result.text.note ? (
            <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-400">{result.text.note}</p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-slate-600 dark:text-slate-400">
              {result.text.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">링크 분석</h3>
          <span
            className={
              "mt-2 inline-block rounded-full px-3 py-1 text-xs font-bold " + URL_LEVEL_BADGE[result.urlSummary.level]
            }
          >
            {result.urls.length === 0 ? "링크 없음" : URL_LEVEL_TEXT[result.urlSummary.level]}
          </span>
          <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-400">
            {result.urls.length === 0
              ? "메시지에서 링크를 찾지 못했습니다."
              : "링크 " + result.urls.length + "개를 찾았고, 접속하지 않고 주소 모양만 확인했습니다."}
          </p>
        </section>
      </div>

      <Section title="의심 표현 표시">
        <p className="whitespace-pre-wrap text-sm leading-7 text-slate-800 dark:text-slate-200">
          {segments.map((s, i) =>
            s.mark ? (
              <mark
                key={i}
                className="rounded bg-yellow-200 px-0.5 text-slate-900 dark:bg-yellow-500/40 dark:text-slate-50"
              >
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </p>
        {ranges.length === 0 && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">표시할 의심 표현이 없습니다.</p>
        )}
      </Section>

      <Section title="위험 유형별 결과">
        <ul className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">
          {result.categories.map((c) => {
            const found = activeSet.has(c.category);
            const weakOnly = !found && c.evidenceCount > 0;
            return (
              <li key={c.category} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{c.label}</p>
                  <span
                    className={
                      "rounded-full px-2.5 py-0.5 text-xs font-semibold " +
                      (found
                        ? "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300"
                        : weakOnly
                          ? "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400")
                    }
                  >
                    {found ? "발견" : weakOnly ? "약한 표현만 있음" : "찾지 못함"}
                  </span>
                </div>
                {found && (
                  <ul className="mt-2 space-y-2">
                    {result.evidence
                      .filter((e) => e.category === c.category)
                      .map((e, i) => (
                        <li key={e.ruleId + ":" + e.start + ":" + i} className="text-sm leading-6">
                          <span className="font-medium text-slate-800 dark:text-slate-200">{e.label}</span>
                          {" — "}
                          <q className="text-slate-700 dark:text-slate-300">{e.text}</q>
                          <br />
                          <span className="text-xs text-slate-500 dark:text-slate-400">{e.reason}</span>
                        </li>
                      ))}
                  </ul>
                )}
                {weakOnly && (
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    관련 표현이 있지만 단독으로는 위험 신호가 아니어서 점수에 넣지 않았습니다.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
          &quot;찾지 못함&quot;은 이 도구가 아는 표현이 없었다는 뜻이며, 그 위험이 없다는 뜻은 아닙니다.
        </p>
      </Section>

      {(result.suppressed.length > 0 || result.benignContexts.length > 0) && (
        <Section title="위험 근거에서 뺀 표현">
          <ul className="space-y-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
            {result.benignContexts.map((b) => (
              <li key={b.id}>
                <span className="font-medium">{b.label}</span>
                <br />
                <span className="text-xs text-slate-500 dark:text-slate-400">{b.reason}</span>
              </li>
            ))}
            {result.suppressed.length > 0 && (
              <li className="text-xs text-slate-500 dark:text-slate-400">
                정상 안내이거나 &quot;~하지 마세요&quot;처럼 부정하는 문맥이라 점수에 넣지 않은 표현이{" "}
                {result.suppressed.length}개 있습니다.
              </li>
            )}
          </ul>
        </Section>
      )}

      <Section title="링크 분석 (접속하지 않고 주소 모양만 확인)">
        {result.urls.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">메시지에서 링크를 찾지 못했습니다.</p>
        ) : (
          <ul className="space-y-3">
            {result.urls.map((u, i) => (
              <li key={u.start + ":" + i} className="text-sm leading-6">
                <p className="font-mono text-xs break-all text-slate-800 dark:text-slate-200">{u.text}</p>
                <p className="mt-1 text-slate-700 dark:text-slate-300">{URL_LEVEL_TEXT[u.level]}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  주소 길이 {u.length}자 · 하위 도메인 {u.subdomainDepth}단계 · 도메인 {u.registrableDomain}
                </p>
                {u.flags.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-slate-500 dark:text-slate-400">
                    {u.flags.map((f) => (
                      <li key={f.id}>
                        {f.label}: {f.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {result.model.status === "ok" && (
        <Section title="통계 모델 참고 신호">
          <span className={"inline-block rounded-full px-3 py-1 text-xs font-bold " + MODEL_BAND_BADGE[result.model.band]}>
            {MODEL_BAND_TEXT[result.model.band]}
          </span>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
            학습한 통계 모델이 이 문장이 이미 알려진 스팸·스미싱 문자와 얼마나 비슷한지 본 참고 신호입니다. 피싱
            확률이 아니며, 처음 보는 수법에는 약하고 업무 안내 같은 정상 문장을 높게 볼 때도 있습니다. 위험
            표현이 없을 때 이 신호가 높으면 등급을 &quot;판단 어려움&quot;으로만 표시합니다.
          </p>
        </Section>
      )}

      <Section
        title="이렇게 대응하세요"
        aside={<StatusImage name="reportMascot" size={96} className="rounded-2xl" />}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700 dark:text-slate-300">
          {actions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        {guidance.map((g) => (
          <div key={g.title} className="mt-4">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{g.title}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700 dark:text-slate-300">
              {g.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        ))}
        <div className="mt-5 rounded-xl bg-slate-100 p-4 text-sm leading-6 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          <p className="font-semibold">이미 어떤 행동을 하셨나요?</p>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="이미 한 행동 선택">
            {DONE_STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                // 같은 버튼을 다시 누르면 선택을 풀고 내용을 닫는다.
                onClick={() => setStage((current) => (current === s.id ? null : s.id))}
                aria-pressed={stage === s.id}
                className={
                  "rounded-full border px-3 py-1 text-xs " +
                  (stage === s.id
                    ? "border-blue-700 bg-blue-700 text-white"
                    : "border-slate-300 text-slate-700 hover:bg-slate-200 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700")
                }
              >
                {s.label}
              </button>
            ))}
          </div>
          {stage && (
            <ul className="mt-3 list-disc space-y-1 pl-5">
              {getStageSteps(stage, result).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{HELP_LINES}</p>
        </div>
      </Section>

      <Section title="알아 두세요">
        <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {result.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>

      <ReportForm result={result} message={submitted} />
    </div>
  );
}

export default function Analyzer() {
  const [text, setText] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const controllerRef = useRef<AbortController | null>(null);

  const trimmedEmpty = text.trim().length === 0;
  const loading = state.status === "loading";

  async function analyze() {
    if (trimmedEmpty || loading) {
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const submitted = text;
    setState({ status: "loading" });

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: submitted }),
        signal: controller.signal,
      });
      let body: ApiOk | ApiFail | null = null;
      try {
        body = (await res.json()) as ApiOk | ApiFail;
      } catch {
        body = null;
      }
      if (body && body.ok === true && body.result) {
        setState({ status: "done", result: body.result, submitted });
      } else if (body && body.ok === false && body.error) {
        setState({ status: "error", message: body.error.message });
      } else {
        setState({ status: "error", message: "분석 결과를 받지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setState({ status: "error", message: "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요." });
    }
  }

  function reset() {
    controllerRef.current?.abort();
    setText("");
    setState({ status: "idle" });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <label htmlFor="message" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          의심되는 문자·메신저 내용
        </label>
        <textarea
          id="message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_LENGTH}
          rows={7}
          placeholder="받은 문자나 메신저 내용, 링크를 여기에 붙여 넣으세요."
          className="mt-2 w-full resize-y rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:ring-blue-900"
        />
        <div className="mt-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>링크는 열지 않고 주소 모양만 봅니다.</span>
          <span>
            {text.length} / {MAX_LENGTH}
          </span>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={analyze}
            disabled={trimmedEmpty || loading}
            className="flex-1 rounded-xl bg-blue-700 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
          >
            {loading ? "분석 중..." : "분석하기"}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={text.length === 0 && state.status === "idle"}
            className="rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            지우기
          </button>
        </div>
      </div>

      {state.status === "idle" && (
        <p className="rounded-2xl border border-dashed border-slate-300 p-5 text-center text-sm leading-6 text-slate-500 dark:border-slate-700 dark:text-slate-400">
          ↑ 위의 입력칸에 의심되는 메시지를 붙여 넣고 &quot;분석하기&quot;를 눌러 주세요.
          <br />
          분석 결과는 이 자리에 나타납니다.
        </p>
      )}

      {state.status === "loading" && (
        <p
          role="status"
          className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-5 text-center text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
        >
          <StatusImage name="analyzing" size={64} />
          메시지를 분석하고 있습니다...
        </p>
      )}

      {state.status === "error" && (
        <p
          role="alert"
          className="rounded-2xl border border-red-300 bg-red-50 p-5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {state.message}
        </p>
      )}

      {state.status === "error" && (
        <ReportForm key={"err:" + state.message} result={null} message={text} defaultType="analysis_failure" />
      )}

      {state.status === "done" && <ResultView key={state.submitted} result={state.result} submitted={state.submitted} />}

      {/* 예시 칸은 분석 전(처음 화면·오류 화면)에만 보이고, 분석 중·결과 화면에서는 숨긴다. */}
      {(state.status === "idle" || state.status === "error") && (
        <CautionExamples
          disabled={loading}
          onTry={(example) => {
            setText(example);
            const input = document.getElementById("message");
            input?.scrollIntoView({ behavior: "smooth", block: "center" });
            input?.focus();
          }}
        />
      )}
    </div>
  );
}

/** '이런 문자는 조심하세요!' 칸: 스미싱·스팸 예시와 위험한 이유. 원하면 예시를 입력칸에 넣어 분석해 볼 수 있다. */
function CautionExamples({ onTry, disabled }: { onTry: (text: string) => void; disabled: boolean }) {
  // 펼쳐 둔 예시(제목). 같은 '예시 보기'를 다시 누르면 접힌다.
  const [open, setOpen] = useState<string | null>(null);
  const buttonClass =
    "rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">이런 문자는 조심하세요!</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
        실제 수법을 바탕으로 만든 가상의 예시예요. 예시 속 주소는 가짜이니 직접 접속하지 마세요.
      </p>
      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {CAUTION_EXAMPLES.map((ex) => {
          const isOpen = open === ex.title;
          return (
            <li key={ex.title} className="py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    "rounded-full px-2 py-0.5 text-[11px] font-bold " +
                    (ex.kind === "스미싱"
                      ? "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300"
                      : "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300")
                  }
                >
                  {ex.kind}
                </span>
                <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{ex.title}</span>
                <span className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : ex.title)}
                    aria-expanded={isOpen}
                    className={buttonClass}
                  >
                    {isOpen ? "접기" : "예시 보기"}
                  </button>
                  <button type="button" onClick={() => onTry(ex.text)} disabled={disabled} className={buttonClass}>
                    이 예시로 분석해 보기
                  </button>
                </span>
              </div>
              {isOpen && (
                <div className="mt-2 rounded-lg bg-slate-50 p-3 text-xs leading-5 dark:bg-slate-800/60">
                  <p className="text-slate-800 dark:text-slate-200">{ex.text}</p>
                  <p className="mt-1.5 text-slate-500 dark:text-slate-400">왜 위험할까요? {ex.why}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
