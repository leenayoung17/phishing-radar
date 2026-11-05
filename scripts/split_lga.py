"""lgaidataset.csv 를 그룹 단위로 조정용(dev)/시험용(test)으로 나눈다.

- 클래스 2 = 스미싱, 클래스 1·3 = 정상(사용자 지정).
- 비슷한 문장(마스킹 일치 또는 5-gram 코사인 >= 0.85)은 같은 그룹으로 묶어 한쪽에만 넣는다.
- 기존 학습·검증 행(smishing.csv 의 train/val)과 마스킹 텍스트가 겹치는 그룹은 무조건 dev 로 보낸다.
  (시험용에 기존 학습 데이터와 같은 문장이 들어가지 않게 하기 위해서다. 기존 test 행 원문은 읽지 않는다.)
- 폴드 5개 중 내용 해시 순서 앞의 2개를 test 로 쓴다(약 40%). 폴드 번호나 결과로 정하지 않는다.
- 합격·불합격 기준은 정하지 않고 통계만 보고한다.
- test 행의 원문은 어떤 출력 파일에도 쓰지 않는다.
- 사용: python -X utf8 -I scripts/split_lga.py [--overwrite]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.model_selection import StratifiedGroupKFold

import train_model as tm

SRC = tm.IMPORTANT_DIR / "lgaidataset.csv"
PROC = tm.FINAL_ASSIGN.parent
SPLIT_CSV = PROC / "lga_split.csv"
DEV_JSONL = PROC / "lga_dev.jsonl"
REPORT = PROC / "lga_split_report.json"
SEED = 42
THRESHOLD = 0.85
N_SPLITS = 5
TEST_FOLDS = 2


def load_rows():
    raw = SRC.read_bytes().decode("utf-8-sig")
    csv.field_size_limit(10**8)
    out = []
    for i, r in enumerate(csv.reader(io.StringIO(raw, newline=""))):
        if i == 0:
            continue
        _, content, cls = r
        out.append({"row": i - 1, "text": content, "cls": cls, "label": 1 if cls == "2" else 0})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()
    for p in (SPLIT_CSV, DEV_JSONL, REPORT):
        if p.exists() and not args.overwrite:
            raise SystemExit(f"{p.name} 가 이미 있습니다. 덮어쓰려면 --overwrite 를 붙이세요.")
    if not SRC.exists():
        raise SystemExit(f"입력 파일이 없습니다: {SRC}")

    t0 = time.time()
    rows = load_rows()
    n = len(rows)
    y = np.array([r["label"] for r in rows])
    masked = [tm.mask_text(r["text"]) for r in rows]
    has_url = np.array([int(tm.has_url(r["text"])) for r in rows])
    cls = np.array([int(r["cls"]) for r in rows])
    strata = cls * 2 + has_url

    # 기존 학습·검증 행과 겹치는 문장(테스트 행 원문은 읽지 않는다).
    orig_dev_keys = set()
    with open(PROC / "dev_eval.jsonl", encoding="utf-8") as f:
        for line in f:
            orig_dev_keys.add(tm.mask_text(json.loads(line)["text"]))
    in_orig_dev = np.array([m in orig_dev_keys for m in masked])

    multi, _, _ = tm.masked_groups(masked, y)
    pr, pc, ps, _, _, _ = tm.similarity_pairs(masked, THRESHOLD, 0.05, 400, 10_000_000)
    gid = tm.build_labels(n, multi, pr, pc, ps, THRESHOLD)
    sizes = np.bincount(gid)
    print(f"행 {n:,}, 그룹 {len(sizes):,}, 최대 그룹 {int(sizes.max()):,}행")

    # 기존 학습·검증과 겹치는 그룹은 dev 로 고정
    forced_groups = set(gid[in_orig_dev].tolist())
    forced = np.array([g in forced_groups for g in gid.tolist()])
    free_idx = np.where(~forced)[0]

    split = np.array(["dev"] * n, dtype=object)
    sgkf = StratifiedGroupKFold(n_splits=N_SPLITS, shuffle=True, random_state=SEED)
    fold = np.full(n, -1, dtype=int)
    for k, (_, te) in enumerate(sgkf.split(np.zeros(len(free_idx)), strata[free_idx], groups=gid[free_idx])):
        fold[free_idx[te]] = k
    if (fold[free_idx] < 0).any():
        raise SystemExit("일부 행이 폴드에 배정되지 않았습니다.")

    keys = []
    for k in range(N_SPLITS):
        members = np.sort(np.array([rows[i]["row"] for i in free_idx if fold[i] == k]))
        digest = hashlib.sha256(",".join(str(int(m)) for m in members).encode("ascii")).hexdigest()
        keys.append((digest, k))
    order = [k for _, k in sorted(keys)]
    test_folds = set(order[:TEST_FOLDS])
    for i in free_idx:
        if fold[i] in test_folds:
            split[i] = "test"

    # 검증: 같은 그룹이 양쪽에 걸치지 않아야 한다.
    g_dev = set(gid[split == "dev"].tolist())
    g_test = set(gid[split == "test"].tolist())
    overlap = len(g_dev & g_test)
    if overlap:
        raise SystemExit(f"그룹이 dev/test 양쪽에 걸쳐 있습니다: {overlap}")

    fingerprint = hashlib.sha256()
    for r, s in zip(range(n), split.tolist()):
        fingerprint.update(f"{r}:{s};".encode("ascii"))

    def stat(mask):
        return {
            "rows": int(mask.sum()),
            "groups": int(len(set(gid[mask].tolist()))),
            "spam": int(y[mask].sum()),
            "spam_ratio": round(float(y[mask].mean()), 4) if mask.any() else None,
            "url_ratio": round(float(has_url[mask].mean()), 4) if mask.any() else None,
            "by_class": {c: int(((cls == int(c)) & mask).sum()) for c in ("1", "2", "3")},
            "by_stratum": {
                f"class{c}/{'URL있음' if u else 'URL없음'}": int(((cls == c) & (has_url == u) & mask).sum())
                for c in (1, 2, 3)
                for u in (0, 1)
            },
        }

    report = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "important/lgaidataset.csv",
        "label_rule": "클래스 2 = 스미싱, 클래스 1·3 = 정상 (사용자 지정)",
        "seed": SEED,
        "similarity_threshold": THRESHOLD,
        "fold_roles": f"{N_SPLITS}개 폴드를 구성 행 sha256 순서로 정렬해 앞 {TEST_FOLDS}개=test, 나머지=dev",
        "forced_dev_note": "기존 학습·검증 행과 마스킹 텍스트가 겹치는 그룹은 dev 로 고정",
        "split_fingerprint": fingerprint.hexdigest(),
        "groups": {"total": int(len(sizes)), "max_size": int(sizes.max()), "forced_dev_groups": len(forced_groups)},
        "group_overlap_dev_test": overlap,
        "rows_forced_dev": int(forced.sum()),
        "dev": stat(split == "dev"),
        "test": stat(split == "test"),
        "note": "합격·불합격 기준은 정하지 않았다. test 행 원문은 어떤 출력에도 쓰지 않았다.",
        "seconds": round(time.time() - t0, 1),
    }
    REPORT.write_text(json.dumps(tm.jsonable(report), ensure_ascii=False, indent=2), encoding="utf-8")

    with open(SPLIT_CSV, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["row", "cls", "label", "has_url", "group_id", "split"])
        for i in range(n):
            w.writerow([rows[i]["row"], rows[i]["cls"], int(y[i]), int(has_url[i]), int(gid[i]), split[i]])
    with open(DEV_JSONL, "w", encoding="utf-8") as f:
        for i in range(n):
            if split[i] == "dev":
                f.write(json.dumps({
                    "source_row": rows[i]["row"], "label": int(y[i]), "cls": rows[i]["cls"],
                    "has_url": int(has_url[i]), "split": "dev", "text": rows[i]["text"],
                }, ensure_ascii=False) + "\n")

    print(json.dumps(tm.jsonable({k: report[k] for k in ("groups", "group_overlap_dev_test", "rows_forced_dev", "dev", "test", "split_fingerprint")}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
