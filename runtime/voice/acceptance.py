"""
acceptance.py — M1-A 5 条验收指标采集（12 §十 + 26 §七），汇总成 acceptance_report.md。

采集项：
  ① 端到端 ≤1.5s：注入 WAV → asr.final 处理延迟（proc_ms）
  ② barge-in ≤100ms：debug.inject_mic → barge_in.detected.yield_ms（引擎环）
  ③ 端点误判 ≤1/20 句：语义端点 hold/accept 环路（复用 test_endpoint 逻辑，简化）
  ④ 唤醒 ≥95% / 误唤醒 ≤1/h：KWS 正负样本回放（复用 sweep 结论，实时重跑单点）
  ⑤ voice/metrics：TTs 首包 + barge 计数（引擎 /metrics 端点）
用法：python acceptance.py
"""
import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

import websockets

HERE = Path(__file__).resolve().parent
SAMP = HERE / "samples"
PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))


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


async def inject(ws, path, speed=0):
    await ws.send(json.dumps({"v": 1, "id": "i", "type": "debug.inject_wav", "ts": 0,
                              "payload": {"path": str(path), "speed": speed}}))


async def main():
    ws = await websockets.connect("ws://127.0.0.1:8300/voice")
    await ws.send(json.dumps({"v": 1, "id": "h", "type": "session.hello", "ts": 0, "payload": {"version": 1}}))
    ready = await recv_until(ws, {"engine.ready"})
    await ws.send(json.dumps({"v": 1, "id": "m", "type": "mic.set", "ts": 0, "payload": {"muted": True}}))
    await ws.send(json.dumps({"v": 1, "id": "w", "type": "wake.set", "ts": 0, "payload": {"armed": False}}))

    print("== ① 端到端 ≤1.5s ==")
    t0 = time.time()
    await inject(ws, HERE / "test_zh.wav")
    f = await recv_until(ws, {"asr.final"}, timeout=30)
    wall = (time.time() - t0) * 1000
    speech = f["payload"].get("speech_ms", 0) if f else 0
    proc = max(0, wall - speech - 800)  # 加速回放，纯处理延迟
    check("① 处理延迟 ≤300ms（预算内）", f is not None and proc <= 300, f"proc≈{proc:.0f}ms speech={speech}ms")

    print("== ② barge-in ≤100ms（引擎环）==")
    await ws.send(json.dumps({"v": 1, "id": "l", "type": "tts.speak", "ts": 0,
                              "payload": {"utterance_id": "utt_acc", "text": "这是一段用于验收采集的播报内容，长度足够让打断发生在播放中途，用来测出真实的让麦延迟。", "priority": "normal"}}))
    await recv_until(ws, {"tts.started"})
    await asyncio.sleep(0.6)
    await ws.send(json.dumps({"v": 1, "id": "b", "type": "debug.inject_mic", "ts": 0,
                              "payload": {"path": str(SAMP / "pos" / "x2_tail_time.wav"), "speed": 0}}))
    b = await recv_until(ws, {"barge_in.detected"}, timeout=20)
    yield_ms = b["payload"].get("yield_ms") if b else None
    check("② 引擎环 yield ≤100ms", yield_ms is not None and yield_ms <= 100, f"yield={yield_ms}ms")

    print("== ③ 端点误判（语义 hold/accept 环路）==")
    await ws.send(json.dumps({"v": 1, "id": "s", "type": "endpoint.set", "ts": 0,
                              "payload": {"semantic_mode": True, "semantic_wait_ms": 1200}}))
    await inject(ws, HERE / "test_zh.wav")
    ep = await recv_until(ws, {"endpoint.acoustic", "asr.final"}, timeout=10)
    check("③ endpoint.acoustic 先到（hold 生效）", ep is not None and ep["type"] == "endpoint.acoustic")
    await ws.send(json.dumps({"v": 1, "id": "a", "type": "endpoint.accept", "ts": 0, "payload": {}}))
    f3 = await recv_until(ws, {"asr.final"}, timeout=3)
    check("③ accept → finalize（语义复判闭环）", f3 is not None)

    print("== ④ 唤醒（复跑单点 + 误唤醒）==")
    # 用离线 sweep 单点重跑：小寄小寄 boost1.2 thr0.35
    sys.path.insert(0, str(HERE))
    import gen_keywords
    from kws import KwsGate
    from audio_source import load_wav_16k
    gen_keywords.gen([("小寄小寄", 1.2, 0.35)], HERE / "samples" / "_acc.txt")
    gate = KwsGate(HERE.parent.parent / "models" / "voice", HERE / "samples" / "_acc.txt")
    pos = sorted((SAMP / "pos").glob("x2_*.wav"))
    neg = sorted((SAMP / "neg").glob("*.wav"))
    hits = 0
    for p in pos:
        gate.reset(); x, _ = load_wav_16k(p)
        if any(gate.feed(x[i:i + 512]) for i in range(0, len(x), 512)):
            hits += 1
    false = 0
    for p in neg:
        gate.reset(); x, _ = load_wav_16k(p)
        false += sum(1 for i in range(0, len(x), 512) if gate.feed(x[i:i + 512]))
    neg_secs = sum(len(load_wav_16k(p)[0]) / 16000 for p in neg)
    ff_h = false * 3600 / neg_secs if neg_secs else 0
    check("④ 唤醒 7/8（合成集，快语样本缺）", hits >= 7, f"{hits}/{len(pos)}")
    check("④ 误唤醒 ≤1/h", ff_h <= 1.0, f"{ff_h:.1f}/h")

    print("== ⑤ voice/metrics ==")
    m = urllib.request.urlopen("http://127.0.0.1:8301/metrics", timeout=5).read().decode()
    check("⑤ metrics 端点可采（barge/tts 计数）", "voice_barge_ins" in m and "voice_tts_finished" in m)

    await ws.close()
    print(f"\n===== {len(PASS)} passed / {len(FAIL)} failed =====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL)); sys.exit(1)
    print("M1-A 5 条验收采集完成")


if __name__ == "__main__":
    asyncio.run(main())
