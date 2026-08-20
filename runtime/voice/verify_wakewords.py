"""verify_wakewords.py — 三唤醒词端到端验证（经 WS 走真实门控路由）。"""
import asyncio
import json
import sys
import time

import websockets

POS = "C:/Users/Aorus/Desktop/Github/Hermit/runtime/voice/samples/pos/"


async def recv_until(ws, wants, timeout=20):
    dl = time.time() + timeout
    while time.time() < dl:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, dl - time.time()))
        except asyncio.TimeoutError:
            return None
        f = json.loads(raw)
        if f["type"] in wants:
            return f
    return None


async def connect():
    ws = await websockets.connect("ws://127.0.0.1:8300/voice")
    await ws.send(json.dumps({"v": 1, "id": "h", "type": "session.hello", "ts": 0, "payload": {"version": 1}}))
    await recv_until(ws, {"engine.ready"})
    return ws


async def main():
    ok = True
    for name, path in [("小寄同学", "xt_tail.wav"), ("小寄酱", "xj_tail.wav"), ("小寄小寄", "x2_tail_time.wav")]:
        # 每个词独立连接（重连回 idle），避免上一词的免唤醒窗吞掉后续唤醒
        ws = await connect()
        await ws.send(json.dumps({"v": 1, "id": "i", "type": "debug.inject_wav", "ts": 0,
                                  "payload": {"path": POS + path, "speed": 0}}))
        f = await recv_until(ws, {"wake.detected", "asr.final"})
        woke = bool(f and f["type"] == "wake.detected")
        ok &= woke
        print(f"  [{'PASS' if woke else 'FAIL'}] {name}  keyword={f['payload'].get('keyword') if f else '—'}")
        await ws.close()
    print("ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
