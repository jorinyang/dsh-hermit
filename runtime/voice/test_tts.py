"""
test_tts.py — D4 真件 TTS + barge-in 验收（引擎需 tts=on + barge_vad=on）。

链路（经 WS）：
  1. engine.ready 报 tts=on / barge_vad=on
  2. 短句 tts.speak → tts.started（真实 first_packet_ms）+ tts.finished（真实 duration_ms）
  3. 长句 tts.speak → 播报中 debug.inject_mic（主人插话 WAV）→ tts.stopped(barge_in)
     + barge_in.detected，yield_ms ≤100ms（12 §4.1/§十.2 让麦目标）
验收：真实发声全链路 + barge-in 本地闭环 yield ≤100ms。
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


async def recv_until(ws, wants, timeout=40):
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


async def main():
    ws = await websockets.connect("ws://127.0.0.1:8300/voice")
    await ws.send(json.dumps({"v": 1, "id": "h", "type": "session.hello", "ts": 0, "payload": {"version": 1}}))
    ready = await recv_until(ws, {"engine.ready"})
    print("== 1. engine 上报 ==")
    check("tts=on", ready["payload"].get("tts") == "on", f"tts={ready['payload'].get('tts')} barge_vad={ready['payload'].get('barge_vad')}")
    check("barge_vad=on", ready["payload"].get("barge_vad") == "on")
    # 静音麦克风：真机测试无需真实 mic（barge 用 inject_mic 确定性注入，无回声）
    await ws.send(json.dumps({"v": 1, "id": "m", "type": "mic.set", "ts": 0, "payload": {"muted": True}}))

    print("== 2. 短句真发声 ==")
    await ws.send(json.dumps({"v": 1, "id": "s", "type": "tts.speak", "ts": 0,
                              "payload": {"utterance_id": "utt_short", "text": "小寄自检完成，耳朵和嘴都在线。", "priority": "normal"}}))
    started = await recv_until(ws, {"tts.started", "engine.error"})
    check("tts.started（真实首包）", started and started["type"] == "tts.started",
          f"first_packet_ms={started['payload'].get('first_packet_ms') if started else '—'}")
    finished = await recv_until(ws, {"tts.finished", "engine.error"})
    check("tts.finished（真实时长）", finished and finished["type"] == "tts.finished",
          f"duration_ms={finished['payload'].get('duration_ms') if finished else '—'}")

    print("== 3. barge-in 让麦（≤100ms）==")
    await ws.send(json.dumps({"v": 1, "id": "l", "type": "tts.speak", "ts": 0,
                              "payload": {"utterance_id": "utt_long",
                                          "text": "这是一段故意说得比较长的播报内容，用来给主人留出打断我的时间窗口。今天天气不错，适合出去走走，呼吸一下新鲜空气，放松一下心情。",
                                          "priority": "normal"}}))
    started2 = await recv_until(ws, {"tts.started", "engine.error"})
    check("长句开始播报", started2 and started2["type"] == "tts.started")
    # 等播放真正起来（否则 inject 全速跑在首块播放前，测不到「中途停播」）
    await asyncio.sleep(0.6)
    await ws.send(json.dumps({"v": 1, "id": "b", "type": "debug.inject_mic", "ts": 0,
                              "payload": {"path": str(SAMP / "pos" / "x2_tail_time.wav"), "speed": 0}}))
    stopped = await recv_until(ws, {"tts.stopped", "barge_in.detected", "tts.finished"}, timeout=40)
    barge = await recv_until(ws, {"barge_in.detected"}, timeout=5) if stopped and stopped["type"] == "tts.stopped" else None
    if stopped and stopped["type"] == "tts.stopped" and stopped["payload"].get("reason") == "barge_in":
        check("tts.stopped(barge_in)", True, f"played={stopped['payload'].get('tts_played_ms')}ms")
        yield_ms = (barge or stopped)["payload"].get("yield_ms")
        check("barge_in.detected 事件", barge is not None, f"yield_ms={yield_ms}")
        check("yield ≤100ms（让麦目标）", yield_ms is not None and yield_ms <= 100, f"yield={yield_ms}ms")
    else:
        check("tts.stopped(barge_in)", False, f"got={stopped['type'] if stopped else 'timeout'}")

    await ws.close()
    print(f"\n===== {len(PASS)} passed / {len(FAIL)} failed =====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("TTS + BARGE-IN PASS")


if __name__ == "__main__":
    asyncio.run(main())
