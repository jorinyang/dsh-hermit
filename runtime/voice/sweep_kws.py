"""
sweep_kws.py — KWS 阈值扫参（12 §五.2 方法定义集 + 26 §8.1 对策落地）。

对 samples/pos（应唤醒）与 samples/neg（不应唤醒）回放，扫 boosting×threshold 网格：
  - 正样本唤醒率（目标 ≥95%）
  - 负样本误唤醒（目标 ≤1 次/小时，按负样本总时长折算）
产出 sweep_report.md 并把推荐参数回填 configs/kws-keywords.txt（经 gen_keywords.gen）。

用法：python sweep_kws.py [--write]
"""
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from kws import KwsGate, KWS_MODEL_DIR  # noqa: E402
from audio_source import load_wav_16k  # noqa: E402
import gen_keywords  # noqa: E402

REPO = HERE.parent.parent
MODELS = REPO / "models" / "voice"
SAMPLES = HERE / "samples"

GRID = {
    "小寄小寄": {"boost": [1.0, 1.2, 1.5], "thr": [0.25, 0.3, 0.35, 0.4]},
    "小寄": {"boost": [1.0, 1.5, 2.0, 2.5], "thr": [0.2, 0.25, 0.3, 0.35, 0.4, 0.5]},
}
POS_BY_KEYWORD = {"小寄小寄": "x2_", "小寄": "x1_"}


def hit_count(gate: KwsGate, wav_path: Path) -> int:
    gate.reset()
    samples, _ = load_wav_16k(wav_path)
    hits = 0
    CHUNK = 512
    for i in range(0, len(samples), CHUNK):
        ev = gate.feed(samples[i:i + CHUNK])
        if ev and ev["type"] == "wake":
            hits += 1
    return hits


def sweep():
    pos = sorted(SAMPLES.glob("pos/*.wav"))
    neg = sorted(SAMPLES.glob("neg/*.wav"))
    neg_secs = sum(len(load_wav_16k(p)[0]) / 16000 for p in neg)
    print(f"样本：pos={len(pos)} neg={len(neg)}（负样本总时长 {neg_secs:.0f}s）\n")
    report = ["# KWS 扫参报告", f"> {time.strftime('%Y-%m-%d %H:%M')} | 样本 pos={len(pos)} neg={len(neg)}（{neg_secs:.0f}s）| 模型 {KWS_MODEL_DIR}", ""]
    chosen = {}

    for kw, grid in GRID.items():
        pos_files = [p for p in pos if p.name.startswith(POS_BY_KEYWORD[kw])]
        print(f"===== {kw}（正样本 {len(pos_files)} 个）=====")
        report.append(f"## {kw}（正样本 {len(pos_files)} 个）")
        report.append("| boosting | threshold | 唤醒率 | 误唤醒/h |")
        report.append("|---|---|---|---|")
        best = None
        for boost in grid["boost"]:
            for thr in grid["thr"]:
                tmp = HERE / "samples" / "_sweep_keywords.txt"
                gen_keywords.gen([(kw, boost, thr)], tmp)
                gate = KwsGate(MODELS, tmp)
                hits = sum(1 for p in pos_files if hit_count(gate, p) > 0)
                wake_rate = hits / len(pos_files) if pos_files else 0
                false_fires = sum(hit_count(gate, p) for p in neg)
                ff_per_h = false_fires * 3600 / neg_secs if neg_secs else 0
                mark = "✅" if (wake_rate >= 0.95 and ff_per_h <= 1.0) else ""
                line = f"| {boost} | {thr} | {wake_rate:.0%} | {ff_per_h:.1f} | {mark}"
                print(f"  boost={boost} thr={thr}  唤醒 {wake_rate:.0%}  误唤醒 {ff_per_h:.1f}/h {mark}")
                report.append(line)
                # 选优：先误唤醒达标，再唤醒率最高，再阈值宽松
                if ff_per_h <= 1.0 and (best is None or wake_rate > best[0] or (wake_rate == best[0] and thr < best[2])):
                    best = (wake_rate, boost, thr, ff_per_h)
        if best:
            chosen[kw] = (best[1], best[2])
            print(f"  → 推荐 boost={best[1]} thr={best[2]}（唤醒 {best[0]:.0%}，误唤醒 {best[3]:.1f}/h）")
            report.append(f"> **推荐**：boosting={best[1]} threshold={best[2]}（唤醒 {best[0]:.0%} / 误唤醒 {best[3]:.1f} 次/h）")
        else:
            print("  → 网格内无达标点，需扩网格或换词")
            report.append("> ⚠️ 网格内无达标点")
        report.append("")
    return chosen, report


if __name__ == "__main__":
    chosen, report = sweep()
    (SAMPLES / "sweep_report.md").write_text("\n".join(report), encoding="utf-8")
    print(f"\n报告 -> {SAMPLES / 'sweep_report.md'}")
    if "--write" in sys.argv and chosen:
        words = [(kw, b, t) for kw, (b, t) in chosen.items()]
        gen_keywords.gen(words)
        print("已回填 configs/kws-keywords.txt")
