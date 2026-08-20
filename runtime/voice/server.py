"""
hermit voice engine — 语音引擎进程（MVP-1 M1-A，26 契约 C）。

D2（2026-08-20）：真件 ASR 上线
  - sherpa-onnx 流式 paraformer（中英）→ asr.partial / asr.final 真转写
  - 声学端点 = recognizer rule2（尾静音 ≥ acoustic_ms）
  - 麦克风源（sounddevice 回调线程）；WAV 注入源（debug.inject_wav，测试用）
  - HTTP /v1/audio/transcriptions（OpenAI 兼容，raw WAV body，仅回环）
  - 假 ASR 事件族（debug.inject_asr）保留在 debug 开关后，供协议回归测试
  - 假 TTS 仍在位（D4 替换为 Qwen3-TTS）

协议信封：{v:1, id, type, ts, payload}，JSON 文本帧，仅绑定 127.0.0.1。
"""
import asyncio
import json
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asr import AsrPipeline  # noqa: E402
from audio_source import MicSource, WavInjectSource, load_wav_16k  # noqa: E402
from kws import KwsGate  # noqa: E402

PROTOCOL_VERSION = 1
HERE = Path(__file__).resolve().parent


def load_config():
    cfg = {
        "port": 8300, "healthz_port": 8301, "debug": True,
        "asr": {"mode": "auto", "models_dir": str(HERE.parent.parent / "models" / "voice")},
        "mic": {"enabled": True},
        "endpoint": {"acoustic_ms": 600, "semantic_wait_ms": 1200},
        "wake": {"enabled": True, "engine": "sherpa-onnx", "keywords_file": "configs/kws-keywords.txt", "dialog_window_s": 30},
        "fake": {"asr_partial_ms": 90, "asr_final_ms": 220, "tts_first_ms": 90, "tts_per_char_ms": 40},
    }
    try:
        import yaml
        p = HERE.parent.parent / "configs" / "voice.yaml"
        if p.exists():
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
            for k in ("port", "healthz_port", "debug"):
                if k in data:
                    cfg[k] = data[k]
            for k in ("asr", "mic", "endpoint", "fake", "wake"):
                if isinstance(data.get(k), dict):
                    cfg[k].update(data[k])
        # 相对路径锚定仓库根（HERMIT/runtime/voice → HERMIT/），不受进程 CWD 影响
        root = HERE.parent.parent
        md = cfg["asr"].get("models_dir", "")
        if md and not Path(md).is_absolute():
            cfg["asr"]["models_dir"] = str((root / md).resolve())
        kf = cfg["wake"].get("keywords_file", "")
        if kf and not Path(kf).is_absolute():
            cfg["wake"]["keywords_file"] = str((root / kf).resolve())
    except Exception as e:
        print(f"[voice-engine] config fallback: {e}", file=sys.stderr)
    return cfg


CFG = load_config()
COUNTERS = {"connections": 0, "asr_finals": 0, "asr_reals": 0, "tts_finished": 0, "barge_ins": 0, "http_transcriptions": 0, "wake_fires": 0}
ENGINE_STATE = {"state": "idle"}
START = time.time()
PIPELINE = {"asr": None, "mode": "fake", "mic_error": None}  # 全局单例：WS 会话与 HTTP 端点共用
KWS = {"gate": None, "enabled": False}  # 唤醒门控单例（D3）
ASR_LOCK = asyncio.Lock()
LAST_ASR = {"text": "", "at": 0.0}


def now_ms():
    return int(time.time() * 1000)


class Conn:
    """单 WS 连接会话态（DSH 是唯一客户端；HTTP 端点独立于此）。"""

    def __init__(self, ws):
        self.ws = ws
        self.wake_armed = True
        self.dialog_until = 0.0
        self.speak_task = None
        self.current_utterance = None
        self.status_task = None

    async def send(self, _type, payload=None, _id=None):
        frame = {"v": PROTOCOL_VERSION, "id": _id or f"e{now_ms()}", "type": _type, "ts": now_ms(), "payload": payload or {}}
        await self.ws.send(json.dumps(frame, ensure_ascii=False))

    def set_state(self, to, reason):
        if to == ENGINE_STATE["state"]:
            return None
        frm = ENGINE_STATE["state"]
        ENGINE_STATE["state"] = to
        return {"from": frm, "to": to, "reason": reason}

    async def emit_state(self, to, reason):
        st = self.set_state(to, reason)
        if st:
            await self.send("state", st)


# ── 假 TTS（D1 保留件，D4 换 Qwen3-TTS）───────────────────────────────
async def fake_speak(conn: Conn, p):
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
        await conn.emit_state("listening" if time.time() < conn.dialog_until else "idle", "tts-finished")
    except asyncio.CancelledError:
        reason = "barge_in" if getattr(conn.speak_task, "_barge", False) else "superseded"
        if reason == "barge_in":
            COUNTERS["barge_ins"] += 1
            await conn.send("tts.stopped", {"utterance_id": uid, "reason": "barge_in"})
            await conn.send("barge_in.detected", {"yield_ms": 85, "tts_played_ms": None})
            await conn.emit_state("listening", "barge-in")
        else:
            await conn.send("tts.stopped", {"utterance_id": uid, "reason": "superseded"})
        raise


# ── 假 ASR 事件族（debug 回归测试用；不触碰真流水线）──────────────────
async def inject_asr_fake(conn: Conn, p):
    text = str(p.get("text", ""))
    fake = CFG["fake"]
    await conn.emit_state("listening", "vad-start")
    await conn.send("vad.start", {})
    await asyncio.sleep(fake["asr_partial_ms"] / 1000)
    await conn.send("asr.partial", {"text": text[: max(1, len(text) // 2)]})
    await asyncio.sleep(fake["asr_partial_ms"] / 1000)
    await conn.send("asr.partial", {"text": text})
    await asyncio.sleep(fake["asr_final_ms"] / 1000)
    await conn.send("endpoint.acoustic", {"pause_ms": (PIPELINE["asr"].acoustic_ms if PIPELINE["asr"] else CFG["endpoint"]["acoustic_ms"])})
    COUNTERS["asr_finals"] += 1
    await conn.send("asr.final", {"text": text, "confidence": 0.97, "emotion": {"label": "neutral", "conf": 0.91}})


# ── 真件音频路由（麦克风 + WAV 注入 → AsrPipeline → WS 帧）────────────
class Router:
    """把音频帧喂进真流水线，把事件翻译成协议帧。整个 DSH 连接一个实例。"""

    def __init__(self, conn: Conn, loop: asyncio.AbstractEventLoop):
        self.conn = conn
        self.loop = loop
        self.audio_q = asyncio.Queue(maxsize=200)
        self.mic = None
        self.injecting = False
        self.feeder_task = None

    async def start(self):
        if PIPELINE["mode"] != "real" or not PIPELINE["asr"]:
            return
        if CFG["mic"]["enabled"]:
            self.mic = MicSource(self.loop, self.audio_q)
            if not self.mic.start():
                PIPELINE["mic_error"] = self.mic.error
                await self.conn.send("engine.error", {"code": "E_MIC_BUSY", "message": f"麦克风不可用：{self.mic.error}", "degrade_hint": "check_device"})
                self.mic = None
        self.feeder_task = asyncio.create_task(self.feeder())
        self.ticker_task = asyncio.create_task(self.window_ticker())

    async def stop(self):
        for task in (self.feeder_task, getattr(self, "ticker_task", None)):
            if task:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self.feeder_task = None
        self.ticker_task = None
        if self.mic:
            self.mic.stop()
            self.mic = None
        while not self.audio_q.empty():
            try:
                self.audio_q.get_nowait()
            except asyncio.QueueEmpty:
                break

    def _pipeline_event_frames(self, ev):
        """AsrPipeline 事件 → 协议帧列表（顺序敏感：endpoint 在 final 前；state 迁移内联）。"""
        if not ev:
            return []
        frames = []
        if ev["type"] == "start":
            frames.append(("vad.start", {}))
            if ENGINE_STATE["state"] == "idle":
                ENGINE_STATE["state"] = "listening"
                frames.append(("state", {"from": "idle", "to": "listening", "reason": "vad-start"}))
        elif ev["type"] == "partial":
            frames.append(("asr.partial", {"text": ev["text"]}))
        elif ev["type"] == "final":
            if not ev.get("text"):
                # 纯唤醒词召唤/噪声端点：空文本不送 DSH（12 §五.3 拒识语义）
                if ENGINE_STATE["state"] == "listening":
                    frames.append(("state", {"from": "listening", "to": "listening", "reason": "empty-final"}))
                return frames
            frames.append(("endpoint.acoustic", {"pause_ms": PIPELINE["asr"].acoustic_ms}))
            frames.append(("asr.final", {"text": ev["text"], "confidence": None, "emotion": None, "speech_ms": ev.get("speech_ms")}))
            # 连续对话：每次 final 刷新免唤醒窗（12 §五.2 对话态全程免唤醒）
            self.conn.dialog_until = time.time() + CFG["wake"]["dialog_window_s"]
            frames.append(("state", {"from": ENGINE_STATE["state"], "to": "listening", "reason": "asr-final-window"}))
            ENGINE_STATE["state"] = "listening"
        return frames

    def _gate_enabled(self) -> bool:
        return bool(KWS["enabled"] and KWS["gate"] and PIPELINE["asr"])

    def _feed_block(self, block):
        """音频帧路由（26 §C.3）：idle 只过 KWS 门；唤醒/免唤醒窗/对话态 → ASR 直通。"""
        now = time.time()
        in_window = now < self.conn.dialog_until
        frames = []
        if not self._gate_enabled() or not self.conn.wake_armed or in_window or ENGINE_STATE["state"] == "listening":
            # KWS 未启用 / 主人关闭唤醒(全开档) / 窗内 / 对话态：ASR 直通
            frames.extend(self._pipeline_event_frames(PIPELINE["asr"].feed(block)))
        else:
            ev = KWS["gate"].feed(block)
            if ev:
                COUNTERS["wake_fires"] += 1
                self.conn.dialog_until = now + CFG["wake"]["dialog_window_s"]
                ENGINE_STATE["state"] = "listening"
                frames.append(("wake.detected", {"keyword": ev["keyword"], "confidence": None}))
                frames.append(("state", {"from": "idle", "to": "listening", "reason": "wake"}))
                # 当前块尾音可能带指令开头（「小寄小寄，今天……」）——同时喂 ASR，不漏字
                frames.extend(self._pipeline_event_frames(PIPELINE["asr"].feed(block)))
        return frames

    async def feeder(self):
        """麦克风帧 → 路由（注入期间暂停消费，避免混音）。"""
        while True:
            if self.injecting:
                await asyncio.sleep(0.02)
                continue
            try:
                block = await asyncio.wait_for(self.audio_q.get(), timeout=0.2)
            except asyncio.TimeoutError:
                continue
            for t, p in self._feed_block(block):
                await self.conn.send(t, p)
                if t == "asr.final":
                    COUNTERS["asr_finals"] += 1
                    COUNTERS["asr_reals"] += 1
                    LAST_ASR.update(text=p["text"], at=time.time())

    async def window_ticker(self):
        """免唤醒窗到期巡检：listening 且窗过期 → 回 idle（12 §五.2 窗口语义）。"""
        while True:
            await asyncio.sleep(0.5)
            if ENGINE_STATE["state"] == "listening" and time.time() > self.conn.dialog_until and not self.conn.speak_task:
                ENGINE_STATE["state"] = "idle"
                await self.conn.send("state", {"from": "listening", "to": "idle", "reason": "window-expired"})

    async def inject_wav(self, path, speed=0.0):
        """WAV 注入：走同一条路由（含 KWS 门控），确定性测试/自检通道。"""
        self.injecting = True
        try:
            src = WavInjectSource(path, speed=speed)

            def feed(block):
                self._pending_frames.extend(self._feed_block(block))

            self._pending_frames = []
            await src.run(feed, lambda: None)
            for t, p in self._pending_frames:
                await self.conn.send(t, p)
                if t == "asr.final":
                    COUNTERS["asr_finals"] += 1
                    COUNTERS["asr_reals"] += 1
                    LAST_ASR.update(text=p["text"], at=time.time())
        except Exception as e:
            await self.conn.send("engine.error", {"code": "E_ASR_TIMEOUT", "message": f"WAV 注入失败：{e}", "degrade_hint": "retry"})
        finally:
            self.injecting = False


async def handler(ws):
    conn = Conn(ws)
    router = Router(conn, asyncio.get_running_loop())
    COUNTERS["connections"] += 1
    print(f"[voice-engine] DSH connected ({COUNTERS['connections']})", file=sys.stderr)

    async def status_loop():
        while True:
            await asyncio.sleep(30)
            await conn.send("engine.status", {"health": "ok", "mode": PIPELINE["mode"], "uptime_s": int(time.time() - START)})

    conn.status_task = asyncio.create_task(status_loop())
    try:
        await conn.send("engine.ready", {
            "models": (["funasr-streaming-paraformer-zh-en"] if PIPELINE["mode"] == "real" else [])
                + (["kws-zipformer-wenetspeech-3.3M"] if KWS["enabled"] else []) + ["fake-tts"],
            "device": "cpu" if PIPELINE["mode"] == "real" else "skeleton",
            "asr_mode": PIPELINE["mode"],
            "kws": "on" if KWS["enabled"] else "off",
            "mic": ("ok" if router.mic else (PIPELINE["mic_error"] or "off")),
        })
        await router.start()
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype, mid, p = msg.get("type"), msg.get("id"), msg.get("payload") or {}
            if mtype == "session.hello":
                if msg.get("v") != PROTOCOL_VERSION:
                    await conn.send("engine.error", {"code": "E_PROTOCOL", "message": f"protocol v{msg.get('v')} != v{PROTOCOL_VERSION}", "degrade_hint": "restart_engine"}, _id=mid)
            elif mtype == "ping":
                await conn.send("pong", {"t": p.get("t")}, _id=mid)
            elif mtype == "wake.set":
                conn.wake_armed = bool(p.get("armed", True))
            elif mtype == "dialog_window.open":
                conn.dialog_until = time.time() + (p.get("ms", 30000) / 1000)
            elif mtype == "endpoint.set":
                if p.get("acoustic_ms") and PIPELINE["asr"]:
                    PIPELINE["asr"].set_acoustic_ms(int(p["acoustic_ms"]))
            elif mtype == "tts.speak":
                if conn.speak_task:
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
                conn.speak_task = asyncio.create_task(fake_speak(conn, p))
            elif mtype == "tts.stop":
                if conn.speak_task:
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
            elif mtype == "mic.set":
                if PIPELINE["mode"] == "real":
                    if p.get("muted") and router.mic:
                        router.mic.stop(); router.mic = None
                    elif not p.get("muted") and not router.mic:
                        router.mic = MicSource(router.loop, router.audio_q)
                        if not router.mic.start():
                            await conn.send("engine.error", {"code": "E_MIC_BUSY", "message": f"麦克风恢复失败：{router.mic.error}", "degrade_hint": "check_device"})
                            router.mic = None
            elif mtype == "asr.context":
                if p.get("hotwords"):
                    # 流式 paraformer 不吃热词（26 §8 决策点 3 挂起）；收下并如实记录
                    print(f"[voice-engine] hotwords accepted (no-op on paraformer): {p['hotwords']}", file=sys.stderr)
            elif mtype == "engine.shutdown":
                await conn.send("state", conn.set_state("idle", "shutdown") or {})
                await ws.close(code=1001)
                print("[voice-engine] graceful shutdown", file=sys.stderr)
                asyncio.get_running_loop().stop()
                return
            elif mtype == "debug.inject_wake" and CFG["debug"]:
                if conn.wake_armed:
                    await conn.send("wake.detected", {"keyword": p.get("keyword", "小寄小寄"), "confidence": 0.95})
                    conn.dialog_until = time.time() + 30
            elif mtype == "debug.inject_asr" and CFG["debug"]:
                await inject_asr_fake(conn, p)
            elif mtype == "debug.inject_bargein" and CFG["debug"]:
                if conn.speak_task:
                    conn.speak_task._barge = True
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
            elif mtype == "debug.inject_wav" and CFG["debug"]:
                await router.inject_wav(p.get("path", ""), float(p.get("speed", 0)))
    except websockets.ConnectionClosed:
        pass
    finally:
        await router.stop()
        conn.status_task.cancel()
        if conn.speak_task:
            conn.speak_task.cancel()
        ENGINE_STATE["state"] = "idle"
        print("[voice-engine] DSH disconnected; devices released, waiting for reconnect", file=sys.stderr)


# ── HTTP：healthz / metrics / OpenAI 兼容转写（仅回环）────────────────
def one_shot_transcribe(wav_bytes: bytes) -> dict:
    """整段 WAV → 文本（复用全局流水线；阻塞调用，跑在线程池）。"""
    import tempfile, os
    if PIPELINE["mode"] != "real" or not PIPELINE["asr"]:
        return {"error": {"message": "real ASR not available", "type": "engine_error", "code": 503}}
    tmp = None
    try:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.write(wav_bytes); tmp.close()
        samples, rate = load_wav_16k(tmp.name)
        pipe = PIPELINE["asr"]
        ev = None
        CHUNK = 16000 * 32 // 1000
        for i in range(0, len(samples), CHUNK):
            ev = pipe.feed(samples[i:i + CHUNK]) or ev
            if ev and ev["type"] == "final":
                break
        if not (ev and ev["type"] == "final"):
            ev = pipe.force_final()
        return {"text": (ev or {}).get("text", ""), "model": "funasr-streaming-paraformer-zh-en"}
    except Exception as e:
        return {"error": {"message": str(e), "type": "invalid_request_error", "code": 400}}
    finally:
        if tmp:
            try: os.unlink(tmp.name)
            except OSError: pass


class HttpApi(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, {"ok": True, "state": ENGINE_STATE["state"], "asr_mode": PIPELINE["mode"], "uptime_s": int(time.time() - START)})
        elif self.path == "/metrics":
            lines = [f"voice_{k} {v}" for k, v in COUNTERS.items()] + [f'voice_state{{s="{ENGINE_STATE["state"]}"}} 1']
            body = ("\n".join(lines) + "\n").encode()
            self.send_response(200); self.send_header("Content-Type", "text/plain; version=0.0.1")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/v1/audio/transcriptions":
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 50 * 1024 * 1024:
                return self._json(400, {"error": {"message": "body must be raw WAV bytes (1~50MB)", "code": 400}})
            wav_bytes = self.rfile.read(length)
            COUNTERS["http_transcriptions"] += 1
            result = one_shot_transcribe(wav_bytes)
            return self._json(503 if result.get("error", {}).get("code") == 503 else 200, result)
        return self._json(404, {"error": "not found"})

    def log_message(self, *a):
        pass


def init_kws():
    """唤醒门控初始化（D3）。缺件则降级：门控关闭 = ASR 全开（D2 行为），WARN 不静默。"""
    if not CFG["wake"].get("enabled", True):
        print("[voice-engine] KWS disabled by config; routing = always-ASR", file=sys.stderr)
        return
    try:
        KWS["gate"] = KwsGate(CFG["asr"]["models_dir"], CFG["wake"]["keywords_file"])
        KWS["enabled"] = True
        print(f"[voice-engine] KWS ready: zipformer-wenetspeech (int8) keywords={CFG['wake']['keywords_file']}", file=sys.stderr)
    except Exception as e:
        KWS["gate"] = None
        KWS["enabled"] = False
        print(f"[voice-engine] WARN: KWS unavailable ({e}); routing = always-ASR", file=sys.stderr)


def init_pipeline():
    """启动即装真流水线（auto：模型不全则回退 fake 并大声说明）。"""
    mode = CFG["asr"].get("mode", "auto")
    if mode == "fake":
        return
    try:
        PIPELINE["asr"] = AsrPipeline(CFG["asr"]["models_dir"], acoustic_ms=CFG["endpoint"]["acoustic_ms"])
        PIPELINE["mode"] = "real"
        print(f"[voice-engine] real ASR ready: funasr-streaming-paraformer (cpu) from {CFG['asr']['models_dir']}", file=sys.stderr)
    except Exception as e:
        if mode == "real":
            print(f"[voice-engine] FATAL: asr.mode=real but pipeline failed: {e}", file=sys.stderr)
            raise
        PIPELINE["asr"] = None
        PIPELINE["mode"] = "fake"
        print(f"[voice-engine] WARN: real ASR unavailable ({e}); falling back to FAKE mode", file=sys.stderr)


async def main():
    port, hport = CFG["port"], CFG["healthz_port"]
    init_pipeline()
    if PIPELINE["mode"] == "real":
        init_kws()
    server = ThreadingHTTPServer(("127.0.0.1", hport), HttpApi)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    async with websockets.serve(handler, "127.0.0.1", port, max_size=1 << 20):
        print(f"[voice-engine] up  ws=ws://127.0.0.1:{port}/voice  http=127.0.0.1:{hport}  asr={PIPELINE['mode']}  debug={CFG['debug']}", file=sys.stderr)
        await asyncio.Future()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    asyncio.run(main())
