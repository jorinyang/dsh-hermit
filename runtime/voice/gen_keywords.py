"""
gen_keywords.py — 生成 sherpa-onnx KWS keywords.txt（26 §8.1）。

用法：python gen_keywords.py
  词表源 = WORDS 列表（raw + boosting + threshold），输出 configs/kws-keywords.txt。
  改词/加别名：改 WORDS 后重跑本脚本。阈值调参结论由 sweep_kws.py 产出后回填。
"""
import sys
from pathlib import Path

import sherpa_onnx

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
TOKENS = REPO / "models" / "voice" / "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01" / "tokens.txt"
OUT = REPO / "configs" / "kws-keywords.txt"

# (raw, boosting, threshold)——sweep_kws.py 扫参结论（2026-08-20）：
#   小寄小寄 boost1.2/thr0.35 → 合成样本 7/8 唤醒（r+2 快速语样本 MISS，语速极值），误唤醒 0/h
#   小寄同学 / 小寄酱：主人 2026-08-20 追加（4/3 音节，小爱同学/小艺 同款结构），阈值随扫参定稿
#   单呼「小寄」已删除——2 音节词在 3.3M KWS 上无可用工作点（松则 TV 误唤醒 116/h，严则 0%）；
#   免唤醒窗/对话态本就不需要 KWS，idle 态统一「小寄小寄」。真机人声调优随 D4 实机验收。
WORDS = [
    ("小寄小寄", 1.2, 0.35),
    ("小寄同学", 1.2, 0.35),
    ("小寄酱", 1.2, 0.35),
]


def gen(words=None, out=None):
    words = words or WORDS
    out = out or OUT
    toks = sherpa_onnx.text2token([w for w, _, _ in words], str(TOKENS), tokens_type="ppinyin")
    lines = []
    for (raw, boost, thr), tk in zip(words, toks):
        lines.append(f"{' '.join(tk)} :{boost} #{thr} @{raw}")
    Path(out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[gen_keywords] {len(lines)} keywords -> {out}")
    for l in lines:
        print("  " + l)


if __name__ == "__main__":
    gen()
