"""
test_endpoint.py — D5 语义端点旁路验收（引擎侧 hold/accept/extend/超时）。

链路：endpoint.set {semantic_mode:true} → inject_wav → 声学端点触发 endpoint.acoustic（不发 final）
     → 客户端语义复判（accept=说完了立即收 / extend=拖延词延长 / 超时兜底）。
对应 12 §二 双层端点：声学层（D2）+ 语义层（D5 引擎侧协议；拖延词规则在插件侧）。
"""
import asyncio
import json
import sys
import time
from pathlib import Path

import websockets

HERE = Path(__file__).resolve().parent
WAV = HERE / "test_zh.wav"   # 「小寄自检，从耳朵到嘴走一圈。今天天气怎么样？」完整句
PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))


async def recv_until(ws, wants, timeout=10):
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


async def inject(ws):
    await ws.send(json.dumps({"v": 1, "id": "i", "type": "debug.inject_wav", "ts": 0,
                              "payload": {"path": str(WAV), "speed": 0}}))


async def main():
    ws = await websockets.connect("ws://127.0.0.1:8300/voice")
    await ws.send(json.dumps({"v": 1, "id": "h", "type": "session.hello", "ts": 0, "payload": {"version": 1}}))
    await recv_until(ws, {"engine.ready"})
    await ws.send(json.dumps({"v": 1, "id": "m", "type": "mic.set", "ts": 0, "payload": {"muted": True}}))
    # 关唤醒门控：注入 WAV 直通 ASR（test_zh 无唤醒词，否则被 KWS 挡在 idle）
    await ws.send(json.dumps({"v": 1, "id": "w", "type": "wake.set", "ts": 0, "payload": {"armed": False}}))
    await ws.send(json.dumps({"v": 1, "id": "s", "type": "endpoint.set", "ts": 0,
                              "payload": {"semantic_mode": True, "semantic_wait_ms": 1200}}))

    print("== 1. 声学端点触发 → endpoint.acoustic（不发 final）==")
    await inject(ws)
    f = await recv_until(ws, {"endpoint.acoustic", "asr.final"}, timeout=10)
    check("endpoint.acoustic 先到", f is not None and f["type"] == "endpoint.acoustic",
          f"text=「{(f['payload'].get('text') if f else '—')[:20]}」")
    # 不 accept，等 0.5s 确认不会自己 finalize（保持中）
    f2 = await recv_until(ws, {"asr.final"}, timeout=0.5)
    check("保持中不自动 finalize", f2 is None)

    print("== 2. endpoint.accept → 立即 finalize ==")
    await ws.send(json.dumps({"v": 1, "id": "a", "type": "endpoint.accept", "ts": 0, "payload": {}}))
    f3 = await recv_until(ws, {"asr.final"}, timeout=3)
    check("accept 后 asr.final", f3 is not None, f"text=「{(f3['payload'].get('text') if f3 else '—')[:20]}」")

    print("== 3. endpoint.extend → 延长等待（不立即 finalize）==")
    await inject(ws)
    f4 = await recv_until(ws, {"endpoint.acoustic"}, timeout=10)
    check("再次 endpoint.acoustic", f4 is not None)
    await ws.send(json.dumps({"v": 1, "id": "e", "type": "endpoint.extend", "ts": 0, "payload": {}}))
    f5 = await recv_until(ws, {"asr.final"}, timeout=0.4)
    check("extend 后短期不 finalize", f5 is None)

    print("== 4. 超时兜底 → 自动 finalize（semantic_wait_ms）==")
    f6 = await recv_until(ws, {"asr.final"}, timeout=4)
    check("超时后自动 finalize", f6 is not None, f"text=「{(f6['payload'].get('text') if f6 else '—')[:20]}」")

    await ws.close()
    print(f"\n===== {len(PASS)} passed / {len(FAIL)} failed =====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("SEMANTIC ENDPOINT PASS")


if __name__ == "__main__":
    asyncio.run(main())
