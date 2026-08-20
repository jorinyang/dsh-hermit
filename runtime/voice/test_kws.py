"""
test_kws.py — D3 唤醒门控端到端验收（引擎需 asr=real + kws=on）。

链路（经 WS，走真实路由）：
  1. engine.ready 报 kws=on
  2. 注入「小寄小寄+指令」WAV → wake.detected + asr.final（指令被接住，不漏字）
  3. 注入纯播报 WAV（无唤醒词）→ **零事件**（idle 态被门控拒识，12 §五.3 环境音拒识）
  4. 关唤醒（armed=false 全开档）→ 纯播报 WAV 又能出 asr.final
验收（26 §六 D3）：唤醒门控拦截正确；误唤醒（门控态播报穿透）= 0。
"""
import asyncio
import json
import sys
import time
from pathlib import Path

import websockets

HERE = Path(__file__).resolve().parent
SAMP = HERE / "samples"
PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))


async def drain(ws, seconds=0.5):
    """清空缓冲（含 pending 事件），返回期间收到的类型集。"""
    seen = []
    deadline = time.time() + seconds
    while True:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, deadline - time.time()))
        except asyncio.TimeoutError:
            break
        seen.append(json.loads(raw)["type"])
    return seen


async def inject(ws, path, wait_types, timeout=30):
    await ws.send(json.dumps({"v": 1, "id": "i", "type": "debug.inject_wav", "ts": 0,
                              "payload": {"path": str(path), "speed": 0}}))
    got = {}
    frames = []
    deadline = time.time() + timeout
    while time.time() < deadline and not all(t in got for t in wait_types):
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, deadline - time.time()))
        except asyncio.TimeoutError:
            continue
        f = json.loads(raw)
        frames.append(f)
        got[f["type"]] = f
    return frames


async def connect():
    ws = await websockets.connect("ws://127.0.0.1:8300/voice")
    await ws.send(json.dumps({"v": 1, "id": "h", "type": "session.hello", "ts": 0, "payload": {"version": 1}}))
    ready = await recv(ws, "engine.ready")
    return ws, ready


async def main():
    print("== 1. engine 上报 ==")
    ws, ready = await connect()
    check("kws=on 上报", ready["payload"].get("kws") == "on", f"kws={ready['payload'].get('kws')} models={ready['payload'].get('models')}")

    print("== 2. 唤醒词+指令（应 wake + asr.final 不漏字）==")
    await drain(ws, 0.3)
    frames = await inject(ws, SAMP / "pos" / "x2_tail_weather.wav", {"wake.detected", "asr.final"}, timeout=30)
    wake = next((f for f in frames if f["type"] == "wake.detected"), None)
    final = next((f for f in frames if f["type"] == "asr.final"), None)
    check("wake.detected", wake is not None, f"keyword={wake['payload'].get('keyword') if wake else '—'}")
    check("asr.final 跟随（指令不漏）", final is not None, f"text=「{final['payload'].get('text') if final else '—'}」")
    if final and "天气" in final["payload"].get("text", ""):
        check("指令文本含「天气」", True, final["payload"]["text"])
    else:
        check("指令文本含「天气」", bool(final), final["payload"].get("text") if final else "无final")

    print("== 3. 纯播报（全新 idle 态应零穿透）==")
    # 重连即复位全局 idle（引擎断连时 handler finally 回 idle），脱离上一步的免唤醒窗
    await ws.close()
    ws, _ = await connect()
    await drain(ws, 0.3)
    seen = await inject(ws, SAMP / "neg" / "tv_1.wav", {"asr.final"}, timeout=15)
    leaked = [f["type"] for f in seen if f["type"] in ("asr.partial", "asr.final", "wake.detected")]
    check("门控态播报零穿透", len(leaked) == 0, f"leaked={leaked}")

    print("== 4. 关唤醒（全开档）→ 播报可转写 ==")
    await ws.send(json.dumps({"v": 1, "id": "w", "type": "wake.set", "ts": 0, "payload": {"armed": False}}))
    await drain(ws, 0.3)
    frames = await inject(ws, SAMP / "neg" / "tv_2.wav", {"asr.final"}, timeout=30)
    final2 = next((f for f in frames if f["type"] == "asr.final"), None)
    check("armed=false 直通转写", final2 is not None, f"text=「{(final2['payload'].get('text') if final2 else '—')[:40]}…」")

    print(f"\n===== {len(PASS)} passed / {len(FAIL)} failed =====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("KWS GATE PASS")


async def recv(ws, want, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, deadline - time.time()))
        except asyncio.TimeoutError:
            return None
        f = json.loads(raw)
        if f["type"] == want:
            return f
    return None


if __name__ == "__main__":
    asyncio.run(main())
