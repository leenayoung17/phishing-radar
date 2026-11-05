/**
 * URL 추출과 구조 분석.
 *
 * - 주소 문자열만 보고 판단한다. 접속, DNS 조회, 평판 조회를 하지 않는다.
 * - 이메일 주소의 일부는 URL 로 보지 않는다(scripts/train_model.py 와 같은 원칙).
 * - 아래 단축 URL, 의심 TLD, 공식 도메인 목록은 불완전한 휴리스틱이며
 *   공식 출처로 다시 확인하기 전까지 검증된 목록이 아니다.
 */

import { toOriginalSpan, type NormalizedView } from "./normalize";
import type { UrlFinding, UrlFlag, UrlLevel } from "./types";

// ---------------------------------------------------------------- 정규식 재료
const URL_CHARS = "[a-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]";
const TLDS =
  "com|net|org|kr|co|me|ly|xyz|top|in|cc|io|gl|app|link|site|online|info|biz|vip|club|shop|store|ae|ml|tk|ga|cf|gq|pw|ws" +
  "|im|so|do|la|pet|press|group|market|wiki|art|one|lol|black|wtf|icu|buzz|click|work|live|fun|cyou|today|world|space" +
  "|website|tech|pro|name|mobi|asia|digital|life|city|monster|rest|bar|bid|date|download|loan|review|stream|trade|win" +
  "|xin|zip|cloud|email|tel|gdn|surf|quest|sbs|cfd|bond|autos|beauty|hair|makeup|skin|yachts|boats|motorcycles" +
  "|red|cool|town|kim|mom|run|fit|rent|cam|bio|fan|pics";

const SCHEME_SRC = "https?://" + URL_CHARS + "+";
const WWW_SRC = "www\\." + URL_CHARS + "+";
const BARE_SRC = "(?:[a-z0-9-]+\\.)+(?:" + TLDS + ")(?![a-z0-9-])(?:/" + URL_CHARS + "*)?";
/**
 * 점 앞에 띄어쓰기를 넣어 링크 인식을 피한 주소(예: "ac-ot . com"). 일반 보기에서 공백은 1칸으로 합쳐져 있다.
 * 문장 끝 마침표 뒤의 다음 단어("...250. In")와 구분하려고 점 '앞' 공백과 영문자가 든 이름을 필수로 한다.
 */
/** 주소 일부를 '*' 로 가린 주소(예: "****me*.kr/*v*uv"). '*' 를 지우고 구조를 본다. */
const MASKED_SRC =
  "(?:[a-z0-9*-]+\\.)*[a-z0-9*-]*\\*[a-z0-9*-]*\\.(?:" + TLDS + ")(?![a-z0-9-])(?:/" + URL_CHARS + "*)?";
const SPACED_SRC =
  "(?:[a-z0-9-]+\\.)*(?=[a-z0-9-]*[a-z])[a-z0-9-]{2,} \\. ?(?:" + TLDS + ")(?![a-z0-9-])(?:/" + URL_CHARS + "*)?";

/** 이메일 로컬 파트에 쓰이는 문자(RFC 5322 atext + 점). '/' 와 '?' 는 URL 구문이라 제외한다. */
const LOCAL_RE = /[a-z0-9._%+!#$&'*=^`{|}~-]/;
const PREV_BLOCK_RE = /[a-z0-9.@-]/;
const TRAIL_RE = /[.,;:!?)\]}'"]/;

/**
 * 이 길이를 넘으면 '매우 긴 주소'로 참고 표시만 한다(점수 0).
 * 조정용 데이터에서 100자 초과 주소는 정상 3.0%, 스미싱 0.2%였다. 긴 주소는 위험 신호가 아니다.
 */
const LONG_URL_CHARS = 100;

// ---------------------------------------------------------------- 휴리스틱 목록(불완전)
const SHORTENERS = new Set([
  "bit.ly",
  "bitly.com",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "is.gd",
  "cutt.ly",
  "ow.ly",
  "buff.ly",
  "rb.gy",
  "tiny.cc",
  "t.ly",
  "me2.do",
  "url.kr",
  "vo.la",
  "han.gl",
  "buly.kr",
  "shorturl.at",
]);

const SUSPICIOUS_TLDS = new Set([
  "xyz",
  "top",
  "ml",
  "tk",
  "ga",
  "cf",
  "gq",
  "pw",
  "vip",
  "icu",
  "buzz",
  "click",
  "ws",
  "cc",
  "one",
  "art",
  "pet",
  "wtf",
  "black",
  "boats",
  "lol",
  "cyou",
  "sbs",
  "cfd",
  "bond",
  "autos",
  "beauty",
  "hair",
  "makeup",
  "skin",
  "yachts",
  "motorcycles",
  "quest",
  "surf",
  "gdn",
  "monster",
  "rest",
  "bar",
  "bid",
  "date",
  "download",
  "loan",
  "review",
  "stream",
  "trade",
  "win",
  "xin",
  "zip",
  "press",
  "group",
  "market",
  "wiki",
  "red",
  "cool",
  "town",
  "cloud",
  "kim",
  "mom",
  "run",
  "fit",
  "rent",
  "cam",
  "bio",
  "fan",
  "pics",
]);

const SECOND_LEVEL = new Set([
  "co.kr",
  "or.kr",
  "go.kr",
  "ne.kr",
  "ac.kr",
  "re.kr",
  "pe.kr",
  "ms.kr",
  "hs.kr",
  "es.kr",
  "sc.kr",
  "kg.kr",
  "co.jp",
  "co.uk",
  "com.cn",
]);

interface Brand {
  token: string;
  official: readonly string[];
}

/** 호스트에 브랜드 이름이 들어 있는데 등록 도메인이 공식 목록에 없으면 의심한다. */
const BRANDS: readonly Brand[] = [
  { token: "naver", official: ["naver.com", "naver.me", "naver.net", "navercorp.com"] },
  { token: "kakao", official: ["kakao.com", "kakaocorp.com", "kakaobank.com", "kakaopay.com"] },
  { token: "toss", official: ["toss.im", "tossbank.com", "tosspayments.com"] },
  { token: "kbstar", official: ["kbstar.com"] },
  { token: "kbcard", official: ["kbcard.com"] },
  { token: "shinhan", official: ["shinhan.com", "shinhancard.com"] },
  { token: "woori", official: ["wooribank.com", "wooricard.com", "woorifg.com"] },
  { token: "hanabank", official: ["hanabank.com"] },
  { token: "nonghyup", official: ["nonghyup.com"] },
  { token: "nhbank", official: ["nhbank.com"] },
  { token: "coupang", official: ["coupang.com"] },
  { token: "cjlogistics", official: ["cjlogistics.com"] },
  { token: "hanjin", official: ["hanjin.com", "hanjin.co.kr"] },
  { token: "logen", official: ["ilogen.com", "logen.co.kr"] },
  { token: "telegram", official: ["telegram.org", "t.me", "telegram.me"] },
  { token: "coinone", official: ["coinone.co.kr"] },
  { token: "upbit", official: ["upbit.com"] },
  { token: "bithumb", official: ["bithumb.com"] },
  { token: "epost", official: ["epost.go.kr"] },
  { token: "hometax", official: ["hometax.go.kr"] },
  { token: "nts", official: ["nts.go.kr"] },
  { token: "police", official: ["police.go.kr"] },
  { token: "gov", official: ["gov.kr"] },
];

/** 공식 도메인 목록(참고용, 불완전)에 있는 주소인지. 정부 도메인(.go.kr)도 공식으로 본다. */
export function isOfficialDomain(registrable: string): boolean {
  if (registrable.endsWith(".go.kr") || registrable === "gov.kr") {
    return true;
  }
  return BRANDS.some((b) => b.official.includes(registrable)) || EXTRA_OFFICIAL.has(registrable);
}

/** 브랜드 흉내 검사에는 쓰지 않고, '정상 안내의 링크인지' 판단에만 쓰는 추가 공식 도메인(참고용). */
const EXTRA_OFFICIAL = new Set([
  "lotteglogis.com",
  "cvsnet.co.kr",
  "gs25.com",
  "kbcard.com",
  "samsungcard.com",
  "hyundaicard.com",
  "lottecard.co.kr",
  "ibk.co.kr",
  "kbanknow.com",
  "kebhana.com",
]);

// ---------------------------------------------------------------- 후보 추출
interface Candidate {
  start: number; // 정규화 문자열 기준(포함)
  end: number; // 정규화 문자열 기준(제외)
  raw: string;
  /** 점 앞뒤에 띄어쓰기를 넣은 위장 주소인지 */
  spaced: boolean;
  /** 주소 일부를 '*' 로 가린 주소인지 */
  masked: boolean;
}

function isEmailPart(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && LOCAL_RE.test(text[i])) {
    i += 1;
  }
  return text[i] === "@";
}

function boundaryBlocked(text: string, index: number): boolean {
  const prev = index > 0 ? text[index - 1] : "";
  if (prev !== "" && PREV_BLOCK_RE.test(prev)) {
    return true;
  }
  return isEmailPart(text, index);
}

function trimTrailing(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAIL_RE.test(raw[end - 1])) {
    end -= 1;
  }
  return raw.slice(0, end);
}

function collectCandidates(text: string): Candidate[] {
  const accepted: Candidate[] = [];

  const scan = (source: string, blocked: (index: number) => boolean, spaced = false, masked = false): void => {
    for (const m of text.matchAll(new RegExp(source, "g"))) {
      const index = m.index ?? 0;
      const raw = trimTrailing(m[0]);
      if (raw.length === 0 || blocked(index)) {
        continue;
      }
      const end = index + raw.length;
      if (accepted.some((c) => index < c.end && end > c.start)) {
        continue;
      }
      accepted.push({ start: index, end, raw, spaced, masked });
    }
  };

  scan(SCHEME_SRC, () => false);
  scan(WWW_SRC, (i) => boundaryBlocked(text, i));
  scan(BARE_SRC, (i) => boundaryBlocked(text, i));
  scan(SPACED_SRC, (i) => boundaryBlocked(text, i), true);
  scan(MASKED_SRC, (i) => boundaryBlocked(text, i), false, true);

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

// ---------------------------------------------------------------- 구조 분석
interface ParsedUrl {
  scheme: "http" | "https" | null;
  hasUserInfo: boolean;
  host: string;
}

function parseUrl(raw: string): ParsedUrl | null {
  let rest = raw;
  let scheme: "http" | "https" | null = null;
  const schemeMatch = /^(https?):\/\//.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1] === "https" ? "https" : "http";
    rest = rest.slice(schemeMatch[0].length);
  }
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const host = hostPort.replace(/:\d*$/, "");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
    return null;
  }
  return { scheme, hasUserInfo: at !== -1, host };
}

function registrableOf(labels: string[]): string {
  if (labels.length >= 3 && SECOND_LEVEL.has(labels.slice(-2).join("."))) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

function findBrandMismatch(host: string, registrable: string): Brand | null {
  const segments = host.split(/[.-]/);
  for (const brand of BRANDS) {
    const hit = segments.some(
      (s) => s === brand.token || (brand.token.length >= 5 && s.includes(brand.token)),
    );
    if (hit && !brand.official.includes(registrable)) {
      return brand;
    }
  }
  return null;
}

/** 두 문자열이 글자 하나(삽입·삭제·교체)만 다른지. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) {
    return false;
  }
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1);
  }
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  return longer.slice(i + 1) === shorter.slice(i);
}

/** 브랜드 이름에서 글자 하나만 다른 도메인(coinone -> coinonve 같은 오타 위장). 짧은 브랜드는 오탐이 많아 제외한다. */
function findBrandLookalike(registrable: string): Brand | null {
  const label = registrable.split(".")[0];
  for (const brand of BRANDS) {
    if (brand.token.length >= 6 && !brand.official.includes(registrable) && oneEditApart(label, brand.token)) {
      return brand;
    }
  }
  return null;
}

function buildFlags(parsed: ParsedUrl, labels: string[], registrable: string): UrlFlag[] {
  const flags: UrlFlag[] = [];
  const host = parsed.host;
  const tld = labels[labels.length - 1];
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

  if (isIp) {
    flags.push({
      id: "ip_host",
      label: "숫자 IP 주소",
      reason: "도메인 이름 대신 숫자 IP 주소를 쓰고 있습니다.",
      points: 3,
    });
  }
  if (parsed.hasUserInfo) {
    flags.push({
      id: "userinfo_at",
      label: "주소 안의 @ 기호",
      reason: "주소 앞부분에 @ 가 있어 실제 접속 대상이 다른 곳일 수 있습니다.",
      points: 3,
    });
  }
  if (labels.some((l) => l.startsWith("xn--"))) {
    flags.push({
      id: "punycode",
      label: "퓨니코드 도메인",
      reason: "비슷하게 생긴 글자로 위장한 도메인(xn--)일 수 있습니다.",
      points: 2,
    });
  }
  if (SHORTENERS.has(registrable)) {
    flags.push({
      id: "shortener",
      label: "단축 URL 서비스",
      reason: "단축 주소라서 실제 도착 주소를 눈으로 확인할 수 없습니다(정상 광고에도 흔해서 약한 신호로만 봅니다).",
      points: 1,
    });
  }
  if (!isIp && SUSPICIOUS_TLDS.has(tld)) {
    flags.push({
      id: "suspicious_tld",
      label: "자주 악용되는 최상위 도메인",
      reason: "." + tld + " 도메인은 스팸·피싱에 자주 쓰인다고 알려져 있습니다(참고용 목록).",
      points: 2,
    });
  }
  if ((host.match(/-/g) ?? []).length >= 3) {
    flags.push({
      id: "many_hyphens",
      label: "하이픈이 많은 도메인",
      reason: "도메인에 하이픈이 3개 이상 들어 있습니다.",
      points: 1,
    });
  }
  if (!isIp && labels.length - registrable.split(".").length >= 3) {
    flags.push({
      id: "deep_subdomain",
      label: "하위 도메인이 많음",
      reason: "하위 도메인이 3단계 이상이라 실제 도메인을 알아보기 어렵습니다.",
      points: 1,
    });
  }
  if (!isIp) {
    const brand = findBrandMismatch(host, registrable);
    if (brand) {
      flags.push({
        id: "brand_mismatch",
        label: "브랜드 이름이 든 비공식 도메인",
        reason:
          "'" + brand.token + "' 이(가) 도메인에 들어 있지만 공식 도메인 목록에 없는 주소입니다(참고용 목록).",
        points: 2,
      });
    } else {
      const lookalike = findBrandLookalike(registrable);
      if (lookalike) {
        flags.push({
          id: "brand_lookalike",
          label: "브랜드 이름을 흉내 낸 주소",
          reason:
            "'" + lookalike.token + "' 과(와) 글자 하나만 다른 주소입니다. 공식 주소처럼 보이게 만든 가짜 주소일 수 있습니다(참고용 목록).",
          points: 2,
        });
      }
    }
  }
  if (parsed.scheme === "http") {
    flags.push({
      id: "plain_http",
      label: "암호화되지 않은 http",
      reason: "https 가 아닌 http 주소입니다(참고 정보이며 점수에는 반영하지 않음).",
      points: 0,
    });
  }
  return flags;
}

/**
 * 사용자가 넣은 원문 주소 문자열에서만 보이는 위장 흔적.
 * 분석용 정규화(NFKC)는 ③ 같은 글자를 평범한 숫자로 바꿔 버리므로 원문을 따로 본다.
 */
function buildOriginalFlags(originalText: string): UrlFlag[] {
  const flags: UrlFlag[] = [];
  let lookalike = 0;
  for (const ch of originalText) {
    if (ch.charCodeAt(0) > 127 && /^[\x21-\x7e]+$/.test(ch.normalize("NFKC"))) {
      lookalike += 1;
    }
  }
  if (lookalike > 0) {
    flags.push({
      id: "lookalike_chars",
      label: "주소에 위장 문자 사용",
      reason:
        "주소 안에 ③·전각 문자처럼 일반 숫자·영문으로 보이게 만든 특수 문자가 " +
        lookalike +
        "개 섞여 있습니다. 정상 주소에는 거의 쓰지 않는 위장 방식입니다.",
      points: 2,
    });
  }
  const tld = /\.([A-Za-z]{2,})(?=[/?#:]|$)/.exec(originalText.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0]);
  if (tld && /[a-z]/.test(tld[1]) && /[A-Z]/.test(tld[1]) && tld[1] !== tld[1][0].toUpperCase() + tld[1].slice(1).toLowerCase()) {
    flags.push({
      id: "odd_case",
      label: "대소문자가 뒤섞인 주소",
      reason: "최상위 도메인(." + tld[1] + ")의 대소문자가 뒤섞여 있습니다. 일부러 단속을 피하려는 모양일 수 있습니다.",
      points: 1,
    });
  }
  return flags;
}

function levelOf(points: number): UrlLevel {
  if (points >= 2) {
    return "elevated";
  }
  if (points >= 1) {
    return "low";
  }
  return "none";
}

export interface UrlAnalysis {
  findings: UrlFinding[];
  count: number;
  /** 링크를 빼고 나면 글자·숫자가 거의 남지 않는 메시지 */
  onlyUrl: boolean;
}

/**
 * 원문에서 URL 을 찾아 구조를 분석한다.
 * @param original 사용자가 넣은 원문(위치 기준)
 * @param view 원문의 일반(공백 유지) 정규화 결과
 */
export function analyzeUrls(original: string, view: NormalizedView): UrlAnalysis {
  const candidates = collectCandidates(view.text);
  const findings: UrlFinding[] = [];

  for (const candidate of candidates) {
    let rawForParse = candidate.spaced ? candidate.raw.replace(/ /g, "") : candidate.raw;
    if (candidate.masked) {
      rawForParse = rawForParse.replace(/\*/g, "");
    }
    const parsed = parseUrl(rawForParse);
    if (!parsed) {
      continue;
    }
    const labels = parsed.host.split(".");
    const registrable = registrableOf(labels);
    const span = toOriginalSpan(view, candidate.start, candidate.end);
    const originalText = original.slice(span.start, span.end);
    const length = Array.from(originalText).length;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.host);
    const subdomainDepth = isIp ? 0 : Math.max(0, labels.length - registrable.split(".").length);
    const flags = [...buildFlags(parsed, labels, registrable), ...buildOriginalFlags(originalText)];
    if (candidate.masked) {
      flags.push({
        id: "masked_domain",
        label: "일부를 가린 주소",
        reason:
          "주소 일부가 '*' 같은 기호로 가려져 있어 실제 주소를 확인할 수 없습니다. 필터를 피하려는 불법 광고에서 자주 쓰입니다.",
        points: 2,
      });
    }
    if (candidate.spaced) {
      flags.push({
        id: "spaced_domain",
        label: "띄어쓰기로 위장한 주소",
        reason:
          "주소의 점(.) 앞뒤에 띄어쓰기를 넣어 문자 앱이 링크로 인식하지 못하게 만든 모양입니다. 차단을 피하려는 불법 광고에서 자주 쓰입니다.",
        points: 2,
      });
    }
    if (length > LONG_URL_CHARS) {
      flags.push({
        id: "long_url",
        label: "매우 긴 주소(참고)",
        reason:
          "주소가 " + length + "자로 길어 실제 목적지를 한눈에 알아보기 어렵습니다. 다만 정상 안내 문자에도 긴 주소가 흔해서 점수에는 넣지 않았습니다.",
        points: 0,
      });
    }
    const points = flags.reduce((sum, f) => sum + f.points, 0);
    findings.push({
      text: originalText,
      length,
      subdomainDepth,
      start: span.start,
      end: span.end,
      scheme: parsed.scheme,
      host: parsed.host,
      registrableDomain: registrable,
      flags,
      points,
      level: levelOf(points),
    });
  }

  let rest = "";
  let cursor = 0;
  for (const candidate of candidates) {
    rest += view.text.slice(cursor, candidate.start) + " ";
    cursor = candidate.end;
  }
  rest += view.text.slice(cursor);
  const letters = rest.match(/[a-z0-9가-힣]/g);
  const onlyUrl = candidates.length > 0 && (letters ? letters.length : 0) < 4;

  return { findings, count: findings.length, onlyUrl };
}

/** 가장 높은 URL 단계 */
export function maxUrlLevel(findings: readonly UrlFinding[]): UrlLevel {
  let level: UrlLevel = "none";
  for (const f of findings) {
    if (f.level === "elevated") {
      return "elevated";
    }
    if (f.level === "low") {
      level = "low";
    }
  }
  return level;
}
