/**
 * 시험 실행기. `tsc`로 임시 폴더에 컴파일한 뒤 `node`로 실행한다.
 * 결과에는 메시지 원문을 출력하지 않고 사례 id 와 등급만 보여 준다.
 */

import { DONE_STAGES, buildGuidance, getStageSteps } from "../guidance";
import { buildAnalysisSummary, maskPersonalInfo, normalizeReporterId } from "../reports";
import { ANALYSIS_CASES } from "./cases";
import { analyzeMessage } from "./engine";
import { buildView } from "./normalize";
import type { AnalysisResult, ModelSignal } from "./types";

let failures = 0;
let checks = 0;
let knownGaps = 0;

function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.log("FAIL  " + name + (detail ? "  -> " + detail : ""));
  }
}

/** 모든 근거·URL 위치가 원문 구간과 정확히 맞는지 검사 */
function checkOffsets(id: string, input: string, r: AnalysisResult): void {
  const analyzed = input.slice(0, r.input.analyzedLength);
  const view = buildView(analyzed, true);
  for (const e of r.evidence) {
    const inRange = e.start >= 0 && e.end <= analyzed.length && e.start < e.end;
    check(id + " offset-range " + e.ruleId, inRange, e.start + "-" + e.end);
    if (!inRange) {
      continue;
    }
    check(id + " offset-text " + e.ruleId, analyzed.slice(e.start, e.end) === e.text);
    const again = buildView(e.text, true).text;
    check(id + " offset-norm " + e.ruleId, again.includes(e.normalized) || e.ruleId === "cred.entry_with_link", again + " / " + e.normalized);
  }
  for (const u of r.urls) {
    check(id + " url-text", analyzed.slice(u.start, u.end) === u.text);
  }
  check(id + " view-maps", view.starts.length === view.text.length && view.ends.length === view.text.length);
}

function runCases(): void {
  const counts = { risk: 0, normal: 0, uncertain: 0 };
  for (const c of ANALYSIS_CASES) {
    counts[c.group] += 1;
    const r = analyzeMessage(c.text);
    // 점수가 있는 유형만 "탐지"로 본다(화면에 위험 유형으로 보이는 기준과 같다).
    const cats = new Set(r.categories.filter((x) => x.points > 0).map((x) => x.category));
    if (c.knownGap && !c.expectGrades.includes(r.grade)) {
      knownGaps += 1;
      console.log("GAP   " + c.id + " (" + r.grade + "): " + c.knownGap);
    } else {
      check(c.id + " grade", c.expectGrades.includes(r.grade), "got " + r.grade);
    }
    for (const m of c.mustCategories ?? []) {
      check(c.id + " has " + m, cats.has(m));
    }
    for (const m of c.mustNotCategories ?? []) {
      check(c.id + " not " + m, !cats.has(m));
    }
    checkOffsets(c.id, c.text, r);
    check(c.id + " limitations", r.limitations.length > 0);
    check(c.id + " label", r.gradeLabel.length > 0);
    console.log("      " + c.id + " => " + r.grade + " (근거 " + r.evidence.length + ", 억제 " + r.suppressed.length + ")");
  }
  console.log("사례 수: 위험 " + counts.risk + ", 정상 " + counts.normal + ", 판단어려움 " + counts.uncertain);
}

function runStructural(): void {
  // 이모지 앞뒤에서도 위치가 정확한지
  const emoji = "😀😀 엄마 나 폰 고장나서 급하게 송금해줘 계좌 110-123-456789";
  const r1 = analyzeMessage(emoji);
  checkOffsets("emoji", emoji, r1);
  check("emoji has evidence", r1.evidence.length > 0);

  // 길이 제한
  const long = "가".repeat(50) + "😀".repeat(10);
  const r2 = analyzeMessage(long, { maxLength: 51 });
  check("truncate flag", r2.input.truncated === true);
  check("truncate surrogate", r2.input.analyzedLength === 50, String(r2.input.analyzedLength));

  // 모델 신호: 넘겨 주지 않으면 unavailable
  const plain = analyzeMessage("오늘 날씨가 좋네요 산책 가요 같이");
  check("model default unavailable", plain.model.status === "unavailable");

  // 모델 high 는 주의까지만 올리고, 높음으로는 올리지 않는다
  const high: ModelSignal = { status: "ok", band: "high", modelVersion: "test" };
  const withModel = analyzeMessage("오늘 날씨가 좋네요 산책 가요 같이", { model: high });
  // 모델이 높게 보고 이상한 기호가 섞여 있으면 '주의 + 스팸', 기호가 없으면 '판단 어려움'.
  const styled = analyzeMessage("오늘 날씨가 좋네요 ♥ 산책 가요 같이", { model: high });
  check("model high + odd symbol -> caution", styled.grade === "caution", styled.grade);
  check("model high + odd symbol -> spam type", styled.messageType === "spam", styled.messageType);
  check("odd symbol alone (no model) not flagged", analyzeMessage("오늘 날씨가 좋네요 ♥ 산책 가요 같이").grade !== "caution");
  // 모델 혼자서는 '판단 어려움'까지만 올린다(주의·높음으로 올리지 않음).
  check("model alone upgrades only to uncertain", withModel.grade === "uncertain", withModel.grade);
  check("model never high", withModel.grade !== "high");
  check("model-only reason present", withModel.reasons.some((x) => x.includes("통계 모델")));

  // 모델 low 는 위험 등급을 낮추지 않는다
  const low: ModelSignal = { status: "ok", band: "low", modelVersion: "test" };
  const risky = "엄마 나 폰이 고장나서 친구 폰으로 문자해. 급하게 300만원만 이 계좌로 송금해줘. 110-123-456789";
  const base = analyzeMessage(risky);
  const lowered = analyzeMessage(risky, { model: low });
  check("model low does not downgrade", lowered.grade === base.grade);

  // 어떤 결과도 안전하다고 단정하지 않는다
  const joined = ANALYSIS_CASES.map((c) => analyzeMessage(c.text))
    .map((r) => r.gradeLabel + " " + r.reasons.join(" "))
    .join(" ");
  check("no safe claim", !/안전합니다|안전한 메시지|100%/.test(joined));

  // 문장·링크 개별 판단
  check("text grade on risky", base.text.grade === "high", base.text.grade);
  const onlyUrl = analyzeMessage("https://example.com/abc");
  check("text uncertain when only url", onlyUrl.text.grade === "uncertain", onlyUrl.text.grade);
  const linkOnlyRisk = analyzeMessage("카드번호와 인증번호를 입력해 주세요 http://pay-check.xyz/a");
  check("text excludes link-derived evidence", linkOnlyRisk.text.grade !== "high", linkOnlyRisk.text.grade);
  check("url level elevated", linkOnlyRisk.urlSummary.level !== "none", linkOnlyRisk.urlSummary.level);
  const noUrl = analyzeMessage("오늘 날씨가 좋네요 산책 가요 같이");
  check("no url count", noUrl.urls.length === 0 && noUrl.urlSummary.count === 0);

  // 위장 문자가 섞인 주소(신고 사례): 정규화하면 평범한 주소가 되어도 원문 기준으로 의심해야 한다.
  const disguised = analyzeMessage("접속 gh③7c.COm");
  const du = disguised.urls[0];
  check("disguised url found", disguised.urls.length === 1, String(disguised.urls.length));
  check("disguised url text keeps original", du !== undefined && du.text === "gh③7c.COm", du ? du.text : "none");
  check("disguised url flagged", du !== undefined && du.flags.some((f) => f.id === "lookalike_chars"));
  check("disguised url elevated", disguised.urlSummary.level === "elevated", disguised.urlSummary.level);
  const plainUrl = analyzeMessage("자료는 https://www.naver.com/ 에서 보세요");
  check("plain url not flagged as lookalike", plainUrl.urls[0].flags.every((f) => f.id !== "lookalike_chars" && f.id !== "odd_case"));
  const capsUrl = analyzeMessage("방문 Example.com 감사합니다");
  check("capitalized domain not odd_case", capsUrl.urls.length === 1 && capsUrl.urls[0].flags.every((f) => f.id !== "odd_case"));

  // 가족 사칭이 의심되면 '아직 아무것도 안 했어요' 안내가 직접 전화 확인을 먼저 권한다.
  const askMoney = analyzeMessage("엄마 나 돈 좀 보내줘");
  const askSteps = getStageSteps("none", askMoney).join(" ");
  check("family none-steps recommend calling", askSteps.includes("직접 전화"), askSteps);
  check("family none-steps do not say do not call", !askSteps.includes("전화하지 말고"), askSteps);
  const parcelSteps = getStageSteps("none", analyzeMessage("[CJ대한통운] 주소 불일치로 배송이 보류되었습니다 bit.ly/3xAbC12")).join(" ");
  check("non-family none-steps keep block advice", parcelSteps.includes("차단"), parcelSteps);
  const chatSteps = getStageSteps("none", analyzeMessage("엄마 오늘 저녁 뭐 먹어? 나 6시쯤 들어갈게")).join(" ");
  check("harmless family chat keeps default none-steps", !chatSteps.includes("직접 전화"), chatSteps);
  const guideGroups = buildGuidance(askMoney).map((g) => g.title).join("|");
  check("family guidance shown for family + money", guideGroups.includes("가족·지인"), guideGroups);
  const sentSteps = getStageSteps("sent", askMoney).join(" ");
  check("sent steps unchanged", sentSteps.includes("지급정지"), sentSteps);

  // 브랜드 오타 위장 주소: 공식 주소는 위장으로 보지 않는다.
  const typo = analyzeMessage("접속 www.coinonve.com");
  check("typosquat flagged", typo.urls[0] !== undefined && typo.urls[0].flags.some((f) => f.id === "brand_lookalike"));
  const official = analyzeMessage("접속 www.coinone.co.kr");
  check("official brand domain not flagged", official.urls[0] !== undefined && official.urls[0].flags.every((f) => f.id !== "brand_lookalike" && f.id !== "brand_mismatch"));
  const never = analyzeMessage("자료 never.com 참고");
  check("short brand word not typosquat", never.urls.every((u) => u.flags.every((f) => f.id !== "brand_lookalike")));

  // A: 주소 길이·하위 도메인 표시(점수에는 넣지 않음)
  const longUrl = analyzeMessage("안내 https://a.b.example.co.kr/" + "x".repeat(120) + " 확인");
  const lu = longUrl.urls[0];
  check("url length field", lu !== undefined && lu.length > 100, lu ? String(lu.length) : "none");
  check("url subdomain depth", lu !== undefined && lu.subdomainDepth === 2, lu ? String(lu.subdomainDepth) : "none");
  check("long url flag has zero points", lu !== undefined && lu.flags.some((f) => f.id === "long_url" && f.points === 0));
  check("long url alone not elevated", longUrl.urlSummary.level === "none", longUrl.urlSummary.level);

  // B: 대응 6단계(요구사항 순서)
  const stageIds = DONE_STAGES.map((s) => s.id).join(",");
  check("six stages in order", stageIds === "none,replied,clicked,entered,installed,sent", stageIds);
  const repliedFamily = getStageSteps("replied", askMoney).join(" ");
  check("replied + family recommends calling", repliedFamily.includes("직접 전화"), repliedFamily);
  const repliedOther = getStageSteps("replied", analyzeMessage("[CJ대한통운] 주소 불일치로 배송이 보류되었습니다 bit.ly/3xAbC12")).join(" ");
  check("replied default stops conversation", repliedOther.includes("대화를 멈추") && !repliedOther.includes("직접 전화"), repliedOther);

  // D: 정상 택배 안내는 근거에서 빼고, 의심 링크가 있으면 정상 안내로 보지 않는다.
  const pickup = analyzeMessage("[한진택배] 상품 집하 안내 오늘 14:00~16:00 사이에 상품을 집하할 예정입니다. 현금성 상품은 집하가 불가합니다.");
  check("delivery notice benign", pickup.benignContexts.some((b) => b.id === "benign.delivery_notice"));
  check("delivery notice not flagged", pickup.grade === "no_clear_signal" || pickup.grade === "uncertain", pickup.grade);
  const fakeParcel = analyzeMessage("[CJ대한통운] 배송 예정이나 주소 불일치로 보류되었습니다 확인 http://cj-delivery.xyz/a");
  check("fake parcel with bad link not benign", fakeParcel.benignContexts.every((b) => b.id !== "benign.delivery_notice"));
  check("fake parcel with bad link flagged", fakeParcel.grade === "high" || fakeParcel.grade === "caution", fakeParcel.grade);
  const blockModel = analyzeMessage("[한진택배] 상품이 터미널에 도착하여 내일 배송될 예정입니다.", {
    model: { status: "ok", band: "high", modelVersion: "test" },
  });
  check("benign notice blocks model upgrade", blockModel.grade !== "caution" && blockModel.grade !== "high", blockModel.grade);

  // 띄어쓰기 위장 주소는 링크로 인식하고 의심 표시한다.
  const spacedUrl = analyzeMessage("어코드 입니다.기존 주소 이용 불가할 경우ac-ot . com 으로 이용 !tok : adp**");
  check("spaced domain detected", spacedUrl.urls.length === 1 && spacedUrl.urls[0].host === "ac-ot.com", spacedUrl.urls.map((u) => u.host).join(","));
  check("spaced domain flagged", spacedUrl.urls[0]?.flags.some((f) => f.id === "spaced_domain") === true);
  check("spaced domain shown as original text", spacedUrl.urls[0]?.text === "ac-ot . com", spacedUrl.urls[0]?.text);
  const english = analyzeMessage("Your number is 447953966250. In Germany you can use your pack as usual.");
  check("sentence end + capital not spaced url", english.urls.every((u) => u.flags.every((f) => f.id !== "spaced_domain")), english.urls.map((u) => u.text).join(","));
  const sentence = analyzeMessage("오늘 회의는 3시입니다. 자료는 나중에 보내드릴게요.");
  check("normal sentence period not a url", sentence.urls.length === 0, sentence.urls.map((u) => u.text).join(","));

  // 스팸/스미싱 구분과 유형별 대처
  check("gambling message typed as spam", spacedUrl.messageType === "spam", spacedUrl.messageType);
  check("family money typed as smishing", askMoney.messageType === "smishing", askMoney.messageType);
  check("normal message has no type", sentence.messageType === "none", sentence.messageType);
  const spamSent = getStageSteps("sent", spacedUrl).join(" ");
  const smishSent = getStageSteps("sent", askMoney).join(" ");
  check("spam and smishing sent-steps differ", spamSent !== smishSent && spamSent.includes("더 입금하지") && smishSent.includes("지급정지"));
  const spamNone = getStageSteps("none", spacedUrl).join(" ");
  check("spam none-steps mention block and report", spamNone.includes("차단") && spamNone.includes("118"));

  // 문장만 보는 모델 신호는 문장 카드에도 반영된다.
  const modelOnly = analyzeMessage("오늘 날씨가 좋네요 산책 가요 같이", { model: { status: "ok", band: "high", modelVersion: "test" } });
  check("model signal reflected in text card", modelOnly.text.grade === modelOnly.grade, modelOnly.text.grade + " vs " + modelOnly.grade);

  // 신고 사례: 코인원 사칭은 문장 카드도 위험으로, 가린 주소·기호 끊기 스팸은 스팸으로 표시
  const coin = analyzeMessage("[국외발신]\n[코인원]\n고객님계정이\n해외IP에서\n로그인되였습니다.해외IP차단해주세요.\nwww.coinonve.com");
  check("coinone overall high", coin.grade === "high", coin.grade);
  check("coinone text card flagged", coin.text.grade === "high" || coin.text.grade === "caution", coin.text.grade);
  check("coinone typed smishing", coin.messageType === "smishing", coin.messageType);
  const masked = analyzeMessage("소▶봉구울▶신규! *이상치킨C ▶ *+* **+*.* **+*지▶톡▶c****노▶추천▶****me*.kr/*v*uv");
  check("masked url detected", masked.urls.some((u) => u.flags.some((f) => f.id === "masked_domain")), masked.urls.map((u) => u.text).join(","));
  check("masked spam typed spam", masked.messageType === "spam", masked.messageType);
  check("masked spam text card explains link", masked.text.note !== null || masked.text.grade === "high" || masked.text.grade === "caution");

  // 제보용 분석 요약에는 메시지 글자·주소 문자열이 들어가면 안 된다.
  const secret = "엄마 나 폰 고장나서 급하게 송금해줘 계좌 110-123-456789 http://kb-secure-login.xyz/verify";
  const summary = buildAnalysisSummary(JSON.parse(JSON.stringify(analyzeMessage(secret))));
  const summaryJson = JSON.stringify(summary);
  check("summary built", summary !== null && summary.ruleIds.length > 0 && summary.urls.length === 1);
  check("summary has no message text", !summaryJson.includes("송금해줘") && !summaryJson.includes("110-123") && !summaryJson.includes("엄마"));
  check("summary has no url text", !summaryJson.includes("kb-secure-login") && !summaryJson.includes("verify"));
  check("summary rejects junk", buildAnalysisSummary("x") === null && buildAnalysisSummary([1]) === null);
  const injected = buildAnalysisSummary({ evidence: [{ ruleId: "<script>alert(1)</script>" }], grade: "hacked" });
  check("summary drops invalid values", injected !== null && injected.ruleIds.length === 0 && injected.grade === null);

  // 제보 저장 전 개인정보 가림
  const masked2 = maskPersonalInfo(
    "연락처 010-1234-5678, 02-123-4567, 주민 900101-1234567, 카드 1234-5678-9012-3456, 계좌 110-123-456789, 메일 hong@test.com, 링크 http://bad.xyz/a 5만원",
  );
  check("mask phone", !masked2.includes("1234-5678,") && masked2.includes("010-****-****"), masked2);
  check("mask landline", !masked2.includes("123-4567"), masked2);
  check("mask rrn", !masked2.includes("900101-1234567"), masked2);
  check("mask card", !masked2.includes("9012-3456"), masked2);
  check("mask account", !masked2.includes("456789"), masked2);
  check("mask email", !masked2.includes("hong@test.com"), masked2);
  check("keep url and amount", masked2.includes("http://bad.xyz/a") && masked2.includes("5만원"), masked2);

  // 제보자 익명 번호: UUID 형식만 받고, 이름·전화번호 같은 값은 버린다.
  check("reporter id uuid accepted", normalizeReporterId("A3F9C2D1-1234-4ABC-9DEF-0123456789AB") === "a3f9c2d1-1234-4abc-9def-0123456789ab");
  check("reporter id junk rejected", normalizeReporterId("홍길동 010-1234-5678") === null && normalizeReporterId(123) === null);

  // 결정성
  const a = JSON.stringify(analyzeMessage(risky));
  const b = JSON.stringify(analyzeMessage(risky));
  check("deterministic", a === b);
}

runCases();
runStructural();
console.log("알려진 미탐지(실패 아님): " + knownGaps);
console.log(failures === 0 ? "ALL PASS (" + checks + " checks)" : failures + " FAILED of " + checks + " checks");
process.exit(failures === 0 ? 0 : 1);
