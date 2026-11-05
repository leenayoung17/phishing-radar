/**
 * 한국어 위험 표현 규칙과 정상 맥락(오탐 억제) 정의.
 *
 * - 모든 패턴은 "공백을 모두 지운 정규화 문자열"(compact view) 위에서 매칭한다.
 *   그래서 패턴에는 공백이 없고, "송 금 해 줘" 같은 띄어쓰기 회피도 잡을 수 있다.
 * - 문장 안에서만 연결되도록 [^.!?] 를 쓴다(마침표·물음표·느낌표를 넘지 않는다).
 * - signal: 점수에 직접 반영되는 근거, context: 같은 유형에 signal 이 있을 때만 보조로 반영.
 * - negatable: 바로 뒤에 "하지 마세요/않습니다" 같은 부정·주의 문맥이 있으면 점수에서 뺀다.
 * - 이 규칙은 직접 만든 알려진 표현 목록이며, 새로운 수법을 모두 잡는다고 보장하지 않는다.
 *   실제 성능은 검증하지 않았다.
 */

import type { RiskCategory, RuleKind } from "./types";

export interface RuleDef {
  id: string;
  category: RiskCategory;
  label: string;
  reason: string;
  weight: 1 | 2 | 3;
  kind: RuleKind;
  negatable: boolean;
  patterns: readonly RegExp[];
}

// ---------------------------------------------------------------- 기호로 끊어 쓴 광고 단어
/** 광고·도박에 자주 쓰이는 단어. 글자 사이에 기호를 끼워 넣어 단어 검사를 피하는 경우를 잡는다. */
const SPLIT_WORDS = [
  "혜택", "가입", "충전", "환전", "입금", "출금", "쿠폰", "당첨", "이벤트", "보너스", "무료", "지급",
  "첫충", "매충", "대박", "카지노", "바카라", "토토", "슬롯", "먹튀", "신규", "추천", "베팅", "배팅", "수익",
];
const SPLIT_SEP = "[./·'`_~|♥♡★☆*,\\-]";

/** 각 단어에서 글자 사이 어딘가에 기호가 한 번 이상 끼어 있는 형태만 만든다(끊기지 않은 원래 단어는 제외). */
function splitWordPattern(): RegExp {
  const alts: string[] = [];
  for (const word of SPLIT_WORDS) {
    const chars = Array.from(word);
    for (let i = 1; i < chars.length; i += 1) {
      const left = chars.slice(0, i).join(SPLIT_SEP + "*");
      const right = chars.slice(i).join(SPLIT_SEP + "*");
      alts.push(left + SPLIT_SEP + "+" + right);
    }
  }
  return new RegExp("(?:" + alts.join("|") + ")");
}

export const RULES: readonly RuleDef[] = [
  // ------------------------------------------------------------ 가족·지인 사칭
  {
    id: "family.address_term",
    category: "family_impersonation",
    label: "가족 호칭",
    reason:
      "엄마·아빠 같은 가족 호칭이 쓰였습니다. 호칭만으로는 위험 신호가 아니며 다른 근거와 함께 볼 때만 반영합니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [
      /(엄마|어머니|엄니|아빠|아버지|아부지|이모|고모|삼촌|할머니|할아버지|(아들|딸)(이야|이에요|예요|이다|인데|입니다))/,
    ],
  },
  {
    id: "family.self_intro",
    category: "family_impersonation",
    label: "'나야' 식 자기소개",
    reason: "상대가 누구인지 밝히지 않고 '나야' 식으로 시작합니다. 단독으로는 위험 신호가 아닙니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(나야|저야|나예요|저예요|저에요)/],
  },
  {
    id: "family.phone_trouble",
    category: "family_impersonation",
    label: "휴대폰 고장·분실 핑계",
    reason: "휴대폰이 고장 났다거나 수리를 맡겼다는 말은 가족 사칭 사기에서 자주 쓰는 첫 핑계입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(폰|핸드폰|휴대폰|휴대전화|스마트폰)(이|가|을|를|이랑|도)?[^.!?]{0,3}(고장|망가|깨졌|깨져|깨짐|먹통|분실|잃어|떨어뜨|수리|안켜|안돼|안되|침수)/,
      /액정(이|가)?[^.!?]{0,2}(깨|파손|나가)/,
      /(수리|as)(를|좀)?(맡겼|맡겨|맡기|보냈|보내)/,
      /(폰|핸드폰|휴대폰|휴대전화)[^.!?]{0,10}(떨궈|떨궜|떨어뜨|변기|물에빠|전원(이)?안|수리중|켜지지않)/,
    ],
  },
  {
    id: "family.borrowed_phone",
    category: "family_impersonation",
    label: "다른 기기·남의 폰으로 연락",
    reason: "친구 폰이나 컴퓨터로 문자를 보낸다는 설명은 평소 번호가 아닌 곳에서 연락하는 이유로 자주 쓰입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(친구|지인|동료|직원|이웃)(의|분)?(폰|핸드폰|휴대폰|전화)(으로|로|를|을|빌려)/,
      /(컴퓨터|pc|피씨|노트북)(로|으로|용이라|용이어서|용인데)?[^.!?]{0,6}문자/,
      /문자나라/,
    ],
  },
  {
    id: "family.cannot_call",
    category: "family_impersonation",
    label: "통화가 어렵다는 말",
    reason: "목소리를 확인하지 못하게 통화가 어렵다고 말합니다. 평범한 대화에도 나오므로 보조 근거로만 봅니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(통화|전화|목소리)(가|는|를|도)?[^.!?]{0,2}(안돼|안되|못해|못받|불가|힘들|어려워|곤란|안받|못하)/],
  },
  {
    id: "family.new_number",
    category: "family_impersonation",
    label: "번호 변경·새 번호 안내",
    reason: "번호가 바뀌었다며 새 번호로 연락하라는 말은 가족 사칭의 전형적인 시작입니다(실제 가족일 수도 있습니다).",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [/(번호|연락처)(가|를|도)?[^.!?]{0,2}(바뀌|바꿨|변경|새로)/, /새(번호|폰|핸드폰)/],
  },
  {
    id: "family.ask_reply",
    category: "family_impersonation",
    label: "문자·톡 답장 요구",
    reason: "문자나 카톡으로 답장을 달라는 표현입니다. 단독으로는 위험 신호가 아닙니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(문자|톡|카톡|카카오톡|답장)(좀|으로|라도)?(해|줘|주세요|주라|보내|남겨|확인)/],
  },
  {
    id: "family.ceremony_invite",
    category: "family_impersonation",
    label: "경조사 초대·부고 링크",
    reason: "결혼·부고·돌잔치 초대를 내세워 링크를 누르게 하는 방식은 지인 사칭 스미싱에서 자주 쓰입니다. 실제 초대일 수도 있습니다.",
    weight: 3,
    kind: "signal",
    negatable: false,
    patterns: [
      /(결혼|혼인|청첩|부고|별세|장례|돌잔치|모바일초대|식장|예식)[\s\S]{0,60}?(https?:\/\/|www\.|[a-z0-9-]{2,}\.[a-z]{2,6}\/)/,
      /(https?:\/\/|www\.|[a-z0-9-]{2,}\.[a-z]{2,6}\/)[\s\S]{0,40}?(결혼|혼인|청첩|부고|별세|장례|돌잔치)/,
    ],
  },

  // ------------------------------------------------------------ 송금·금전 요구
  {
    id: "money.transfer_request",
    category: "money_request",
    label: "송금·입금 요구",
    reason: "송금·입금·이체를 해 달라고 직접 요구하는 표현입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [
      /(송금|입금|이체)(을|를|좀|부터|먼저)?(해|하)?(줘|줄수|줄래|주세요|주라|주실|주시|달라|부탁|세요|십시오|셔야|야)/,
      /(돈|비용|금액|[0-9][0-9,]*(만|천)?원)(을|를|좀|만)?[^.!?]{0,3}(빌려|보내|부쳐|입금|송금|이체)(해|하)?(줘|줄|주세요|주라|달라|부탁|야|야돼|야되)/,
      /계좌(로|에)?[^.!?]{0,12}(보내|입금|송금|이체)(해|하)?(줘|줄|주세요|주라|달라|부탁|세요|야)/,
      /(송금|입금|이체|결제|구매|구입)[^.!?]{0,10}대신(좀|먼저|우선|잠깐|한번)*(해|하)?(줘|줄|주세요|주라|달라)/,
      /대신(좀|먼저|우선|잠깐|한번)*(송금|입금|이체|결제|구매|구입|사)(해|하)?(줘|줄|주세요|주라|달라)/,
    ],
  },
  {
    id: "money.giftcard_mention",
    category: "money_request",
    label: "상품권·기프트카드 언급",
    reason: "문화상품권·구글 기프트카드 같은 현금성 상품권은 사기에서 결제 수단으로 자주 요구됩니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [/(문화상품권|구글기프트|기프트카드|기프트권|구글플레이카드|해피머니|컬쳐랜드|애플기프트)/],
  },
  {
    id: "money.giftcard_purchase",
    category: "money_request",
    label: "상품권 구매·핀번호 요구",
    reason: "상품권을 대신 사 달라거나 핀 번호를 보내 달라는 표현입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [
      /(상품권|기프트|기프트권|기프트카드|구글플레이)[^.!?]{0,16}(사줘|사줄|사주|구매해|구입해|결제해|핀번호|핀을|코드를?보내|번호를?보내|사서)/,
      /(사|구매|구입)(해|하)?(줄수|줘|주세요|주라)[^.!?]{0,6}(상품권|기프트)/,
    ],
  },
  {
    id: "money.voucher_denomination",
    category: "money_request",
    label: "상품권 금액·장수를 정해 구매 요구",
    reason:
      "'5만원권 3장 구매해줘'처럼 상품권 금액과 장수를 정해 대신 사 달라는 표현입니다. 가족·지인을 사칭한 상품권 사기에서 자주 쓰입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [
      /([0-9]+만원권|[0-9]+천원권)[^.!?]{0,16}(사줘|사달라|사주|사와|사서|구매해(줘|주|달라)|구입해(줘|주|달라))/,
      /(구매|구입)(해줘|해주|해달라|해주세요|해봐)[^.!?]{0,12}([0-9]+만원권|[0-9]+천원권)/,
      /([0-9]+만원권)(이랑|하고|과|와)[^.!?]{0,6}([0-9]+만원권)[^.!?]{0,8}필요/,
      /(문상|문화상품권)[^.!?]{0,12}(사서|사줘|사달라|구매해(줘|주|달라)|핀번호)/,
    ],
  },
  {
    id: "money.purchase_check",
    category: "money_request",
    label: "구매·송금 했는지 재촉",
    reason: "'구매했어?'처럼 돈을 쓰거나 보냈는지 계속 확인합니다. 다른 금전 요구와 함께 있을 때만 보조 근거로 봅니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(구매|결제|송금|입금)(했어|했니|했나|했냐|했음|했어요)/],
  },
  {
    id: "money.account_number",
    category: "money_request",
    label: "은행 계좌번호 제시",
    reason: "은행 이름과 계좌번호가 함께 적혀 있어 입금처를 알려 주는 표현일 수 있습니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(국민|신한|우리|하나|농협|기업|카카오뱅크|카뱅|토스뱅크|케이뱅크|새마을|우체국|수협|대구|부산|경남|광주|전북|제주|씨티|sc제일)(은행)?[0-9]{2,6}-?[0-9]{2,8}-?[0-9]{2,8}/,
    ],
  },
  {
    id: "money.urgent_cash",
    category: "money_request",
    label: "급한 돈 이야기",
    reason: "급하게 돈이 필요하다는 표현입니다. 단독으로는 판단하기 어렵습니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(급하게|급히|급해서|급한|긴급)[^.!?]{0,6}(돈|송금|입금|이체|결제|현금)/,
      /(돈|현금)(이|을|좀)?[^.!?]{0,2}(필요해|급해|빌려줘|빌려줄)/,
    ],
  },

  // ------------------------------------------------------------ 금융기관·공공기관·기업 사칭
  {
    id: "inst.sender_claim",
    category: "institution_impersonation",
    label: "기관·기업 이름 표시",
    reason: "[국민은행] 같은 꼬리표로 발신 기관을 밝히고 있습니다. 정상 안내에도 흔해서 보조 근거로만 봅니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [
      /[[【(][^\]】)]{0,14}(은행|카드|증권|보험|금융|캐피탈|뱅크|페이|우체국|택배|물류|통운|로지스|국세청|세무|경찰|검찰|법원|정부|건강보험|국민연금|금융감독|금감원|통신|텔레콤|쿠팡|네이버|카카오|토스|kb|skt|lgu|cj|코인원|업비트|빗썸|코빗|거래소|텔레그램|인스타그램|이베이|아마존|애플|구글)[^\]】)]{0,10}[\]】)]/,
    ],
  },
  {
    id: "inst.name_mention",
    category: "institution_impersonation",
    label: "기관·기업 이름 언급",
    reason: "금융기관·공공기관·택배사 이름이 언급됩니다. 이름만으로는 위험 신호가 아닙니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [
      /(국민은행|신한은행|우리은행|하나은행|농협|기업은행|카카오뱅크|토스뱅크|케이뱅크|금융감독원|금감원|국세청|경찰청|검찰청|대법원|건강보험공단|국민연금공단|우체국|cj대한통운|대한통운|한진택배|로젠택배|롯데택배|쿠팡|정부24|코인원|업비트|빗썸|코빗)/,
    ],
  },
  {
    id: "inst.authority_threat",
    category: "institution_impersonation",
    label: "수사기관 사칭·안전계좌 이체 유도",
    reason: "검찰·경찰·금융감독원 등을 내세워 범죄 연루를 말하거나 안전계좌 이체를 유도하는 표현입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [
      /(검찰|검사|경찰|수사관|금융감독원|금감원|국세청|법원|사이버수사|형사)[^.!?]{0,20}(범죄|연루|사건|수사|체포|구속|영장|동결|도용|안전계좌|조사)/,
      /(안전계좌|국가안전계좌|임시계좌|보호계좌)/,
    ],
  },
  {
    id: "inst.overdue_notice",
    category: "institution_impersonation",
    label: "미납·과태료·고지서 확인 유도",
    reason: "미납금·과태료·통지서를 확인하거나 납부하라는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [/(통지서|고지서|과태료|범칙금|벌점|체납|미납)[^.!?]{0,10}(발송|발부|부과|확인|납부|조회|열람|이의)/],
  },
  {
    id: "inst.parcel_problem",
    category: "institution_impersonation",
    label: "배송 문제·주소 확인 유도",
    reason: "배송 실패·주소 오류를 내세워 주소 확인이나 수정을 유도하는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(배송|택배|배달|물품|상품|우편)[^.!?]{0,8}(실패|불가|지연|오류|반송|보류|미수령|주소불명|주소오류|송달)/,
      // '주소가 변경되었습니다'처럼 이미 끝난 안내는 제외한다(확인·수정을 요구하는 문구만 잡음).
      /(주소|배송지)(를|가|이|은|는)?[^.!?]{0,6}(확인|수정|변경|재입력|재설정|오류|불명)(?!되었|됐|되어|완료)/,
    ],
  },
  {
    id: "inst.account_suspend",
    category: "institution_impersonation",
    label: "계정·계좌 정지·이상 알림",
    reason: "계정이나 계좌가 정지·차단되거나 이상이 생겼다고 겁을 주는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [/(계정|계좌|카드|서비스|이용|통장|거래)[^.!?]{0,10}(정지|차단|제한|해지|동결|도용|해킹|비정상|이상거래)/],
  },
  {
    id: "inst.refund_prize",
    category: "institution_impersonation",
    label: "환급금·보상금·대출 승인 미끼",
    reason: "환급금·보상금·지급 대상·대출 승인 같은 이익을 내세워 연락을 유도하는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [/(환급금|보상금|지급대상|대출승인|한도상향|무직자대출|저금리대출|미수령)/],
  },
  {
    id: "inst.benefit_mention",
    category: "institution_impersonation",
    label: "환급·지원금·당첨 언급",
    reason: "환급·지원금·당첨 같은 말은 정상 광고·안내에도 흔해서 보조 근거로만 봅니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(환급|지원금|당첨)/],
  },
  {
    id: "inst.notice_check",
    category: "institution_impersonation",
    label: "통보서·검진결과·위반 안내 확인 유도",
    reason: "건강검진 결과·통보서·교통위반 같은 공적 통지를 내세워 내용 확인을 유도하는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(통보서|통보문|통지문|문진표|진단서|검진|진단결과|검사결과|도로위반|교통위반|법규위반)[^.!?]{0,24}(내용확인|내용보기|내용조회|결과조회|결과확인|확인하세요|확인바랍니다|전송완료|발송완료|발급완료|정상발송)/,
    ],
  },
  {
    id: "inst.not_you_inquiry",
    category: "institution_impersonation",
    label: "결제·로그인 알림 후 '본인이 아니면 문의' 유도",
    reason:
      "결제나 기기 등록 알림을 보내 놓고 본인이 아니면 연락하라고 해서 전화·링크로 유도하는 표현입니다. 정상 카드사 알림에도 비슷한 문구가 있을 수 있습니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(승인|결제|해외|구매|기기등록|로그인)[\s\S]{0,30}본인(이|은)?아(닐|닌|니)(경우|시|면|라면)?/,
      /본인(이|은)?아(닐|닌|니)(경우|시|면|라면)?[^.!?]{0,12}(문의|연락|확인요망|신고)/,
    ],
  },
  {
    id: "inst.foreign_login",
    category: "institution_impersonation",
    label: "해외 IP 로그인·차단 알림",
    reason:
      "해외에서 로그인됐다며 차단이나 확인을 유도하는 표현입니다. 거래소·포털 사칭에 자주 쓰이며, 정상 보안 알림에도 비슷한 문구가 있을 수 있습니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [/해외(ip|아이피)[\s\S]{0,24}(로그인|접속|차단|감지)/, /(로그인|접속)[\s\S]{0,12}해외(ip|아이피|에서)/],
  },
  {
    id: "inst.parcel_check",
    category: "institution_impersonation",
    label: "배송정보·송장 확인 유도",
    reason: "배송정보나 송장을 확인하라고 유도하는 표현입니다. 택배 사칭 문자에서 자주 쓰이며, 정상 택배 안내에도 비슷한 말이 있을 수 있습니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /(배송정보|송장번호|택배|물품|상품)[^.!?]{0,14}(확인바랍니다|확인해주세요|확인하세요|확인부탁|정보확인|확인해주)/,
      /택배[^.!?]{0,6}도착[^.!?]{0,10}(확인|본인)/,
    ],
  },
  {
    id: "inst.giveaway",
    category: "institution_impersonation",
    label: "금액 지급·증정 안내",
    reason: "수신자에게 일정 금액을 지급한다는 식으로 링크 접속을 유도하는 표현입니다. 정상 이벤트 안내와 구분이 어려울 수 있습니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [/(만원|[0-9]원)(이|을|를)?[^.!?]{0,6}지급(됩니다|되었|해드립니다|예정)/, /수신고객/],
  },
  {
    id: "inst.loan_offer",
    category: "institution_impersonation",
    label: "대출·저금리 상품 권유(금융기관 사칭 광고)",
    reason: "대출·저금리·정부지원 상품을 내세워 연락을 유도하는 광고성 문구입니다. 정상 금융 광고와 구분이 어려울 수 있습니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      /대[.\-·]?출[\s\S]{0,60}(무담보|무보증|무방문|저금리|최저금리|한도|당일|즉시|무직자|신용|정부|서민|긴급|승인|상환|금리|대환)/,
      /(무담보|무보증|무방문|저금리|최저금리|정부지원|서민지원|긴급지원|무직자|신용불량)[\s\S]{0,60}대[.\-·]?출/,
      /(최저금리|기준금리|적용이율|금리인하|상환방법|무직자|최고한도|한도최고|대환상품|긴급생활안정자금|생활안정자금|정부지원자금|지원자금)/,
    ],
  },

  // ------------------------------------------------------------ 인증번호·개인정보 요구
  {
    id: "cred.share_request",
    category: "credential_request",
    label: "인증번호·보안정보를 알려 달라는 요구",
    reason: "인증번호·보안카드·주민번호 등을 알려 주거나 보내 달라고 요구합니다. 정상 기관은 이를 요구하지 않습니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [
      /(인증번호|인증코드|otp|보안카드|공동인증서|공인인증서|주민등록번호|주민번호|카드번호|cvc|cvv|유효기간|신분증|계좌비밀번호)(를|을|좀|도|만|앞자리|뒷자리|전체|사진)?[^.!?]{0,8}(알려|보내|불러|말씀|전달|제출|전송|촬영|찍어|사진)/,
    ],
  },
  {
    id: "cred.password_financial",
    category: "credential_request",
    label: "금융 비밀번호 요구",
    reason: "계좌·카드·은행 비밀번호를 알려 달라거나 입력하라는 표현입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [/(계좌|카드|은행|통장|뱅킹|금융)[^.!?]{0,6}비밀번호(를|가|좀)?[^.!?]{0,8}(알려|보내|불러|말씀|전달|입력|제출)/],
  },
  {
    id: "cred.password_request",
    category: "credential_request",
    label: "비밀번호 요구",
    reason: "비밀번호를 알려 달라거나 입력하라는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [/비밀번호(를|가|좀)?[^.!?]{0,6}(알려|보내|불러|말씀|전달|입력|제출)/],
  },
  {
    id: "cred.entry_request",
    category: "credential_request",
    label: "인증번호·카드번호 입력 안내",
    reason:
      "인증번호나 카드번호를 입력하라는 안내입니다. 정상 인증 문자에도 흔해서 단독으로는 반영하지 않고, 의심스러운 링크와 함께 있을 때만 위험 근거가 됩니다.",
    weight: 1,
    kind: "context",
    negatable: true,
    patterns: [/(인증번호|인증코드|otp|카드번호|주민등록번호|주민번호|보안카드)(를|을|좀|도)?[^.!?]{0,8}(입력|넣어|기재|등록)/],
  },
  {
    id: "cred.personal_info_entry",
    category: "credential_request",
    label: "본인확인·개인정보 입력 요구",
    reason: "본인확인을 내세워 개인정보를 입력하거나 제출하라는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [/(개인정보|본인(인증|확인)|실명|신원|계좌정보|카드정보)(을|를)?[^.!?]{0,8}(입력|확인|갱신|업데이트|재확인|인증해|제출)/],
  },
  {
    id: "cred.noun_mention",
    category: "credential_request",
    label: "인증·보안 용어 언급",
    reason: "인증번호·비밀번호 같은 용어가 언급됩니다. 용어만으로는 위험 신호가 아닙니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(인증번호|인증코드|otp|비밀번호|주민등록번호|주민번호|카드번호|보안카드)/],
  },

  // ------------------------------------------------------------ 원격제어 앱 설치 유도
  {
    id: "remote.app_name",
    category: "remote_app",
    label: "원격제어 앱 이름",
    reason: "팀뷰어·애니데스크·퀵서포트 같은 원격제어 앱은 기기를 통째로 넘겨주게 되므로 사기에 자주 쓰입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [
      /(팀뷰어|teamviewer|애니데스크|anydesk|퀵서포트|quicksupport|알서포트|rsupport|rustdesk|airdroid|에어드로이드|splashtop|원격제어앱|원격지원앱)/,
    ],
  },
  {
    id: "remote.unknown_source",
    category: "remote_app",
    label: "출처 불명 앱 설치 허용 유도",
    reason: "알 수 없는 출처의 앱을 허용하거나 보안 경고를 끄라는 안내는 악성 앱 설치 유도에 쓰입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [/(알수없는출처|출처를알수없는|알수없는앱|보안(경고|설정)[^.!?]{0,4}(무시|해제|끄)|설치(를)?허용)/],
  },
  {
    id: "remote.control",
    category: "remote_app",
    label: "원격 접속·제어 유도",
    reason: "원격으로 연결하거나 제어·지원하겠다는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [/(원격)(으로)?[^.!?]{0,3}(제어|지원|접속|연결|조종|도움|설치)/, /(제어권|화면공유|화면을공유|화면을보여)/],
  },
  {
    id: "remote.phone_link",
    category: "remote_app",
    label: "상대 폰과 연결해서 대신 처리하겠다는 말",
    reason:
      "'엄마 폰이랑 연결해서 해볼게'처럼 상대의 휴대폰에 직접 연결해 조작하겠다는 표현은 원격 조종 앱 설치를 유도할 때 쓰입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [
      /(엄마|아빠|엄니|어머니|아버지|부모님|할머니|할아버지|이모|고모|삼촌|네|너|당신|고객님)(의)?(폰|핸드폰|휴대폰|휴대전화|스마트폰)(이랑|과|와|에|을|를)?[^.!?]{0,6}연결/,
    ],
  },
  {
    id: "remote.app_install",
    category: "remote_app",
    label: "앱·프로그램 설치 유도",
    reason: "앱이나 프로그램을 설치하라는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [/(앱|어플|애플리케이션|프로그램|apk|설치파일|보안앱|백신앱|확인앱)(을|를|이|도)?[^.!?]{0,6}(설치|다운로드|다운받|내려받)/],
  },
  {
    id: "remote.apk_mention",
    category: "remote_app",
    label: "APK 파일 언급",
    reason: "APK 설치 파일은 공식 앱 장터 밖에서 악성 앱을 설치하게 할 때 자주 쓰입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [/apk/],
  },

  // ------------------------------------------------------------ 불법 도박·베팅 사이트 유도
  {
    id: "gamble.site_term",
    category: "illegal_gambling",
    label: "불법 도박 사이트 용어",
    reason: "바카라·카지노·파워볼·먹튀 같은 도박 사이트 용어입니다. 모르는 번호로 온 도박 광고는 불법 도박 사이트로 이어지는 스팸입니다.",
    weight: 3,
    kind: "signal",
    negatable: true,
    patterns: [/(바카라|카지노|파워볼|먹튀|토토사이트|온라인슬롯|슬롯머신|슬롯사이트|사설토토|안전놀이터|메이저놀이터)/],
  },
  {
    id: "gamble.bonus_offer",
    category: "illegal_gambling",
    label: "첫충·입플 같은 도박 보너스 문구",
    reason: "첫충·입플·충전 보너스 같은 도박 사이트의 가입·입금 혜택 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [/(첫충|첫입금|입플|매충|충환전|가입쿠폰|꽁머니)/, /(첫|가|입|충)→[0-9]/],
  },
  {
    id: "gamble.win_slang",
    category: "illegal_gambling",
    label: "'넣으면 딴다' 같은 도박 광고 표현",
    reason:
      "'넣기만 하면 딴다', '따본 사람이 안다'처럼 돈을 넣으면(입금하면) 딸 수 있다고 유혹하는 불법 도박 광고 표현입니다.",
    weight: 3,
    kind: "signal",
    negatable: false,
    // '따다'·'넣다'는 일상어라 둘이 함께 쓰인 경우만 잡는다(조정용 데이터 정상 15,771건 중 0건).
    patterns: [
      /(넣|입금|충전)[^.!?]{0,8}(딴다|땁니다|따간다|따가|따요|따세요|따자|따는)/,
      /(따본|따봤|딴)(사람|분)[^.!?]{0,4}(안다|압니다|알죠|알지)/,
      /(넣|입금|충전)(으면|하면|시)[^.!?]{0,6}[0-9]+배/,
    ],
  },
  {
    id: "evade.split_word",
    category: "evasion",
    label: "기호로 끊어 쓴 광고 단어",
    reason:
      "'혜/택', '완.전.무.료'처럼 광고 단어의 글자 사이에 기호를 넣어 끊은 모양입니다. 단어 검사를 피하려는 광고에서 쓰입니다. 정상 광고도 강조용으로 가끔 써서 약한 신호로만 봅니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    // 조정용 데이터: 스미싱 357건, 정상 6건(0.06%). 하트(♥)만 있는 것은 정상에 더 많아(290건) 근거로 쓰지 않는다.
    patterns: [splitWordPattern()],
  },
  {
    id: "gamble.bet_variant",
    category: "illegal_gambling",
    label: "철자를 바꾼 '베팅'",
    reason:
      "'벧./튕', '벳팅'처럼 '베팅'을 일부러 다른 글자나 기호로 바꿔 쓴 표현입니다. 단어 검사를 피하려는 불법 도박 광고에서 쓰입니다.",
    weight: 3,
    kind: "signal",
    negatable: false,
    // 일반 '베팅·배팅'은 스포츠 기사에도 나와 제외하고, 철자를 바꾼 것만 잡는다(조정용 데이터 정상 0건).
    patterns: [
      /(벳|벧)[./,'·_\-~|]*(팅|튕)/,
      /(베|배)[./,'·_\-~|]*튕/,
      /(베|배)[./,'·_\-~|]+팅/,
    ],
  },
  {
    id: "gamble.address_change",
    category: "illegal_gambling",
    label: "차단된 사이트의 새 주소 안내",
    reason:
      "기존 주소가 막혔다며 새 주소로 접속하라는 안내입니다. 단속을 피해 주소를 계속 바꾸는 불법 도박·성인 사이트에서 흔히 쓰입니다.",
    weight: 2,
    kind: "signal",
    negatable: false,
    patterns: [
      // 사이에 새 주소(점 포함)가 끼므로 이 구간은 마침표도 허용한다.
      // 정상적인 '주소 변경 안내'와 구분하려고 '이용 불가·차단·막힘'만 잡는다.
      /(기존|이전|예전|구)?(주소|도메인|사이트)[^.!?]{0,8}(이용불가|접속불가|차단|막히|막혀)[\s\S]{0,30}?(으로|로)(이용|접속|오세요|들어오)/,
      /(신주소|우회주소|대체주소)/,
    ],
  },
  {
    id: "gamble.messenger_id",
    category: "illegal_gambling",
    label: "메신저 아이디로 연락 유도",
    reason:
      "카톡·텔레그램 아이디로 따로 연락하라는 표현입니다. 단독으로는 판단하기 어려워 다른 근거와 함께 볼 때만 반영합니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(카톡|카카오톡|톡|tok|텔레|텔레그램|telegram|라인)(아이디|id)?[:：][a-z0-9_]{2,}/],
  },
  {
    id: "gamble.betting_term",
    category: "illegal_gambling",
    label: "베팅·슬롯·룰렛 용어",
    reason: "베팅·슬롯·룰렛 같은 용어입니다. 일반 광고나 스포츠 기사에도 나와서 보조 근거로만 봅니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(베팅|배팅|슬롯|룰렛|홀덤|도박)/],
  },

  // ------------------------------------------------------------ 재촉·협박(보조 신호)
  {
    id: "pressure.deadline",
    category: "pressure",
    label: "기한·긴급 표현",
    reason: "긴급하다거나 기한 안에 하라고 재촉하는 표현입니다. 정상 안내에도 흔해서 보조 근거로만 봅니다.",
    weight: 1,
    kind: "context",
    negatable: false,
    patterns: [/(긴급|즉시|지금바로|당장|24시간(이내|안)|오늘(안에|까지|중)|기한(내|이내)|마감|서둘러|지금확인)/],
  },
  {
    id: "pressure.threat",
    category: "pressure",
    label: "불이익·협박 표현",
    reason: "정지·소멸·법적 조치 같은 불이익을 내세워 겁을 주는 표현입니다.",
    weight: 2,
    kind: "signal",
    negatable: true,
    patterns: [
      /(체포|구속|고발|법적(조치|책임)|형사(고발|처벌)|압류|강제집행|신용불량|불이익|소멸|정지됩|정지될|정지예정|이용제한|계정정지|영구정지)/,
    ],
  },
];

// ---------------------------------------------------------------- 부정·주의 문맥
/** 일치 직후(같은 문장 안)에 이런 표현이 오면 "요구하지 않습니다" 같은 경고 문장으로 본다. */
export const NEGATION_RE = /(지마|지않|마세요|마십시오|말고|금지|않습니다|않아요|않으며|없습니다|아닙니다|말것|하지말)/;

// ---------------------------------------------------------------- 정상 맥락
export interface BenignDef {
  id: string;
  label: string;
  reason: string;
  /** 이 맥락이 있으면 점수에서 빼는 규칙 ID */
  suppresses: readonly string[];
  /** compact 문자열에서 맥락을 찾아 [start, end) 를 돌려준다. 없으면 null */
  find: (compact: string) => { start: number; end: number } | null;
  /** true 이면 공식 목록에 없는 링크가 함께 있을 때는 정상 안내로 보지 않는다. */
  requiresCleanUrl?: boolean;
  /** true 이면 이 맥락이 있을 때(공식 목록에 없는 링크가 없을 때만) 통계 모델 신호로 등급을 올리지 않는다. */
  blocksModel?: boolean;
}

/**
 * 정상 택배·배송 상태 안내. 집하·배송 예정, 배송 출발·완료, 반품 접수 같은 상태 알림 문구.
 * 사기 문자는 보통 '보류·불가·주소 불일치' 뒤에 링크·연락을 요구하므로 링크 조건과 함께 쓴다.
 */
function findDeliveryNotice(t: string): { start: number; end: number } | null {
  // 광고 문자는 택배 상태 안내가 아니다.
  if (/\(광고\)|광고\)/.test(t)) {
    return null;
  }
  // 택배 관련 단어가 함께 있어야 한다('신청접수 되었습니다' 같은 다른 안내와 구분).
  if (!/(택배|소포|우편물|등기|집하|송장|운송장|반품|기사님|경비실|현관|문앞|로켓배송|통운|로지스|우체국)/.test(t)) {
    return null;
  }
  const m =
    /(집하|배송|배달|도착|수거|방문|회수|입고)(할|될|하실|해드릴|드릴)?예정|배송(이)?(출발|완료|중)|(집하|배달|배송|반품|입고|보관|반품접수|수거)(가|이|를)?(완료|되었|됐)|정상접수|경비실에(보관|맡겨)/.exec(
      t,
    );
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

function findOtpNotice(t: string): { start: number; end: number } | null {
  const code = /(인증번호|인증코드|otp|승인번호)[^0-9.!?]{0,6}[0-9]{4,8}/.exec(t);
  const warning =
    /(타인|누구에게도|절대|유출|노출|공유)[^.!?]{0,10}(알리지|알려주지|말아|마세요|금지|주의|공유하지|말씀하지)/.exec(t);
  if (!code || !warning) {
    return null;
  }
  return {
    start: Math.min(code.index, warning.index),
    end: Math.max(code.index + code[0].length, warning.index + warning[0].length),
  };
}

function findTransactionNotice(t: string): { start: number; end: number } | null {
  const m = /(입금|출금|이체|결제|승인|사용)(이)?(되었|됐|완료|내역|알림|안내)/.exec(t);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

function findScamWarning(t: string): { start: number; end: number } | null {
  const m = /(스미싱|보이스피싱|피싱|사칭)[^.!?]{0,20}(주의|예방|유의|범죄|사례|피해|조심)/.exec(t);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

export const BENIGN_DEFS: readonly BenignDef[] = [
  {
    id: "benign.scam_warning",
    label: "스미싱·피싱 예방 안내 문구",
    reason:
      "스미싱·피싱을 주의하라는 안내 문구라서, 그 안에 나열된 사기 수법 표현은 위험 근거로 보지 않습니다. 사기 문자가 이런 문구를 흉내 낼 수도 있어 링크 분석은 그대로 합니다.",
    suppresses: [
      "inst.parcel_problem",
      "inst.overdue_notice",
      "inst.account_suspend",
      "inst.authority_threat",
      "inst.refund_prize",
      "inst.notice_check",
      "inst.not_you_inquiry",
      "inst.loan_offer",
      "cred.share_request",
      "cred.password_financial",
      "cred.password_request",
      "cred.entry_request",
      "cred.personal_info_entry",
      "cred.noun_mention",
      "remote.app_name",
      "remote.unknown_source",
      "remote.control",
      "remote.app_install",
      "remote.apk_mention",
      "money.transfer_request",
      "money.giftcard_mention",
      "money.giftcard_purchase",
      "money.voucher_denomination",
      "pressure.threat",
      "family.phone_trouble",
      "family.borrowed_phone",
      "family.new_number",
    ],
    find: findScamWarning,
    blocksModel: true,
  },
  {
    id: "benign.delivery_notice",
    label: "택배·배송 상태 안내로 보이는 표현",
    reason:
      "집하·배송 예정, 배송 출발·완료 같은 정상 택배 안내의 형태이고 의심스러운 링크가 없어, 배송 관련 표현을 위험 근거로 보지 않습니다.",
    suppresses: ["inst.parcel_problem", "inst.parcel_check"],
    find: findDeliveryNotice,
    requiresCleanUrl: true,
    blocksModel: true,
  },
  {
    id: "benign.otp_notice",
    label: "인증번호 안내 문자로 보이는 표현",
    reason:
      "인증번호와 '타인에게 알리지 마세요' 같은 주의 문구가 함께 있어 정상적인 인증 안내 문자의 형태입니다.",
    suppresses: ["cred.entry_request", "cred.noun_mention", "cred.password_request"],
    find: findOtpNotice,
    requiresCleanUrl: true,
    blocksModel: true,
  },
  {
    id: "benign.transaction_notice",
    label: "입출금·결제 알림으로 보이는 표현",
    reason: "입금·출금·결제 완료 같은 거래 알림의 형태라서 계좌번호 표시를 위험 근거로 보지 않습니다.",
    suppresses: ["money.account_number"],
    find: findTransactionNotice,
  },
];
