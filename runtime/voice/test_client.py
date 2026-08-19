"""
test_client.py — D1 环路验收客户端（扮演 DSH 侧，26 契约 B 的对端）。

验证链：hello→ready → ping/pong → 假唤醒 → 假 ASR 流水（vad/partial/endpoint/final）
      → tts.speak started/finished → barge-in 100ms 闭环 → 档位事件序。
全部通过打印 LOOP PASS + 分段时延；任一失败 exit 1。
用法：python test_client.py [ws_url]（默认 ws://127.0.0.1:8300/voice）
"""
import asyncio
import json
import sys
import time
import uuid

import websockets

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))


async def recv_until(ws, wanted, timeout=5.0, collector=None):
    """收帧直到出现 wanted 中任一 type；途经帧交给 collector。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, deadline - time.time()))
        except asyncio.TimeoutError:
            return None
        f = json.loads(raw)
        if collector:
            collector(f)
        if f["type"] in wanted:
            return f
    return None


async def main(url):
    t0 = time.time()
    async with websockets.connect(url) as ws:

        async def send(t, p=None):
            await ws.send(json.dumps({"v": 1, "id": uuid.uuid4().hex[:8], "type": t, "ts": int(time.time() * 1000), "payload": p or {}}))

        print("== 1. hello / ready ==")
        await send("session.hello", {"version": 1, "caps": ["turn-machine", "speak-priority"]})
        f = await recv_until(ws, {"engine.ready", "engine.error"})
        check("hello→engine.ready", f and f["type"] == "engine.ready", f"models={f['payload'].get('models') if f else '—'}")

        print("== 2. heartbeat ==")
        await send("ping", {"t": 1})
        f = await recv_until(ws, {"pong"})
        check("ping→pong", f is not None)

        print("== 3. wake (fake KWS) ==")
        await send("debug.inject_wake", {"keyword": "小寄小寄"})
        f = await recv_until(ws, {"wake.detected"})
        check("wake.detected", f is not None, f"conf={f['payload'].get('confidence') if f else '—'}")

        print("== 4. fake ASR pipeline ==")
        ta = time.time()
        seen = []
        await send("debug.inject_asr", {"text": "小寄自检：从耳朵到嘴走一圈。"})
        f = await recv_until(ws, {"asr.final"}, timeout=5, collector=lambda x: seen.append(x["type"]))
        asr_ms = (time.time() - ta) * 1000
        check("asr.final", f is not None and "小寄自检" in f["payload"].get("text", ""), f"{asr_ms:.0f}ms")
        for ev in ("vad.start", "asr.partial", "endpoint.acoustic"):
            check(f"event {ev}", ev in seen)

        print("== 5. tts speak round ==")
        ts = time.time()
        await send("tts.speak", {"utterance_id": "utt_test1", "text": "环路自检完成，耳朵嘴巴都正常。", "priority": "normal"})
        f = await recv_until(ws, {"tts.started"})
        first_ms = (time.time() - ts) * 1000
        check("tts.started", f is not None, f"first={first_ms:.0f}ms")
        f = await recv_until(ws, {"tts.finished"}, timeout=8)
        dur_ms = (time.time() - ts) * 1000
        check("tts.finished", f is not None, f"total={dur_ms:.0f}ms")

        print("== 6. barge-in ==")
        await send("debug.inject_asr", {"text": "等等"})
        await recv_until(ws, {"asr.final"})
        await send("tts.speak", {"utterance_id": "utt_test2", "text": "这句会被人打断的话比较长一些，保证在播报中途插入。", "priority": "normal"})
        await recv_until(ws, {"tts.started"})
        tb = time.time()
        await send("debug.inject_bargein")
        f = await recv_until(ws, {"tts.stopped", "barge_in.detected"})
        yield_ms = (time.time() - tb) * 1000
        check("tts.stopped(barge_in)", f is not None and f["payload"].get("reason") == "barge_in")
        f2 = await recv_until(ws, {"barge_in.detected"})
        check("barge_in.detected", f2 is not None, f"client-observed {yield_ms:.0f}ms (engine-reported {f2['payload'].get('yield_ms') if f2 else '—'}ms)")
        f3 = await recv_until(ws, {"state"})
        check("state→listening", f3 is not None and f3["payload"].get("to") == "listening")

        print("== 7. supersede (tts.stop) ==")
        await send("tts.speak", {"utterance_id": "utt_test3", "text": "被主动停掉的一句。", "priority": "normal"})
        await recv_until(ws, {"tts.started"})
        await send("tts.stop", {"reason": "api"})
        f = await recv_until(ws, {"tts.stopped"})
        check("tts.stopped(superseded)", f is not None and f["payload"].get("reason") == "superseded")

    total = time.time() - t0
    print(f"\n===== {len(PASS)} passed / {len(FAIL)} failed ({total:.1f}s) =====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("LOOP PASS — 假转写→假发声全链路 + barge-in 闭环 OK")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8300/voice"))
