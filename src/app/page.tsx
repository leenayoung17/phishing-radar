import Analyzer from "@/components/Analyzer";
import SiteFooter from "@/components/SiteFooter";
import StatusImage from "@/components/StatusImage";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-slate-100 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-2xl items-center gap-4 px-4 py-6">
          <StatusImage name="brand" size={64} className="rounded-2xl" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">피싱 탐지 레이더</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">
              의심스러운 문자·메신저 메시지와 링크를 붙여 넣으면, 피싱 위험 신호와 근거, 대응 방법을 알려 드려요.
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-6 pb-24 sm:pb-28">
        <Analyzer />
      </main>

      <SiteFooter />
    </div>
  );
}
