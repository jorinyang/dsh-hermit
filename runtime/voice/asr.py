"""
asr.py — 真件流式 ASR 流水线（MVP-1 M1-A D2，26 契约 C.1）。

选型（D2 实证 2026-08-20，见 26 §8.2）：
  - 运行时 sherpa-onnx 1.13.6（pip；Win/Mac/Linux；CPU 实时）
  - 模型 FunASR streaming-paraformer 中英双语（流式 partial + final）
  - 声学端点 = recognizer 内置 endpoint 规则（rule2 尾静音 ≥ acoustic_ms）
  - silero VAD 不进 ASR 主环（D3 起用于唤醒门控/barge-in；模型已备）
  - Fun-ASR-Nano 离线档：sherpa 1.13.6 原生 OfflineRecognizer.from_funasr_nano，
    作为 final 质量增强的后续选项（备查，D2 不上）

事件流（12 §一「全程流式」）：
  feed(16k mono 帧) → {type:start} 首个非空识别结果
                    → {type:partial, text} 文本变化时
                    → {type:final, text, speech_ms} is_endpoint 触发（rule2 尾静音）
非线程安全——所有 feed 调用须在同一线程/任务串行。
"""
from pathlib import Path

import numpy as np
import sherpa_onnx

MODEL_DIR = "sherpa-onnx-streaming-paraformer-bilingual-zh-en"


def _pick(onnx_name: str) -> str:
    """优先 int8（CPU 低延迟），缺则回退 fp32。"""
    return onnx_name.replace(".onnx", ".int8.onnx")


class AsrPipeline:
    """流式 paraformer 封装。"""

    def __init__(self, models_dir, acoustic_ms: int = 600, sample_rate: int = 16000):
        self.models_dir = str(models_dir)
        self.sample_rate = sample_rate
        self.acoustic_ms = max(200, int(acoustic_ms))
        self.semantic_mode = False      # 语义端点旁路（12 §二 语义层）：声学端点后保持，等 accept/extend
        self.semantic_wait_ms = 1200
        self._check_models()
        self._build()
        self._new_turn()

    def _model_paths(self):
        d = Path(self.models_dir) / MODEL_DIR
        enc = d / _pick("encoder.onnx")
        dec = d / _pick("decoder.onnx")
        if not enc.exists():
            enc = d / "encoder.onnx"
        if not dec.exists():
            dec = d / "decoder.onnx"
        return enc, dec, d / "tokens.txt"

    def _check_models(self):
        enc, dec, tok = self._model_paths()
        missing = [str(p) for p in (enc, dec, tok) if not p.exists()]
        if missing:
            raise FileNotFoundError("ASR 模型不全: " + "; ".join(missing))

    def _build(self):
        enc, dec, tok = self._model_paths()
        self.recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(tok), encoder=str(enc), decoder=str(dec),
            num_threads=3, sample_rate=self.sample_rate, feature_dim=80,
            enable_endpoint_detection=True,
            # rule2：说话后尾静音 ≥ acoustic_ms → 端点（12 §二 声学层阈值）
            rule2_min_trailing_silence=self.acoustic_ms / 1000.0,
            # rule3：单轮话语硬上限 60s（防失控；超长强切）
            rule3_min_utterance_length=60.0,
            decoding_method="greedy_search", provider="cpu",
        )

    def _new_turn(self):
        self.speech_ms = 0
        self._had_partial = False
        self._last_partial = ""
        self._ep_emitted = False   # 语义模式：本轮是否已发声学端点 cue
        self.stream = self.recognizer.create_stream()

    def set_acoustic_ms(self, ms: int):
        """端点阈值热更（voice_config 工具 → endpoint.set → 此处）。轻量重建，mmap 不重载。"""
        self.acoustic_ms = max(200, int(ms))
        self._build()
        self._new_turn()

    def set_semantic(self, mode: bool, wait_ms: int = 1200):
        """语义端点旁路开关（DSH 插件经 endpoint.set 下发）。关=声学端点即 finalize（D2 行为）。"""
        self.semantic_mode = bool(mode)
        self.semantic_wait_ms = max(600, int(wait_ms))

    def feed(self, chunk: np.ndarray):
        """喂 16k mono 帧（int16 或 float32）。返回事件 dict 或 None。"""
        if chunk.dtype != np.float32:
            chunk = chunk.astype(np.float32) / 32768.0
        if not chunk.size:
            return None
        self.stream.accept_waveform(self.sample_rate, chunk)
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        self.speech_ms += int(len(chunk) * 1000 / self.sample_rate)

        text = self.recognizer.get_result(self.stream) or ""
        ev = None
        if text and not self._had_partial:
            self._had_partial = True
            ev = {"type": "start"}
        elif text and text != self._last_partial:
            self._last_partial = text
            ev = {"type": "partial", "text": text}

        if self.recognizer.is_endpoint(self.stream):
            if self.semantic_mode:
                # 声学端点 cue：保持（不 finalize），等 DSH 语义复判（endpoint.accept/extend）或超时
                if not self._ep_emitted:
                    self._ep_emitted = True
                    return {"type": "endpoint_acoustic", "text": text.strip(), "pause_ms": self.acoustic_ms}
                return ev
            final = (self.recognizer.get_result(self.stream) or "").strip()
            ms = self.speech_ms
            self._new_turn()
            return {"type": "final", "text": final, "speech_ms": ms}
        return ev

    def force_final(self):
        """强制收尾（语义端点旁路「说完了」判定用，12 §二）。"""
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        text = (self.recognizer.get_result(self.stream) or "").strip()
        if not text:
            self._new_turn()
            return None
        ms = self.speech_ms
        self._new_turn()
        return {"type": "final", "text": text, "speech_ms": ms}

    def reset(self):
        self._new_turn()
