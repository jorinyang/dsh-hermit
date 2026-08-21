import time

import numpy as np
import sounddevice as sd

print("默认输入设备 index:", sd.default.device[0])
d = sd.query_devices(sd.default.device[0])
print("默认输入设备:", d["name"])

buf = []
def cb(indata, frames, t, status):
    buf.append(indata.copy())

sr = 16000
with sd.InputStream(samplerate=sr, channels=1, dtype="int16", blocksize=1600, callback=cb) as stream:
    print("录音 2 秒…（请对着麦克风说话）")
    time.sleep(2)

data = np.concatenate(buf).astype(np.float32) / 32768.0
rms = float(np.sqrt(np.mean(data ** 2)))
peak = float(np.max(np.abs(data)))
print(f"采样数={len(data)}  RMS={rms:.5f}  峰值={peak:.4f}")
if rms < 0.005:
    print(">>> 判定：麦克风是静音（没收到声音）——设备选错/被静音/没插好")
elif peak < 0.05:
    print(">>> 判定：有微弱声音但很轻")
else:
    print(">>> 判定：能收到声音")
