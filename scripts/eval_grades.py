"""등급별 신뢰성: 저장된 시험 결과(test_rows.csv, 원문 없음)로 계산한다. 시스템은 다시 실행하지 않는다.

- 등급마다 '그 등급으로 표시된 메시지 중 실제 스미싱 비율'과 '스미싱·정상 각각이 그 등급에 간 비율'을 낸다.
- 신뢰구간: 그룹 단위 부트스트랩 95%.
- 주의: 실제 스미싱 비율은 데이터의 스미싱 비중(기존 약 32%, 새 데이터 약 58%)에 따라 달라진다.
- 사용: python -X utf8 -I scripts/eval_grades.py
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np

import train_model as tm

PROC = tm.FINAL_ASSIGN.parent
ROWS = PROC / "test_rows.csv"
OUT = PROC / "test_grade_reliability.json"
GRADES = ("high", "caution", "uncertain", "no_clear_signal")
BANDS = ("high", "medium", "low", "unreliable")
BOOT = 1000


def ppv_ci(y, mask, inv, n_groups, rng):
    if mask.sum() == 0:
        return None, None
    a = np.bincount(inv, weights=mask.astype(float), minlength=n_groups)
    b = np.bincount(inv, weights=(mask & (y == 1)).astype(float), minlength=n_groups)
    vals = []
    for _ in range(BOOT):
        idx = rng.integers(0, n_groups, n_groups)
        s = a[idx].sum()
        if s:
            vals.append(b[idx].sum() / s)
    return round(float(y[mask].mean()), 4), [round(float(np.percentile(vals, 2.5)), 4), round(float(np.percentile(vals, 97.5)), 4)]


def table(rows, col, levels, rng):
    y = np.array([int(r["label"]) for r in rows])
    groups, inv = np.unique(np.array([r["group"] for r in rows]), return_inverse=True)
    v = np.array([r[col] for r in rows])
    out = {}
    for lv in levels:
        m = v == lv
        ppv, ci = ppv_ci(y, m, inv, len(groups), rng)
        out[lv] = {
            "rows": int(m.sum()),
            "spam_share_within_level": ppv,
            "spam_share_ci95": ci,
            "share_of_all_spam": round(float(m[y == 1].mean()), 4),
            "share_of_all_normal": round(float(m[y == 0].mean()), 4),
        }
    return out


def main():
    rows = list(csv.DictReader(open(ROWS, encoding="utf-8", newline="")))
    rng = np.random.default_rng(0)
    report = {"source": "test_rows.csv (시험용 1회 평가 결과, 수정 전 버전)", "datasets": {}}
    for ds in ("orig", "lga"):
        sub = [r for r in rows if r["id"].startswith(ds + ":")]
        report["datasets"][ds] = {
            "spam_ratio": round(float(np.mean([int(r["label"]) for r in sub])), 4),
            "final_grade": table(sub, "final", GRADES, rng),
            "rules_only_grade": table(sub, "rule", GRADES, rng),
            "model_band": table(sub, "band", BANDS, rng),
        }
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    names = {"high": "높음", "caution": "주의", "uncertain": "판단어려움", "no_clear_signal": "신호없음",
             "medium": "보통", "low": "낮음", "unreliable": "판단불가"}
    for ds, d in report["datasets"].items():
        print(f"== {ds} (스미싱 비중 {d['spam_ratio']:.1%})")
        for key, title in (("final_grade", "최종 등급(규칙+모델)"), ("model_band", "모델 단계")):
            print(f"  [{title}]")
            for lv, t in d[key].items():
                if t["rows"]:
                    print(f"    {names[lv]:6s} {t['rows']:5d}행 | 그중 실제 스미싱 {t['spam_share_within_level']:.1%} {t['spam_share_ci95']}"
                          f" | 전체 스미싱의 {t['share_of_all_spam']:.1%}, 전체 정상의 {t['share_of_all_normal']:.1%}")
    print("저장:", OUT)


if __name__ == "__main__":
    main()
