import asyncio, json, time
import websockets

async def main():
    ws = await websockets.connect("ws://127.0.0.1:8300/voice")
    await ws.send(json.dumps({"v":1,"id":"h","type":"session.hello","ts":0,"payload":{"version":1}}))
    # drain ready
    while True:
        f = json.loads(await ws.recv())
        if f["type"] == "engine.ready": break
    await ws.send(json.dumps({"v":1,"id":"m","type":"mic.set","ts":0,"payload":{"muted":True}}))
    await ws.send(json.dumps({"v":1,"id":"w","type":"wake.set","ts":0,"payload":{"armed":False}}))
    await ws.send(json.dumps({"v":1,"id":"s","type":"endpoint.set","ts":0,"payload":{"semantic_mode":True,"semantic_wait_ms":1200}}))
    await ws.send(json.dumps({"v":1,"id":"i","type":"debug.inject_wav","ts":0,"payload":{"path":"C:/Users/Aorus/Desktop/Github/Hermit/runtime/voice/test_zh.wav","speed":0}}))
    dl = time.time() + 5
    got = []
    while time.time() < dl:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, dl-time.time()))
        except asyncio.TimeoutError:
            continue
        f = json.loads(raw)
        got.append(f["type"])
        print("EVENT:", f["type"], "|", json.dumps(f["payload"], ensure_ascii=False)[:60])
    print("ALL:", got)
    await ws.close()

asyncio.run(main())
