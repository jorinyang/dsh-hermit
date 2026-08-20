"""
test_asr.py — D2 真件 ASR 验收（需引擎 asr=real 运行在 127.0.0.1:8300）。

链路：WS debug.inject_wav（加速回放，纯处理延迟）→ 事件序 + 最终文本 + RTF
     HTTP POST /v1/audio/transcriptions（OpenAI 兼容）→ 文本 + 墙钟
验收（26 §六 D2）：转写延迟 ≤300ms（语音结束后 final 的处理耗时）；文本正确性抽查。
"""
import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

import websockets

HERE = Path(__file__).resolve().parent
PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))


async def recv_until(ws, wanted, timeout=30.0, collector=None):
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


async def inject_and_measure(ws, wav_path: Path, expect_any: str = ""):
    events = []
    t0 = time.time()
    await ws.send(json.dumps({"v": 1, "id": "t", "type": "debug.inject_wav", "ts": int(t0 * 1000),
                              "payload": {"path": str(wav_path), "speed": 0}}))
    f = await recv_until(ws, {"asr.final", "engine.error"}, timeout=60, collector=lambda x: events.append(x["type"]))
    wall = (time.time() - t0) * 1000
    if not f or f["type"] == "engine.error":
        return None, wall, events
    speech_ms = f["payload"].get("speech_ms") or 0
    # 注入含 800ms 补静音；处理延迟 ≈ 墙钟 − 音频时长（clamp≥0）
    proc_ms = max(0, wall - speech_ms - 800)
    return {"text": f["payload"].get("text", ""), "speech_ms": speech_ms, "proc_ms": proc_ms, "partials": events.count("asr.partial")}, wall, events


async def main():
    async with websockets.connect("ws://127.0.0.1:8300/voice") as ws:
        print("== 0. engine mode ==")
        await ws.send(json.dumps({"v": 1, "id": "h", "type": "session.hello", "ts": 0, "payload": {"version": 1}}))
        f = await recv_until(ws, {"engine.ready"})
        mode = f["payload"].get("asr_mode")
        check("asr_mode == real", mode == "real", f"mode={mode} models={f['payload'].get('models')}")
        # D3 起引擎有 KWS 门控：ASR 单测关唤醒直通（wake.set armed=false = 全开转写档）
        await ws.send(json.dumps({"v": 1, "id": "w", "type": "wake.set", "ts": 0, "payload": {"armed": False}}))

        print("== 1. SAPI 中文 WAV（小寄自检/天气句）==")
        r, wall, ev = await inject_and_measure(ws, HERE / "test_zh.wav")
        if r:
            check("asr.final 到达", True, f"wall={wall:.0f}ms speech={r['speech_ms']}ms")
            check("流式 partial 有产出", r["partials"] >= 2, f"partials={r['partials']}")
            check("文本含关键词(天气/一圈/自检 任一)", any(k in r["text"] for k in ("天气", "一圈", "自检")), f"text=「{r['text']}」")
            check("处理延迟 ≤300ms（D2 目标）", r["proc_ms"] <= 300, f"proc≈{r['proc_ms']:.0f}ms")
            check("RTF < 1（CPU 实时）", r["speech_ms"] > 0 and wall < r["speech_ms"] + 800 + 300, f"wall={wall:.0f} vs speech+silence={r['speech_ms'] + 800}")
        else:
            check("asr.final 到达", False, f"wall={wall:.0f} events={ev}")

        print("== 2. 官方测试 WAV 0.wav ==")
        mdir = Path(r"C:\Users\Aorus\Desktop\Github\Hermit\models\voice\sherpa-onnx-streaming-paraformer-bilingual-zh-en\test_wavs")
        if (mdir / "0.wav").exists():
            r2, wall2, _ = await inject_and_measure(ws, mdir / "0.wav")
            if r2:
                check("0.wav 转写非空", bool(r2["text"]), f"text=「{r2['text'][:50]}」proc≈{r2['proc_ms']:.0f}ms")
            else:
                check("0.wav 转写非空", False)
        else:
            print("  [skip] 0.wav 不存在")

    print("== 3. HTTP /v1/audio/transcriptions ==")
    t0 = time.time()
    req = urllib.request.Request("http://127.0.0.1:8301/v1/audio/transcriptions",
                                 data=(HERE / "test_zh.wav").read_bytes(), method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())
    dt = (time.time() - t0) * 1000
    check("HTTP 200 + text 字段", "text" in body, f"「{body.get('text', body)}」 {dt:.0f}ms")

    print(f"\n===== {len(PASS)} passed / {len(FAIL)} failed =====")
    if FAIL:
        print("FAILED:", ", ".join(FAIL))
        sys.exit(1)
    print("ASR REAL PASS")


if __name__ == "__main__":
    asyncio.run(main())
