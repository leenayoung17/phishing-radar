/**
 * 원문 위치를 보존하는 정규화.
 *
 * 규칙 매칭은 정규화한 문자열 위에서 하지만, 사용자에게 보여 줄 위치는 원문 기준이어야 한다.
 * 그래서 정규화 문자열의 글자 하나하나가 원문의 어느 구간(UTF-16 오프셋)에서 왔는지 함께 기록한다.
 *
 * 처리 내용
 * - 원문을 "글자 덩어리(grapheme)" 단위로 나눠 각각 NFKC 정규화한다.
 *   (NFD 로 분해된 한글도 한 덩어리로 묶여 올바르게 합쳐진다.)
 * - 영문 A-Z 만 소문자로 바꾼다. 길이가 변하지 않는다.
 * - 제로폭 문자 등 보이지 않는 문자는 버린다.
 * - compact 모드는 모든 공백을 버리고, 일반 모드는 연속 공백을 하나로 합친다.
 *
 * 주의: 이 정규화는 규칙 분석용이다. 통계 모델은 학습에 쓴 정규화와 똑같이 맞춘
 * 별도 함수(model.ts 의 cleanForModel)를 쓴다.
 */

export interface NormalizedView {
  readonly text: string;
  /** text[i] 가 유래한 원문 구간의 시작(UTF-16 오프셋, 포함) */
  readonly starts: readonly number[];
  /** text[i] 가 유래한 원문 구간의 끝(UTF-16 오프셋, 제외) */
  readonly ends: readonly number[];
}

const IGNORABLE = /[​‌‍⁠﻿­]/;
const WHITESPACE = /\s/;

interface Cluster {
  text: string;
  index: number;
}

function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : s[i];
  }
  return out;
}

function splitClusters(original: string): Cluster[] {
  const clusters: Cluster[] = [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("ko", { granularity: "grapheme" });
    for (const part of segmenter.segment(original)) {
      clusters.push({ text: part.segment, index: part.index });
    }
    return clusters;
  }
  // Intl.Segmenter 가 없는 환경에서는 코드포인트 단위로 나눈다.
  let index = 0;
  for (const ch of original) {
    clusters.push({ text: ch, index });
    index += ch.length;
  }
  return clusters;
}

/**
 * 원문을 정규화하고 글자별 원문 구간을 기록한다.
 * @param compact true 이면 모든 공백을 제거한다(규칙 매칭용). false 이면 연속 공백만 합친다(URL 추출용).
 */
export function buildView(original: string, compact: boolean): NormalizedView {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  for (const cluster of splitClusters(original)) {
    const lowered = asciiLower(cluster.text.normalize("NFKC"));
    const clusterEnd = cluster.index + cluster.text.length;
    for (let k = 0; k < lowered.length; k += 1) {
      const ch = lowered[k];
      if (IGNORABLE.test(ch)) {
        continue;
      }
      if (WHITESPACE.test(ch)) {
        if (compact) {
          continue;
        }
        const last = out.length - 1;
        if (last >= 0 && out[last] === " ") {
          ends[last] = clusterEnd; // 합쳐진 공백이 차지하는 원문 구간을 넓힌다.
          continue;
        }
        out.push(" ");
        starts.push(cluster.index);
        ends.push(clusterEnd);
        continue;
      }
      out.push(ch);
      starts.push(cluster.index);
      ends.push(clusterEnd);
    }
  }

  return { text: out.join(""), starts, ends };
}

/** 정규화 문자열의 [start, end) 구간을 원문의 [start, end) 구간으로 바꾼다. */
export function toOriginalSpan(
  view: NormalizedView,
  start: number,
  end: number,
): { start: number; end: number } {
  return { start: view.starts[start], end: view.ends[end - 1] };
}
