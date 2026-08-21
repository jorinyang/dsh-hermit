import sounddevice as sd

devs = sd.query_devices()
ins = [i for i, d in enumerate(devs) if d["max_input_channels"] > 0]
print("输入设备数:", len(ins))
for i in ins:
    d = devs[i]
    print(f"  [{i}] {d['name']} in_ch={d['max_input_channels']} default_sr={d['default_samplerate']}")
print("默认输入设备 index:", sd.default.device[0])
