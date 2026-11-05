"use client";

// 결과 화면 하단의 작은 제보 영역. 로그인 없이 /api/report 로 보낸다.
// 원문은 사용자가 체크한 경우에만 보낸다(기본 꺼짐).
import { useState } from "react";
import type { AnalysisResult } from "@/lib/analysis/types";
import {
  DESCRIPTION_MAX,
  REPORTER_ID_STORAGE_KEY,
  REPORT_TYPES,
  REPORT_TYPE_INFO,
  normalizeReporterId,
  type ReportType,
} from "@/lib/reports";

/**
 * 이 브라우저의 익명 제보자 번호. 처음 제보할 때 임의로 만들어 브라우저에 기억해 둔다.
 * 브라우저 저장소를 쓸 수 없으면(사생활 보호 모드 등) 이번 제보에만 쓰는 번호를 만든다.
 */
function getReporterId(): string {
  try {
    const saved = normalizeReporterId(window.localStorage.getItem(REPORTER_ID_STORAGE_KEY));
    if (saved) {
      return saved;
    }
    const created = crypto.randomUUID();
    window.localStorage.setItem(REPORTER_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

interface ReportResponse {
  ok?: boolean;
  reportId?: string;
  error?: { message?: string };
}

type SendState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "done"; reportId: string }
  | { status: "error"; message: string };

export default function ReportForm({
  result,
  message,
  defaultType,
}: {
  result: AnalysisResult | null;
  message: string;
  defaultType?: ReportType;
}) {
  const [type, setType] = useState<ReportType | null>(defaultType ?? null);
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<SendState>({ status: "idle" });
  const hasMessage = message.trim().length > 0;

  async function submit() {
    if (!type || state.status === "sending") {
      return;
    }
    setState({ status: "sending" });
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          description,
          consent: consent && hasMessage,
          message: consent && hasMessage ? message : undefined,
          analysis: result ?? undefined,
          reporterId: getReporterId(),
        }),
      });
      let body: ReportResponse | null;
      try {
        body = (await res.json()) as ReportResponse;
      } catch {
        body = null;
      }
      if (body?.ok && body.reportId) {
        setState({ status: "done", reportId: body.reportId });
      } else {
        setState({ status: "error", message: body?.error?.message ?? "제보를 보내지 못했습니다. 잠시 후 다시 시도해 주세요." });
      }
    } catch {
      setState({ status: "error", message: "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요." });
    }
  }

  if (state.status === "done") {
    return (
      <div
        role="status"
        className="rounded-2xl border border-teal-200 bg-teal-50 p-4 text-sm leading-6 text-teal-900 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200"
      >
        제보가 접수되었습니다. 보내 주신 내용은 탐지 규칙과 모델을 개선하는 데 쓰입니다.
        <span className="mt-1 block text-xs text-teal-700 dark:text-teal-400">
          접수 번호: {state.reportId.slice(0, 8)}
        </span>
      </div>
    );
  }

  return (
    <details className="group rounded-2xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
            결과가 이상하거나 새로운 수법을 발견했나요?
          </span>
          <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-400">
            제보해 주시면 탐지 규칙과 모델을 개선하는 데 쓰여요.
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors group-hover:bg-violet-700 dark:bg-violet-400 dark:text-violet-950 dark:group-hover:bg-violet-300">
          <span className="group-open:hidden">제보하기 ›</span>
          <span className="hidden group-open:inline">닫기</span>
        </span>
      </summary>

      <div className="mt-4 flex flex-col gap-4">
        <fieldset>
          <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">제보 유형</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {REPORT_TYPES.map((t) => (
              <label
                key={t}
                className={
                  "flex cursor-pointer flex-col rounded-xl border p-3 text-sm " +
                  (type === t
                    ? "border-blue-700 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40"
                    : "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")
                }
              >
                <span className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                  <input
                    type="radio"
                    name="report-type"
                    value={t}
                    checked={type === t}
                    onChange={() => setType(t)}
                    className="accent-blue-700"
                  />
                  {REPORT_TYPE_INFO[t].label}
                </span>
                <span className="mt-1 pl-6 text-xs text-slate-500 dark:text-slate-400">{REPORT_TYPE_INFO[t].help}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="report-description" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            추가 설명 <span className="font-normal text-slate-500">(선택)</span>
          </label>
          <textarea
            id="report-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={DESCRIPTION_MAX}
            rows={3}
            placeholder="예: 정상 택배 안내인데 '주의'로 나왔어요 / 카톡으로 이런 식으로 돈을 요구했어요"
            className="mt-2 w-full resize-y rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:ring-blue-900"
          />
          <div className="mt-1 flex justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>
              무엇이 이상했는지 내 말로 적는 칸이에요. 메시지 원문은 여기에 붙여 넣지 말고 아래 체크로 보내 주세요.
            </span>
            <span className="shrink-0">
              {description.length} / {DESCRIPTION_MAX}
            </span>
          </div>
        </div>

        {hasMessage && (
          <label className="flex items-start gap-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1.5 accent-blue-700"
            />
            <span>
              분석한 메시지 원문도 함께 보내기 <span className="text-slate-500">(선택)</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                위에서 분석한 메시지를 그대로 따로 저장해, 탐지 규칙과 모델을 고치는 데만 씁니다. 체크하지 않으면 원문 없이
                분석 결과 요약(등급·유형 등)만 보냅니다.
              </span>
            </span>
          </label>
        )}

        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          전화번호·계좌번호·주민등록번호·카드번호·이메일은 저장할 때 자동으로 가려집니다(예: 010-****-****). 그래도 이름 같은
          개인정보는 적지 말아 주세요. 같은 기기에서는 10분에 5건까지 보낼 수 있어요. 같은 사람의 제보를 묶어 보기 위해 이
          브라우저를 구별하는 임의의 번호가 함께 저장됩니다(이름·전화번호·IP와는 연결되지 않아요).
        </p>

        {state.status === "error" && (
          <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-300">
            {state.message}
          </p>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={!type || state.status === "sending"}
          className="self-start rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-900 disabled:cursor-not-allowed disabled:bg-slate-300 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white dark:disabled:bg-slate-700 dark:disabled:text-slate-400"
        >
          {state.status === "sending" ? "보내는 중..." : "제보 보내기"}
        </button>
      </div>
    </details>
  );
}
