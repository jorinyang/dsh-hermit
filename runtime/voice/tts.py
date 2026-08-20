"""
tts.py — 真件 TTS 引擎（M1-A D4，26 契约 C.1）。

选型（D4 实证 2026-08-20，见 26 §8.2 补充）：
  - 运行时 sherpa-onnx OfflineTts（与 ASR/KWS 同库，一依赖通吃）
  - 模型 kokoro-multi-lang-v1_0（中文多音色；02 兜底 Kokoro-82M 路线）
  - 决策点 1 拍板：官方预设音色先行（voice 可配置，克隆后续）
  - Qwen3-TTS 不在 sherpa 1.13.6 支持列表，暂缓（见 26 §8.2 记录）

合成语义：整句合成（OfflineTts 非流式解码），产出 float32 PCM（kokoro 24kHz）；
「流式首包」近似 = 合成耗时 + 播放起播，first_packet_ms 实测上报。
"""
from pathlib import Path

import numpy as np
import sherpa_onnx

KOKORO_DIR = "kokoro-multi-lang-v1_0"

# kokoro-multi-lang-v1_0 中文音色 name→sid（据 sherpa 文档布局：32 个英语音色在前，zh 块 32..43）。
# ⚠️ 待实机听感校准：ASR 回环已证 53 音色全会说中文（lang=zh 决定发音），音色差异是听感问题，
# 无法离线定夺；主人 D4 实机听一遍后回填。sid 偏移如有出入，用 voice_sid 直接覆盖。
ZH_VOICE_SID = {
    "zf_xiaobei": 32, "zf_xiaoni": 33, "zf_sijing": 34, "zf_sisheng": 35,
    "zf_xiaoxiao": 36, "zf_xiaoyi": 37, "zf_xiaoxuan": 38,
    "zm_yunjian": 39, "zm_yunxi": 40, "zm_yunjie": 41, "zm_yunhao": 42, "zm_yunyang": 43,
}
DEFAULT_VOICE = "zf_xiaoni"


class TtsEngine:
    def __init__(self, models_dir, voice: str = "zf_xiaoni", sample_rate: int | None = None):
        d = Path(models_dir) / KOKORO_DIR

        def pick(*names):
            for n in names:
                if (d / n).exists():
                    return str(d / n)
            return None

        model = pick("model.int8.onnx", "model.onnx")
        tokens = pick("tokens.txt")
        voices = pick("voices.bin")
        lexicon = pick("lexicon-zh.txt", "lexicon.txt")
        data_dir = str(d)                       # 含 espeak-ng-data/（非中文音素化用）
        dict_dir = str(d / "dict") if (d / "dict").is_dir() else ""
        for name, p in (("model", model), ("tokens", tokens), ("voices", voices), ("lexicon", lexicon)):
            if not p:
                raise FileNotFoundError(f"TTS 缺件 {name}: {d}")

        kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=model, voices=voices, tokens=tokens, lexicon=lexicon,
            data_dir=data_dir, dict_dir=dict_dir, lang="zh",
        )
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=2, provider="cpu"),
            max_num_sentences=1,
        )
        self.tts = sherpa_onnx.OfflineTts(config)
        self.sample_rate = sample_rate or self.tts.sample_rate
        self.num_speakers = self.tts.num_speakers
        self.set_voice(voice)

    def set_voice(self, voice):
        """voice 可为音色名（zf_xiaoni）或数字 sid。未知名回退默认音色。"""
        if isinstance(voice, int) or (isinstance(voice, str) and voice.strip().isdigit()):
            self.sid = int(voice)
        elif voice in ZH_VOICE_SID:
            self.sid = ZH_VOICE_SID[voice]
        else:
            self.sid = ZH_VOICE_SID.get(DEFAULT_VOICE, 0)
            print(f"[tts] 未知音色 {voice}，回退 {DEFAULT_VOICE}(sid={self.sid})", flush=True)
        self.voice = voice if isinstance(voice, str) else f"sid{self.sid}"

    def synthesize(self, text: str, speed: float = 1.0) -> np.ndarray:
        """整句合成 → float32 PCM（sample_rate 采样率）。"""
        result = self.tts.generate(text, sid=self.sid, speed=speed)
        # sherpa 1.13.6: generate 返回 GeneratedAudio{samples: list[float], sample_rate}
        self.sample_rate = int(getattr(result, "sample_rate", self.sample_rate))
        return np.asarray(result.samples, dtype=np.float32)
