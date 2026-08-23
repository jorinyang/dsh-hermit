import sys
sys.path.insert(0, r"C:\Users\Aorus\Desktop\Github\Hermit\runtime\voice")
import server

print("== resolved qwen3 config ==")
for k, v in server.CFG["tts"]["qwen3"].items():
    print(f"  {k} = {v}")

server.init_tts()
print(f"== engine_name={server.TTS['engine_name']} ready={server.TTS['ready']} ==")
e = server.TTS["engine"]
if e:
    print(f"sample_rate={e.sample_rate} voice={e.voice}")
    s = e.synthesize("你好，我是小寄，你的贴身管家。")
    print(f"OK samples={len(s)} dur={len(s)/e.sample_rate:.2f}s")
    close = getattr(e, "close", None)
    if close:
        close()
        print("closed ok")
    else:
        print("(sherpa engine: no close needed)")
