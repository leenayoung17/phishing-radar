/**
 * 분석 엔진 동작 확인용 시험 문장. 모두 직접 작성한 가상의 문장이다.
 * 이 시험은 "규칙이 의도대로 동작하는지" 확인하는 용도이며 실제 탐지 성능을 뜻하지 않는다.
 */

import type { Grade, RiskCategory } from "./types";

export interface AnalysisCase {
  id: string;
  group: "risk" | "normal" | "uncertain";
  text: string;
  /** 허용하는 등급(하나 이상) */
  expectGrades: Grade[];
  /** 근거(evidence)에 반드시 들어 있어야 하는 유형 */
  mustCategories?: RiskCategory[];
  /** 근거에 들어 있으면 안 되는 유형 */
  mustNotCategories?: RiskCategory[];
  /** 요청 범위 밖이라 현재 엔진이 놓치는 것을 알고 있는 사례. 실패로 세지 않고 따로 표시한다. */
  knownGap?: string;
}

export const ANALYSIS_CASES: AnalysisCase[] = [
  // ---------------------------------------------------------- 위험
  {
    id: "risk-family-money",
    group: "risk",
    text: "엄마 나 폰이 고장나서 친구 폰으로 문자해. 급하게 300만원만 이 계좌로 송금해줘. 110-123-456789",
    expectGrades: ["high"],
    mustCategories: ["family_impersonation", "money_request"],
  },
  {
    id: "risk-family-giftcard",
    group: "risk",
    text: "엄마 핸드폰 액정이 깨져서 번호 바뀌었어. 카톡 안 되니까 문상 30만원 사서 핀번호 보내줘",
    expectGrades: ["high", "caution"],
    mustCategories: ["family_impersonation"],
  },
  {
    id: "risk-institution-credential",
    group: "risk",
    text: "[국민은행] 고객님 계좌가 보안 위반으로 정지되었습니다. 즉시 http://kb-secure-login.xyz/verify 접속 후 인증번호와 계좌 비밀번호를 입력하세요",
    expectGrades: ["high"],
    mustCategories: ["institution_impersonation", "credential_request"],
  },
  {
    id: "risk-police-remote",
    group: "risk",
    text: "서울중앙지검 수사관입니다. 고객님 명의 계좌가 범죄에 연루되어 조사가 필요합니다. 팀뷰어 앱을 설치하고 연결해 주세요",
    expectGrades: ["high"],
    mustCategories: ["remote_app"],
  },
  {
    id: "risk-parcel-url",
    group: "risk",
    text: "[CJ대한통운] 주소 불일치로 배송이 보류되었습니다. 24시간 내에 확인하지 않으면 반송됩니다 bit.ly/3xAbC12",
    expectGrades: ["high", "caution"],
    mustCategories: ["institution_impersonation"],
  },
  {
    id: "risk-apk",
    group: "risk",
    text: "택배 배송 불가. 아래 링크에서 apk 파일을 설치해서 주소를 다시 등록해주세요 http://192.168.10.5/app.apk",
    expectGrades: ["high", "caution"],
  },
  {
    id: "risk-loan",
    group: "risk",
    text: "고객님은 저금리 대환대출 대상자입니다. 기존 대출 상환 후 지정 계좌로 송금하시면 즉시 승인됩니다",
    expectGrades: ["high", "caution"],
    knownGap: "송금을 유도하는 대출 사칭 문장은 아직 '판단 어려움'에 그친다. 대출 광고형은 일부 잡지만 이 문장 유형은 약하다.",
  },
  {
    id: "risk-obfuscated-spacing",
    group: "risk",
    text: "엄 마 나 폰 고 장 나 서 급 하 게 돈 좀 송 금 해 줘 계 좌 알 려 줄 게",
    expectGrades: ["high", "caution"],
    mustCategories: ["family_impersonation"],
  },
  {
    id: "risk-nfd-hangul",
    group: "risk",
    text: "엄마 나 폰 고장나서 친구 폰이야. 급하게 송금해줘 계좌번호 110-123-456789".normalize("NFD"),
    expectGrades: ["high", "caution"],
    mustCategories: ["family_impersonation"],
  },
  {
    id: "risk-fullwidth-url",
    group: "risk",
    text: "[국세청] 환급금 지급 대상입니다. ｈｔｔｐ://ｎｔｓ-refund.top/ 에서 카드번호와 인증번호를 입력하세요",
    expectGrades: ["high", "caution"],
  },
  {
    id: "risk-zero-width",
    group: "risk",
    text: "엄​마 나 폰 고​장나서 급​하게 송​금해줘 계좌번호 110-123-456789",
    expectGrades: ["high", "caution"],
  },

  {
    id: "risk-gambling-user-report",
    group: "risk",
    text: "[국제발신]\n정통바카라\n우카계열\n첫→24비OK\n가→30000쿺\n입→100000출\n\ngh③7c.COm",
    expectGrades: ["high"],
    mustCategories: ["illegal_gambling"],
  },
  {
    id: "risk-coinone-typosquat-user-report",
    group: "risk",
    text: "[국외발신]\n[코인원]\n고객님계정이\n해외IP에서\n로그인되였습니다.해외IP차단해주세요.\nwww.coinonve.com",
    expectGrades: ["high"],
    mustCategories: ["institution_impersonation"],
  },
  {
    id: "risk-family-voucher-chat-user-report",
    group: "risk",
    text:
      "엄마 그리고 이거 5만원권 3장으로만\n더 구매해줘\n\n2만원권이랑 5만원권 2가지 필요해\n\n그 이모님 한테 한번만 더 부탁해줘\n\n구매 했어?\n\n엄마 아직이야?\n\n엄마 가입할수 있겠어?\n\n아니면 네가 엄마 폰이랑 연결해서\n해볼께\n\n그러면 엄마 좀 잇다 톡해줘\n\n엄마 집 가면 톡해줘",
    expectGrades: ["high"],
    mustCategories: ["money_request", "remote_app"],
  },
  {
    id: "normal-cash-bills",
    group: "normal",
    text: "아까 5만원권 3장 줬는데 받았지? 거스름돈은 내일 줄게",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["money_request"],
  },
  {
    id: "normal-phone-pc-link",
    group: "normal",
    text: "내 폰이랑 컴퓨터 연결해서 사진 옮겼어 확인해봐",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["remote_app"],
  },
  {
    id: "risk-glyph-domain-casino",
    group: "risk",
    text: "ⓩⓟⓩ22.comZ-CASINO~ 금일 대박나세요~",
    expectGrades: ["high", "caution"],
    mustCategories: ["evasion"],
  },
  {
    id: "normal-numbered-list",
    group: "normal",
    text: "신청 안내 ① 신청기간 5월 1일~5월 10일 ② 준비물 신분증 ③ 문의 고객센터",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["evasion"],
  },
  {
    id: "risk-spaced-domain-user-report",
    group: "risk",
    text: "어코드 입니다.기존 주소 이용 불가할 경우ac-ot . com 으로 이용 !tok : adp**",
    expectGrades: ["high"],
    mustCategories: ["illegal_gambling"],
  },
  {
    id: "risk-masked-separator-spam-user-report",
    group: "risk",
    text: "소▶봉구울▶신규! *이상치킨C ▶ *+* **+*.* **+*지▶톡▶c****노▶추천▶****me*.kr/*v*uv",
    expectGrades: ["high"],
    mustCategories: ["evasion"],
  },
  {
    id: "risk-gambling-slang-user-report",
    group: "risk",
    text: "♥ FM ♥따본 사람이 안다!넣기만 하면 딴다!**분째'퐁당퐁당'ⓕⓜⓕ***.com",
    expectGrades: ["high"],
    mustCategories: ["illegal_gambling", "evasion"],
  },
  {
    id: "risk-bet-variant-user-report",
    group: "risk",
    text: "불금♥어차피벧./튕할꺼혜/택더받고, 대우더받읍시다!bit.ly/*vi*Rg*com",
    expectGrades: ["high"],
    mustCategories: ["illegal_gambling", "evasion"],
  },
  {
    id: "normal-heart-family",
    group: "normal",
    text: "엄마 생일 축하해♥ 오늘 저녁에 케이크 사 갈게♥",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["evasion"],
  },
  {
    id: "normal-sports-betting-news",
    group: "normal",
    text: "어제 축구 경기 해설에서 배팅 이야기가 나왔는데 선수들 실력이 정말 좋더라",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["illegal_gambling"],
  },
  {
    id: "normal-certificate-and-deposit",
    group: "normal",
    text: "이번 달에 자격증 따고 월급 넣으면 적금 들 거야. 엄마도 같이 할래?",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["illegal_gambling"],
  },
  {
    id: "normal-homepage-address-change",
    group: "normal",
    text: "회사 홈페이지 주소가 변경되었습니다. 앞으로 새 홈페이지로 접속해 주세요.",
    expectGrades: ["no_clear_signal", "uncertain"],
  },
  {
    id: "risk-gambling-no-url",
    group: "risk",
    text: "[Web발신] 카지노 첫충 30% 지급 신규가입 이벤트 진행중",
    expectGrades: ["high", "caution"],
    mustCategories: ["illegal_gambling"],
  },
  {
    id: "normal-baseball-batting",
    group: "normal",
    text: "어제 경기에서 그 타자가 배팅 연습을 많이 했다고 하더라 오늘도 이길 것 같아",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["illegal_gambling"],
  },

  // ---------------------------------------------------------- 정상
  {
    id: "normal-otp",
    group: "normal",
    text: "[Web발신] [신한은행] 인증번호 482915 입니다. 타인에게 절대 알려주지 마세요.",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["credential_request"],
  },
  {
    id: "normal-bank-transaction",
    group: "normal",
    text: "[KB국민] 11/05 14:22 입금 50,000원 홍*동 잔액 1,234,567원 (계좌 123456-**-****)",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["money_request"],
  },
  {
    id: "normal-delivery",
    group: "normal",
    text: "[쿠팡] 주문하신 상품이 오늘 오후 배송 예정입니다. 문 앞에 두고 갑니다.",
    expectGrades: ["no_clear_signal", "uncertain"],
  },
  {
    id: "normal-phishing-warning",
    group: "normal",
    text: "[농협] 금융기관은 전화나 문자로 인증번호, 비밀번호를 요구하지 않습니다. 보이스피싱에 주의하세요.",
    expectGrades: ["no_clear_signal", "uncertain", "caution"],
  },
  {
    id: "normal-friend-chat",
    group: "normal",
    text: "오늘 저녁에 같이 밥 먹을래? 6시에 강남역에서 보자",
    expectGrades: ["no_clear_signal", "uncertain"],
  },
  {
    id: "normal-official-url",
    group: "normal",
    text: "내일 회의 자료는 https://www.naver.com/ 에서 확인 가능합니다. 참고해 주세요.",
    expectGrades: ["no_clear_signal", "uncertain"],
  },
  {
    id: "normal-email-only",
    group: "normal",
    text: "문의 사항은 hong.gildong@gmail.com 으로 보내주시면 확인 후 답변드리겠습니다.",
    expectGrades: ["no_clear_signal", "uncertain"],
  },
  {
    id: "normal-family-chat",
    group: "normal",
    text: "엄마 오늘 저녁 뭐 먹어? 나 6시쯤 들어갈게",
    expectGrades: ["no_clear_signal", "uncertain"],
    mustNotCategories: ["money_request"],
  },
  {
    id: "normal-negated-transfer",
    group: "normal",
    text: "계좌 이체나 송금을 요구하지 않습니다. 의심되면 직접 지점에 문의하세요.",
    expectGrades: ["no_clear_signal", "uncertain", "caution"],
  },

  // ---------------------------------------------------------- 판단 어려움
  {
    id: "uncertain-empty",
    group: "uncertain",
    text: "",
    expectGrades: ["uncertain"],
  },
  {
    id: "uncertain-short",
    group: "uncertain",
    text: "네 알겠어요",
    expectGrades: ["uncertain"],
  },
  {
    id: "uncertain-only-url",
    group: "uncertain",
    text: "https://example.com/abc",
    expectGrades: ["uncertain", "caution"],
  },
  {
    id: "uncertain-weak-signal",
    group: "uncertain",
    text: "내일까지 확인 부탁드립니다. 가능하시면 회신 주세요.",
    expectGrades: ["uncertain", "no_clear_signal"],
  },
];
