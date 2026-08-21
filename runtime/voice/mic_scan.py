import time

import numpy as np
import sounddevice as sd

devs = sd.query_devices()
ins = [i for i, d in enumerate(devs) if d["max_input_channels"] > 0]
print(f"共 {len(ins)} 个输入设备，逐个抓 1.5 秒…（请持续说话）")
results = []
for i in ins:
    d = devs[i]
    name = d["name"]
    buf = []

    def cb(indata, frames, t, status):
        buf.append(indata.copy())

    try:
        with sd.InputStream(samplerate=16000, channels=1, dtype="int16", blocksize=1600, device=i, callback=cb) as stream:
            time.sleep(1.5)
        data = np.concatenate(buf).astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(data ** 2)))
        peak = float(np.max(np.abs(data)))
        results.append((i, name, rms, peak))
        print(f"  [{i}] {name}: RMS={rms:.5f} 峰值={peak:.4f} {'<<< 有声音' if peak > 0.05 else ''}")
    except Exception as e:
        print(f"  [{i}] {name}: 打开失败 {e}")

best = max(results, key=lambda r: r[3]) if results else None
if best and best[3] > 0.05:
    print(f"\n>>> 建议：你的实际麦克风是 [{best[0]}] {best[1]}")
else:
    print("\n>>> 所有设备都没明显声音——请检查麦克风是否被系统静音/隐私权限")
