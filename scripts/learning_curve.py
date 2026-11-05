"""학습 곡선: 학습 데이터를 늘릴수록 검증 성능이 오르는지 확인한다(다시 학습할 가치가 있는지 판단용).

- 최종 모델과 같은 설정(문자 n-gram (1,3), C=16, 특징 120,000개, 같은 입력 정리)으로
  학습 행의 25/50/75/100% 만 써서 학습하고, 검증 행(기존 val, 새 데이터 val)으로 잰다.
- 비율마다 뽑는 순서를 바꿔 3번 반복한다(100% 는 1번). 시험용 행은 쓰지 않는다.
- 지표: PR-AUC, 그리고 검증 정상 점수의 98% 분위수를 기준점으로 했을 때의 재현율·오탐률.
- 사용: python -X utf8 -I scripts/learning_curve.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score

import train_final as tf
import train_model as tm

OUT = tm.FINAL_ASSIGN.parent / "learning_curve.json"
FRACTIONS = [0.25, 0.5, 0.75, 1.0]
SEEDS = [0, 1, 2]


def main():
    t0 = time.time()
    sets = tf.load_sets()
    xtr_all = [tf.clean_final(c) for _, c, _ in sets["train"]]
    ytr_all = np.array([l for _, _, l in sets["train"]])
    vals = {
        name: ([tf.clean_final(c) for _, c, _ in sets[name]], np.array([l for _, _, l in sets[name]]))
        for name in ("orig_val", "lga_val")
    }
    print(f"학습 행 {len(ytr_all):,}개, 검증: 기존 {len(vals['orig_val'][1]):,} / 새 데이터 {len(vals['lga_val'][1]):,}")

    results = []
    for frac in FRACTIONS:
        runs = []
        for seed in (SEEDS if frac < 1.0 else [0]):
            rng = np.random.RandomState(seed)
            n = int(len(ytr_all) * frac)
            idx = rng.permutation(len(ytr_all))[:n]
            x = [xtr_all[i] for i in idx]
            y = ytr_all[idx]
            vec = TfidfVectorizer(analyzer="char", ngram_range=tf.NGRAM, lowercase=False,
                                  min_df=tf.MIN_DF, max_features=tf.MAX_FEATURES, sublinear_tf=True)
            a = vec.fit_transform(x)
            clf = LogisticRegression(C=tf.C, class_weight="balanced", solver="liblinear",
                                     max_iter=1000, random_state=0).fit(a, y)
            scores = {name: clf.decision_function(vec.transform(xv)) for name, (xv, _) in vals.items()}
            normals = np.concatenate([scores[name][vals[name][1] == 0] for name in vals])
            thr = float(np.quantile(normals, tf.HIGH_Q))
            run = {"seed": seed, "train_rows": int(n)}
            for name, (_, yv) in vals.items():
                s = scores[name]
                run[name] = {
                    "pr_auc": float(average_precision_score(yv, s)),
                    "recall": float((s[yv == 1] > thr).mean()),
                    "fpr": float((s[yv == 0] > thr).mean()),
                }
            runs.append(run)
        summary = {"fraction": frac, "train_rows": runs[0]["train_rows"], "runs": runs}
        for name in vals:
            for k in ("pr_auc", "recall", "fpr"):
                v = np.array([r[name][k] for r in runs])
                summary[f"{name}_{k}_mean"] = float(v.mean())
                summary[f"{name}_{k}_sd"] = float(v.std())
        results.append(summary)
        print(
            f"{int(frac * 100):3d}% ({summary['train_rows']:6,}행) | "
            f"기존: PR-AUC {summary['orig_val_pr_auc_mean']:.4f} 재현율 {summary['orig_val_recall_mean']:.3f} 오탐 {summary['orig_val_fpr_mean']:.3f} | "
            f"새: PR-AUC {summary['lga_val_pr_auc_mean']:.4f} 재현율 {summary['lga_val_recall_mean']:.3f} 오탐 {summary['lga_val_fpr_mean']:.3f}"
        )

    report = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "note": "학습 데이터 비율별 검증 성능(시험용 미사용). 기준점은 검증 정상 점수의 98% 분위수.",
        "config": {"ngram": list(tf.NGRAM), "C": tf.C, "max_features": tf.MAX_FEATURES, "min_df": tf.MIN_DF},
        "results": results,
        "seconds": round(time.time() - t0, 1),
    }
    OUT.write_text(json.dumps(tm.jsonable(report), ensure_ascii=False, indent=2), encoding="utf-8")
    print("저장:", OUT)


if __name__ == "__main__":
    main()
