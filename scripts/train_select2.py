"""모델 선택 2단계: 기존 데이터 + 새 데이터(lgaidataset)를 함께 학습하고 두 검증셋을 따로 본다.

- 학습: 기존 train + 새 데이터 dev 에서 뗀 학습분. 검증: 기존 val, 새 데이터 dev 에서 뗀 검증분.
- 두 시험용(기존 test, 새 데이터 test)은 읽지 않는다(배정 파일의 역할만 사용).
- 새 데이터 행 중 기존 val 과 비슷한(유사도 0.85+) 그룹은 제외, 기존 train 과 비슷한 그룹은 학습으로만 보낸다.
- 선택 기준(사전 지정): 두 검증셋 PR-AUC 중 낮은 값이 가장 높은 후보.
- 입력 정리: NFKC, 영문 소문자, '*' 제거(수집 과정의 가림 표시), URL 제거(자리표시 없음), 숫자 -> 0, 공백 정리.
- 사용: python -X utf8 -I scripts/train_select2.py [--overwrite]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

import train_model as tm

PROC = tm.FINAL_ASSIGN.parent
LGA_CSV = tm.IMPORTANT_DIR / "lgaidataset.csv"
LGA_SPLIT = PROC / "lga_split.csv"
ASSIGN_OUT = PROC / "combined_assignment.csv"
REPORT = PROC / "select2_report.json"
SEED = 42
THRESHOLD = 0.85
TARGET_FPR = 0.02

GRID = [
    {"ngram": ng, "C": c, "max_features": mf}
    for ng in ((1, 3), (2, 4))
    for c in (4.0, 16.0)
    for mf in (60000, 120000)
]


def clean(content: str) -> str:
    """학습·추론 공통 입력 정리. TS 구현과 1:1 로 맞춰야 한다."""
    t = tm.nfkc_lower(content).replace("*", "")
    t = tm._URL_RE.sub(" ", t)
    t = tm._BARE_RE.sub(" ", t)
    t = tm._DIGIT_RE.sub("0", t)
    return tm.collapse_ws(t)


def url_flag(content: str) -> int:
    t = tm.nfkc_lower(content).replace("*", "")
    return int(bool(tm._URL_RE.search(t) or tm._BARE_RE.search(t)))


def metrics(y, s):
    if len(set(y.tolist())) < 2:
        return None
    thr = float(np.quantile(s[y == 0], 1.0 - TARGET_FPR))
    pred = s > thr
    return {
        "n": int(len(y)), "spam": int(y.sum()),
        "roc_auc": float(roc_auc_score(y, s)), "pr_auc": float(average_precision_score(y, s)),
        "recall_at_fpr2": float(pred[y == 1].mean()), "fpr": float(pred[y == 0].mean()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()
    for p in (ASSIGN_OUT, REPORT):
        if p.exists() and not args.overwrite:
            raise SystemExit(f"{p.name} 가 이미 있습니다. 덮어쓰려면 --overwrite 를 붙이세요.")
    t0 = time.time()

    # ---- 기존 데이터: train/val 만 읽는다
    records, _, _, _ = tm.read_records()
    by_row = {rec_no: (content, label) for rec_no, content, label in records}
    orig = []  # (source_row, text, label, split)
    with open(tm.FINAL_ASSIGN, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["split"] in ("train", "val"):
                content, label = by_row[int(r["source_row"])]
                orig.append((int(r["source_row"]), content, int(label), r["split"]))
    orig_keys = {tm.mask_text(o[1]) for o in orig}

    # ---- 새 데이터: dev 역할인 행만 읽는다
    csv.field_size_limit(10**8)
    lga_all = list(csv.reader(io.StringIO(LGA_CSV.read_bytes().decode("utf-8-sig"), newline="")))[1:]
    lga = []  # (row, text, label, cls, group_in_lga_split)
    with open(LGA_SPLIT, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["split"] != "dev":
                continue
            i = int(r["row"])
            _, content, cls = lga_all[i]
            lga.append((i, content, int(r["label"]), r["cls"], int(r["group_id"])))
    lga_free = [x for x in lga if tm.mask_text(x[1]) not in orig_keys]
    print(f"기존 train/val {len(orig):,}행, 새 데이터 dev {len(lga):,}행 (기존과 겹쳐 제외 {len(lga) - len(lga_free):,}행)")

    # ---- 합쳐서 유사도 그룹을 만든다(누수 방지)
    texts = [o[1] for o in orig] + [x[1] for x in lga_free]
    masked = [tm.mask_text(t) for t in texts]
    y_all = np.array([o[2] for o in orig] + [x[2] for x in lga_free])
    multi, _, _ = tm.masked_groups(masked, y_all)
    pr, pc, ps, _, _, _ = tm.similarity_pairs(masked, THRESHOLD, 0.05, 300, 10_000_000)
    gid = tm.build_labels(len(masked), multi, pr, pc, ps, THRESHOLD)

    n_orig = len(orig)
    comp_roles: dict[int, set] = {}
    for i in range(n_orig):
        comp_roles.setdefault(int(gid[i]), set()).add(orig[i][3])

    role = []  # 새 데이터 행의 역할: drop / train / eligible
    for j, x in enumerate(lga_free):
        roles = comp_roles.get(int(gid[n_orig + j]), set())
        role.append("drop" if "val" in roles else ("train" if "train" in roles else "eligible"))
    print("새 데이터 역할 후보:", {k: role.count(k) for k in ("drop", "train", "eligible")})

    # eligible 그룹을 학습/검증으로 나눈다(내용 해시 순서 첫 폴드 = 검증, 약 20%)
    elig = [j for j, r in enumerate(role) if r == "eligible"]
    strata = np.array([int(lga_free[j][3]) * 2 + url_flag(lga_free[j][1]) for j in elig])
    egid = np.array([int(gid[n_orig + j]) for j in elig])
    sgkf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=SEED)
    fold = np.full(len(elig), -1)
    for k, (_, te) in enumerate(sgkf.split(np.zeros(len(elig)), strata, groups=egid)):
        fold[te] = k
    digests = []
    for k in range(5):
        members = sorted(lga_free[elig[i]][0] for i in range(len(elig)) if fold[i] == k)
        digests.append((hashlib.sha256(",".join(map(str, members)).encode("ascii")).hexdigest(), k))
    val_fold = sorted(digests)[0][1]
    lga_role = {}
    for j, r in enumerate(role):
        lga_role[j] = "drop" if r == "drop" else ("train" if r == "train" else None)
    for idx, j in enumerate(elig):
        lga_role[j] = "val" if fold[idx] == val_fold else "train"

    tr_texts, tr_y = [], []
    va = {"orig_val": ([], [], []), "lga_val": ([], [], [])}
    with open(ASSIGN_OUT, "w", encoding="utf-8", newline="") as fa:
        w = csv.writer(fa)
        w.writerow(["dataset", "row", "role"])
        for (sr, content, label, split) in orig:
            w.writerow(["orig", sr, split])
            if split == "train":
                tr_texts.append(clean(content))
                tr_y.append(label)
            else:
                va["orig_val"][0].append(clean(content))
                va["orig_val"][1].append(label)
                va["orig_val"][2].append(url_flag(content))
        for j, x in enumerate(lga_free):
            r = lga_role[j]
            w.writerow(["lga", x[0], r])
            if r == "train":
                tr_texts.append(clean(x[1]))
                tr_y.append(x[2])
            elif r == "val":
                va["lga_val"][0].append(clean(x[1]))
                va["lga_val"][1].append(x[2])
                va["lga_val"][2].append(url_flag(x[1]))
    tr_y = np.array(tr_y)
    sets = {k: (v[0], np.array(v[1]), np.array(v[2])) for k, v in va.items()}
    print(f"학습 {len(tr_y):,}행 (스미싱 {int(tr_y.sum()):,}), 검증: " +
          ", ".join(f"{k} {len(v[1]):,}행(스미싱 {int(v[1].sum()):,})" for k, v in sets.items()))

    results = []
    for cfg in GRID:
        vec = TfidfVectorizer(
            analyzer="char", ngram_range=cfg["ngram"], lowercase=False,
            min_df=3, max_features=cfg["max_features"], sublinear_tf=True,
        )
        a = vec.fit_transform(tr_texts)
        clf = LogisticRegression(
            C=cfg["C"], class_weight="balanced", solver="liblinear", max_iter=1000, random_state=0,
        ).fit(a, tr_y)
        res = {"ngram": list(cfg["ngram"]), "C": cfg["C"], "max_features": cfg["max_features"], "features": int(a.shape[1])}
        for name, (xs, ys, us) in sets.items():
            s = clf.decision_function(vec.transform(xs))
            res[name] = {
                "all": metrics(ys, s),
                "url": metrics(ys[us == 1], s[us == 1]),
                "no_url": metrics(ys[us == 0], s[us == 0]),
            }
        res["criterion_min_pr_auc"] = min(res["orig_val"]["all"]["pr_auc"], res["lga_val"]["all"]["pr_auc"])
        results.append(res)
        o, g = res["orig_val"]["all"], res["lga_val"]["all"]
        print(
            f"ng={cfg['ngram']} C={cfg['C']:<5} mf={cfg['max_features']:<6} | 기존검증 PR {o['pr_auc']:.3f} 재현@2% {o['recall_at_fpr2']:.3f}"
            f" | 새검증 PR {g['pr_auc']:.3f} 재현@2% {g['recall_at_fpr2']:.3f} | 기준(min) {res['criterion_min_pr_auc']:.4f}"
        )

    best = max(results, key=lambda r: r["criterion_min_pr_auc"])
    report = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "note": "검증 행 기준 후보 비교. 최종 성능이 아니며 두 시험용은 읽지 않았다.",
        "selection_criterion": "두 검증셋 PR-AUC 중 낮은 값이 가장 높은 후보(사전 지정)",
        "text_cleaning": "NFKC, 영문 소문자, '*' 제거, URL 제거(자리표시 없음), 숫자->0, 공백 정리",
        "rows": {"train": int(len(tr_y)), **{k: int(len(v[1])) for k, v in sets.items()}, "test_read": 0},
        "lga_roles": {k: sum(1 for v in lga_role.values() if v == k) for k in ("train", "val", "drop")},
        "candidates": results,
        "best": {k: best[k] for k in ("ngram", "C", "max_features", "criterion_min_pr_auc")},
        "seconds": round(time.time() - t0, 1),
    }
    REPORT.write_text(json.dumps(tm.jsonable(report), ensure_ascii=False, indent=2), encoding="utf-8")
    print("선택:", report["best"], "| 보고서:", REPORT)


if __name__ == "__main__":
    main()
