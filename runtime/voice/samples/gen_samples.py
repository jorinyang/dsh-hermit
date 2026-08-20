"""
gen_samples.py — 生成 KWS 正负样本集（pyttsx3 封 SAPI，确定性；12 §五.2 方法定义集自动化版）。

真机调优（主人真声 20 次 + 背景音 30min）随 D4 实机验收再做；本集用于 D3 扫参起步。
用法：python gen_samples.py
产出：samples/pos/*.wav（应唤醒）+ samples/neg/*.wav（不应唤醒）
"""
import sys
from pathlib import Path

import numpy as np
import pyttsx3
import wave

HERE = Path(__file__).resolve().parent
POS = HERE / "pos"
NEG = HERE / "neg"
POS.mkdir(parents=True, exist_ok=True)
NEG.mkdir(parents=True, exist_ok=True)

def _make_engine():
    """每个文件独立引擎实例——pyttsx3 连续 runAndWait 在 SAPI 上会挂死，实测绕过。"""
    e = pyttsx3.init()
    zh = next((v for v in e.getProperty("voices") if "Chinese" in v.name or "Huihui" in v.name), None)
    if not zh:
        print("未找到中文 SAPI 语音", file=sys.stderr)
        sys.exit(1)
    e.setProperty("voice", zh.id)
    return e


def speak(text: str, file: Path, rate_delta: int = 0, volume: float = 0.9):
    e = _make_engine()
    e.setProperty("rate", 200 + rate_delta * 25)  # pyttsx3 rate 是绝对 wpm；200 基线
    e.setProperty("volume", volume)
    e.save_to_file(text, str(file))
    e.runAndWait()
    e.stop()
    del e
    print(f"  {file.name}  ({text[:12]}…)" if len(text) > 12 else f"  {file.name}  ({text})", flush=True)


print("== 正样本：小寄小寄 ×8 ==")
speak("小寄小寄", POS / "x2_r0_v90.wav")
speak("小寄小寄", POS / "x2_r-2_v90.wav", rate_delta=-2)
speak("小寄小寄", POS / "x2_r2_v90.wav", rate_delta=2)
speak("小寄小寄", POS / "x2_r0_v60.wav", volume=0.6)
speak("小寄小寄，现在几点了", POS / "x2_tail_time.wav")
speak("小寄小寄，今天天气怎么样", POS / "x2_tail_weather.wav")
speak("小寄小寄，帮我查一下邮件", POS / "x2_tail_mail.wav", rate_delta=1)
speak("小寄小寄小寄小寄", POS / "x2_double.wav")

print("== 正样本：小寄 ×4 ==")
speak("小寄", POS / "x1_r0.wav")
speak("小寄", POS / "x1_r-2.wav", rate_delta=-2)
speak("小寄", POS / "x1_r2.wav", rate_delta=2)
speak("小寄，你在吗", POS / "x1_tail.wav")

print("== 负样本：近似音陷阱 ×10 ==")
for i, w in enumerate(["小季", "小纪", "小鸡", "小吉", "书记", "消极", "小姐", "小杰", "晓洁", "呼吸机"], 1):
    speak(w, NEG / f"near_{i:02d}.wav")

print("== 负样本：播报长语音 ×2 ==")
speak("据中央气象台报道，今天白天到夜间，华北地区晴转多云，气温十八到二十六摄氏度。未来三天，南方多地将迎来大范围降水，局部地区有暴雨。专家提醒，出行请注意交通安全，携带雨具。空气质量方面，全国大部分地区空气质量良好，适宜户外活动。", NEG / "tv_1.wav")
speak("下面播报财经新闻。今日三大指数集体收涨，科技股领涨。分析师指出，市场情绪回暖，成交量明显放大。板块方面，人工智能、新能源、医药涨幅居前。建议投资者关注政策导向，合理配置资产，注意控制风险。明日将有重要经济数据公布，市场观望情绪较浓。", NEG / "tv_2.wav", rate_delta=1)

print("== 负样本：低噪静音 ==")
with wave.open(str(NEG / "silence.wav"), "wb") as w:
    w.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    rng = np.random.default_rng(42)
    w.writeframes(rng.normal(0, 40, 16000 * 3).astype(np.int16).tobytes())
print("  silence.wav (3s 低噪)")

print(f"DONE: pos={len(list(POS.glob('*.wav')))} neg={len(list(NEG.glob('*.wav')))}")
