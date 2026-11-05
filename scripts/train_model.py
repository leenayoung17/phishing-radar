"""Phishing Radar - 한국어 문자 분류 모델 파이프라인 (데이터 준비 단계).

이 파일은 데이터 준비 단계만 구현한다.
(prepare / preview-split / finalize-split)
학습, 임계값 선정, 테스트셋 평가, model.json 생성은
다음 승인 후 별도 단계로 추가한다.

실행 순서 (각 단계는 사용자 승인 후 실행)
  1) python -I -X utf8 scripts/train_model.py prepare
     정제, 정확 중복 처리, 마스킹 그룹, 유사 중복 그룹 통계.
     분할은 하지 않는다.
  2) python -I -X utf8 scripts/train_model.py preview-split
     비확정 미리보기 분할. 계층 분포, 편차, 누수 감사를
     관측값만 보고한다. FAIL 기준은 없다.
     이 결과는 후속 학습 단계에서 사용할 수 없다.
  3) python -I -X utf8 scripts/train_model.py finalize-split
         --max-group-size N --min-stratum-rows M --balance-tol T
     기준 3개를 직접 지정해야 실행된다(기본값 없음).
     모두 만족할 때만 split_assignment.csv 를 만든다.

중단/재실행
  - 모든 출력은 '이름.partial' 로 먼저 쓰고 완성되면 교체한다.
  - 보고서(JSON)를 마지막에 쓰며, 보고서가 있으면 완료로 본다.
  - 중단된 흔적이 있으면 안내만 하고 멈춘다.
    같은 명령에 --overwrite 를 붙이면 덮어쓴다(삭제하지 않음).

입력 : important/smishing.csv (읽기 전용)
출력 : important/processed/ (Git 제외). 문장 원문은 저장하지 않는다.

설계 원칙
  - content 와 label 만 사용한다. explanation, type 은 쓰지 않는다.
  - 이름 없는 추가 컬럼의 이상값은 위치만 기록하고 행은 보존한다.
  - 정확 중복은 '원문 키'(앞뒤 공백 제거 + 줄바꿈 통일)로만 제거한다.
    원문이 같고 라벨이 다르면 모든 사본을 제외한다.
  - 숫자/URL 마스킹은 그룹화 전용이며 행 삭제에 쓰지 않는다.
  - 유사 중복 그룹 = 마스킹 동일 행 + 코사인 유사도 연결 요소.
    연쇄 연결 여부는 직접 연결 밀도와 그룹 내부 쌍별 코사인
    표본으로 보고한다(기준 없음).
  - 분할: StratifiedGroupKFold(7, shuffle, seed=42)
    폴드 0=테스트, 1=검증, 2~6=학습. 계층=(라벨 x URL 유무).
  - 누수 감사는 참고 지표이며 PASS/FAIL 에 쓰지 않는다.

후속 단계 설계 메모 (여기서는 구현하지 않음)
  - 부트스트랩 신뢰구간은 Accuracy/Precision/Recall/F1/FPR/FNR 과
    PR-AUC 모두에 적용하며, 모두 그룹 단위로 복원추출한다.
  - 모델 점수와 서비스 최종 위험 등급(높음/주의/
    뚜렷한 위험 신호 없음/판단 어려움)은 분리한다.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np
import scipy
import sklearn
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer
from sklearn.model_selection import StratifiedGroupKFold

ROOT = Path(__file__).resolve().parent.parent
IMPORTANT_DIR = ROOT / "important"
RAW_CSV = IMPORTANT_DIR / "smishing.csv"
OUT_DIR = IMPORTANT_DIR / "processed"

PREPARE_REPORT = OUT_DIR / "prepare_report.json"
GROUPS_CSV = OUT_DIR / "prepared_groups.csv"
PREVIEW_REPORT = OUT_DIR / "split_preview_report.json"
PREVIEW_CSV = OUT_DIR / "split_preview.csv"
FINAL_REPORT = OUT_DIR / "split_final_report.json"
FINAL_ASSIGN = OUT_DIR / "split_assignment.csv"

NORM_VERSION = "norm-v1: NFKC, ascii-lower, url->token, digit->0, ws"
LABEL_MAP = {"정상": 0, "스미싱": 1}
SIM_THRESHOLDS = (0.80, 0.85, 0.90)
GROUP_COLUMNS = {0.80: "group_080", 0.85: "group_085", 0.90: "group_090"}
N_SPLITS = 7
SPLIT_FRACTION = {"train": 5 / 7, "val": 1 / 7, "test": 1 / 7}
STRATA_NAMES = {
    0: "정상/URL없음",
    1: "정상/URL있음",
    2: "스미싱/URL없음",
    3: "스미싱/URL있음",
}
NAMED_COLUMNS = ("content", "label", "explanation", "type")
# 아래 구간은 참고용 표의 구간일 뿐 기준이 아니다.
SIZE_CAPS = (10, 25, 50, 100, 250, 500, 1000)

# 유사도 곱셈 메모리 보호. 곱셈 전에 chunk * n 으로 사전 검사한다.
MAX_CHUNK_WORST_NNZ = 10_000_000
BYTES_PER_NNZ = 21  # 칸당 메모리 추정치(미실측)

# 연쇄 연결 점검의 규모 상한(결정적, 시간 기반 중단은 쓰지 않는다)
CHAIN_SEED = 12345
CHAIN_TOP_K = 10
CHAIN_RANDOM_GROUPS = 50
CHAIN_MAX_MEMBERS = 1000
CHAIN_PAIR_BUDGET = 10_000_000

LEAK_NOTE = (
    "참고 지표이며 PASS/FAIL 판정에 쓰지 않는다. "
    "누수 허용 기준은 정해지지 않았다. "
    "분할 기준 PASS 는 누수 위험이 없다는 뜻이 아니다. "
    "이 척도(문자 3-gram 자카드)가 잡지 못하는 "
    "유사성도 있을 수 있다."
)
VERDICT_MEANING = (
    "PASS = 사용자가 지정한 분할 기준을 충족했다는 뜻이다. "
    "(최대 그룹 크기, 계층 최소 건수, 편차 허용치) "
    "누수 위험이 없다는 뜻이 아니다. "
    "누수 감사는 참고 지표이며 판정에 쓰지 않았다."
)
SAMPLE_SIZE_NOTE = (
    "계층별 건수는 건수만 보고한다. "
    "표본 크기가 충분한지에 대한 기준은 확정되지 않았다. "
    "신뢰구간은 후속 단계에서 그룹 단위 부트스트랩으로 계산한다."
)

_START = time.time()


def log(msg: str) -> None:
    print(f"[{time.time() - _START:7.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------- 정규화
# TS 구현과 1:1 로 맞추기 위해 \s, \d, \b 대신 명시적 문자 클래스를 쓴다.
_WS = " \\t\\n\\r\\f\\v\\u00a0\\u3000"
# 이메일 로컬 파트에 쓰이는 문자(RFC 5322 atext + 점).
# '/' 와 '?' 는 URL 구문이라 제외한다.
_LOCAL = "a-z0-9._%+!#$&'*=^`{|}~-"
# 후보의 시작부터 '@' 까지가 모두 로컬 파트 문자이면 이메일의 일부다.
_EMAIL_GUARD = r"(?![" + _LOCAL + r"]*@)"
_URL_RE = re.compile(
    r"(?:https?://|(?<![a-z0-9@.-])www\." + _EMAIL_GUARD + r")[^" + _WS + r"]+"
)
_TLDS = (
    "com|net|org|kr|co|me|ly|xyz|top|in|cc|io|gl|app|link|site"
    "|online|info|biz|vip|club|shop|store|ae|ml|tk|ga|cf|gq|pw|ws"
)
# 점으로 구분된 라벨의 반복만 허용해서 정규식 역추적 폭증을 피한다.
_BARE_RE = re.compile(
    r"(?<![a-z0-9.@-])"
    + _EMAIL_GUARD
    + r"(?:[a-z0-9-]+\.)+(?:"
    + _TLDS
    + r")(?![a-z0-9-])(?:/[^"
    + _WS
    + r"]*)?"
)
_DIGIT_RE = re.compile(r"[0-9]")
_WS_RE = re.compile("[" + _WS + "]+")
_LOWER = {ord(c): ord(c) + 32 for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"}


def nfkc_lower(text: str) -> str:
    """NFKC 정규화 후 영문 A-Z 만 소문자화한다."""
    return unicodedata.normalize("NFKC", text).translate(_LOWER)


def collapse_ws(s: str) -> str:
    return _WS_RE.sub(" ", s).strip()


def raw_key(text: str) -> str:
    """정확 중복용 원문 키: 앞뒤 공백 제거 + 줄바꿈 표기 통일만 한다."""
    return text.replace("\r\n", "\n").replace("\r", "\n").strip()


def has_url(text: str) -> bool:
    t = nfkc_lower(text)
    return bool(_URL_RE.search(t) or _BARE_RE.search(t))


def mask_text(text: str) -> str:
    """그룹화 전용 마스킹 텍스트. 행 삭제에는 사용하지 않는다."""
    t = nfkc_lower(text)
    t = _URL_RE.sub("<url>", t)
    t = _BARE_RE.sub("<url>", t)
    t = _DIGIT_RE.sub("0", t)
    return collapse_ws(t)


def plain_text(text: str) -> str:
    """마스킹 없이 NFKC + 소문자 + 공백 정리만 한 텍스트(누수 감사용)."""
    return collapse_ws(nfkc_lower(text))


# ---------------------------------------------------------------- 보조 함수
def jsonable(o):
    if isinstance(o, dict):
        return {str(k): jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(v) for v in o]
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    return o


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def compress_ids(values) -> np.ndarray:
    mapping: dict[int, int] = {}
    out = np.empty(len(values), dtype=np.int64)
    for i, v in enumerate(values):
        v = int(v)
        if v not in mapping:
            mapping[v] = len(mapping)
        out[i] = mapping[v]
    return out


def ensure_out_dir() -> None:
    if IMPORTANT_DIR.resolve() not in OUT_DIR.resolve().parents:
        raise SystemExit("출력 폴더가 important/ 밖입니다. 중단합니다.")
    OUT_DIR.mkdir(parents=True, exist_ok=True)


def check_outputs(marker: Path, others, overwrite: bool) -> None:
    """이전 실행의 흔적을 검사한다. 보고서(marker)는 마지막에 쓰인다."""
    all_paths = [marker, *others]
    partial = [
        p.name + ".partial"
        for p in all_paths
        if p.with_name(p.name + ".partial").exists()
    ]
    present = [p.name for p in all_paths if p.exists()]
    if overwrite or not (partial or present):
        return
    if partial or not marker.exists():
        raise SystemExit(
            "이전 실행이 중간에 중단된 것으로 보입니다.\n"
            f"  남아 있는 임시 파일: {partial or '없음'}\n"
            f"  남아 있는 결과 파일: {present or '없음'}\n"
            "  재실행: 같은 명령에 --overwrite 를 붙이세요.\n"
            "  (파일을 삭제하지 않고 새 결과로 덮어씁니다)"
        )
    raise SystemExit(
        f"이미 결과가 있어 중단합니다: {present}\n"
        "덮어쓰려면 --overwrite 를 명시하세요."
    )


def atomic_write(path: Path, write_fn) -> None:
    tmp = path.with_name(path.name + ".partial")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        write_fn(f)
    os.replace(tmp, path)


def write_json_atomic(path: Path, obj) -> None:
    def _write(f):
        json.dump(jsonable(obj), f, ensure_ascii=False, indent=2)

    atomic_write(path, _write)


def write_csv_atomic(path: Path, header, rows) -> None:
    def _write(f):
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)

    atomic_write(path, _write)


# ---------------------------------------------------------------- CSV 읽기
def _iter_rows(reader):
    """헤더와 본문을 읽는 동안 생기는 csv.Error 를 안내 메시지로 바꾼다."""
    try:
        yield from reader
    except csv.Error as e:
        raise SystemExit(f"CSV 파싱 오류(줄 {reader.line_num}): {e}")


def read_records():
    """content/label 만 꺼낸다. 이름 없는 추가 컬럼의 이상값은 기록만 한다."""
    data = RAW_CSV.read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise SystemExit(
            f"CSV 를 UTF-8 로 읽을 수 없습니다(위치 {e.start}). "
            "인코딩을 확인하세요."
        )
    csv.field_size_limit(10**9)
    reader = csv.reader(io.StringIO(text, newline=""))
    rows = _iter_rows(reader)
    header = next(rows, None)
    if not header:
        raise SystemExit("CSV 가 비어 있거나 헤더가 없습니다.")
    names = [h.strip() for h in header]
    if "content" not in names or "label" not in names:
        raise SystemExit("헤더에 content/label 이 없습니다: " + repr(names[:6]))
    i_content = names.index("content")
    i_label = names.index("label")
    extra_idx = [i for i, h in enumerate(names) if h not in NAMED_COLUMNS]
    need = max(i_content, i_label)

    stats = {
        "records_parsed_total": 0,
        "column_count_distribution": Counter(),
        "dropped_too_few_columns": 0,
        "dropped_empty_content": 0,
        "dropped_invalid_label": 0,
    }
    label_text_counts = Counter()
    label_overflow = 0
    anomalies = []
    anomaly_count = 0
    records = []  # (source_row, content, label_int)
    prev_line = reader.line_num

    for rec_no, r in enumerate(rows):
        start_line = prev_line + 1
        prev_line = reader.line_num
        stats["records_parsed_total"] += 1
        stats["column_count_distribution"][len(r)] += 1

        # explanation/type 은 읽지 않는다. 이름 없는 추가 칸만 검사한다.
        cols = [i for i in extra_idx if i < len(r)]
        cols += list(range(len(names), len(r)))
        odd = [(i, r[i]) for i in cols if r[i].strip() != ""]

        if len(r) <= need:
            stats["dropped_too_few_columns"] += 1
            continue
        label_text = r[i_label].strip()
        content = r[i_content]

        key = label_text[:20]
        if key in label_text_counts or len(label_text_counts) < 20:
            label_text_counts[key] += 1
        else:
            label_overflow += 1

        kept, reason = True, None
        if label_text not in LABEL_MAP:
            stats["dropped_invalid_label"] += 1
            kept, reason = False, "invalid_label"
        elif content.strip() == "":
            stats["dropped_empty_content"] += 1
            kept, reason = False, "empty_content"
        else:
            records.append((rec_no, content, LABEL_MAP[label_text]))

        if odd:
            anomaly_count += 1
            if len(anomalies) < 50:
                items = [
                    {
                        "index": i,
                        "header_name": names[i] if i < len(names) else None,
                        "value": v if len(v) <= 8 else None,
                        "value_length": len(v),
                    }
                    for i, v in odd
                ]
                anomalies.append(
                    {
                        "source_row": rec_no,
                        "first_physical_line": start_line,
                        "last_physical_line": reader.line_num,
                        "columns": items,
                        "content_length": len(content),
                        "label_valid": label_text in LABEL_MAP,
                        "row_kept": kept,
                        "drop_reason": reason,
                    }
                )

    stats["column_count_distribution"] = dict(stats["column_count_distribution"])
    stats["header_columns_total"] = len(names)
    stats["header_named_columns"] = [h for h in names if h]
    stats["anomalous_extra_column_values"] = {
        "records_with_values": anomaly_count,
        "listed": len(anomalies),
        "items": anomalies,
        "policy": "이름 없는 추가 컬럼의 값만 기록한다. content/label 이 유효하면 행은 보존한다.",
    }
    by_label = Counter(r[2] for r in records)
    stats["label_text_counts_all_records"] = {
        "counts": dict(label_text_counts),
        "overflow_not_listed": label_overflow,
    }
    stats["rows_passing_label_and_content_checks"] = {
        "total": len(records),
        "by_label": {"정상": by_label[0], "스미싱": by_label[1]},
    }
    lengths = sorted((len(c) for _, c, _ in records), reverse=True)
    stats["longest_content_lengths_top5"] = lengths[:5]
    stats["notes"] = {
        "records_parsed_total": (
            "CSV 파서가 돌려준 레코드 수(빈 줄 포함, 헤더 제외)."
        ),
        "label_text_counts_all_records": (
            "컬럼 수가 충분한 모든 레코드의 라벨 문자열별 건수(최대 20종). "
            "정상/스미싱이 아닌 값도 여기에 나온다."
        ),
        "rows_passing_label_and_content_checks": (
            "라벨이 정상/스미싱 중 하나이고 content 가 비어 있지 않은 행. "
            "원시 전체 행 수가 아니며 정확 중복 제거 전 값이다."
        ),
        "longest_content_lengths_top5": (
            "따옴표 짝이 안 맞아 여러 행이 합쳐졌는지 알아채기 위한 참고값."
        ),
    }
    return records, stats, len(data), hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- 정확 중복 처리
def exact_dedup(records):
    by_key: dict[str, list[int]] = {}
    for i, (_, content, _) in enumerate(records):
        by_key.setdefault(raw_key(content), []).append(i)

    kept = []
    conflict_keys = conflict_rows = removed = 0
    copies = Counter()
    for idxs in by_key.values():
        labels = {records[i][2] for i in idxs}
        if len(labels) > 1:
            conflict_keys += 1
            conflict_rows += len(idxs)
            continue
        if len(idxs) > 1:
            removed += len(idxs) - 1
            copies[len(idxs)] += 1
        kept.append(records[idxs[0]])
    kept.sort(key=lambda r: r[0])
    info = {
        "rule": "원문 키가 같고 라벨도 같으면 첫 행만 유지",
        "input_rows": len(records),
        "unique_raw_texts": len(by_key),
        "duplicate_rows_removed": removed,
        "keys_with_copies": int(sum(copies.values())),
        "max_copies_of_one_text": max(copies) if copies else 1,
        "label_conflict": {
            "rule": "원문이 같은데 라벨이 다르면 모든 사본을 제외",
            "keys": conflict_keys,
            "rows_removed": conflict_rows,
        },
        "rows_after": len(kept),
    }
    return kept, info


# ---------------------------------------------------------------- 마스킹 그룹
def masked_groups(masked, y):
    by_mask: dict[str, list[int]] = defaultdict(list)
    for i, m in enumerate(masked):
        by_mask[m].append(i)
    multi = [v for v in by_mask.values() if len(v) > 1]
    mixed = [v for v in multi if len({int(y[i]) for i in v}) > 1]
    info = {
        "note": (
            "마스킹 결과가 같아도 행을 삭제하지 않고 같은 그룹으로만 묶는다. "
            "정확 중복은 이미 제거되어 그룹 안의 원문은 서로 다르다."
        ),
        "distinct_masked_texts": len(by_mask),
        "template_variant_groups_size_ge2": len(multi),
        "rows_in_template_variant_groups": int(sum(len(v) for v in multi)),
        "max_template_group_size": max((len(v) for v in multi), default=1),
        "mixed_label_masked_groups": len(mixed),
        "rows_in_mixed_label_masked_groups": int(sum(len(v) for v in mixed)),
    }
    return multi, by_mask, info


# ---------------------------------------------------------------- 유사 중복 쌍과 그룹
def similarity_pairs(masked, min_thr, max_df, chunk, max_pairs):
    """코사인 유사도가 min_thr 이상인 쌍(i<j)만 모은다."""
    n = len(masked)
    # 곱셈 전에 최악의 결과 크기를 계산해 상한을 넘으면 바로 중단한다.
    worst = min(chunk, n) * n
    if worst > MAX_CHUNK_WORST_NNZ:
        allowed = max(1, MAX_CHUNK_WORST_NNZ // n)
        mb = worst * BYTES_PER_NNZ // 10**6
        raise SystemExit(
            f"chunk={chunk}, 문서 수={n:,}: 곱셈 결과가 최악의 경우\n"
            f"{worst:,}칸(약 {mb} MB 추정)이라 상한\n"
            f"{MAX_CHUNK_WORST_NNZ:,}칸을 넘습니다.\n"
            f"--chunk {allowed} 이하로 지정하세요. (곱셈 전에 중단)"
        )

    vec = TfidfVectorizer(
        analyzer="char",
        ngram_range=(5, 5),
        sublinear_tf=True,
        min_df=2,
        max_df=max_df,
        lowercase=False,
        dtype=np.float32,
    )
    try:
        X = vec.fit_transform(masked).tocsr()
    except ValueError as e:
        raise SystemExit(
            f"TF-IDF 계산에 실패했습니다: {e}\n"
            "--max-df 값을 높여서 다시 실행하거나 상의하세요."
        )
    zero_docs = int((np.diff(X.indptr) == 0).sum())
    XT = X.T.tocsr()
    rows_l, cols_l, sims_l = [], [], []
    total = 0
    for start in range(0, n, chunk):
        S = (X[start:start + chunk] @ XT).tocoo()
        # 먼저 개수만 센다. 상한을 넘으면 쌍 배열을 만들기 전에 중단한다.
        upper = (S.data >= min_thr) & (S.col > S.row + start)
        new = int(upper.sum())
        if total + new > max_pairs:
            raise SystemExit(
                f"유사 쌍이 상한 {max_pairs:,}개를 넘게 됩니다.\n"
                f"처리한 행 {start:,}/{n:,}, 지금까지 {total:,}쌍, "
                f"이번 청크 추가 예정 {new:,}쌍.\n"
                "쌍을 저장하기 전에 중단했습니다. "
                "거대 군집 가능성이 있어 상의가 필요합니다."
            )
        if new:
            rows_l.append((S.row[upper] + start).astype(np.int32))
            cols_l.append(S.col[upper].astype(np.int32))
            sims_l.append(S.data[upper].astype(np.float32))
            total += new
        if (start // chunk) % 10 == 0:
            done = min(start + chunk, n)
            log(f"  유사도 계산 {done:,}/{n:,} (누적 쌍 {total:,})")

    vocab_size = len(vec.vocabulary_)
    if total == 0:
        e = np.empty(0)
        return (
            e.astype(np.int32),
            e.astype(np.int32),
            e.astype(np.float32),
            zero_docs,
            vocab_size,
            X,
        )
    return (
        np.concatenate(rows_l),
        np.concatenate(cols_l),
        np.concatenate(sims_l),
        zero_docs,
        vocab_size,
        X,
    )


def build_labels(n, multi_groups, pr, pc, ps, thr):
    """연결 요소로 그룹을 만든다. 마스킹 그룹은 첫 구성원과 연결한다."""
    sel = ps >= thr - 1e-9
    mr, mc = [], []
    for members in multi_groups:
        first = members[0]
        for m in members[1:]:
            mr.append(first)
            mc.append(m)
    rows = np.concatenate([pr[sel].astype(np.int64), np.asarray(mr, dtype=np.int64)])
    cols = np.concatenate([pc[sel].astype(np.int64), np.asarray(mc, dtype=np.int64)])
    ones = np.ones(len(rows), dtype=np.int8)
    graph = coo_matrix((ones, (rows, cols)), shape=(n, n))
    _, labels = connected_components(graph, directed=False)
    return labels.astype(np.int64)  # 0..k-1 로 연속된 그룹 번호


def group_distribution(labels, y, strata):
    """그룹 통계만 계산한다(분할 없음). 기준 판단 없이 관측값만 보고한다."""
    n_rows = len(labels)
    sizes = np.bincount(labels)
    n_groups = len(sizes)
    pos = np.bincount(labels, weights=y.astype(float), minlength=n_groups)
    mixed = (pos > 0) & (pos < sizes)
    per_stratum = [
        np.bincount(labels, weights=(strata == c).astype(float), minlength=n_groups)
        for c in range(4)
    ]
    strata_cnt = np.stack(per_stratum, axis=1)
    spans = (strata_cnt > 0).sum(axis=1) >= 2

    bins = [(1, 1), (2, 2), (3, 5), (6, 10), (11, 50), (51, 10**9)]
    hist = {}
    for lo, hi in bins:
        if lo == hi:
            name = f"{lo}"
        elif hi >= 10**9:
            name = f"{lo}+"
        else:
            name = f"{lo}-{hi}"
        hist[name] = int(((sizes >= lo) & (sizes <= hi)).sum())

    top = []
    for g in np.argsort(-sizes)[:5]:
        top.append(
            {
                "size": int(sizes[g]),
                "share_of_rows": round(float(sizes[g]) / n_rows, 5),
                "strata": {
                    STRATA_NAMES[c]: int(strata_cnt[g, c]) for c in range(4)
                },
            }
        )

    exceed = []
    for cap in SIZE_CAPS:
        over = sizes[sizes > cap]
        exceed.append(
            {
                "cap": cap,
                "groups_over_cap": int(len(over)),
                "rows_in_those_groups": int(over.sum()),
            }
        )

    big = sizes >= 2
    return {
        "rows": int(n_rows),
        "groups": int(n_groups),
        "max_group_size": int(sizes.max()),
        "max_group_share_of_rows": round(float(sizes.max()) / n_rows, 5),
        "groups_size_ge2": int(big.sum()),
        "rows_in_groups_size_ge2": int(sizes[big].sum()),
        "share_rows_in_groups_size_ge2": round(float(sizes[big].sum()) / n_rows, 4),
        "mixed_label_groups": int(mixed.sum()),
        "rows_in_mixed_label_groups": int(sizes[mixed].sum()),
        "groups_spanning_multiple_strata": int(spans.sum()),
        "group_size_histogram": hist,
        "top5_groups": top,
        "size_exceedance_table_reference_only": exceed,
    }


def link_density(labels, pr, pc, ps, thr):
    """크기 3 이상 그룹의 '직접 연결된 쌍 / 전체 쌍'. 낮으면 연쇄 모양이다.
    (마스킹 그룹으로만 연결된 쌍은 세지 않으므로 낮게 나올 수 있다.)"""
    sizes = np.bincount(labels)
    sel = ps >= thr - 1e-9
    edges = np.bincount(labels[pr[sel]], minlength=len(sizes))
    mask = sizes >= 3
    if not mask.any():
        return {"groups_size_ge3": 0}
    dens = edges[mask] / (sizes[mask] * (sizes[mask] - 1) / 2.0)
    bins = [
        (0.0, 0.1, "[0,0.1)"),
        (0.1, 0.5, "[0.1,0.5)"),
        (0.5, 0.9, "[0.5,0.9)"),
        (0.9, 1.0001, "[0.9,1]"),
    ]
    hist = {name: int(((dens >= a) & (dens < b)).sum()) for a, b, name in bins}
    return {
        "groups_size_ge3": int(mask.sum()),
        "density_min": round(float(dens.min()), 4),
        "density_median": round(float(np.median(dens)), 4),
        "density_histogram_descriptive_bins": hist,
    }


def _inspect_group(X, labels, g, sizes, zero, thr, rng, remaining):
    """그룹 내부 실제 쌍별 코사인을 계산한다. 쌍 예산을 넘으면 건너뛴다."""
    members = np.where(labels == g)[0]
    members = members[~zero[members]]  # 벡터가 빈 문장은 계산할 수 없다
    info = {
        "group_size": int(sizes[g]),
        "members_with_vectors": int(len(members)),
    }
    if len(members) < 3:
        info["skipped"] = "벡터가 있는 구성원이 3개 미만"
        return info, 0
    sampled_down = len(members) > CHAIN_MAX_MEMBERS
    if sampled_down:
        pick = rng.choice(members, size=CHAIN_MAX_MEMBERS, replace=False)
        members = np.sort(pick)
    m = int(len(members))
    pairs = m * (m - 1) // 2
    info["members_compared"] = m
    info["sampled_down"] = bool(sampled_down)
    if pairs > remaining:
        info["skipped"] = "쌍 예산 초과로 점검하지 않음"
        return info, 0
    sub = X[members]
    sim = (sub @ sub.T).toarray()
    v = sim[np.triu_indices(m, k=1)]
    q = np.quantile(v, [0.05, 0.5])
    info.update(
        {
            "pairs_compared": int(pairs),
            "share_pairs_cos_ge_thr": round(float((v >= thr - 1e-9).mean()), 4),
            "cos_min": round(float(v.min()), 3),
            "cos_p05": round(float(q[0]), 3),
            "cos_median": round(float(q[1]), 3),
        }
    )
    return info, pairs


def chain_check(X, labels, thr):
    """그룹 내부 쌍별 코사인 표본 점검(연쇄 연결 확인). 기준 없이 관측값만 보고한다."""
    rng = np.random.default_rng(CHAIN_SEED)
    sizes = np.bincount(labels)
    zero = np.diff(X.indptr) == 0
    order = np.argsort(-sizes)
    top = [int(g) for g in order[:CHAIN_TOP_K] if sizes[g] >= 3]
    cand = np.setdiff1d(np.where(sizes >= 3)[0], np.array(top, dtype=np.int64))
    n_pick = min(CHAIN_RANDOM_GROUPS, len(cand))
    picked = rng.choice(cand, size=n_pick, replace=False) if n_pick else []
    plan = [("top", g) for g in top] + [("random", int(g)) for g in picked]

    used = 0
    top_info, rand_info = [], []
    for kind, g in plan:
        remaining = CHAIN_PAIR_BUDGET - used
        info, pairs = _inspect_group(X, labels, g, sizes, zero, thr, rng, remaining)
        used += pairs
        (top_info if kind == "top" else rand_info).append(info)

    all_info = top_info + rand_info
    inspected = sum(1 for i in all_info if "skipped" not in i)
    sampled = sum(1 for i in all_info if i.get("sampled_down"))
    shares = [
        r["share_pairs_cos_ge_thr"]
        for r in rand_info
        if "share_pairs_cos_ge_thr" in r
    ]
    summary = {"groups_with_result": len(shares)}
    if shares:
        qs = np.quantile(shares, [0, 0.25, 0.5, 0.75, 1])
        summary["share_pairs_cos_ge_thr_min_p25_med_p75_max"] = [
            round(float(x), 4) for x in qs
        ]
    return {
        "note": (
            "그룹 안에 서로 직접 유사하지 않은 쌍이 얼마나 있는지 보는 "
            "관측값이다. 판정 기준은 없다. 무작위 그룹은 크기 3 이상 "
            "그룹에서 뽑으므로 대부분 작다. 큰 그룹은 top_groups 를 본다."
        ),
        "scope": {
            "top_k_requested": CHAIN_TOP_K,
            "random_groups_requested": CHAIN_RANDOM_GROUPS,
            "max_members_per_group": CHAIN_MAX_MEMBERS,
            "pair_budget": CHAIN_PAIR_BUDGET,
            "random_seed": CHAIN_SEED,
            "groups_planned": len(plan),
            "groups_inspected": inspected,
            "groups_not_inspected": len(plan) - inspected,
            "groups_sampled_down": sampled,
            "total_pairs_compared": int(used),
        },
        "top_groups": top_info,
        "random_groups_summary": summary,
        "random_groups": rand_info,
    }


def length_stats(plain, y):
    out = {}
    for lab, name in ((0, "normal"), (1, "spam")):
        v = np.array([len(plain[i]) for i in range(len(plain)) if y[i] == lab])
        if len(v) == 0:
            out[name] = {"rows": 0}
            continue
        out[name] = {
            "rows": int(len(v)),
            "length_median": int(np.median(v)),
            "length_p90": int(np.percentile(v, 90)),
            "length_max": int(v.max()),
            "under_30_chars_share": round(float(np.mean(v < 30)), 4),
        }
    return out


# ---------------------------------------------------------------- 분할 통계(기준 없음)
FOLD_ROLES_DESC = (
    "폴드를 구성 행(source_row)의 sha256 순서로 정렬해 1번째=test, 2번째=val, "
    "나머지=train (폴드 번호나 결과를 보고 정하지 않음)"
)


def fold_role_order(fold, source_rows):
    """각 폴드의 구성 행으로 만든 해시 순서(작은 것부터). 폴드 번호와 무관하다."""
    keys = []
    for k in range(N_SPLITS):
        members = np.sort(source_rows[fold == k])
        digest = hashlib.sha256(",".join(str(int(r)) for r in members).encode("ascii"))
        keys.append((digest.hexdigest(), k))
    return [k for _, k in sorted(keys)]


def split_fingerprint(source_rows, split):
    """(source_row, split) 전체의 sha256. 미리보기와 확정이 같은 분할인지 대조한다."""
    h = hashlib.sha256()
    for r, s in zip(source_rows.tolist(), split.tolist()):
        h.update(f"{r}:{s};".encode("ascii"))
    return h.hexdigest()


def make_split(strata, gid, seed, source_rows):
    n = len(strata)
    n_groups = len(set(gid.tolist()))
    if n_groups < N_SPLITS:
        raise SystemExit(
            f"그룹이 {n_groups}개뿐이라 {N_SPLITS}-폴드 분할을 할 수 없습니다."
        )
    sgkf = StratifiedGroupKFold(n_splits=N_SPLITS, shuffle=True, random_state=seed)
    fold = np.full(n, -1, dtype=int)
    try:
        for k, (_, te) in enumerate(sgkf.split(np.zeros(n), strata, groups=gid)):
            fold[te] = k
    except ValueError as e:
        raise SystemExit(f"그룹 분할에 실패했습니다: {e}")
    if (fold < 0).any():
        raise SystemExit("일부 행이 어떤 폴드에도 배정되지 않았습니다.")
    order = fold_role_order(fold, source_rows)
    test_fold, val_fold = order[0], order[1]
    return np.where(fold == test_fold, "test", np.where(fold == val_fold, "val", "train"))


def split_statistics(split, y, url, strata, gid):
    """학습·검증·테스트 모두 같은 방식으로 건수, 그룹 수, 편차를 계산한다."""
    totals = {c: int((strata == c).sum()) for c in range(4)}
    out = {"group_overlap_between_splits": {}, "splits": {}}
    for a, b in (("train", "val"), ("train", "test"), ("val", "test")):
        ga = set(gid[split == a].tolist())
        gb = set(gid[split == b].tolist())
        out["group_overlap_between_splits"][f"{a}-{b}"] = len(ga & gb)

    all_rows, all_dev, vt_rows, vt_dev = [], [], [], []
    for s in ("train", "val", "test"):
        idx = np.where(split == s)[0]
        table = {}
        for code, name in STRATA_NAMES.items():
            sel = strata[idx] == code
            cnt = int(sel.sum())
            exp = totals[code] * SPLIT_FRACTION[s]
            dev = (cnt - exp) / exp if exp > 0 else None
            table[name] = {
                "rows": cnt,
                "groups": int(len(set(gid[idx][sel].tolist()))),
                "expected_rows": round(exp, 1),
                "relative_deviation": None if dev is None else round(dev, 3),
            }
            all_rows.append(cnt)
            if dev is not None:
                all_dev.append(abs(dev))
            if s in ("val", "test"):
                vt_rows.append(cnt)
                if dev is not None:
                    vt_dev.append(abs(dev))
        has_rows = len(idx) > 0
        out["splits"][s] = {
            "rows": int(len(idx)),
            "groups": int(len(set(gid[idx].tolist()))),
            "spam_rows": int(y[idx].sum()),
            "normal_rows": int(len(idx) - y[idx].sum()),
            "spam_ratio": round(float(y[idx].mean()), 4) if has_rows else None,
            "url_ratio": round(float(url[idx].mean()), 4) if has_rows else None,
            "strata": table,
        }

    key = STRATA_NAMES[2]
    spam_no_url = {
        s: {
            "rows": out["splits"][s]["strata"][key]["rows"],
            "groups": out["splits"][s]["strata"][key]["groups"],
        }
        for s in ("train", "val", "test")
    }
    out["observed_summary"] = {
        "min_stratum_rows_all_splits": min(all_rows),
        "min_stratum_rows_val_test": min(vt_rows),
        "max_abs_deviation_all_splits": round(max(all_dev), 3) if all_dev else None,
        "max_abs_deviation_val_test": round(max(vt_dev), 3) if vt_dev else None,
        "spam_no_url_counts": spam_no_url,
        "sample_size_note": SAMPLE_SIZE_NOTE,
    }
    return out


def jaccard_audit(plain, split, y, src, ref="train", chunk=200):
    """다른 척도(문자 3-gram 자카드)로 문장별 학습셋 최대 유사도를 잰다."""
    vec = CountVectorizer(
        analyzer="char",
        ngram_range=(3, 3),
        binary=True,
        lowercase=False,
        dtype=np.float32,
    )
    B = vec.fit_transform(plain).tocsr()
    sizes = np.asarray(B.sum(axis=1)).ravel()
    ref_idx = np.where(split == ref)[0]
    src_idx = np.where(split == src)[0]
    BrefT = B[ref_idx].T.tocsr()
    size_ref = sizes[ref_idx]
    best = np.zeros(len(src_idx), dtype=np.float64)
    for start in range(0, len(src_idx), chunk):
        sub = src_idx[start:start + chunk]
        S = (B[sub] @ BrefT).tocoo()
        denom = sizes[sub][S.row] + size_ref[S.col] - S.data
        jac = S.data / np.maximum(denom, 1.0)
        local = np.zeros(len(sub))
        np.maximum.at(local, S.row, jac)
        best[start:start + len(sub)] = local

    def summarize(vals):
        if len(vals) == 0:
            return {"n": 0}
        q = np.quantile(vals, [0.5, 0.9, 0.95, 0.99])
        return {
            "n": int(len(vals)),
            "median": round(float(q[0]), 3),
            "p90": round(float(q[1]), 3),
            "p95": round(float(q[2]), 3),
            "p99": round(float(q[3]), 3),
            "max": round(float(vals.max()), 3),
            "share_ge_0.5": round(float((vals >= 0.5).mean()), 4),
            "share_ge_0.7": round(float((vals >= 0.7).mean()), 4),
            "share_ge_0.8": round(float((vals >= 0.8).mean()), 4),
            "share_ge_0.9": round(float((vals >= 0.9).mean()), 4),
        }

    ys = y[src_idx]
    return {
        "note": LEAK_NOTE,
        "measure": "문자 3-gram 자카드(마스킹 없는 NFKC 텍스트), 학습셋 대비 최대값",
        "overall": summarize(best),
        "normal": summarize(best[ys == 0]),
        "spam": summarize(best[ys == 1]),
    }


# ---------------------------------------------------------------- 1단계: prepare (분할 없음)
def cmd_prepare(args):
    if not RAW_CSV.exists():
        raise SystemExit(f"입력 파일이 없습니다: {RAW_CSV}")
    ensure_out_dir()
    check_outputs(PREPARE_REPORT, [GROUPS_CSV], args.overwrite)

    log("1) CSV 읽기 (content/label 만 사용)")
    records, parse_stats, n_bytes, sha = read_records()
    an = parse_stats["anomalous_extra_column_values"]
    ok = parse_stats["rows_passing_label_and_content_checks"]
    log(f"   파서 레코드 {parse_stats['records_parsed_total']:,}")
    log(f"   라벨/내용 검사 통과 행 {ok['total']:,} {ok['by_label']}")
    log(f"   라벨 문자열별 건수 {parse_stats['label_text_counts_all_records']['counts']}")
    log(f"   이름 없는 컬럼 이상값 행 {an['records_with_values']}건 (행 보존)")
    log(f"   가장 긴 content 길이 {parse_stats['longest_content_lengths_top5']}")

    log("2) 정확 중복 처리 (원문 기준)")
    kept, dedup_info = exact_dedup(records)
    conflict_rows = dedup_info["label_conflict"]["rows_removed"]
    log(f"   중복 제거 {dedup_info['duplicate_rows_removed']:,}")
    log(f"   라벨 충돌 제외 {conflict_rows:,} / 남은 행 {len(kept):,}")
    if not kept:
        raise SystemExit("정제 후 남은 행이 없습니다. 입력 파일을 확인하세요.")

    n = len(kept)
    contents = [c for _, c, _ in kept]
    source_rows = np.array([s for s, _, _ in kept], dtype=np.int64)
    y = np.array([lab for _, _, lab in kept], dtype=np.int64)
    if len(set(y.tolist())) < 2:
        raise SystemExit("정제 후 한쪽 라벨만 남았습니다. CSV 파싱을 확인하세요.")
    if args.max_df * n < 2:
        raise SystemExit(
            f"정제 후 행이 {n}개뿐이라 --max-df {args.max_df} 를 쓸 수 없습니다. "
            "CSV 가 잘못 파싱됐을 수 있습니다."
        )

    log("3) 정규화, 마스킹, URL 유무 판정")
    masked = [mask_text(c) for c in contents]
    plain = [plain_text(c) for c in contents]
    url = np.array([1 if has_url(c) else 0 for c in contents], dtype=np.int64)
    strata = y * 2 + url
    del contents
    multi, by_mask, mask_info = masked_groups(masked, y)
    mask_gid = compress_ids([by_mask[m][0] for m in masked])

    log("4) 유사 중복 쌍 계산 (문자 5-gram TF-IDF 코사인)")
    pr, pc, ps, zero_docs, vocab_size, X = similarity_pairs(
        masked, min(SIM_THRESHOLDS), args.max_df, args.chunk, args.max_pairs
    )
    log(f"   유사 쌍(>=0.80) {len(pr):,}개, 벡터가 빈 문장 {zero_docs:,}개")

    near_info = {
        "tfidf": {
            "ngram": [5, 5],
            "min_df": 2,
            "max_df": args.max_df,
            "vocab_size": vocab_size,
            "zero_vector_docs_linked_by_mask_only": zero_docs,
        },
        "pairs_ge_0.80": int(len(pr)),
        "by_threshold": {},
    }
    gids = {}
    for thr in SIM_THRESHOLDS:
        labels = build_labels(n, multi, pr, pc, ps, thr)
        gids[thr] = labels
        d = group_distribution(labels, y, strata)
        d["link_density"] = link_density(labels, pr, pc, ps, thr)
        d["chain_check"] = chain_check(X, labels, thr)
        near_info["by_threshold"][f"{thr:.2f}"] = d
        scope = d["chain_check"]["scope"]
        log(f"   임계값 {thr:.2f}: 그룹 {d['groups']:,}, "
            f"최대 그룹 {d['max_group_size']:,} "
            f"({d['max_group_share_of_rows']:.2%})")
        log(f"      라벨 혼합 그룹 {d['mixed_label_groups']}, "
            f"여러 계층에 걸친 그룹 {d['groups_spanning_multiple_strata']}")
        log(f"      연쇄 점검: 그룹 {scope['groups_inspected']}개, "
            f"쌍 {scope['total_pairs_compared']:,}개 비교")

    totals = {STRATA_NAMES[c]: int((strata == c).sum()) for c in range(4)}
    worst = min(args.chunk, n) * n
    report = {
        "stage": "prepare (분할 없음: 그룹 통계만)",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "environment": {
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "scikit-learn": sklearn.__version__,
        },
        "config": {
            "similarity_thresholds": list(SIM_THRESHOLDS),
            "max_df": args.max_df,
            "chunk": args.chunk,
            "max_pairs": args.max_pairs,
            "chunk_worst_case_nnz": worst,
            "chunk_worst_case_mb_estimate": worst * BYTES_PER_NNZ // 10**6,
            "max_chunk_worst_nnz": MAX_CHUNK_WORST_NNZ,
            "chain_check_limits": {
                "top_k": CHAIN_TOP_K,
                "random_groups": CHAIN_RANDOM_GROUPS,
                "max_members_per_group": CHAIN_MAX_MEMBERS,
                "pair_budget": CHAIN_PAIR_BUDGET,
            },
            "normalization": NORM_VERSION,
        },
        "input": {
            "path": "important/smishing.csv",
            "bytes": n_bytes,
            "sha256": sha,
            "used_columns": ["content", "label"],
            "not_used_columns": ["explanation", "type", "이름 없는 추가 컬럼"],
        },
        "parsing": parse_stats,
        "exact_dedup": dedup_info,
        "masking_groups": mask_info,
        "near_duplicate": near_info,
        "dataset_after_cleaning": {
            "rows": n,
            "groups_by_threshold": {
                f"{t:.2f}": int(gids[t].max()) + 1 for t in SIM_THRESHOLDS
            },
            "label_counts": {
                "정상": int((y == 0).sum()),
                "스미싱": int((y == 1).sum()),
            },
            "strata_counts": totals,
            "strata_rows_per_fold_if_perfectly_balanced": {
                k: round(v / 7, 1) for k, v in totals.items()
            },
            "sample_size_note": SAMPLE_SIZE_NOTE,
            "url_ratio_by_label": {
                "정상": round(float(url[y == 0].mean()), 4) if (y == 0).any() else None,
                "스미싱": round(float(url[y == 1].mean()), 4) if (y == 1).any() else None,
            },
            "length_by_label": length_stats(plain, y),
        },
        "decisions_needed": [
            "최대 그룹 크기 기준: 확정되지 않음. 임계값별 최대 그룹 크기, "
            "참고용 초과 표, 연쇄 연결 점검 결과를 보고 정한다.",
            "분할에 쓸 유사도 임계값: 기본 0.85 이나 분포를 보고 확정한다.",
            "(라벨 x URL 유무) 계층의 최소 건수 기준: 확정되지 않음.",
            "(라벨 x URL 유무) 계층의 기대 대비 편차 허용치: 확정되지 않음.",
        ],
        "next_step": (
            "preview-split 으로 비확정 분할의 계층 분포와 편차를 확인한 뒤 "
            "기준을 확정한다. 분할은 아직 확정되지 않았다."
        ),
    }

    log("5) 결과 저장 (원문 없음, 분할 없음, 보고서는 마지막)")
    header = [
        "source_row", "label", "has_url", "stratum",
        "masked_group", "group_080", "group_085", "group_090",
    ]
    rows = (
        [
            int(source_rows[i]), int(y[i]), int(url[i]), int(strata[i]),
            int(mask_gid[i]), int(gids[0.80][i]), int(gids[0.85][i]),
            int(gids[0.90][i]),
        ]
        for i in range(n)
    )
    write_csv_atomic(GROUPS_CSV, header, rows)
    report["outputs"] = {
        "prepared_groups_csv": "important/processed/prepared_groups.csv",
        "rows": n,
        "prepared_groups_sha256": sha256_file(GROUPS_CSV),
    }
    write_json_atomic(PREPARE_REPORT, report)

    print()
    print("=" * 60)
    print(f"최종 정제 행 수: {n:,}")
    for t in SIM_THRESHOLDS:
        d = near_info["by_threshold"][f"{t:.2f}"]
        print(f"  임계값 {t:.2f}: 그룹 {d['groups']:,}개, "
              f"최대 그룹 {d['max_group_size']:,}행, "
              f"크기 2+ 그룹 {d['groups_size_ge2']:,}개")
    print("분할은 하지 않았습니다.")
    print("확정이 필요한 기준은 보고서의 decisions_needed 를 확인하세요.")
    print("보고서:", PREPARE_REPORT)
    return 0


# ---------------------------------------------------------------- 분할 단계 공통 부분
def load_prepared(threshold: float):
    for p in (PREPARE_REPORT, GROUPS_CSV):
        if not p.exists():
            raise SystemExit(f"먼저 prepare 를 실행해야 합니다. 없는 파일: {p.name}")
    with open(PREPARE_REPORT, encoding="utf-8") as f:
        report = json.load(f)
    if sha256_file(RAW_CSV) != report["input"]["sha256"]:
        raise SystemExit(
            "입력 CSV 가 prepare 이후 바뀌었습니다(해시 불일치). "
            "prepare 를 다시 실행하세요."
        )
    if sha256_file(GROUPS_CSV) != report["outputs"]["prepared_groups_sha256"]:
        raise SystemExit(
            "prepared_groups.csv 가 prepare 결과와 다릅니다(해시 불일치). "
            "prepare 를 --overwrite 로 다시 실행하세요."
        )
    col = GROUP_COLUMNS[threshold]
    cols = {"source_row": [], "label": [], "has_url": [], "stratum": [], col: []}
    with open(GROUPS_CSV, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            for k in cols:
                cols[k].append(int(row[k]))
    arr = {k: np.array(v, dtype=np.int64) for k, v in cols.items()}
    return (
        report,
        arr["source_row"],
        arr["label"],
        arr["has_url"],
        arr["stratum"],
        arr[col],
    )


def load_plain(source_rows):
    records, _, _, _ = read_records()
    by_row = {rec_no: content for rec_no, content, _ in records}
    try:
        return [plain_text(by_row[int(r)]) for r in source_rows]
    except KeyError as e:
        raise SystemExit(f"prepare 결과의 행 번호를 CSV 에서 찾지 못했습니다: {e}")


def print_split_tables(stats, header):
    print(header)
    for s in ("train", "val", "test"):
        d = stats["splits"][s]
        print(f"  [{s}] 행 {d['rows']:,} / 그룹 {d['groups']:,} / "
              f"스미싱 비율 {d['spam_ratio']} / URL 비율 {d['url_ratio']}")
        for name, t in d["strata"].items():
            print(f"      {name:10s} 행 {t['rows']:6,} / 그룹 {t['groups']:6,}")
            print(f"          기대 {t['expected_rows']:8,.1f} / "
                  f"편차 {t['relative_deviation']}")
    print("  그룹 겹침:", stats["group_overlap_between_splits"])
    print("  참고:", SAMPLE_SIZE_NOTE)


def run_split(args, final: bool):
    if not RAW_CSV.exists():
        raise SystemExit(f"입력 파일이 없습니다: {RAW_CSV}")
    ensure_out_dir()
    if final:
        check_outputs(FINAL_REPORT, [FINAL_ASSIGN], args.overwrite)
    else:
        check_outputs(PREVIEW_REPORT, [PREVIEW_CSV], args.overwrite)

    prep, source_rows, y, url, strata, gid = load_prepared(args.threshold)
    thr_key = f"{args.threshold:.2f}"
    dist = prep["near_duplicate"]["by_threshold"][thr_key]
    log(f"유사도 임계값 {thr_key}: 그룹 {dist['groups']:,}개, "
        f"최대 그룹 {dist['max_group_size']:,}행 사용")

    mode_text = "확정 시도" if final else "비확정 미리보기"
    log(f"분할 (StratifiedGroupKFold, 시드 {args.seed}) [{mode_text}]")
    split = make_split(strata, gid, args.seed, source_rows)
    fingerprint = split_fingerprint(source_rows, split)
    if final:
        # 확정은 사용자가 본 미리보기와 완전히 같은 분할일 때만 진행한다. 다르면 아무것도 쓰지 않는다.
        if not PREVIEW_REPORT.exists():
            raise SystemExit("미리보기 보고서가 없습니다. preview-split 을 먼저 실행하세요.")
        with open(PREVIEW_REPORT, encoding="utf-8") as f:
            pv = json.load(f)
        mismatch = []
        if pv.get("seed") != args.seed:
            mismatch.append(f"시드 {pv.get('seed')} != {args.seed}")
        if pv.get("similarity_threshold") != args.threshold:
            mismatch.append(f"임계값 {pv.get('similarity_threshold')} != {args.threshold}")
        if pv.get("split_fingerprint") != fingerprint:
            mismatch.append("분할 지문(split_fingerprint) 불일치 또는 미리보기에 지문 없음")
        if mismatch:
            raise SystemExit(
                "미리보기와 확정 조건이 다릅니다. 아무것도 저장하지 않았습니다: "
                + "; ".join(mismatch)
                + "\n같은 시드·임계값으로 preview-split 을 --overwrite 로 다시 실행해 "
                "검토한 뒤 확정하세요."
            )
    stats = split_statistics(split, y, url, strata, gid)
    print_split_tables(stats, "\n분할 결과 (세 분할 모두 같은 방식으로 계산)")

    log("누수 감사 (자카드, 검증/테스트 -> 학습) - 참고 지표")
    plain = load_plain(source_rows)
    leak = {
        "test_vs_train": jaccard_audit(plain, split, y, "test"),
        "val_vs_train": jaccard_audit(plain, split, y, "val"),
    }
    for k, v in leak.items():
        o = v["overall"]
        print(f"  {k}: 중앙값 {o['median']}, p95 {o['p95']}, "
              f"0.8 이상 {o['share_ge_0.8']:.2%}, 0.9 이상 {o['share_ge_0.9']:.2%}")
    print("  참고:", LEAK_NOTE)

    base = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "seed": args.seed,
        "similarity_threshold": args.threshold,
        "n_splits": N_SPLITS,
        "fold_roles": FOLD_ROLES_DESC,
        "split_fingerprint": fingerprint,
        "input_sha256": prep["input"]["sha256"],
        "group_distribution_at_threshold": dist,
        "split_statistics": stats,
        "leakage_audit": leak,
    }
    header = ["source_row", "label", "has_url", "stratum", "group_id", "split"]

    def split_rows():
        return (
            [
                int(source_rows[i]), int(y[i]), int(url[i]),
                int(strata[i]), int(gid[i]), str(split[i]),
            ]
            for i in range(len(y))
        )

    if not final:
        obs = stats["observed_summary"]
        base["status"] = "PREVIEW (비확정). 후속 학습 단계는 이 분할을 쓸 수 없다."
        base["decisions_needed"] = [
            {
                "item": "최대 그룹 크기 기준",
                "observed": {
                    "max_group_size": dist["max_group_size"],
                    "max_group_share_of_rows": dist["max_group_share_of_rows"],
                },
                "status": "사용자 확정 필요",
            },
            {
                "item": "(라벨 x URL 유무) 계층 최소 건수 기준",
                "observed": {
                    "min_rows_val_test": obs["min_stratum_rows_val_test"],
                    "min_rows_all_splits": obs["min_stratum_rows_all_splits"],
                },
                "status": "사용자 확정 필요",
            },
            {
                "item": "(라벨 x URL 유무) 기대 대비 편차 허용치",
                "observed": {
                    "max_abs_deviation_val_test": obs["max_abs_deviation_val_test"],
                    "max_abs_deviation_all_splits": obs["max_abs_deviation_all_splits"],
                },
                "status": "사용자 확정 필요",
            },
        ]
        base["next_step"] = (
            "기준 3개를 확정하면 finalize-split 에 --max-group-size, "
            "--min-stratum-rows, --balance-tol 을 직접 지정해 실행한다."
        )
        write_csv_atomic(PREVIEW_CSV, header, split_rows())
        write_json_atomic(PREVIEW_REPORT, base)
        print("\n미리보기만 저장했습니다. 이 분할은 확정되지 않았습니다.")
        print("보고서:", PREVIEW_REPORT)
        return 0

    # 확정 단계: 사용자가 직접 지정한 기준만 적용한다.
    # 누수 감사는 판정에 쓰지 않는다.
    criteria = {
        "max_group_size": args.max_group_size,
        "min_stratum_rows": args.min_stratum_rows,
        "balance_tol": args.balance_tol,
        "source": "사용자 확정 값(기본값 없음)",
    }
    fail = []
    if dist["max_group_size"] > args.max_group_size:
        fail.append(
            f"최대 그룹 크기 {dist['max_group_size']:,} > 기준 {args.max_group_size:,}"
        )
    overlap = stats["group_overlap_between_splits"]
    if sum(overlap.values()) > 0:
        fail.append(f"그룹이 여러 분할에 걸쳐 있음: {overlap}")
    for s in ("train", "val", "test"):
        for name, t in stats["splits"][s]["strata"].items():
            if t["rows"] == 0:
                fail.append(f"{s}: '{name}' 표본 0건")
            elif t["rows"] < args.min_stratum_rows:
                fail.append(
                    f"{s}: '{name}' {t['rows']}건 < 기준 {args.min_stratum_rows}"
                )
            dev = t["relative_deviation"]
            if dev is not None and abs(dev) > args.balance_tol:
                fail.append(
                    f"{s}: '{name}' 편차 {dev:+.1%} > 허용 ±{args.balance_tol:.0%}"
                )

    verdict = "FAIL" if fail else "PASS"
    base["criteria"] = criteria
    base["checks"] = {
        "verdict": verdict,
        "verdict_meaning": VERDICT_MEANING,
        "fail": fail,
        "rule": (
            "PASS 일 때만 split_assignment.csv 를 만든다. "
            "후속 단계는 verdict 가 PASS 가 아니면 거부한다."
        ),
    }
    if verdict == "PASS":
        write_csv_atomic(FINAL_ASSIGN, header, split_rows())
        base["outputs"] = {
            "split_assignment_csv": "important/processed/split_assignment.csv",
            "rows": int(len(y)),
            "split_assignment_sha256": sha256_file(FINAL_ASSIGN),
        }
    else:
        base["outputs"] = {
            "split_assignment_csv": None,
            "note": "기준을 만족하지 못해 분할을 확정하지 않았다.",
        }
        if FINAL_ASSIGN.exists():
            # 이전에 확정한 파일이 쓰이지 않도록 이름만 바꾼다(삭제하지 않음).
            stale = FINAL_ASSIGN.with_name(FINAL_ASSIGN.name + ".invalidated")
            os.replace(FINAL_ASSIGN, stale)
            base["outputs"]["invalidated_previous_assignment"] = stale.name
    write_json_atomic(FINAL_REPORT, base)

    print()
    print("=" * 60)
    print(f"분할 기준 검사 결과: {verdict}")
    print("  의미:", VERDICT_MEANING)
    for m in fail:
        print("  [FAIL]", m)
    if verdict == "FAIL":
        print("분할을 확정하지 않았습니다. 학습을 진행하지 말고 통계를 검토하세요.")
    print("보고서:", FINAL_REPORT)
    return 0 if verdict == "PASS" else 2


# ---------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser(description="피싱 탐지 레이더 학습 파이프라인 (데이터 준비)")
    sub = ap.add_subparsers(dest="stage", required=True)

    p = sub.add_parser("prepare", help="정제, 정확 중복 처리, 그룹 통계 (분할 안 함)")
    p.add_argument("--max-df", type=float, default=0.05,
                   help="공통 틀 n-gram 제외 비율")
    p.add_argument("--chunk", type=int, default=400,
                   help="유사도 계산 청크 크기(곱셈 전에 크기를 사전 검사)")
    p.add_argument("--max-pairs", type=int, default=10_000_000,
                   help="유사 쌍 상한(저장 전에 검사하는 안전장치)")
    p.add_argument("--overwrite", action="store_true",
                   help="기존/중단된 결과를 새 결과로 교체한다")

    def add_split_args(sp):
        sp.add_argument("--threshold", type=float, default=0.85,
                        choices=list(SIM_THRESHOLDS), help="분할에 쓸 유사도 임계값")
        sp.add_argument("--seed", type=int, default=42)
        sp.add_argument("--overwrite", action="store_true",
                        help="기존/중단된 결과를 새 결과로 교체한다")

    pv = sub.add_parser("preview-split", help="비확정 미리보기 분할(기준 없음)")
    add_split_args(pv)

    pf = sub.add_parser("finalize-split", help="확정 기준 3개를 직접 지정해야 실행")
    add_split_args(pf)
    pf.add_argument("--max-group-size", type=int, required=True,
                    help="허용하는 최대 그룹 크기(행 수)")
    pf.add_argument("--min-stratum-rows", type=int, required=True,
                    help="모든 분할의 계층별 최소 행 수")
    pf.add_argument("--balance-tol", type=float, required=True,
                    help="계층별 기대 대비 편차 허용치(예: 0.2)")

    args = ap.parse_args()
    try:
        if args.stage == "prepare":
            code = cmd_prepare(args)
        elif args.stage == "preview-split":
            code = run_split(args, final=False)
        else:
            code = run_split(args, final=True)
    except MemoryError:
        raise SystemExit(
            "메모리가 부족합니다. prepare 라면 --chunk 를 줄이거나(예: 200) "
            "--max-df 를 낮춰 다시 실행하세요.\n"
            "일부 결과가 남아 있으면 같은 명령에 --overwrite 를 붙여 재실행하세요."
        )
    sys.exit(code)


if __name__ == "__main__":
    main()
