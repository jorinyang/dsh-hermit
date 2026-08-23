"""
tts.py — 真件 TTS 引擎（M1-A D4，26 契约 C.1）。

选型（D4 实证 2026-08-20，见 26 §8.2 补充）：
  - 运行时 sherpa-onnx OfflineTts（与 ASR/KWS 同库，一依赖通吃）
  - 主模型：vits-melo-tts-zh_en（MeloTTS 中文，自带 date/number/phone FST，日期数字朗读正确，发音比 kokoro 自然）
  - 兜底：kokoro-multi-lang-v1_0（旧模型，vits 未下载时回退）

合成语义：整句合成（OfflineTts 非流式解码），产出 float32 PCM；
「流式首包」近似 = 合成耗时 + 播放起播，first_packet_ms 实测上报。
"""
import re
from pathlib import Path

import numpy as np
import sherpa_onnx

KOKORO_DIR = "kokoro-multi-lang-v1_0"
VITS_DIR = "vits-melo-tts-zh_en"

_CN_DIGITS = "零一二三四五六七八九"
_CN_UNITS = ["", "十", "百", "千"]


def _cn_small(n: int) -> str:
    """0-9999 → 中文数字（含十/百/千），如 2026→二千零二十六、23→二十三、15→十五。"""
    if n == 0:
        return _CN_DIGITS[0]
    parts = []
    s = str(n)
    length = len(s)
    zero_pending = False
    for i, ch in enumerate(s):
        d = int(ch)
        unit_idx = length - 1 - i
        if d == 0:
            zero_pending = True
            continue
        if zero_pending and parts:
            parts.append(_CN_DIGITS[0])
        zero_pending = False
        if d == 1 and unit_idx == 1 and not parts:
            # 十位是 1 且是开头（如 15 → 十五，不是 一十五）
            parts.append(_CN_UNITS[1])
        else:
            parts.append(_CN_DIGITS[d] + _CN_UNITS[unit_idx])
    return "".join(parts)


def normalize_cn_numbers(text: str) -> str:
    """把文本里的阿拉伯数字串转成中文读法（vits-melo lexicon 对阿拉伯数字 OOV）。"""
    def repl(m):
        digits = m.group(0)
        if len(digits) <= 4:
            return _cn_small(int(digits))
        # 超过 4 位（如年份 2026 之外的更长串）：逐位读
        return "".join(_CN_DIGITS[int(c)] for c in digits)
    return re.sub(r"\d+", repl, text)

# kokoro-multi-lang-v1_0 中文音色 name→sid（据 sherpa 文档布局：32 个英语音色在前，zh 块 32..43）。
ZH_VOICE_SID = {
    "zf_xiaobei": 32, "zf_xiaoni": 33, "zf_sijing": 34, "zf_sisheng": 35,
    "zf_xiaoxiao": 36, "zf_xiaoyi": 37, "zf_xiaoxuan": 38,
    "zm_yunjian": 39, "zm_yunxi": 40, "zm_yunjie": 41, "zm_yunhao": 42, "zm_yunyang": 43,
}
DEFAULT_VOICE = "zf_xiaoni"


class TtsEngine:
    def __init__(self, models_dir, voice: str = "zm_yunjian", sample_rate: int | None = None):
        d = Path(models_dir)
        vits_dir = d / VITS_DIR
        if (vits_dir / "model.onnx").exists() and (vits_dir / "tokens.txt").exists():
            self.engine = "vits"
            self._init_vits(vits_dir, sample_rate)
        else:
            self.engine = "kokoro"
            self._init_kokoro(d / KOKORO_DIR, voice, sample_rate)

    def _init_vits(self, d: Path, sample_rate):
        for name, p in (("model", d / "model.onnx"), ("lexicon", d / "lexicon.txt"), ("tokens", d / "tokens.txt")):
            if not p.exists():
                raise FileNotFoundError(f"vits TTS 缺件 {name}: {d}")
        vits = sherpa_onnx.OfflineTtsVitsModelConfig(
            model=str(d / "model.onnx"),
            lexicon=str(d / "lexicon.txt"),
            tokens=str(d / "tokens.txt"),
            # 中文 jieba 字典走 dict_dir；data_dir 是英文 espeak 用的，误塞 dict/ 会导致合成变短/变糊
            dict_dir=str(d / "dict") if (d / "dict").is_dir() else "",
        )
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(vits=vits, num_threads=2, provider="cpu"),
            max_num_sentences=1,
        )
        self.tts = sherpa_onnx.OfflineTts(config)
        self.sample_rate = sample_rate or self.tts.sample_rate
        self.num_speakers = self.tts.num_speakers
        self.sid = 0          # vits-melo-tts-zh_en 单 speaker
        self.voice = "vits-melo-zh_en"

    def _init_kokoro(self, d: Path, voice, sample_rate):
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
        """整句合成 → float32 PCM（sample_rate 采样率）。合成前把阿拉伯数字转成中文读法。"""
        text = normalize_cn_numbers(text)
        result = self.tts.generate(text, sid=self.sid, speed=speed)
        # sherpa 1.13.6: generate 返回 GeneratedAudio{samples: list[float], sample_rate}
        self.sample_rate = int(getattr(result, "sample_rate", self.sample_rate))
        return np.asarray(result.samples, dtype=np.float32)
