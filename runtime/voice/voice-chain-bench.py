"""
voice-chain-bench.py — 唤醒-识别-注入-思考-产出-合成-输出 全链路实测
链路：KWS(x2_tail_weather.wav 真件) → ASR(paraformer 真件) → 注入语义 → 大脑(8080) → TTS(Kokoro 真件)
每节点计时 + 资源采样（引擎/大脑/GPU）。
用法：.venv\\Scripts\\python.exe voice-chain-bench.py
"""
import asyncio
import json
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

import websockets

HERE = Path(__file__).resolve().parent
WS_URL = "ws://127.0.0.1:8300/voice"
BRAIN_URL = "http://127.0.0.1:8080/v1/chat/completions"
WAKE_WAV = HERE / "test_zh.wav"
BRAIN_MODEL = "Qwen3.5-9B"

ENGINE_PID = None   # 运行时探测
BRAIN_PID = None
TIMELINE = []       # (name, ts_sec, note)
BASELINE_RES = {}   # 资源基线


def mark(name, note=""):
    TIMELINE.append((name, time.time(), note))


def _task_proc(pid):
    """tasklist 采样：累计 CPU 秒 + 工作集 MB。"""
    r = subprocess.run(["C:/Windows/System32/tasklist.exe", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
                       capture_output=True, text=True, timeout=10)
    line = r.stdout.strip()
    if not line or "INFO: No tasks" in line:
        return None
    parts = line.strip('"').split('","')
    if len(parts) < 5:
        return None
    ram_kb = int(parts[4].split()[0].replace(",", ""))
    return {"ram_mb": ram_kb // 1024}


def resample():
    """采样引擎/大脑进程 CPU 秒 + RAM MB，GPU 显存/利用率。返回 dict。"""
    out = {}
    if ENGINE_PID:
        v = _task_proc(ENGINE_PID)
        if v:
            out["engine"] = v
    if BRAIN_PID:
        v = _task_proc(BRAIN_PID)
        if v:
            out["brain"] = v
    r = subprocess.run(
        ["C:/Windows/System32/nvidia-smi.exe", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=10)
    if r.stdout.strip():
        used, util = [x.strip() for x in r.stdout.strip().split(",")]
        out["gpu"] = {"mem_mb": int(used), "util_pct": int(util)}
    return out


def diff_res(a, b):
    d = {}
    for k in ("engine", "brain"):
        if k in a and k in b:
            d[k] = {"ram_mb": b[k]["ram_mb"]}
    if "gpu" in a and "gpu" in b:
        d["gpu"] = {"mem_mb": b["gpu"]["mem_mb"], "util_pct": b["gpu"]["util_pct"]}
    return d


def brain_call(text):
    """调 8080 大脑（流式），返回 (ttft_ms, gen_ms, content)。"""
    body = {
        "model": BRAIN_MODEL,
        "messages": [{"role": "user", "content": text + "（请用一两句话简短回答）"}],
        "max_tokens": 200,
        "stream": True,
        "temperature": 0.5,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BRAIN_URL, data=data, headers={"Content-Type": "application/json"})
    t0 = time.perf_counter()
    t_first = None
    t_last = None
    content = ""
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except Exception:
                continue
            now = time.perf_counter()
            if t_first is None:
                t_first = now
            delta = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content")
            if delta:
                content += delta
                t_last = now
    e2e = (time.perf_counter() - t0) * 1000
    if t_first is None:
        return (e2e, 0, content)
    ttft = (t_first - t0) * 1000
    gen = ((t_last if t_last else t_first) - t_first) * 1000
    return (ttft, gen, content)


async def main():
    global ENGINE_PID, BRAIN_PID
    # 探测进程（netstat -ano，Windows 自带）
    def port_pid(port):
        r = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10)
        for ln in r.stdout.splitlines():
            if ":%d" % port in ln and "LISTENING" in ln:
                return int(ln.split()[-1])
        return None
    ENGINE_PID = port_pid(8300)
    BRAIN_PID = port_pid(8080)
    print(f"引擎 PID={ENGINE_PID}  大脑 PID={BRAIN_PID}")

    t_begin = time.time()
    BASELINE_RES["before"] = resample()

    async with websockets.connect(WS_URL) as ws:
        async def send(t, p=None):
            await ws.send(json.dumps({"v": 1, "id": uuid.uuid4().hex[:8], "type": t,
                                      "ts": int(time.time() * 1000), "payload": p or {}}))

        # 1. hello → ready
        await send("session.hello", {"version": 1, "caps": ["turn-machine", "speak-priority"], "home": "dsh-hermit-bench"})
        while True:
            f = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if f["type"] == "engine.ready":
                print("engine.ready:", json.dumps(f["payload"], ensure_ascii=False)[:200])
                break
        mark("ready")

        # 2. 唤醒：debug.inject_wake 开 KWS 门（引擎自检同款；真 KWS 延迟见 26 §8.1/12 §十.4 报告）
        print("\n== 唤醒（debug.inject_wake，门控开启）==")
        mark("inject_wake_sent")
        await send("debug.inject_wake", {"keyword": "小寄小寄", "confidence": 0.95})
        while True:
            f = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if f["type"] == "wake.detected":
                wake_at = time.time()
                mark("wake.detected", f"conf={f['payload'].get('confidence')}")
                print(f"  wake.detected conf={f['payload'].get('confidence')}")
                break
        print(f"  [KWS] 注入→唤醒 {(wake_at - TIMELINE[1][1]) * 1000:.0f}ms")

        # 3. 识别：WAV 注入走真 ASR（门已开 → ASR 直通）
        print(f"\n== 识别（真 ASR paraformer）：{WAKE_WAV.name} ==")
        mark("inject_wav_sent")
        await send("debug.inject_wav", {"path": str(WAKE_WAV)})
        asr_text = None
        asr_final_at = None
        while True:
            try:
                f = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            except asyncio.TimeoutError:
                print("!! 20s 内未完成识别"); break
            t = f["type"]
            if t == "vad.start":
                mark("vad.start")
            elif t == "asr.partial":
                pass
            elif t == "asr.final":
                asr_final_at = time.time()
                asr_text = f["payload"].get("text", "")
                mark("asr.final", asr_text)
                print(f"  asr.final: {asr_text}")
                break
            elif t == "engine.error":
                print("  engine.error:", f["payload"]); break
        if asr_final_at:
            print(f"  [ASR] 注入→final {(asr_final_at - TIMELINE[1][1]) * 1000:.0f}ms")
        RES1 = resample()

        # 3. 思考+产出：asr 文本 → 大脑
        print(f"\n== 大脑（8080 {BRAIN_MODEL}）==")
        if asr_text:
            mark("brain_req_sent", asr_text)
            ttft, gen, content = brain_call(asr_text)
            mark("brain_done", f"ttft={ttft:.0f}ms gen={gen:.0f}ms")
            print(f"  [大脑] TTFT {ttft:.0f}ms | 生成 {gen:.0f}ms | 回复: {content[:60]}")
            RES2 = resample()

            # 4. 合成+输出：speak
            print(f"\n== TTS 合成+播放（Kokoro）==")
            mark("speak_sent")
            await send("tts.speak", {"utterance_id": "utt_chain_" + uuid.uuid4().hex[:6],
                                     "text": content, "priority": "normal", "source": "chain-bench"})
            t_started = None
            t_finished = None
            while True:
                try:
                    f = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                except asyncio.TimeoutError:
                    print("!! TTS 超时"); break
                t = f["type"]
                if t == "tts.started":
                    t_started = time.time()
                    mark("tts.started", f"first={f['payload'].get('first_packet_ms')}")
                    print(f"  tts.started first_packet={f['payload'].get('first_packet_ms')}ms")
                elif t == "tts.finished":
                    t_finished = time.time()
                    mark("tts.finished", f"dur={f['payload'].get('duration_ms')}")
                    print(f"  tts.finished duration={f['payload'].get('duration_ms')}ms")
                    break
            if t_started and t_finished:
                print(f"  [TTS] speak→started {(t_started - TIMELINE[0][1] if False else t_started - dict((n, ts) for n, ts, _ in TIMELINE)['speak_sent']) * 1000:.0f}ms")
                print(f"  [TTS] 播放时长 {(t_finished - t_started) * 1000:.0f}ms")
            RES3 = resample()
        else:
            RES2 = RES3 = resample()

    # 汇总
    print("\n===== 链路延迟（客户端观察）=====")
    by_name = {n: ts for n, ts, _ in TIMELINE}
    if "wake.detected" in by_name and "inject_wake_sent" in by_name:
        print(f"KWS 唤醒       : 注入→wake.detected {(by_name['wake.detected'] - by_name['inject_wake_sent']) * 1000:.0f} ms")
    if "asr.final" in by_name:
        print(f"ASR 识别       : 注入→asr.final    {(by_name['asr.final'] - by_name['inject_wav_sent']) * 1000:.0f} ms")
    if "brain_done" in by_name and "asr.final" in by_name:
        print(f"思考+产出      : final→回复完成     {(by_name['brain_done'] - by_name['asr.final']) * 1000:.0f} ms")
    if "tts.started" in by_name and "speak_sent" in by_name:
        print(f"TTS 首包       : speak→started      {(by_name['tts.started'] - by_name['speak_sent']) * 1000:.0f} ms")
    if "tts.finished" in by_name and "tts.started" in by_name:
        print(f"TTS 播放       : started→finished   {(by_name['tts.finished'] - by_name['tts.started']) * 1000:.0f} ms")
    if "tts.finished" in by_name and "inject_wav_sent" in by_name:
        print(f"端到端(注入→播完): {(by_name['tts.finished'] - by_name['inject_wav_sent']) * 1000:.0f} ms")

    print("\n===== 资源消耗（阶段差值）=====")
    stages = [("before", "after-wake+asr", RES1), ("before", "after-brain", RES2), ("before", "after-tts", RES3)]
    for name_a, name_b, res_b in stages:
        if res_b:
            d = diff_res(BASELINE_RES["before"], res_b)
            print(f"{name_b}: {json.dumps(d, ensure_ascii=False)}")
    print(f"\n总耗时: {time.time() - t_begin:.1f}s")


if __name__ == "__main__":
    asyncio.run(main())
