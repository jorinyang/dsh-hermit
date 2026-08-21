import asyncio, json, time
import websockets

async def main():
    ws = await websockets.connect("ws://127.0.0.1:8300/voice")
    await ws.send(json.dumps({"v":1,"id":"h","type":"session.hello","ts":0,"payload":{"version":1}}))
    dl = time.time() + 5
    while time.time() < dl:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, dl-time.time()))
        except asyncio.TimeoutError:
            continue
        f = json.loads(raw)
        if f["type"] == "engine.ready":
            p = f["payload"]
            print("engine.ready payload:")
            print("  models:", p.get("models"))
            print("  asr_mode:", p.get("asr_mode"))
            print("  kws:", p.get("kws"))
            print("  tts:", p.get("tts"))
            print("  barge_vad:", p.get("barge_vad"))
            print("  mic:", p.get("mic"))
            break
        elif f["type"] == "engine.error":
            print("engine.error:", f["payload"])
    # 继续收 3 秒，看有没有 state/wake/asr 事件（用户说话时）
    print("--- 监听 3 秒事件流 ---")
    dl = time.time() + 3
    while time.time() < dl:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, dl-time.time()))
        except asyncio.TimeoutError:
            continue
        f = json.loads(raw)
        if f["type"] != "pong":
            print("  EVENT:", f["type"], json.dumps(f["payload"], ensure_ascii=False)[:80])
    await ws.close()

asyncio.run(main())
