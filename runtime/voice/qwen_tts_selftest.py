import sys, time
sys.path.insert(0, r"C:\Users\Aorus\Desktop\Github\Hermit\runtime\voice")
from qwen_tts import QwenTtsEngine

e = QwenTtsEngine(
    r"C:\Users\Aorus\Desktop\Github\Hermit\runtime\qwentts.cpp\build\tts-server.exe",
    r"C:\Users\Aorus\Desktop\Github\Hermit\models\voice\qwen3-tts\qwen-talker-0.6b-base-Q8_0.gguf",
    r"C:\Users\Aorus\Desktop\Github\Hermit\models\voice\qwen3-tts\qwen-tokenizer-12hz-Q8_0.gguf",
    cuda_bin=r"C:\Users\Aorus\Desktop\Github\Hermit\runtime\mamba\envs\cuda\Library\bin",
    port=8310,
)
t0 = time.time()
s = e.synthesize("你好，我是小寄，你的贴身管家。")
dt = time.time() - t0
print(f"SELFTEST OK sr={e.sample_rate} samples={len(s)} dur={len(s)/e.sample_rate:.2f}s synth_ms={dt*1000:.0f} rtf={dt/(len(s)/e.sample_rate):.3f}")
# 第二句：验证常驻（无模型重载）
t0 = time.time()
s2 = e.synthesize("今天天气不错。")
dt2 = time.time() - t0
print(f"SELFTEST 2nd sr={e.sample_rate} dur={len(s2)/e.sample_rate:.2f}s synth_ms={dt2*1000:.0f} rtf={dt2/(len(s2)/e.sample_rate):.3f}")
e.close()
print("SELFTEST closed ok")
