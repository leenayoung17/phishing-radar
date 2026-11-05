// 사이트 하단: 로고·서비스 이름·한 줄 안내(왼쪽), 도움받을 곳(오른쪽), 저작권·데이터 출처(아래 한 줄).
// 배경은 페이지 배경(slate-100)보다 아주 살짝만 진한 회색. 데이터 출처 표기는 학습 데이터 라이선스(CC BY-NC-SA 4.0)의
// 저작자 표시 조건 때문에 남긴다.
import StatusImage from "@/components/StatusImage";

const HELP = [
  { name: "경찰", number: "112" },
  { name: "인터넷진흥원", number: "118" },
  { name: "금융감독원", number: "1332" },
];

export default function SiteFooter() {
  return (
    <footer className="border-t border-slate-400/70 bg-slate-300/70 dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto max-w-5xl px-6 py-7 sm:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <StatusImage name="brand" size={36} className="rounded-xl" />
            <div>
              <p className="text-sm font-bold text-slate-800 dark:text-slate-100">피싱 탐지 레이더</p>
              <p className="text-xs text-slate-600 dark:text-slate-400">참고용 서비스이며 피싱 여부를 확정하지 않아요</p>
            </div>
          </div>
          <p className="text-xs text-slate-700 dark:text-slate-400">
            {HELP.map((h, i) => (
              <span key={h.number}>
                {i > 0 && <span className="mx-2 text-slate-400 dark:text-slate-600">|</span>}
                {h.name} <span className="font-bold text-slate-800 dark:text-slate-200">{h.number}</span>
              </span>
            ))}
          </p>
        </div>
        <div className="mt-5 flex flex-col gap-1 border-t border-slate-400/50 pt-4 text-[11px] text-slate-600 sm:flex-row sm:justify-between dark:border-slate-800 dark:text-slate-500">
          <p>© 2026 피싱 탐지 레이더 · 비영리 프로젝트</p>
          <p>데이터: kor-smishing-message (CC BY-NC-SA 4.0), Korean_message</p>
        </div>
      </div>
    </footer>
  );
}
