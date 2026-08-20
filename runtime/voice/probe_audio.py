import sounddevice as sd

print("default out:", sd.default.device)
devs = sd.query_devices()
outs = [i for i, d in enumerate(devs) if d["max_output_channels"] > 0]
print("output devices:", len(outs))
for i in outs[:8]:
    d = devs[i]
    print(f"  [{i}] {d['name']} ch={d['max_output_channels']} sr={d['default_samplerate']}")
