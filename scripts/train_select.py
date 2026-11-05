"""모델 선택 단계: 학습 행으로 학습하고 검증 행으로 후보를 비교한다.

- 테스트 행은 읽지 않는다(분할 파일에서 test 를 만나면 건너뛰고 텍스트도 불러오지 않는다).
- 입력 텍스트는 train_model.mask_text (NFKC, 영문 소문자, URL -> <url>, 숫자 -> 0, 공백 정리).
- 지표는 검증 행 기준이며 후보를 고르는 데 쓰인다. 최종 성능이 아니다.
- 사용: python -X utf8 -I scripts/train_select.py [--overwrite]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

import train_model as tm

REPORT = tm.FINAL_ASSIGN.parent / "select_report.json"
TARGET_FPR = 0.02

GRID = [
    {"url": u, "ngram": ng, "C": c}
    for u in ("mask", "remove")
    for ng in ((1, 3), (2, 4))
    for c in (1.0, 4.0, 16.0)
]


def url_removed_text(content: str) -> str:
    """URL 을 자리표시 토큰 없이 완전히 제거한다(모델이 '링크 있음' 자체를 쓰지 못하게)."""
    t = tm.nfkc_lower(content)
    t = tm._URL_RE.sub(" ", t)
    t = tm._BARE_RE.sub(" ", t)
    t = tm._DIGIT_RE.sub("0", t)
    return tm.collapse_ws(t)


def load_dev():
    """train/val 행만 불러온다. test 행은 텍스트를 읽지 않는다."""
    if not tm.FINAL_ASSIGN.exists():
        raise SystemExit("split_assignment.csv 가 없습니다. finalize-split 을 먼저 통과해야 합니다.")
    records, _, _, _ = tm.read_records()
    by_row = {rec_no: (content, label) for rec_no, content, label in records}
    rows = {"train": [], "val": []}
    with open(tm.FINAL_ASSIGN, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            split = r["split"]
            if split not in rows:
                continue  # test 는 건너뛴다
            content, label = by_row[int(r["source_row"])]
            assert int(r["label"]) == int(label)
            rows[split].append(
                (tm.mask_text(content), int(label), int(r["has_url"]), url_removed_text(content))
            )
    return rows


def recall_at_fpr(y, s, target):
    normals = s[y == 0]
    thr = float(np.quantile(normals, 1.0 - target))
    pred = s > thr
    return {
        "threshold": thr,
        "recall": float(pred[y == 1].mean()) if (y == 1).any() else None,
        "fpr": float(pred[y == 0].mean()) if (y == 0).any() else None,
    }


def metrics(y, s, thr_all=None):
    if len(set(y.tolist())) < 2:
        return None
    out = {
        "n": int(len(y)),
        "spam": int(y.sum()),
        "roc_auc": float(roc_auc_score(y, s)),
        "pr_auc": float(average_precision_score(y, s)),
        "at_fpr_2pct": recall_at_fpr(y, s, TARGET_FPR),
    }
    if thr_all is not None:
        pred = s > thr_all
        out["at_global_threshold"] = {
            "recall": float(pred[y == 1].mean()),
            "fpr": float(pred[y == 0].mean()),
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()
    if REPORT.exists() and not args.overwrite:
        raise SystemExit(f"{REPORT.name} 가 이미 있습니다. 덮어쓰려면 --overwrite 를 붙이세요.")

    t0 = time.time()
    rows = load_dev()
    ytr = np.array([r[1] for r in rows["train"]])
    yva = np.array([r[1] for r in rows["val"]])
    uva = np.array([r[2] for r in rows["val"]])
    texts = {
        "mask": ([r[0] for r in rows["train"]], [r[0] for r in rows["val"]]),
        "remove": ([r[3] for r in rows["train"]], [r[3] for r in rows["val"]]),
    }
    print(f"학습 {len(ytr):,}행, 검증 {len(yva):,}행 (테스트는 읽지 않음)")

    results = []
    for cfg in GRID:
        xtr, xva = texts[cfg["url"]]
        vec = TfidfVectorizer(
            analyzer="char", ngram_range=cfg["ngram"], lowercase=False,
            min_df=3, max_features=60000, sublinear_tf=True,
        )
        a = vec.fit_transform(xtr)
        b = vec.transform(xva)
        clf = LogisticRegression(
            C=cfg["C"], class_weight="balanced", solver="liblinear", max_iter=1000, random_state=0,
        )
        clf.fit(a, ytr)
        s = clf.decision_function(b)
        thr_all = recall_at_fpr(yva, s, TARGET_FPR)["threshold"]
        res = {
            "url": cfg["url"], "ngram": list(cfg["ngram"]), "C": cfg["C"], "features": int(a.shape[1]),
            "val_all": metrics(yva, s, thr_all),
            "val_url": metrics(yva[uva == 1], s[uva == 1], thr_all),
            "val_no_url": metrics(yva[uva == 0], s[uva == 0], thr_all),
        }
        results.append(res)
        g = res["val_all"]["at_global_threshold"]
        gu = res["val_url"]["at_global_threshold"]
        gn = res["val_no_url"]["at_global_threshold"]
        print(
            f"url={cfg['url']:6s} ng={cfg['ngram']} C={cfg['C']:<5} | PR-AUC {res['val_all']['pr_auc']:.3f} "
            f"| 전체 재현 {g['recall']:.3f}/오탐 {g['fpr']:.3f} | URL있음 재현 {gu['recall']:.3f}/오탐 {gu['fpr']:.3f} "
            f"| URL없음 재현 {gn['recall']:.3f}/오탐 {gn['fpr']:.3f}"
        )

    # URL 유무만 쓰는 기준 모델: 모델이 URL 편향만 배운 것이 아닌지 비교한다.
    base = metrics(yva, uva.astype(float))
    print(f"[기준] URL 유무만 사용: PR-AUC {base['pr_auc']:.3f}, ROC-AUC {base['roc_auc']:.3f}")

    best = max(results, key=lambda r: r["val_all"]["pr_auc"])
    report = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "note": "검증 행 기준 후보 비교. 최종 성능이 아니며 테스트 행은 사용하지 않았다.",
        "text_normalization": "train_model.mask_text (NFKC, 영문 소문자, URL->'<url>', 숫자->0, 공백 정리)",
        "vectorizer": {"analyzer": "char", "min_df": 3, "max_features": 60000, "sublinear_tf": True},
        "classifier": {"type": "LogisticRegression", "class_weight": "balanced", "solver": "liblinear"},
        "target_fpr": TARGET_FPR,
        "split_fingerprint_note": "split_assignment.csv 기준",
        "candidates": results,
        "baseline_url_presence_only": base,
        "best_by_val_pr_auc": {"url": best["url"], "ngram": best["ngram"], "C": best["C"]},
        "rows": {"train": len(ytr), "val": len(yva), "test_read": 0},
        "seconds": round(time.time() - t0, 1),
    }
    REPORT.write_text(json.dumps(tm.jsonable(report), ensure_ascii=False, indent=2), encoding="utf-8")
    print("가장 높은 검증 PR-AUC:", best["url"], best["ngram"], best["C"], "| 보고서:", REPORT)


if __name__ == "__main__":
    main()
