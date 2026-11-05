// 서비스 아이콘과 결과 그림의 파일 경로를 한 곳에서 관리한다.
// 지금은 임시(placeholder) SVG 이다. 틸론 GPU 로 만든 PNG 가 준비되면
// public 폴더의 파일을 바꾸고 아래 경로의 확장자만 .png 로 고치면 된다.
export const IMAGES = {
  // 서비스 로고: 사용자가 틸론 GPU 로 만든 그림(picture/사진2.png 를 복사)
  brand: "/brand/logo.png",
  // '이렇게 대응하세요' 칸 제목 옆 그림: 사용자가 틸론 GPU 로 만든 그림(picture/사진1.png 를 복사)
  reportMascot: "/brand/report-mascot.png",
  analyzing: "/status/analyzing.svg",
  risk: "/status/risk.svg",
  clear: "/status/clear.svg",
  uncertain: "/status/uncertain.svg",
} as const;

export type ImageKey = keyof typeof IMAGES;
