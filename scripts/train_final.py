"""최종 모델 학습과 내보내기.

- 설정: train_select2.py 의 사전 기준으로 고른 값(문자 n-gram (1,3), C=16, 특징 120,000개).
- 학습: 기존 데이터 train + 새 데이터(lgaidataset) 학습분(combined_assignment.csv 의 train).
- 검증 행(기존 val, 새 데이터 val)은 '높음/보통' 기준점을 정하는 데만 쓴다. 두 시험용은 쓰지 않는다.
- IDF·가중치를 소수 6자리로 반올림한 뒤 그 값으로 점수를 다시 계산한다(TS 와 정확히 맞추기 위해).
- sklearn 결과와 별도로 직접 구현한 계산(TS 와 같은 방식)이 일치하는지도 확인한다.
- 출력:
  src/lib/analysis/model/model.json            모델
  src/lib/analysis/model/parity-fixtures.json  직접 쓴 문장의 기대값(데이터셋 문장 아님)
  important/processed/parity_dev.jsonl         학습·검증 행 일부의 기대값(git 제외)
  important/processed/final_model_report.json
- 사용: python -X utf8 -I scripts/train_final.py [--overwrite]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score

import train_model as tm
import train_select2 as t2

MODEL_DIR = tm.ROOT / "src" / "lib" / "analysis" / "model"
MODEL_JSON = MODEL_DIR / "model.json"
FIXTURES_JSON = MODEL_DIR / "parity-fixtures.json"
PROC = tm.FINAL_ASSIGN.parent
PARITY_DEV = PROC / "parity_dev.jsonl"
REPORT = PROC / "final_model_report.json"

MODEL_VERSION = "tfidf-lr-0.2.0"
NGRAM = (1, 3)
C = 16.0
MAX_FEATURES = 120000
MIN_DF = 3
MIN_CHARS = 10
DECIMALS = 6
HIGH_Q = 0.98    # 검증 정상 점수의 98% 분위수 초과 = 높음
MEDIUM_Q = 0.90  # 90% 분위수 초과 = 보통

# 직접 쓴 시험 문장(데이터셋 문장 아님). 정규화가 까다로운 글자도 일부러 넣었다.
HAND_WRITTEN = [
    "엄마 나 폰이 고장나서 친구 폰으로 문자해. 급하게 300만원만 이 계좌로 송금해줘. 110-123-456789",
    "엄마 핸드폰 액정이 깨져서 번호 바뀌었어. 카톡 안 되니까 문상 30만원 사서 핀번호 보내줘",
    "[국민은행] 고객님 계좌가 보안 위반으로 정지되었습니다. 즉시 http://kb-secure-login.xyz/verify 접속 후 인증번호와 계좌 비밀번호를 입력하세요",
    "서울중앙지검 수사관입니다. 고객님 명의 계좌가 범죄에 연루되어 조사가 필요합니다. 팀뷰어 앱을 설치하고 연결해 주세요",
    "[CJ대한통운] 주소 불일치로 배송이 보류되었습니다. 24시간 내에 확인하지 않으면 반송됩니다 bit.ly/3xAbC12",
    "고객님은 저금리 대환대출 대상자입니다. 기존 대출 상환 후 지정 계좌로 송금하시면 즉시 승인됩니다",
    "엄 마 나 폰 고 장 나 서 급 하 게 돈 좀 송 금 해 줘 계 좌 알 려 줄 게",
    "엄마 나 돈 좀 보내줘",
    "[Web발신] [신한은행] 인증번호 482915 입니다. 타인에게 절대 알려주지 마세요.",
    "[KB국민] 11/05 14:22 입금 50,000원 홍*동 잔액 1,234,567원 (계좌 123456-**-****)",
    "[쿠팡] 주문하신 상품이 오늘 오후 배송 예정입니다. 문 앞에 두고 갑니다.",
    "[농협] 금융기관은 전화나 문자로 인증번호, 비밀번호를 요구하지 않습니다. 보이스피싱에 주의하세요.",
    "오늘 저녁에 같이 밥 먹을래? 6시에 강남역에서 보자",
    "내일 회의 자료는 https://www.naver.com/ 에서 확인 가능합니다. 참고해 주세요.",
    "엄마 오늘 저녁 뭐 먹어? 나 6시쯤 들어갈게",
    "네 알겠어요",
    "[국제발신]\n정통바카라\n우카계열\n첫→24비OK\n가→30000쿺\n입→100000출\n\ngh③7c.COm",
    "[국외발신]\n[코인원]\n고객님계정이\n해외IP에서\n로그인되였습니다.해외IP차단해주세요.\nwww.coinonve.com",
    "문의 사항은 hong.gildong@gmail.com 으로 보내주시면 확인 후 답변드리겠습니다.",
    "카드번호와 인증번호를 입력해 주세요 http://pay-check.xyz/a www.example.co.kr/path?x=1, 끝.",
    "ＨＴＴＰＳ://ＥＸＡＭＰＬＥ.ＣＯＭ/ａｂｃ 전각 문자와 ①②③ 숫자, ㈜회사, ＊별표＊",
    "😀😀 엄마 나 폰 고장났어 \t\t 탭과   여러   공백 　 전각공백 줄바꿈\r\n포함 👍🏽",
    "ⓩⓟⓩ22.comZ-CASINO~ 금일 대박나세요~ 𝐁𝐎𝐍𝐔𝐒 Ⅻ ㎏ ﬁ é",
    "  가나다라\u0085\u0085마바사 아자차\x1c\x1d카타파하 ",
    "a+www.example.com@gmail.com 과 john.co+tag@gmail.com 은 이메일입니다",
    "가" * 40,
    "ab",
    "",
    "   ",
    "한글과 English가 섞인 Mixed CASE 문장 123-456 입니다 (광고) 무료수신거부 080-123-4567",
]

PY_WS2 = re.compile(r"\s\s+")
# 이메일 주소: 개인정보이고, 링크만 지우면 '.com' 조각이 남아 스팸 신호로 잘못 학습되므로 지운다.
_EMAIL_RE = re.compile("[" + tm._LOCAL + "]+@[a-z0-9-]+(?:\\.[a-z0-9-]+)+")


def clean_final(content: str) -> str:
    """최종 모델의 입력 정리. TS(model.ts 의 cleanForModel)와 1:1 로 같아야 한다.
    train_select2.clean 에 이메일 제거를 더했다(선택 단계 이후 직접 쓴 문장 점검에서 발견한 문제 수정)."""
    t = tm.nfkc_lower(content).replace("*", "")
    t = _EMAIL_RE.sub(" ", t)
    t = tm._URL_RE.sub(" ", t)
    t = tm._BARE_RE.sub(" ", t)
    t = tm._DIGIT_RE.sub("0", t)
    return tm.collapse_ws(t)


def load_sets():
    """combined_assignment.csv 의 train/val 행만 불러온다(시험용 행은 이 파일에 없다)."""
    if not t2.ASSIGN_OUT.exists():
        raise SystemExit("combined_assignment.csv 가 없습니다. train_select2.py 를 먼저 실행하세요.")
    records, _, _, _ = tm.read_records()
    by_row = {rec_no: (content, label) for rec_no, content, label in records}
    csv.field_size_limit(10**8)
    lga_all = list(csv.reader(io.StringIO(t2.LGA_CSV.read_bytes().decode("utf-8-sig"), newline="")))[1:]
    sets = {"train": [], "orig_val": [], "lga_val": []}
    with open(t2.ASSIGN_OUT, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            row, role = int(r["row"]), r["role"]
            if r["dataset"] == "orig":
                content, label = by_row[row]
                key = "train" if role == "train" else "orig_val"
            else:
                if role not in ("train", "val"):
                    continue
                _, content, cls = lga_all[row]
                label = 1 if cls == "2" else 0
                key = "train" if role == "train" else "lga_val"
            sets[key].append((f"{r['dataset']}:{row}", content, int(label)))
    return sets


def manual_score(cleaned, index, idf, coef, intercept):
    """TS 구현과 같은 방식의 직접 계산(검증용)."""
    text = PY_WS2.sub(" ", cleaned)
    counts = Counter()
    length = len(text)
    for n in range(NGRAM[0], NGRAM[1] + 1):
        for i in range(length - n + 1):
            j = index.get(text[i:i + n])
            if j is not None:
                counts[j] += 1
    if not counts:
        return float(intercept)
    w = {j: (1.0 + math.log(c)) * idf[j] for j, c in counts.items()}
    norm = math.sqrt(sum(v * v for v in w.values()))
    return float(intercept) + sum(v * coef[j] for j, v in w.items()) / norm


def band_of(cleaned, score, thr_high, thr_medium):
    if len(cleaned) < MIN_CHARS:
        return "unreliable"
    if score > thr_high:
        return "high"
    if score > thr_medium:
        return "medium"
    return "low"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()
    for p in (MODEL_JSON, FIXTURES_JSON, PARITY_DEV, REPORT):
        if p.exists() and not args.overwrite:
            raise SystemExit(f"{p.name} 가 이미 있습니다. 덮어쓰려면 --overwrite 를 붙이세요.")
    sel = json.loads(t2.REPORT.read_text(encoding="utf-8"))["best"]
    if (tuple(sel["ngram"]), float(sel["C"]), int(sel["max_features"])) != (NGRAM, C, MAX_FEATURES):
        raise SystemExit(f"선택 보고서의 설정 {sel} 과 이 스크립트의 설정이 다릅니다. 중단합니다.")
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    sets = load_sets()
    xtr = [clean_final(c) for _, c, _ in sets["train"]]
    ytr = np.array([l for _, _, l in sets["train"]])
    print(f"학습 {len(ytr):,}행(스미싱 {int(ytr.sum()):,}), 기존 검증 {len(sets['orig_val']):,}행, 새 검증 {len(sets['lga_val']):,}행")

    vec = TfidfVectorizer(
        analyzer="char", ngram_range=NGRAM, lowercase=False,
        min_df=MIN_DF, max_features=MAX_FEATURES, sublinear_tf=True,
    )
    a = vec.fit_transform(xtr)
    clf = LogisticRegression(
        C=C, class_weight="balanced", solver="liblinear", max_iter=1000, random_state=0,
    ).fit(a, ytr)

    # 반올림한 값으로 교체한다. 이후 모든 점수는 이 값으로 계산한다.
    vec.idf_ = np.round(vec.idf_.astype(np.float64), DECIMALS)
    clf.coef_ = np.round(clf.coef_.astype(np.float64), DECIMALS)
    clf.intercept_ = np.round(clf.intercept_.astype(np.float64), DECIMALS)

    vocab = [None] * len(vec.vocabulary_)
    for term, idx in vec.vocabulary_.items():
        vocab[idx] = term
    assert all(v is not None for v in vocab)
    index = {t: i for i, t in enumerate(vocab)}
    idf = [float(x) for x in vec.idf_]
    coef = [float(x) for x in clf.coef_[0]]
    intercept = float(clf.intercept_[0])

    def sk_scores(contents):
        cleaned = [clean_final(c) for c in contents]
        return cleaned, [float(s) for s in clf.decision_function(vec.transform(cleaned))]

    # 기준점: 두 검증셋 정상 점수를 합쳐 분위수로 정한다.
    val = {}
    for name in ("orig_val", "lga_val"):
        _, s = sk_scores([c for _, c, _ in sets[name]])
        val[name] = (np.array(s), np.array([l for _, _, l in sets[name]]))
    normals = np.concatenate([s[y == 0] for s, y in val.values()])
    # 분위수는 실제 점수 하나와 정확히 같을 수 있다(같은 틀의 문장이 같은 점수를 받음).
    # 동점이면 TS 와 경계 판정이 갈리므로 소수 6자리로 '올림'해서, 동점 묶음은 기준점 아래에 두고
    # 두 언어 모두 같은 판정을 내리게 한다.
    scale = 10 ** DECIMALS
    thr_high = math.ceil(float(np.quantile(normals, HIGH_Q)) * scale) / scale
    thr_medium = math.ceil(float(np.quantile(normals, MEDIUM_Q)) * scale) / scale

    val_stats = {}
    for name, (s, y) in val.items():
        val_stats[name] = {
            "rows": int(len(y)), "spam": int(y.sum()),
            "pr_auc": float(average_precision_score(y, s)),
            "high": {"recall": float((s[y == 1] > thr_high).mean()), "fpr": float((s[y == 0] > thr_high).mean())},
            "medium_or_higher": {"recall": float((s[y == 1] > thr_medium).mean()), "fpr": float((s[y == 0] > thr_medium).mean())},
        }
        print(f"[{name}] PR-AUC {val_stats[name]['pr_auc']:.3f} | 높음: 재현 {val_stats[name]['high']['recall']:.3f} 오탐 {val_stats[name]['high']['fpr']:.3f}")

    bundle = {
        "version": MODEL_VERSION,
        "note": "참고 신호용 통계 모델. 피싱 확률이 아니며, 학습 데이터에 있던 유형을 알아보는 용도라 새 수법에는 약할 수 있다.",
        "normalization": "NFKC, 영문 A-Z 소문자, '*' 제거, 이메일 제거, URL 제거(자리표시 없음), 숫자 0, 공백 정리",
        "ngram": list(NGRAM),
        "min_chars": MIN_CHARS,
        "thresholds": {"high": thr_high, "medium": thr_medium},
        "intercept": intercept,
        "vocab": vocab,
        "idf": idf,
        "coef": coef,
    }
    MODEL_JSON.write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 직접 쓴 문장 기대값 + 직접 계산과 sklearn 일치 확인
    cleaned, scores = sk_scores(HAND_WRITTEN)
    max_gap = 0.0
    fixtures = []
    for i, (inp, c, s) in enumerate(zip(HAND_WRITTEN, cleaned, scores)):
        m = manual_score(c, index, idf, coef, intercept)
        max_gap = max(max_gap, abs(m - s))
        fixtures.append({"id": f"hand:{i}", "input": inp, "cleaned": c, "score": s, "band": band_of(c, s, thr_high, thr_medium)})
    FIXTURES_JSON.write_text(json.dumps(fixtures, ensure_ascii=False, indent=1), encoding="utf-8")

    pool = sets["train"] + sets["orig_val"] + sets["lga_val"]
    pick = np.random.RandomState(0).choice(len(pool), size=1500, replace=False)
    chosen = [pool[int(i)] for i in pick]
    cl, sc = sk_scores([c for _, c, _ in chosen])
    with open(PARITY_DEV, "w", encoding="utf-8") as f:
        for (rid, content, _), c, s in zip(chosen, cl, sc):
            m = manual_score(c, index, idf, coef, intercept)
            max_gap = max(max_gap, abs(m - s))
            f.write(json.dumps({"id": rid, "input": content, "cleaned": c, "score": s, "band": band_of(c, s, thr_high, thr_medium)}, ensure_ascii=False) + "\n")
    if max_gap > 1e-9:
        raise SystemExit(f"직접 계산과 sklearn 점수가 다릅니다(최대 차이 {max_gap}). 중단합니다.")

    report = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model_version": MODEL_VERSION,
        "config": {"ngram": list(NGRAM), "C": C, "max_features": MAX_FEATURES, "min_df": MIN_DF, "url": "remove", "asterisk": "remove", "email": "remove"},
        "cleaning_change_note": "선택 단계(train_select2) 이후 이메일 제거를 추가했다. 직접 쓴 정상 문장의 이메일이 '높음'으로 나온 문제 때문이다.",
        "rows": {"train": int(len(ytr)), "orig_val": len(sets["orig_val"]), "lga_val": len(sets["lga_val"]), "test_read": 0},
        "thresholds": {"high": thr_high, "medium": thr_medium, "meaning": "두 검증셋 정상 점수의 98%/90% 분위수"},
        "val_stats": val_stats,
        "manual_vs_sklearn_max_gap": max_gap,
        "model_json_bytes": MODEL_JSON.stat().st_size,
        "features": len(vocab),
        "seconds": round(time.time() - t0, 1),
    }
    REPORT.write_text(json.dumps(tm.jsonable(report), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"모델 {MODEL_JSON.stat().st_size / 1e6:.2f} MB, 특징 {len(vocab):,}개, 직접계산-sklearn 최대 차이 {max_gap:.2e}")
    print("직접 쓴 문장 점수(띠):")
    for fx in fixtures:
        print(f"  {fx['id']:8s} {fx['score']:7.2f} {fx['band']}")


if __name__ == "__main__":
    main()
