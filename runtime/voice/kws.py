"""
kws.py — 唤醒门控（M1-A D3，26 §8.1 sherpa-onnx 开放词表 KWS 落地）。

职责（12 §五 + 26 §C.3 引擎半边）：
  - idle 态音频只过 KeywordSpotter（CPU 级，ASR 不吃电）
  - 命中关键词 → {type:wake, keyword}，上层负责开免唤醒窗并放行 ASR
  - 模型：sherpa-onnx-kws-zipformer-wenetspeech-3.3M（int8 优先）
  - 词表：configs/kws-keywords.txt（gen_keywords.py 生成；逐词 boosting/threshold）

注意：get_result 命中即返回关键词原文（@raw），不暴露置信度；
唤醒率/误唤醒率由 sweep_kws.py 用正负样本回放实测（12 §五.2 方法定义集）。
"""
from pathlib import Path

import numpy as np
import sherpa_onnx

KWS_MODEL_DIR = "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
STEM = "epoch-99-avg-1-chunk-16-left-64"


class KwsGate:
    def __init__(self, models_dir, keywords_file, sample_rate: int = 16000):
        d = Path(models_dir) / KWS_MODEL_DIR

        def pick(name: str) -> Path:
            p = d / name.replace(".onnx", ".int8.onnx")
            return p if p.exists() else d / name

        enc = pick(f"encoder-{STEM}.onnx")
        dec = pick(f"decoder-{STEM}.onnx")
        join = pick(f"joiner-{STEM}.onnx")
        tok = d / "tokens.txt"
        kw = Path(keywords_file)
        for p in (enc, dec, join, tok, kw):
            if not p.exists():
                raise FileNotFoundError(f"KWS 缺件: {p}")

        self.spotter = sherpa_onnx.KeywordSpotter(
            tokens=str(tok), encoder=str(enc), decoder=str(dec), joiner=str(join),
            keywords_file=str(kw),
            num_threads=2, sample_rate=sample_rate, feature_dim=80,
            max_active_paths=4, provider="cpu",
        )
        self.sample_rate = sample_rate
        self.stream = self.spotter.create_stream()

    def feed(self, chunk: np.ndarray):
        """喂 16k mono 帧。命中返回 {'type':'wake','keyword':原文}，否则 None。"""
        if chunk.dtype != np.float32:
            chunk = chunk.astype(np.float32) / 32768.0
        if not chunk.size:
            return None
        self.stream.accept_waveform(self.sample_rate, chunk)
        while self.spotter.is_ready(self.stream):
            self.spotter.decode_stream(self.stream)
        r = self.spotter.get_result(self.stream)
        if r:
            self.spotter.reset_stream(self.stream)
            return {"type": "wake", "keyword": str(r).strip()}
        return None

    def reset(self):
        self.spotter.reset_stream(self.stream)
