"""
hermit voice engine — 语音引擎进程骨架（MVP-1 M1-A D1，26 契约 C）。

职责边界：麦克风/扬声器归本进程独占；DSH 侧只走 WS 协议 v1（契约 B）。
D1 骨架：假 ASR / 假 TTS 回环 + debug.* 注入族（debug=true 时启用）。
D2 起逐日替换为真件（26 §六）：D2 Fun-ASR-Nano / D3 sherpa-onnx KWS / D4 Qwen3-TTS。

协议信封：{v:1, id, type, ts, payload}，JSON 文本帧，仅绑定 127.0.0.1。
"""
import asyncio
import json
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import websockets

PROTOCOL_VERSION = 1
HERE = Path(__file__).resolve().parent

# ── 配置（configs/voice.yaml，缺失用默认）─────────────────────────────
def load_config():
    cfg = {
        "port": 8300, "healthz_port": 8301, "debug": True,
        "endpoint": {"acoustic_ms": 600, "semantic_wait_ms": 1200},
        "fake": {"asr_partial_ms": 90, "asr_final_ms": 220, "tts_first_ms": 90, "tts_per_char_ms": 40},
    }
    try:
        import yaml
        p = HERE.parent.parent / "configs" / "voice.yaml"
        if p.exists():
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            for k in ("port", "healthz_port", "debug"):
                if k in data: cfg[k] = data[k]
            if isinstance(data.get("endpoint"), dict): cfg["endpoint"].update(data["endpoint"])
            if isinstance(data.get("fake"), dict): cfg["fake"].update(data["fake"])
    except Exception as e:  # 配置坏了不挡启动，用默认
        print(f"[voice-engine] config load fallback: {e}", file=sys.stderr)
    return cfg

CFG = load_config()
COUNTERS = {"connections": 0, "asr_finals": 0, "tts_finished": 0, "barge_ins": 0}
ENGINE_STATE = {"state": "idle"}  # 引擎侧轮次状态（契约 C.3）


def now_ms(): return int(time.time() * 1000)


class Conn:
    """单连接会话态（DSH 是唯一客户端）。"""

    def __init__(self, ws):
        self.ws = ws
        self.wake_armed = True
        self.dialog_until = 0.0
        self.acoustic_ms = CFG["endpoint"]["acoustic_ms"]
        self.speak_task = None           # 当前 tts.speak 模拟任务
        self.current_utterance = None
        self.status_task = None

    async def send(self, _type, payload=None, _id=None):
        frame = {"v": PROTOCOL_VERSION, "id": _id or f"e{now_ms()}", "type": _type, "ts": now_ms(), "payload": payload or {}}
        await self.ws.send(json.dumps(frame, ensure_ascii=False))

    def set_state(self, to, reason):
        if to == ENGINE_STATE["state"]:
            return
        frm = ENGINE_STATE["state"]
        ENGINE_STATE["state"] = to
        return {"from": frm, "to": to, "reason": reason}

    async def emit_state(self, to, reason):
        st = self.set_state(to, reason)
        if st:
            await self.send("state", st)


async def fake_speak(conn: Conn, p):
    """假 TTS：tts.started → (可被打断) → tts.finished / tts.stopped（契约 B.2/B.3）。"""
    uid = p.get("utterance_id", "")
    text = str(p.get("text", ""))
    fake = CFG["fake"]
    try:
        await asyncio.sleep(fake["tts_first_ms"] / 1000)
        await conn.send("tts.started", {"utterance_id": uid, "first_packet_ms": fake["tts_first_ms"]})
        await conn.emit_state("speaking", "tts-started")
        duration = min(6.0, max(0.5, 0.4 + len(text) * fake["tts_per_char_ms"] / 1000))
        await asyncio.sleep(duration)
        COUNTERS["tts_finished"] += 1
        await conn.send("tts.finished", {"utterance_id": uid, "duration_ms": int(duration * 1000)})
        # 引擎侧回 idle（对话窗内回 listening）
        await conn.emit_state("listening" if time.time() < conn.dialog_until else "idle", "tts-finished")
    except asyncio.CancelledError:
        played_ms = None
        reason = "barge_in" if getattr(conn.speak_task, "_barge", False) else "superseded"
        if reason == "barge_in":
            COUNTERS["barge_ins"] += 1
            await conn.send("tts.stopped", {"utterance_id": uid, "reason": "barge_in"})
            await conn.send("barge_in.detected", {"yield_ms": 85, "tts_played_ms": played_ms})
            await conn.emit_state("listening", "barge-in")
        else:
            await conn.send("tts.stopped", {"utterance_id": uid, "reason": "superseded"})
        raise


async def inject_asr(conn: Conn, p):
    """假 ASR 流水（契约 B.2 事件序）：vad.start → partial×2 → endpoint.acoustic → asr.final。"""
    text = str(p.get("text", ""))
    fake = CFG["fake"]
    await conn.emit_state("listening", "vad-start")
    await conn.send("vad.start", {})
    await asyncio.sleep(fake["asr_partial_ms"] / 1000)
    await conn.send("asr.partial", {"text": text[: max(1, len(text) // 2)]})
    await asyncio.sleep(fake["asr_partial_ms"] / 1000)
    await conn.send("asr.partial", {"text": text})
    await asyncio.sleep(fake["asr_final_ms"] / 1000)
    await conn.send("endpoint.acoustic", {"pause_ms": conn.acoustic_ms})
    COUNTERS["asr_finals"] += 1
    await conn.send("asr.final", {"text": text, "confidence": 0.97, "emotion": {"label": "neutral", "conf": 0.91}})


async def handler(ws):
    conn = Conn(ws)
    COUNTERS["connections"] += 1
    print(f"[voice-engine] DSH connected ({COUNTERS['connections']})", file=sys.stderr)

    async def status_loop():
        while True:
            await asyncio.sleep(30)
            await conn.send("engine.status", {"health": "ok", "gpu_mem": 0.0, "uptime_s": int(time.time() - START)})

    conn.status_task = asyncio.create_task(status_loop())
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype, mid, p = msg.get("type"), msg.get("id"), msg.get("payload") or {}
            if mtype == "session.hello":
                if msg.get("v") != PROTOCOL_VERSION:
                    await conn.send("engine.error", {"code": "E_PROTOCOL", "message": f"protocol v{msg.get('v')} != v{PROTOCOL_VERSION}", "degrade_hint": "restart_engine"}, _id=mid)
                    continue
                await conn.send("engine.ready", {"models": ["fake-asr", "fake-tts"], "device": "skeleton"}, _id=mid)
            elif mtype == "ping":
                await conn.send("pong", {"t": p.get("t")}, _id=mid)
            elif mtype == "wake.set":
                conn.wake_armed = bool(p.get("armed", True))
            elif mtype == "dialog_window.open":
                conn.dialog_until = time.time() + (p.get("ms", 30000) / 1000)
            elif mtype == "endpoint.set":
                if p.get("acoustic_ms"): conn.acoustic_ms = int(p["acoustic_ms"])
            elif mtype == "tts.speak":
                if conn.speak_task:  # 上一句未完：supersede（幂等语义由 utterance_id 侧保证）
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
                conn.speak_task = asyncio.create_task(fake_speak(conn, p))
            elif mtype == "tts.stop":
                if conn.speak_task:
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
            elif mtype == "mic.set" or mtype == "asr.context":
                pass  # 骨架空实现：D2 接真件时落热词/静音
            elif mtype == "engine.shutdown":
                await conn.send("state", conn.set_state("idle", "shutdown") or {})
                await ws.close(code=1001)
                print("[voice-engine] graceful shutdown", file=sys.stderr)
                asyncio.get_running_loop().stop()
                return
            elif CFG["debug"] and mtype == "debug.inject_wake":
                if conn.wake_armed:
                    await conn.send("wake.detected", {"keyword": p.get("keyword", "小寄小寄"), "confidence": 0.95})
                    conn.dialog_until = time.time() + 30
            elif CFG["debug"] and mtype == "debug.inject_asr":
                await inject_asr(conn, p)
            elif CFG["debug"] and mtype == "debug.inject_bargein":
                if conn.speak_task:
                    conn.speak_task._barge = True
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
            elif mtype.startswith("debug."):
                if not CFG["debug"]:
                    await conn.send("engine.error", {"code": "E_PROTOCOL", "message": "debug family disabled", "degrade_hint": "restart_engine"}, _id=mid)
    except websockets.ConnectionClosed:
        pass
    finally:
        conn.status_task.cancel()
        if conn.speak_task:
            conn.speak_task.cancel()
        # 设备释放点（骨架无设备；D2+ 在此释放麦克风/扬声器句柄）——A2 无残留
        ENGINE_STATE["state"] = "idle"
        print("[voice-engine] DSH disconnected; devices released, waiting for reconnect", file=sys.stderr)


# ── healthz（契约 B.4 最小面；OpenAI 兼容端点随 D2 真件落）────────────
class Healthz(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            body = json.dumps({"ok": True, "state": ENGINE_STATE["state"], "uptime_s": int(time.time() - START)}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
        elif self.path == "/metrics":
            lines = [f'voice_{k} {v}' for k, v in COUNTERS.items()] + [f'voice_state{{s="{ENGINE_STATE["state"]}"}} 1']
            body = ("\n".join(lines) + "\n").encode()
            self.send_response(200); self.send_header("Content-Type", "text/plain; version=0.0.1"); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()

    def log_message(self, *a): pass


START = time.time()


async def main():
    port, hport = CFG["port"], CFG["healthz_port"]
    hb = threading.Thread(target=lambda: HTTPServer(("127.0.0.1", hport), Healthz).serve_forever(), daemon=True)
    hb.start()
    async with websockets.serve(handler, "127.0.0.1", port, max_size=1 << 20):
        print(f"[voice-engine] skeleton up  ws=ws://127.0.0.1:{port}/voice  healthz=127.0.0.1:{hport}/healthz  debug={CFG['debug']}", file=sys.stderr)
        await asyncio.Future()  # run until shutdown


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    asyncio.run(main())
