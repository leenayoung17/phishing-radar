"""두 시험용 데이터로 최종 시스템(규칙 + 통계 모델)을 한 번만 평가한다.

- 기존 데이터 시험용(split_assignment.csv 의 test)과 새 데이터 시험용(lga_split.csv 의 test).
- 시험용 원문은 파일로 쓰지 않고 node 프로세스(eval-test.js)의 표준입력으로만 넘긴다.
- 학습 행과 비슷한(마스킹 문자 5-gram 코사인 0.85 이상) 시험 행을 표시하고,
  '전체'와 '비슷한 행 제외' 수치를 함께 보고한다(누수 점검).
- 신뢰구간: 그룹 단위 부트스트랩 95% (같은 그룹 문장은 함께 뽑는다).
- test_report.json 이 이미 있으면 실행하지 않는다(시험용을 다시 보며 고치는 것을 막기 위해).
- 사용: python -X utf8 -I scripts/eval_test.py <eval-test.js 경로>
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

import train_model as tm
import train_select2 as t2

PROC = tm.FINAL_ASSIGN.parent
LGA_SPLIT = PROC / "lga_split.csv"
REPORT = PROC / "test_report.json"
ROWS_OUT = PROC / "test_rows.csv"
FLAG = ("high", "caution")
GRADES = ("high", "caution", "uncertain", "no_clear_signal")
BOOT = 1000
SEED = 0


def load_test_rows():
    rows = []
    records, _, _, _ = tm.read_records()
    by_row = {rec_no: content for rec_no, content, _ in records}
    with open(tm.FINAL_ASSIGN, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["split"] == "test":
                i = int(r["source_row"])
                rows.append({"ds": "orig", "id": f"orig:{i}", "text": by_row[i], "label": int(r["label"]),
                             "has_url": int(r["has_url"]), "cls": "", "gid": f"o{r['group_id']}"})
    csv.field_size_limit(10**8)
    lga_all = list(csv.reader(io.StringIO(t2.LGA_CSV.read_bytes().decode("utf-8-sig"), newline="")))[1:]
    with open(LGA_SPLIT, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["split"] == "test":
                i = int(r["row"])
                rows.append({"ds": "lga", "id": f"lga:{i}", "text": lga_all[i][1], "label": int(r["label"]),
                             "has_url": int(r["has_url"]), "cls": r["cls"], "gid": f"l{r['group_id']}"})
    return rows


def load_train_texts():
    records, _, _, _ = tm.read_records()
    by_row = {rec_no: content for rec_no, content, _ in records}
    csv.field_size_limit(10**8)
    lga_all = list(csv.reader(io.StringIO(t2.LGA_CSV.read_bytes().decode("utf-8-sig"), newline="")))[1:]
    out = []
    with open(t2.ASSIGN_OUT, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            if r["role"] != "train":
                continue
            out.append(by_row[int(r["row"])] if r["dataset"] == "orig" else lga_all[int(r["row"])][1])
    return out


def mark_near_train(test_rows, train_texts):
    masked = [tm.mask_text(t) for t in train_texts] + [tm.mask_text(r["text"]) for r in test_rows]
    n_train = len(train_texts)
    pr, pc, ps, _, _, _ = tm.similarity_pairs(masked, 0.85, 0.05, 300, 10_000_000)
    train_keys = set(masked[:n_train])
    near = np.zeros(len(test_rows), dtype=bool)
    for a, b in zip(pr.tolist(), pc.tolist()):
        if a < n_train <= b:
            near[b - n_train] = True
    for j, r in enumerate(test_rows):
        if masked[n_train + j] in train_keys:
            near[j] = True
    return near


def group_arrays(gid):
    groups, inv = np.unique(np.array(gid), return_inverse=True)
    return len(groups), inv


def rate_ci(y, flag, inv, n_groups, rng):
    sp = np.bincount(inv, weights=(y == 1).astype(float), minlength=n_groups)
    spf = np.bincount(inv, weights=((y == 1) & flag).astype(float), minlength=n_groups)
    no = np.bincount(inv, weights=(y == 0).astype(float), minlength=n_groups)
    nof = np.bincount(inv, weights=((y == 0) & flag).astype(float), minlength=n_groups)
    rec, fpr = [], []
    for _ in range(BOOT):
        idx = rng.integers(0, n_groups, n_groups)
        a, b, c, d = sp[idx].sum(), spf[idx].sum(), no[idx].sum(), nof[idx].sum()
        rec.append(b / a if a else np.nan)
        fpr.append(d / c if c else np.nan)

    def ci(v):
        v = np.array(v)
        v = v[~np.isnan(v)]
        return [round(float(np.percentile(v, 2.5)), 4), round(float(np.percentile(v, 97.5)), 4)] if len(v) else None

    return {
        "recall": round(float(flag[y == 1].mean()), 4) if (y == 1).any() else None,
        "recall_ci95": ci(rec) if (y == 1).any() else None,
        "fpr": round(float(flag[y == 0].mean()), 4) if (y == 0).any() else None,
        "fpr_ci95": ci(fpr) if (y == 0).any() else None,
    }


def auc_ci(y, s, inv, n_groups, rng, iters=300):
    if len(set(y.tolist())) < 2:
        return None
    members = [[] for _ in range(n_groups)]
    for i, g in enumerate(inv.tolist()):
        members[g].append(i)
    members = [np.array(m) for m in members]
    vals = []
    for _ in range(iters):
        idx = np.concatenate([members[g] for g in rng.integers(0, n_groups, n_groups)])
        if len(set(y[idx].tolist())) == 2:
            vals.append(average_precision_score(y[idx], s[idx]))
    return {
        "pr_auc": round(float(average_precision_score(y, s)), 4),
        "pr_auc_ci95": [round(float(np.percentile(vals, 2.5)), 4), round(float(np.percentile(vals, 97.5)), 4)],
        "roc_auc": round(float(roc_auc_score(y, s)), 4),
    }


def summarize(sub, rng):
    y = np.array([r["label"] for r in sub])
    n_groups, inv = group_arrays([r["gid"] for r in sub])
    out = {"rows": int(len(y)), "spam": int(y.sum()), "normal": int((y == 0).sum()), "groups": int(n_groups)}
    for name, col in (("rules_only", "rule"), ("rules_plus_model", "final")):
        g = np.array([r[col] for r in sub])
        out[name] = {
            "caution_or_higher": rate_ci(y, np.isin(g, FLAG), inv, n_groups, rng),
            "high_only": rate_ci(y, g == "high", inv, n_groups, rng),
            "grade_counts": {
                "spam": {k: int(((g == k) & (y == 1)).sum()) for k in GRADES},
                "normal": {k: int(((g == k) & (y == 0)).sum()) for k in GRADES},
            },
        }
    band = np.array([r["band"] for r in sub])
    out["model_high_band"] = rate_ci(y, band == "high", inv, n_groups, rng)
    out["model_ranking"] = auc_ci(y, np.array([r["score"] for r in sub]), inv, n_groups, rng)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("eval_js")
    args = ap.parse_args()
    if REPORT.exists():
        raise SystemExit(f"{REPORT.name} 가 이미 있습니다. 시험용은 한 번만 평가합니다. 다시 실행하지 않습니다.")
    t0 = time.time()

    rows = load_test_rows()
    print(f"시험용: 기존 {sum(r['ds'] == 'orig' for r in rows):,}행, 새 데이터 {sum(r['ds'] == 'lga' for r in rows):,}행")
    near = mark_near_train(rows, load_train_texts())
    for r, nr in zip(rows, near.tolist()):
        r["near_train"] = bool(nr)

    payload = "\n".join(json.dumps({"id": r["id"], "text": r["text"]}, ensure_ascii=False) for r in rows) + "\n"
    proc = subprocess.run(["node", args.eval_js], input=payload, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise SystemExit(f"eval-test.js 실행 실패(코드 {proc.returncode}). 원문을 출력하지 않기 위해 오류 내용은 생략합니다.")
    results = {}
    for line in proc.stdout.splitlines():
        if line.strip():
            o = json.loads(line)
            results[o["id"]] = o
    if len(results) != len(rows):
        raise SystemExit(f"결과 수가 다릅니다: {len(results)} != {len(rows)}")
    for r in rows:
        r.update({k: results[r["id"]][k] for k in ("rule", "final", "text_grade", "url_level", "band", "score")})
    engine = results[rows[0]["id"]]["engine"]
    model_version = results[rows[0]["id"]]["model_version"]

    rng = np.random.default_rng(SEED)
    report = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "engine_version": engine,
        "model_version": model_version,
        "note": "시험용 한 번 평가. '주의 이상' = 높음 또는 주의. 신뢰구간은 그룹 단위 부트스트랩 95%.",
        "flag_definition": "caution_or_higher = grade in (high, caution)",
        "datasets": {},
    }
    for ds in ("orig", "lga"):
        sub = [r for r in rows if r["ds"] == ds]
        far = [r for r in sub if not r["near_train"]]
        entry = {
            "near_train_rows": int(sum(r["near_train"] for r in sub)),
            "all": summarize(sub, rng),
            "excluding_near_train": summarize(far, rng),
            "by_url": {
                ("URL있음" if u else "URL없음"): summarize([r for r in sub if r["has_url"] == u], rng)
                for u in (0, 1)
                if len({r["label"] for r in sub if r["has_url"] == u}) == 2
            },
        }
        if ds == "lga":
            entry["normal_by_class"] = {
                c: {
                    "rows": sum(1 for r in sub if r["cls"] == c),
                    "fpr_rules_only": round(float(np.mean([r["rule"] in FLAG for r in sub if r["cls"] == c])), 4),
                    "fpr_rules_plus_model": round(float(np.mean([r["final"] in FLAG for r in sub if r["cls"] == c])), 4),
                }
                for c in ("1", "3")
            }
        report["datasets"][ds] = entry
    report["seconds"] = round(time.time() - t0, 1)
    REPORT.write_text(json.dumps(tm.jsonable(report), ensure_ascii=False, indent=2), encoding="utf-8")

    with open(ROWS_OUT, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "label", "has_url", "cls", "group", "near_train", "rule", "final", "text_grade", "url_level", "band", "score"])
        for r in rows:
            w.writerow([r["id"], r["label"], r["has_url"], r["cls"], r["gid"], int(r["near_train"]), r["rule"], r["final"],
                        r["text_grade"], r["url_level"], r["band"], round(r["score"], 6)])

    def line(name, d):
        rc, rm = d["rules_only"]["caution_or_higher"], d["rules_plus_model"]["caution_or_higher"]
        mr = d["model_ranking"]
        print(f"  {name:16s} n={d['rows']:5d} | 규칙만: 재현 {rc['recall']:.3f} {rc['recall_ci95']} 오탐 {rc['fpr']:.3f} {rc['fpr_ci95']}"
              f" | 규칙+모델: 재현 {rm['recall']:.3f} {rm['recall_ci95']} 오탐 {rm['fpr']:.3f} {rm['fpr_ci95']}"
              f" | 모델 PR-AUC {mr['pr_auc'] if mr else '-'}")

    for ds, e in report["datasets"].items():
        print(f"== {ds} (학습과 비슷한 시험 행 {e['near_train_rows']}개)")
        line("전체", e["all"])
        line("비슷한 행 제외", e["excluding_near_train"])
        for k, v in e["by_url"].items():
            line(k, v)
        if "normal_by_class" in e:
            print("  정상 클래스별 오탐:", e["normal_by_class"])
    print("보고서:", REPORT)


if __name__ == "__main__":
    main()
