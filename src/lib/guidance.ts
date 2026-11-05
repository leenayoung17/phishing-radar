// 분석 결과에 맞는 예방 행동 안내. 고정 문구로 만든 규칙 기반 안내이며 AI 가 생성한 문장이 아니다.
import type { AnalysisResult, RiskCategory } from "./analysis/types";

export interface GuidanceGroup {
  title: string;
  steps: string[];
}

const CATEGORY_GUIDANCE: Partial<Record<RiskCategory, GuidanceGroup>> = {
  family_impersonation: {
    title: "가족·지인을 사칭한 것으로 보일 때",
    steps: [
      "메시지로 알려 준 새 번호가 아니라, 원래 저장돼 있던 번호로 직접 전화해 확인하세요.",
      "통화나 영상통화를 피하고 문자만 고집하면 더 의심하세요.",
      "본인 확인이 끝나기 전에는 돈을 보내거나 상품권 번호를 알려 주지 마세요.",
    ],
  },
  money_request: {
    title: "송금·금전을 요구할 때",
    steps: [
      "송금, 상품권 구매, 핀번호 전달을 모두 멈추세요.",
      "받은 계좌번호로 보내기 전에 가족이나 기관에 다른 연락 수단으로 확인하세요.",
    ],
  },
  institution_impersonation: {
    title: "기관·기업을 사칭한 것으로 보일 때",
    steps: [
      "문자에 적힌 전화번호나 링크가 아니라, 공식 앱이나 직접 검색한 공식 대표번호로 문의하세요.",
      "택배·은행·통신사 문자라면 공식 앱에서 같은 내용이 있는지 확인하세요.",
      "일반적으로 수사기관이나 금융기관은 문자로 계좌이체나 앱 설치를 요구하지 않습니다.",
    ],
  },
  credential_request: {
    title: "인증번호·개인정보를 요구할 때",
    steps: [
      "인증번호, 비밀번호, 카드번호, 주민등록번호는 누구에게도 알려 주지 마세요.",
      "링크의 화면에 정보를 입력하지 마세요.",
    ],
  },
  remote_app: {
    title: "앱 설치·원격 조종을 유도할 때",
    steps: [
      "상대가 알려 준 앱이나 원격제어 앱은 설치하거나 연결하지 마세요.",
      "공식 앱스토어가 아닌 곳(링크, 파일)에서 받는 앱은 설치하지 마세요.",
    ],
  },
};

CATEGORY_GUIDANCE.illegal_gambling = {
  title: "불법 도박·불법 사이트로 유도할 때",
  steps: [
    "링크에 접속하거나 가입하지 마세요. 입금하면 돌려받지 못하는 사기(먹튀) 피해로 이어질 수 있습니다.",
    "불법 도박은 이용하는 사람에게도 법적 문제가 생길 수 있으니 문의나 답장을 하지 말고 번호를 차단하세요.",
    "이미 가입하거나 입금했다면 개인정보 도용 가능성이 있으니 비밀번호를 바꾸고, 경찰(112)이나 불법스팸 신고(118)로 상담하세요.",
  ],
};

CATEGORY_GUIDANCE.evasion = {
  title: "글자를 바꿔 숨긴 광고성 문자일 때",
  steps: [
    "정상 업체는 글자를 이렇게 바꿔 쓰지 않습니다. 링크 접속, 가입, 답장을 하지 마세요.",
    "번호를 차단하고, 스팸 신고(118)를 하면 다른 사람의 피해를 줄이는 데 도움이 됩니다.",
  ],
};

const ORDER: RiskCategory[] = [
  "family_impersonation",
  "money_request",
  "institution_impersonation",
  "credential_request",
  "remote_app",
  "illegal_gambling",
  "evasion",
];

/**
 * 가족·지인일 가능성을 함께 고려해야 하는 메시지인가.
 * 가족 호칭만으로는 위험 신호가 아니지만, 다른 위험 신호(돈 요구 등)와 함께 있으면
 * 진짜 가족일 수도 있으므로 '차단'보다 '직접 확인'을 먼저 안내해야 한다.
 */
function mayBeFamily(result: AnalysisResult): boolean {
  const family = result.categories.find((c) => c.category === "family_impersonation");
  if (!family || family.evidenceCount === 0) {
    return false;
  }
  return result.categories.some((c) => c.category !== "pressure" && c.points > 0);
}

/** 탐지된 위험 유형과 링크 유무에 맞는 행동 안내를 만든다. */
export function buildGuidance(result: AnalysisResult): GuidanceGroup[] {
  const groups: GuidanceGroup[] = [];
  // 점수가 있는 유형만 안내한다(보조 근거만 있는 유형은 위험 신호가 아니다).
  const found = new Set(result.categories.filter((c) => c.points > 0).map((c) => c.category));
  if (mayBeFamily(result)) {
    found.add("family_impersonation");
  }
  for (const category of ORDER) {
    const g = CATEGORY_GUIDANCE[category];
    if (found.has(category) && g) {
      groups.push(g);
    }
  }
  if (result.urls.length > 0) {
    groups.push({
      title: "메시지에 링크가 있을 때",
      steps: [
        "링크를 누르지 마세요. 꼭 확인해야 하면 공식 앱이나 직접 검색한 공식 사이트로 들어가세요.",
        "링크 주소가 단축 주소(bit.ly 등)이거나 이상한 글자가 섞여 있으면 특히 조심하세요.",
      ],
    });
  }
  return groups;
}

export type DoneStage = "none" | "replied" | "clicked" | "entered" | "installed" | "sent";

/** 피해 진행 단계(요구사항 순서): 받음 → 답장 → 링크 클릭 → 정보 입력 → 앱 설치 → 송금 */
export const DONE_STAGES: { id: DoneStage; label: string }[] = [
  { id: "none", label: "메시지만 받은 상태" },
  { id: "replied", label: "답장한 상태" },
  { id: "clicked", label: "링크를 클릭한 상태" },
  { id: "entered", label: "개인정보·인증번호를 입력한 상태" },
  { id: "installed", label: "앱을 설치한 상태" },
  { id: "sent", label: "돈을 송금한 상태" },
];

export const STAGE_STEPS: Record<DoneStage, string[]> = {
  none: [
    "답장하거나 전화하지 말고, 메시지를 삭제하고 번호를 차단하세요.",
    "스팸 신고(118)를 하면 다른 사람의 피해를 줄이는 데 도움이 됩니다.",
  ],
  replied: [
    "더 이상 답장하지 말고 대화를 멈추세요. 상대가 계속 연락하거나 재촉해도 응하지 마세요.",
    "답장으로 이름·주소·계좌번호·신분증 사진 같은 정보를 보냈다면 '개인정보·인증번호를 입력한 상태'의 안내도 함께 따르세요.",
    "답장 뒤에는 같은 번호나 다른 번호로 사기 문자가 더 올 수 있으니 번호를 차단하고 스팸 신고(118)를 하세요.",
  ],
  clicked: [
    "열린 화면에 아무 정보도 입력하지 말고 창을 닫으세요.",
    "파일이 내려받아졌다면 열지 말고 삭제하세요.",
    "이후 모르는 앱이 설치됐는지, 이상한 알림이 오는지 살펴보세요.",
  ],
  installed: [
    "먼저 비행기 모드로 바꿔 인터넷 연결을 끊으세요.",
    "방금 설치한 앱을 삭제하고, 휴대폰 보안 검사를 해 보세요.",
    "다른 기기에서 금융·메신저·이메일 비밀번호를 바꾸고, 금융앱 이용내역을 확인하세요.",
    "의심이 계속되면 통신사나 제조사 서비스센터에서 점검받거나 초기화를 고려하세요.",
  ],
  entered: [
    "해당 금융기관·서비스의 공식 고객센터에 바로 연락해 이용 제한이나 카드 재발급을 요청하세요.",
    "같은 비밀번호를 쓰는 다른 서비스의 비밀번호도 바꾸세요.",
    "모르는 결제나 대출이 있는지 확인하세요.",
  ],
  sent: [
    "지금 바로 송금한 은행 고객센터에 전화해 지급정지를 요청하세요. 빠를수록 좋습니다.",
    "경찰(112)에 신고하세요. 대화 화면, 계좌번호, 송금 내역을 지우지 말고 보관하세요.",
    "추가로 돈을 요구받아도 보내지 마세요.",
  ],
};

const FAMILY_NONE_STEPS = [
  "메시지에 답장하거나 새 번호로 연락하지 말고, 원래 알고 있던(저장해 둔) 번호로 직접 전화해 확인해 보세요. 진짜 가족일 수도 있습니다.",
  "전화를 받지 않거나 통화를 피하면, 돈을 보내지 말고 다른 가족에게 먼저 확인하세요.",
  "가족이 아닌 것으로 확인되면 메시지를 삭제하고 번호를 차단하세요. 스팸 신고(118)도 도움이 됩니다.",
];

/** 불법·광고성 스팸으로 보일 때의 단계별 조치. 정보 입력·앱 설치는 스미싱과 같은 조치를 쓴다. */
const SPAM_STAGE_STEPS: Partial<Record<DoneStage, string[]>> = {
  none: [
    "링크에 접속하거나 가입·답장하지 말고, 메시지를 삭제한 뒤 번호를 차단하세요.",
    "휴대폰의 스팸 신고 기능이나 불법스팸 신고(118)로 신고하면 같은 스팸을 줄이는 데 도움이 됩니다.",
    "출처를 알 수 없는 불법 광고라면 문자에 적힌 '수신거부' 번호로 연락하지 말고 차단·신고만 하세요. 연락하면 번호가 실제로 쓰인다는 것이 알려질 수 있습니다.",
  ],
  replied: [
    "더 이상 답장하지 마세요. 답장하면 번호가 실제로 쓰인다는 것이 알려져 스팸이 늘 수 있습니다.",
    "번호를 차단하고 스팸 신고(118)를 하세요.",
    "답장으로 이름·연락처·계좌 같은 정보를 보냈다면 '개인정보·인증번호를 입력한 상태'의 안내도 함께 따르세요.",
  ],
  clicked: [
    "열린 사이트에 가입하거나 정보를 입력하지 말고 창을 닫으세요.",
    "파일이 내려받아졌다면 열지 말고 삭제하세요.",
    "이후 모르는 앱이 설치됐는지, 광고 알림이 계속 오는지 살펴보세요.",
  ],
  sent: [
    "더 입금하지 마세요. 불법 도박·불법 사이트에 넣은 돈은 돌려받기 어렵고, '출금하려면 수수료를 더 내라'는 식의 추가 입금 요구로 이어지는 경우가 많습니다.",
    "입금한 은행에 연락해 상황을 알리고, 경찰(112)에 상담·신고하세요. 입금 내역과 대화 화면은 지우지 말고 보관하세요.",
    "보이스피싱·스미싱 피해와 달리 불법 사이트 입금은 피해 구제 절차가 적용되지 않을 수 있습니다.",
  ],
};

/** 결과 카드에 보여 줄 스팸용 요약·행동 */
export const SPAM_SUMMARY = "원치 않는 불법·광고성 문자로 보입니다. 링크 접속, 가입, 답장은 하지 마세요.";
export const SPAM_ACTIONS = [
  "링크에 접속하거나 사이트에 가입하지 마세요.",
  "답장하지 말고 번호를 차단하세요.",
  "스팸 신고(118)를 하면 같은 스팸을 줄이는 데 도움이 됩니다.",
];

/** "스팸과 스미싱은 어떻게 다른가요?" 설명 */
export const TYPE_EXPLAINER: { title: string; body: string }[] = [
  {
    title: "스팸",
    body: "받는 사람이 원하지 않는 광고성 문자예요. 불법 도박·성인 사이트·대출 광고처럼 가입이나 입금을 유도하는 경우가 많아요. 광고가 주목적이지만, 링크를 누르거나 가입하면 개인정보 유출이나 금전 피해로 이어질 수 있어요.",
  },
  {
    title: "스미싱·피싱",
    body: "스미싱은 문자(SMS)와 피싱(phishing)을 합친 말이에요. 택배사·은행·공공기관·가족을 사칭해 링크 클릭, 앱 설치, 인증번호·개인정보 입력, 송금을 유도해서 돈이나 정보를 직접 빼내려는 사기예요. 카카오톡에서 가족·지인을 사칭하는 메신저 피싱도 같은 방식이에요.",
  },
  {
    title: "대처의 차이",
    body: "스팸은 차단과 신고로 충분한 경우가 많아요. 스미싱·피싱은 이미 정보를 입력했거나 돈을 보냈다면 금융기관 지급정지 요청, 경찰 신고처럼 빠른 조치가 필요해요.",
  },
  {
    title: "주의",
    body: "이 구분은 메시지 표현을 보고 한 추정이에요. 스팸처럼 보여도 사기일 수 있으니 링크·가입·송금은 하지 마세요.",
  },
];

const FAMILY_REPLIED_FIRST =
  "가족·지인이라고 했다면 대화를 이어 가지 말고, 원래 알고 있던(저장해 둔) 번호로 직접 전화해 확인하세요. 진짜 가족일 수도 있습니다.";

/** "이미 한 행동"에 따른 조치. 가족·지인 사칭이 의심되면 '차단'보다 '직접 확인'을 먼저 안내한다. */
export function getStageSteps(stage: DoneStage, result: AnalysisResult): string[] {
  if (result.messageType === "spam") {
    return SPAM_STAGE_STEPS[stage] ?? STAGE_STEPS[stage];
  }
  if (stage === "none" && mayBeFamily(result)) {
    return FAMILY_NONE_STEPS;
  }
  if (stage === "replied" && mayBeFamily(result)) {
    return [FAMILY_REPLIED_FIRST, ...STAGE_STEPS.replied];
  }
  return STAGE_STEPS[stage];
}

export const HELP_LINES = "경찰 112 · 한국인터넷진흥원 118 · 금융감독원 1332";
