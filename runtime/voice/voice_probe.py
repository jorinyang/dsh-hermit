"""
voice_probe.py — 探测 kokoro 中文音色块（D4）。

思路：合成固定中文句 → 喂回 paraformer ASR → 能转写回中文的 sid 即中文音色。
离线自证，不依赖抓不到的音色文档。同时输出 num_speakers 与各 sid 识别结果。
用法：python voice_probe.py [sid_start] [sid_end]
"""
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tts import TtsEngine  # noqa: E402
from asr import AsrPipeline  # noqa: E402

MODELS = HERE.parent.parent / "models" / "voice"
SENTENCE = "小寄同学，今天天气怎么样。"


def synth_to_wav(tts: TtsEngine, text: str, sid: int, path: Path):
    tts.sid = sid
    samples = tts.synthesize(text)
    rate = tts.sample_rate
    samples = np.clip(samples * 32768, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setparams((1, 2, rate, len(samples), "NONE", "not compressed"))
        w.writeframes(samples.tobytes())


def recognize(asr: AsrPipeline, wav_path: Path) -> str:
    from audio_source import load_wav_16k
    x, _ = load_wav_16k(wav_path)
    asr.reset()
    ev = None
    for i in range(0, len(x), 512):
        r = asr.feed(x[i:i + 512])
        if r and r["type"] == "final":
            ev = r
            break
    if not (ev and ev["type"] == "final"):
        ev = asr.force_final()
    return (ev or {}).get("text", "").strip()


def has_chinese(s: str) -> bool:
    return any('\u4e00' <= ch <= '\u9fff' for ch in s)


def main():
    lo = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    hi = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    print("loading TTS + ASR ...", flush=True)
    tts = TtsEngine(MODELS)
    asr = AsrPipeline(MODELS)
    n = tts.tts.num_speakers
    print(f"num_speakers = {n}", flush=True)
    hi = min(hi, n - 1)
    hits = []
    with tempfile.TemporaryDirectory() as td:
        for sid in range(lo, hi + 1):
            p = Path(td) / f"s{sid}.wav"
            try:
                synth_to_wav(tts, SENTENCE, sid, p)
                text = recognize(asr, p)
            except Exception as e:
                print(f"  sid={sid}: ERROR {e}", flush=True)
                continue
            cn = has_chinese(text)
            if cn:
                hits.append(sid)
            print(f"  sid={sid}: cn={cn} text=「{text[:30]}」", flush=True)
    print(f"\n中文音色 sid 范围: {lo}~{hi} 内命中 {hits}")
    if hits:
        print(f"连续块: {min(hits)}..{max(hits)}（{len(hits)} 个）")


if __name__ == "__main__":
    main()
