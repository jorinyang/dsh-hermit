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
import re
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
from tts import TtsEngine  # noqa: E402
from qwen_tts import QwenTtsEngine  # noqa: E402

PROTOCOL_VERSION = 1
HERE = Path(__file__).resolve().parent


def load_config():
    cfg = {
        "port": 8300, "healthz_port": 8301, "debug": True,
        "asr": {"mode": "auto", "models_dir": str(HERE.parent.parent / "models" / "voice")},
        "mic": {"enabled": True},
        "endpoint": {"acoustic_ms": 600, "semantic_wait_ms": 1200, "semantic_enabled": False},
        "wake": {"enabled": True, "engine": "sherpa-onnx", "keywords_file": "configs/kws-keywords.txt", "dialog_window_s": 30},
        "tts": {
            "engine": "auto",  # qwen3(CUDA) | sherpa(CPU) | auto(qwen3→sherpa→fake) | fake
            "voice": "zf_xiaoni", "speed": 1.0,
            "qwen3": {
                "exe": "runtime/qwentts.cpp/build/tts-server.exe",
                "talker": "models/voice/qwen3-tts/qwen-talker-0.6b-base-Q8_0.gguf",
                "codec": "models/voice/qwen3-tts/qwen-tokenizer-12hz-Q8_0.gguf",
                "cuda_bin": "runtime/mamba/envs/cuda/Library/bin",
                "host": "127.0.0.1", "port": 8310, "lang": "Chinese",
            },
        },
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
            for k in ("asr", "mic", "endpoint", "fake", "wake", "tts"):
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
        q3 = cfg["tts"].get("qwen3", {})
        for k in ("exe", "talker", "codec", "cuda_bin"):
            v = q3.get(k, "")
            if v and not Path(v).is_absolute():
                q3[k] = str((root / v).resolve())
    except Exception as e:
        print(f"[voice-engine] config fallback: {e}", file=sys.stderr)
    return cfg


CFG = load_config()
COUNTERS = {"connections": 0, "asr_finals": 0, "asr_reals": 0, "tts_finished": 0, "barge_ins": 0, "http_transcriptions": 0, "wake_fires": 0}
ENGINE_STATE = {"state": "idle"}
START = time.time()
PIPELINE = {"asr": None, "mode": "fake", "mic_error": None, "mic_count": 0}  # 全局单例：WS 会话与 HTTP 端点共用（mic_count 引用计数，多连接不误判）
KWS = {"gate": None, "enabled": False}  # 唤醒门控单例（D3）
TTS = {"engine": None, "ready": False, "engine_name": "fake-tts"}  # TTS 引擎单例（D4）
BARGIN = {"vad": None}  # barge-in 静音检测 VAD（silero，D4）
ASR_LOCK = asyncio.Lock()
LAST_ASR = {"text": "", "at": 0.0}
# 引擎开关（HTTP 可控，跨连接持久）：麦克风静音 / 唤醒模式（voice语音|hotkey按键|off关闭=免唤醒持续对话）/ 摄像头开关
TOGGLES = {"mic_muted": False, "wake_mode": "voice", "camera_enabled": False}
ACTIVE = {"router": None, "conn": None}   # 当前 WS 连接（HTTP 开关要作用到它）
LOOP = None   # 主 asyncio loop（HTTP TTS 播报在 loop 上调度 real_speak）

# ASR 唤醒词模糊匹配：蓝牙麦把「寄」(jì) 糊成 鸡/气/系/机 等翘舌音，ASR 转写也跟着糊。
# 用「小 + 翘舌音字」做宽松匹配（比 3.3M KWS 的精确 ppinyin 更鲁棒）。
WAKE_JQX = "鸡机记纪技寄几其器期齐系西喜溪席"
WAKE_RE = re.compile(f"小[{WAKE_JQX}]")

# 实时电平（供 /level 端点 + 侧边栏波形可视化）：feeder 写、HTTP 线程读
LEVEL_LOCK = threading.Lock()
LEVEL_HISTORY = []          # [(ts, rms)] 最近 ~3s，每 ~100ms 一个点
LEVEL_PEAK = {"value": 0.0, "at": 0.0}


def _push_level(rms: float):
    """把 ~100ms 窗口的 RMS 追加到全局电平历史（线程安全，保留最近 3s）。"""
    with LEVEL_LOCK:
        now = time.time()
        LEVEL_HISTORY.append((now, rms))
        cutoff = now - 3.0
        while LEVEL_HISTORY and LEVEL_HISTORY[0][0] < cutoff:
            LEVEL_HISTORY.pop(0)
        if rms > LEVEL_PEAK["value"]:
            LEVEL_PEAK["value"] = rms
            LEVEL_PEAK["at"] = now


def now_ms():
    return int(time.time() * 1000)


def resolve_mic_device():
    """解析 mic.device 配置：auto/空→系统默认(None)；数字→指定输入设备 index。"""
    v = CFG["mic"].get("device")
    if v is None or v == "" or v == "auto":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class Conn:
    """单 WS 连接会话态（DSH 是唯一客户端；HTTP 端点独立于此）。"""

    def __init__(self, ws):
        self.ws = ws
        self.wake_mode = TOGGLES.get("wake_mode", "voice")
        self.dialog_until = 0.0
        self.speak_task = None
        self.current_utterance = None
        self.status_task = None
        self.speak_active = False        # 正在播报（barge-in 监听窗口）
        self.barge_signal = threading.Event()  # 线程安全：VAD 命中 → 停播
        self.barge_speech_at = None      # 首次检测到主人语音的时间戳（算 yield_ms）

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


# ── 真件 TTS 播报 + barge-in（D4）────────────────────────────────────
def _play_blocking(samples, rate, conn):
    """阻塞播放（跑在 executor 线程）；conn.barge_signal set → 立即停，返回 (status, played_ms, stop_time)。

    32ms 小块写入，每块之间查 barge_signal → 反应粒度 ~32ms，满足 100ms 让麦（12 §4.1）。
    """
    import sounddevice as sd
    chunk = max(rate // 32, 512)
    stream = sd.OutputStream(samplerate=rate, channels=1, dtype="float32")
    stream.start()
    pos = 0
    try:
        while pos < len(samples):
            if conn.barge_signal.is_set():
                return "barged", int(pos / rate * 1000), time.time()
            end = min(pos + chunk, len(samples))
            stream.write(samples[pos:end])
            pos = end
        # 尾部排空（sounddevice write 已阻塞到送入缓冲；再小睡保证播完）
        stream.stop()
        stream.close()
        return "done", int(len(samples) / rate * 1000), time.time()
    finally:
        try:
            stream.stop()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass


def split_zh_sentences(text: str) -> list:
    """中文文本按句末标点切句（。！？；…）；过短碎片并入前句；无标点长句保持单句。"""
    text = str(text or "").strip()
    if not text:
        return []
    parts = re.split(r"(?<=[。！？；…])", text)
    parts = [p.strip() for p in parts if p.strip()]
    merged = []
    for p in parts:
        if merged and len(p) < 4 and not p[-1] in "。！？；…":
            merged[-1] += p
        else:
            merged.append(p)
    return merged


def _play_sentences_streaming(conn, tts, sentences, first_samples, speed, chunk=1024):
    """分句流式播报（executor 线程）：先播首句，后续句子边合成边续播；barge 可打断。
    26 §A.4「流式续接」的引擎侧实现（v1 协议不变：speak 整发，引擎内部分句）。"""
    rate = tts.sample_rate
    stream = sd.OutputStream(samplerate=rate, channels=1, dtype="float32")
    stream.start()
    total = 0

    def write_all(samples):
        nonlocal total
        pos = 0
        while pos < len(samples):
            if conn.barge_signal.is_set():
                return False
            end = min(pos + chunk, len(samples))
            stream.write(samples[pos:end])
            pos = end
        total += len(samples)
        return True

    try:
        if not write_all(first_samples):
            return "barged", int(total / rate * 1000), time.time()
        for sent in sentences[1:]:
            if conn.barge_signal.is_set():
                return "barged", int(total / rate * 1000), time.time()
            samples = tts.synthesize(sent, speed)
            if not write_all(samples):
                return "barged", int(total / rate * 1000), time.time()
        stream.stop()
        stream.close()
        return "done", int(total / rate * 1000), time.time()
    finally:
        try:
            stream.stop()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass


async def real_speak(conn: Conn, p):
    """真 TTS（分句流式）：按句末标点切句 → 首句合成完即报 started 并开播 → 后续逐句续播（barge 可打断）→ tts.finished。"""
    uid = p.get("utterance_id", "")
    text = str(p.get("text", ""))
    tts = TTS["engine"]
    loop = asyncio.get_running_loop()
    conn.barge_signal.clear()
    conn.barge_speech_at = None
    if BARGIN["vad"]:
        BARGIN["vad"].reset()
    try:
        sentences = split_zh_sentences(text) or [text]
        speed = float(p.get("rate", 1.0) or 1.0)
        t0 = time.time()
        first_samples = await loop.run_in_executor(None, tts.synthesize, sentences[0], speed)
        first_ms = int((time.time() - t0) * 1000)
        rate = tts.sample_rate
        await conn.send("tts.started", {"utterance_id": uid, "first_packet_ms": first_ms, "sentences": len(sentences)})
        await conn.emit_state("speaking", "tts-started")
        conn.speak_active = True
        status, played_ms, stop_time = await loop.run_in_executor(
            None, _play_sentences_streaming, conn, tts, sentences, first_samples, speed)
        conn.speak_active = False
        if status == "barged":
            COUNTERS["barge_ins"] += 1
            yield_ms = int((stop_time - conn.barge_speech_at) * 1000) if conn.barge_speech_at else None
            await conn.send("tts.stopped", {"utterance_id": uid, "reason": "barge_in", "yield_ms": yield_ms, "tts_played_ms": played_ms})
            await conn.send("barge_in.detected", {"yield_ms": yield_ms, "tts_played_ms": played_ms})
            await conn.emit_state("listening", "barge-in")
        else:
            COUNTERS["tts_finished"] += 1
            await conn.send("tts.finished", {"utterance_id": uid, "duration_ms": played_ms, "first_packet_ms": first_ms})
            await conn.emit_state("listening" if time.time() < conn.dialog_until else "idle", "tts-finished")
    except asyncio.CancelledError:
        conn.speak_active = False
        if getattr(conn.speak_task, "_barge", False):
            COUNTERS["barge_ins"] += 1
            await conn.send("tts.stopped", {"utterance_id": uid, "reason": "barge_in", "yield_ms": None, "tts_played_ms": None})
            await conn.send("barge_in.detected", {"yield_ms": None, "tts_played_ms": None})
            await conn.emit_state("listening", "barge-in")
        else:
            await conn.send("tts.stopped", {"utterance_id": uid, "reason": "superseded"})
        raise
    except Exception as e:
        conn.speak_active = False
        await conn.send("engine.error", {"code": "E_TTS_TIMEOUT", "message": f"TTS 失败：{e}", "degrade_hint": "text_only"})
        await conn.emit_state("listening" if time.time() < conn.dialog_until else "idle", "tts-error")


# ── 假 TTS（TTS 未就绪时的降级件，D1 保留）───────────────────────────
async def fake_speak(conn: Conn, p):
    uid = p.get("utterance_id", "")
    text = str(p.get("text", ""))
    fake = CFG["fake"]
    try:
        await asyncio.sleep(fake["tts_first_ms"] / 1000)
        await conn.send("tts.started", {"utterance_id": uid, "first_packet_ms": fake["tts_first_ms"]})
        await conn.emit_state("speaking", "tts-started")
        conn.speak_active = True
        duration = min(6.0, max(0.5, 0.4 + len(text) * fake["tts_per_char_ms"] / 1000))
        await asyncio.sleep(duration)
        conn.speak_active = False
        COUNTERS["tts_finished"] += 1
        await conn.send("tts.finished", {"utterance_id": uid, "duration_ms": int(duration * 1000)})
        await conn.emit_state("listening" if time.time() < conn.dialog_until else "idle", "tts-finished")
    except asyncio.CancelledError:
        conn.speak_active = False
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
        self._ep_timer = None   # 语义端点保持定时器（endpoint.acoustic → accept/extend/超时）
        # 每连接独立 KWS 门控（多实例/多会话各自一条 stream，避免共享 stream 音频交织导致唤醒失效）
        self.kws = None
        if KWS["enabled"]:
            try:
                self.kws = KwsGate(CFG["asr"]["models_dir"], CFG["wake"]["keywords_file"])
            except Exception as e:
                print(f"[voice-engine] WARN: per-conn KWS init failed: {e}", file=sys.stderr)

    async def start(self):
        if PIPELINE["mode"] != "real" or not PIPELINE["asr"]:
            return
        if CFG["mic"]["enabled"] and not TOGGLES.get("mic_muted", False):
            self.mic = MicSource(self.loop, self.audio_q, device=resolve_mic_device(), gain=CFG["mic"].get("gain", 1.0))
            if not self.mic.start():
                PIPELINE["mic_error"] = self.mic.error
                await self.conn.send("engine.error", {"code": "E_MIC_BUSY", "message": f"麦克风不可用：{self.mic.error}", "degrade_hint": "check_device"})
                self.mic = None
            else:
                PIPELINE["mic_count"] += 1
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
        self._cancel_ep_timer()
        if self.mic:
            self.mic.stop()
            self.mic = None
            PIPELINE["mic_count"] = max(0, PIPELINE["mic_count"] - 1)
        while not self.audio_q.empty():
            try:
                self.audio_q.get_nowait()
            except asyncio.QueueEmpty:
                break

    def _pipeline_event_frames(self, ev):
        """AsrPipeline 事件 → 协议帧列表（顺序敏感；语义模式：endpoint_acoustic 与 final 分离）。"""
        if not ev:
            return []
        frames = []
        t = ev["type"]
        if t == "start":
            frames.append(("vad.start", {}))
            if ENGINE_STATE["state"] == "idle":
                ENGINE_STATE["state"] = "listening"
                frames.append(("state", {"from": "idle", "to": "listening", "reason": "vad-start"}))
        elif t == "partial":
            frames.append(("asr.partial", {"text": ev["text"]}))
        elif t == "endpoint_acoustic":
            frames.append(("endpoint.acoustic", {"text": ev["text"], "pause_ms": ev["pause_ms"]}))
            self._start_ep_timer()
        elif t == "final":
            if not ev.get("text"):
                if ENGINE_STATE["state"] == "listening":
                    frames.append(("state", {"from": "listening", "to": "listening", "reason": "empty-final"}))
                return frames
            frames.append(("asr.final", {"text": ev["text"], "confidence": None, "emotion": None, "speech_ms": ev.get("speech_ms")}))
            self.conn.dialog_until = time.time() + CFG["wake"]["dialog_window_s"]
            frames.append(("state", {"from": ENGINE_STATE["state"], "to": "listening", "reason": "asr-final-window"}))
            ENGINE_STATE["state"] = "listening"
        return frames

    def _start_ep_timer(self):
        self._cancel_ep_timer()
        wait_s = CFG["endpoint"].get("semantic_wait_ms", 1200) / 1000.0
        self._ep_timer = self.loop.call_later(wait_s, self._finalize_endpoint)

    def _cancel_ep_timer(self):
        if self._ep_timer:
            self._ep_timer.cancel()
            self._ep_timer = None

    def _finalize_endpoint(self):
        self._ep_timer = None
        ev = PIPELINE["asr"].force_final()
        if ev:
            for t, p in self._pipeline_event_frames(ev):
                asyncio.ensure_future(self.conn.send(t, p))
                if t == "asr.final":
                    COUNTERS["asr_finals"] += 1
                    COUNTERS["asr_reals"] += 1
                    LAST_ASR.update(text=p["text"], at=time.time())
                    print(f"[voice-engine] ASR final: 「{p['text']}」", file=sys.stderr)

    def accept_endpoint(self):
        """DSH 语义复判「说完了」→ 立即 finalize。"""
        self._cancel_ep_timer()
        self._finalize_endpoint()

    def extend_endpoint(self):
        """DSH 语义复判「没说完」（拖延词）→ 延长等待至 semantic_wait_ms。"""
        self._cancel_ep_timer()
        self._start_ep_timer()

    def _gate_enabled(self) -> bool:
        return bool(KWS["enabled"] and self.kws and PIPELINE["asr"])

    def _feed_block(self, block):
        """音频帧路由（唤醒三态）：voice=语音唤醒检测 / hotkey=只等快捷键 / off=免唤醒持续对话。"""
        now = time.time()
        in_window = now < self.conn.dialog_until
        frames = []
        mode = self.conn.wake_mode
        if mode == "hotkey" and not in_window and ENGINE_STATE["state"] != "listening":
            # 按键唤醒：idle 态丢弃音频，只等右 Shift 快捷键触发唤醒
            return frames
        if mode == "off" or in_window or ENGINE_STATE["state"] == "listening":
            # 关闭唤醒（免唤醒持续对话，接收所有信息）/ 窗内 / 对话态：ASR 直通
            frames.extend(self._pipeline_event_frames(PIPELINE["asr"].feed(block)))
        else:
            # 语音唤醒：ASR 唤醒词检测（蓝牙麦糊「寄」音，用 paraformer 宽松匹配「小+翘舌音」）
            PIPELINE["asr"].feed(block)
            text = PIPELINE["asr"].current_text()
            m = WAKE_RE.search(text) if text else None
            if m:
                COUNTERS["wake_fires"] += 1
                self.conn.dialog_until = now + CFG["wake"]["dialog_window_s"]
                ENGINE_STATE["state"] = "listening"
                frames.append(("wake.detected", {"keyword": m.group(0), "confidence": None}))
                frames.append(("state", {"from": "idle", "to": "listening", "reason": "asr-wake"}))
                # 唤醒命中：丢弃已累积的唤醒词文本，指令从下一块开始识别（连读会漏首字，但转写干净）
                PIPELINE["asr"].reset()
        return frames

    def _barge_feed(self, block):
        """speaking 期间：mic 帧进 silero VAD，命中即置 barge_signal（本地闭环停播，不等 DSH）。"""
        if block.dtype != np.float32:
            block = block.astype(np.float32) / 32768.0
        vad = BARGIN["vad"]
        for i in range(0, len(block), 512):
            w = block[i:i + 512]
            if len(w) < 512:
                break
            vad.accept_waveform(w)
            if vad.is_speech_detected():
                if self.conn.barge_speech_at is None:
                    self.conn.barge_speech_at = time.time()
                self.conn.barge_signal.set()
                vad.reset()
                break

    async def feeder(self):
        """麦克风帧 → 路由（speaking 期只喂 barge VAD；注入期间暂停消费，避免混音）。"""
        hist_acc = 0.0
        hist_n = 0
        diag_acc = 0.0
        diag_n = 0
        diag_peak = 0.0
        diag_t = time.time()
        while True:
            if self.injecting:
                await asyncio.sleep(0.02)
                continue
            try:
                block = await asyncio.wait_for(self.audio_q.get(), timeout=0.2)
            except asyncio.TimeoutError:
                continue
            # 实时电平：每 ~100ms（3 个 32ms block）推一个点给 /level 波形可视化
            f = block.astype(np.float32) / 32768.0
            rms = float(np.mean(f ** 2))
            hist_acc += rms
            hist_n += 1
            if hist_n >= 3:
                _push_level((hist_acc / hist_n) ** 0.5)
                hist_acc = 0.0
                hist_n = 0
            # 诊断：1s 聚合（RMS/峰值）+ 响块即时告警（定位「声音到没到 KWS 门」）
            diag_acc += rms
            diag_n += 1
            diag_peak = max(diag_peak, float(np.max(np.abs(f))))
            rms_now = rms ** 0.5
            if rms_now >= 0.01:
                in_window = time.time() < self.conn.dialog_until
                print(f"[voice-engine] LOUD rms={rms_now:.4f} state={ENGINE_STATE['state']} mode={self.conn.wake_mode} window={in_window}", file=sys.stderr, flush=True)
            if time.time() - diag_t >= 1.0:
                print(f"[voice-engine] DIAG 1s rms={(diag_acc / max(diag_n, 1)) ** 0.5:.5f} peak={diag_peak:.4f} state={ENGINE_STATE['state']} mode={self.conn.wake_mode} qsize={self.audio_q.qsize()}", file=sys.stderr, flush=True)
                diag_acc = 0.0
                diag_n = 0
                diag_peak = 0.0
                diag_t = time.time()
            if self.conn.speak_active and BARGIN["vad"]:
                self._barge_feed(block)
                continue
            for t, p in self._feed_block(block):
                await self.conn.send(t, p)
                if t == "asr.final":
                    COUNTERS["asr_finals"] += 1
                    COUNTERS["asr_reals"] += 1
                    LAST_ASR.update(text=p["text"], at=time.time())
                    print(f"[voice-engine] ASR final: 「{p['text']}」", file=sys.stderr)
                elif t == "wake.detected":
                    print(f"[voice-engine] WAKE: {p.get('keyword')}", file=sys.stderr)
                elif t == "asr.partial":
                    print(f"[voice-engine] ASR partial: 「{p.get('text')}」", file=sys.stderr)
                elif t == "endpoint.acoustic":
                    print(f"[voice-engine] ENDPOINT cue: 「{p.get('text')}」 pause={p.get('pause_ms')}ms", file=sys.stderr)

    async def window_ticker(self):
        """免唤醒窗到期巡检：listening 且窗过期 → 回 idle（12 §五.2 窗口语义）。"""
        while True:
            await asyncio.sleep(0.5)
            if ENGINE_STATE["state"] == "listening" and time.time() > self.conn.dialog_until and not self.conn.speak_task:
                ENGINE_STATE["state"] = "idle"
                await self.conn.send("state", {"from": "listening", "to": "idle", "reason": "window-expired"})

    async def inject_mic(self, path, speed=0.0):
        """确定性 barge-in 测试：WAV 直接喂 barge VAD（模拟主人插话，无回声干扰）。"""
        if not BARGIN["vad"]:
            await self.conn.send("engine.error", {"code": "E_TTS_TIMEOUT", "message": "barge VAD 未就绪", "degrade_hint": "retry"})
            return
        try:
            src = WavInjectSource(path, speed=speed)

            def feed(block):
                if block.dtype != np.float32:
                    block = block.astype(np.float32) / 32768.0
                vad = BARGIN["vad"]
                for i in range(0, len(block), 512):
                    w = block[i:i + 512]
                    if len(w) < 512:
                        break
                    vad.accept_waveform(w)
                    if vad.is_speech_detected():
                        if self.conn.barge_speech_at is None:
                            self.conn.barge_speech_at = time.time()
                        self.conn.barge_signal.set()
                        vad.reset()
                        break

            await src.run(feed, lambda: None)
        except Exception as e:
            await self.conn.send("engine.error", {"code": "E_TTS_TIMEOUT", "message": f"mic 注入失败：{e}", "degrade_hint": "retry"})

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
    # 语义模式是全局管线状态：每连接复位到 config 默认，避免漏给「不响应 endpoint.acoustic」的原始客户端
    if PIPELINE["asr"]:
        PIPELINE["asr"].set_semantic(CFG["endpoint"].get("semantic_enabled", False))

    async def status_loop():
        while True:
            await asyncio.sleep(30)
            await conn.send("engine.status", {"health": "ok", "mode": PIPELINE["mode"], "uptime_s": int(time.time() - START)})

    conn.status_task = asyncio.create_task(status_loop())
    try:
        # 先握手 + 白名单检查，通过后才开麦（避免 53551 等非 4080 实例反复开麦抢设备/刷日志）
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=15)
        except asyncio.TimeoutError:
            await ws.close(code=1008)
            return
        try:
            hello = json.loads(raw)
        except Exception:
            await ws.close(code=1008)
            return
        home = str((hello.get("payload") or {}).get("home", ""))
        if hello.get("type") != "session.hello" or "dsh-hermit" not in home:
            # 非 4080 实例（如 53551 桌面的 hermit 预设）→ 待机而非拒绝：
            # 接受连接但不登记 ACTIVE、不开麦，避免客户端无限重连刷日志。
            print(f"[voice-engine] STANDBY non-hermit connection (home={home or '未标识'})", file=sys.stderr)
            await conn.send("engine.ready", {
                "models": [], "device": "standby", "asr_mode": "fake",
                "kws": "off", "tts": "off", "barge_vad": "off", "mic": "off",
                "standby": True,
            })
            try:
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue
                    if msg.get("type") == "ping":
                        await conn.send("pong", {"t": (msg.get("payload") or {}).get("t")}, _id=msg.get("id"))
            except Exception:
                pass
            return
        # 白名单通过 → 登记 ACTIVE 供 HTTP 开关作用，再开麦 + 上报 engine.ready
        ACTIVE["router"] = router
        ACTIVE["conn"] = conn
        await router.start()
        await conn.send("engine.ready", {
            "models": (["funasr-streaming-paraformer-zh-en"] if PIPELINE["mode"] == "real" else [])
                + (["kws-zipformer-wenetspeech-3.3M"] if KWS["enabled"] else [])
                + ([TTS["engine_name"]] if TTS["ready"] else ["fake-tts"]),
            "device": "cpu" if PIPELINE["mode"] == "real" else "skeleton",
            "asr_mode": PIPELINE["mode"],
            "kws": "on" if KWS["enabled"] else "off",
            "tts": "on" if TTS["ready"] else "off",
            "barge_vad": "on" if BARGIN["vad"] else "off",
            "mic": ("ok" if router.mic else (PIPELINE["mic_error"] or "off")),
        })
        if router.mic:
            import sounddevice as _sd
            _dev = resolve_mic_device()
            _devname = _sd.query_devices(_dev)["name"] if _dev is not None else "系统默认"
            print(f"[voice-engine] mic STARTED ok (device=[{_dev if _dev is not None else 'default'}] {_devname})", file=sys.stderr)
        else:
            print(f"[voice-engine] mic NOT started: {PIPELINE['mic_error'] or 'disabled'}", file=sys.stderr)
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            mtype, mid, p = msg.get("type"), msg.get("id"), msg.get("payload") or {}
            if mtype == "session.hello":
                # 已在握手阶段处理过，重复 hello 忽略
                pass
            elif mtype == "ping":
                await conn.send("pong", {"t": p.get("t")}, _id=mid)
            elif mtype == "wake.set":
                mode = p.get("mode")
                if mode in ("voice", "hotkey", "off"):
                    conn.wake_mode = mode
                    TOGGLES["wake_mode"] = mode
                else:
                    conn.wake_mode = "voice" if p.get("armed", True) else "off"
            elif mtype == "dialog_window.open":
                conn.dialog_until = time.time() + (p.get("ms", 30000) / 1000)
            elif mtype == "endpoint.set":
                if p.get("acoustic_ms") and PIPELINE["asr"]:
                    PIPELINE["asr"].set_acoustic_ms(int(p["acoustic_ms"]))
                if "semantic_mode" in p and PIPELINE["asr"]:
                    PIPELINE["asr"].set_semantic(bool(p["semantic_mode"]), int(p.get("semantic_wait_ms", 1200)))
            elif mtype == "endpoint.accept":
                router.accept_endpoint()
            elif mtype == "endpoint.extend":
                router.extend_endpoint()
            elif mtype == "tts.speak":
                if conn.speak_task:
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
                conn.speak_task = asyncio.create_task(real_speak(conn, p) if TTS["ready"] else fake_speak(conn, p))
            elif mtype == "tts.stop":
                if conn.speak_task:
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
            elif mtype == "mic.set":
                if PIPELINE["mode"] == "real":
                    if p.get("muted") and router.mic:
                        router.mic.stop(); router.mic = None; PIPELINE["mic_count"] = max(0, PIPELINE["mic_count"] - 1)
                    elif not p.get("muted") and not router.mic:
                        router.mic = MicSource(router.loop, router.audio_q, device=resolve_mic_device(), gain=CFG["mic"].get("gain", 1.0))
                        if not router.mic.start():
                            await conn.send("engine.error", {"code": "E_MIC_BUSY", "message": f"麦克风恢复失败：{router.mic.error}", "degrade_hint": "check_device"})
                            router.mic = None
                        else:
                            PIPELINE["mic_count"] += 1
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
                if conn.wake_mode != "off":
                    await conn.send("wake.detected", {"keyword": p.get("keyword", "小寄小寄"), "confidence": 0.95})
                    conn.dialog_until = time.time() + 30
            elif mtype == "debug.inject_asr" and CFG["debug"]:
                await inject_asr_fake(conn, p)
            elif mtype == "debug.inject_bargein" and CFG["debug"]:
                if conn.speak_task:
                    conn.speak_task._barge = True
                    if TTS["ready"]:
                        # 真件：走真实停播机制（barge_signal 让 _play_blocking 收手，不依赖 task cancel）
                        if conn.barge_speech_at is None:
                            conn.barge_speech_at = time.time()
                        conn.barge_signal.set()
                    conn.speak_task.cancel()
                    await asyncio.sleep(0)
            elif mtype == "debug.inject_mic" and CFG["debug"]:
                await router.inject_mic(p.get("path", ""), float(p.get("speed", 0)))
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
        if ACTIVE["router"] is router:
            ACTIVE["router"] = None
            ACTIVE["conn"] = None
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


def _set_mic_muted(muted: bool):
    """HTTP 开关：静音/恢复麦克风（作用于当前 WS 连接的 router）。"""
    TOGGLES["mic_muted"] = bool(muted)
    router = ACTIVE["router"]
    if router is None:
        return
    if muted and router.mic:
        router.mic.stop()
        router.mic = None
        PIPELINE["mic_count"] = max(0, PIPELINE["mic_count"] - 1)
        print("[voice-engine] mic muted (via HTTP)", file=sys.stderr, flush=True)
    elif not muted and not router.mic:
        router.mic = MicSource(router.loop, router.audio_q, device=resolve_mic_device(), gain=CFG["mic"].get("gain", 1.0))
        if router.mic.start():
            PIPELINE["mic_count"] += 1
            print("[voice-engine] mic unmuted (via HTTP)", file=sys.stderr, flush=True)
        else:
            PIPELINE["mic_error"] = router.mic.error
            router.mic = None


def _set_wake_mode(mode: str):
    """HTTP 开关：唤醒模式三态 voice(语音) / hotkey(按键) / off(关闭=免唤醒持续对话)。"""
    mode = mode if mode in ("voice", "hotkey", "off") else "voice"
    TOGGLES["wake_mode"] = mode
    if ACTIVE["conn"] is not None:
        ACTIVE["conn"].wake_mode = mode
    print(f"[voice-engine] wake_mode={mode} (via HTTP)", file=sys.stderr, flush=True)


def _set_camera_enabled(enabled: bool):
    """HTTP 开关：摄像头开关（MVP-2 占位，暂无真实摄像头，仅持久化状态）。"""
    TOGGLES["camera_enabled"] = bool(enabled)
    print(f"[voice-engine] camera enabled={bool(enabled)} (via HTTP)", file=sys.stderr, flush=True)


def _trigger_wake(keyword: str = "快捷键"):
    """HTTP 唤醒快捷键：触发一次唤醒（开窗 + 状态 listening + 发 wake.detected），作用于 ACTIVE 连接。
    全部动作调度到主 loop（ASR 非线程安全，避免与 feeder 竞态）。"""
    conn = ACTIVE["conn"]
    loop = LOOP
    if conn is None or loop is None or loop.is_closed():
        return {"ok": False, "error": "no active connection"}

    def _schedule():
        async def _do():
            COUNTERS["wake_fires"] += 1
            conn.dialog_until = time.time() + CFG["wake"]["dialog_window_s"]
            ENGINE_STATE["state"] = "listening"
            if PIPELINE["asr"]:
                PIPELINE["asr"].reset()
            await conn.send("wake.detected", {"keyword": keyword, "confidence": None})
            await conn.send("state", {"from": "idle", "to": "listening", "reason": "hotkey"})
            print(f"[voice-engine] WAKE (hotkey): {keyword}", file=sys.stderr, flush=True)
        asyncio.ensure_future(_do())

    loop.call_soon_threadsafe(_schedule)
    return {"ok": True}


def _http_tts_speak(payload: dict) -> dict:
    """HTTP 触发 TTS 播报：在主 loop 上对 ACTIVE 连接调度 real_speak（供 host 侧 voiceBridge 跨 realm 发声）。"""
    conn = ACTIVE["conn"]
    loop = LOOP
    if conn is None:
        return {"ok": False, "error": "no active connection"}
    if not TTS["ready"]:
        return {"ok": False, "error": "tts not ready"}
    if loop is None or loop.is_closed():
        return {"ok": False, "error": "loop not ready"}

    text = str(payload.get("text", "")).strip()
    if not text:
        return {"ok": False, "error": "empty text"}

    async def _schedule():
        if conn.speak_task:
            conn.speak_task.cancel()
            await asyncio.sleep(0)
        p = {
            "utterance_id": str(payload.get("utterance_id", "http_tts")),
            "text": text,
            "priority": str(payload.get("priority", "normal")),
            "source": str(payload.get("source", "arbiter")),
            "voice_preset": str(payload.get("voice_preset", CFG["tts"].get("voice", "zf_xiaoni"))),
            "rate": float(payload.get("rate", 1.0) or 1.0),
        }
        conn.speak_task = asyncio.create_task(real_speak(conn, p))

    loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_schedule()))
    return {"ok": True}


def _http_tts_stop(_payload: dict) -> dict:
    """HTTP 停止 TTS：取消 ACTIVE 连接正在进行的播报。"""
    conn = ACTIVE["conn"]
    loop = LOOP
    if conn is None or loop is None or loop.is_closed():
        return {"ok": False, "error": "no active connection"}

    def _cancel():
        if conn.speak_task:
            conn.speak_task.cancel()

    loop.call_soon_threadsafe(_cancel)
    return {"ok": True}


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
            self._json(200, {
                "ok": True,
                "state": ENGINE_STATE["state"],
                "asr_mode": PIPELINE["mode"],
                "uptime_s": int(time.time() - START),
                "modules": {
                    "mic": "ok" if PIPELINE["mic_count"] > 0 else (PIPELINE["mic_error"] or "off"),
                    "kws": "on" if KWS["enabled"] else "off",
                    "asr": PIPELINE["mode"],
                    "tts": "on" if TTS["ready"] else "off",
                    "barge_vad": "on" if BARGIN.get("vad") else "off",
                },
                "models": [
                    {"kind": "asr", "name": "funasr-streaming-paraformer-zh-en",
                     "status": "ok" if PIPELINE["mode"] == "real" else "fake"},
                    {"kind": "kws", "name": "kws-zipformer-wenetspeech-3.3M",
                     "status": "ok" if KWS["enabled"] else "off"},
                    {"kind": "tts", "name": TTS["engine_name"],
                     "status": "ok" if TTS["ready"] else "fake"},
                    {"kind": "vad", "name": "silero-vad",
                     "status": "ok" if BARGIN.get("vad") else "off"},
                ],
                "toggles": {"mic_muted": TOGGLES["mic_muted"], "wake_mode": TOGGLES["wake_mode"], "camera_enabled": TOGGLES["camera_enabled"]},
            })
        elif self.path == "/metrics":
            lines = [f"voice_{k} {v}" for k, v in COUNTERS.items()] + [f'voice_state{{s="{ENGINE_STATE["state"]}"}} 1']
            body = ("\n".join(lines) + "\n").encode()
            self.send_response(200); self.send_header("Content-Type", "text/plain; version=0.0.1")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif self.path == "/level":
            with LEVEL_LOCK:
                levels = [round(rms, 6) for _ts, rms in LEVEL_HISTORY]
                peak = round(LEVEL_PEAK["value"], 6)
                speaking = bool(levels) and levels[-1] >= 0.005
            self._json(200, {"ok": True, "levels": levels, "peak": peak, "speaking": speaking, "mic_active": PIPELINE["mic_count"] > 0})
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
        if self.path in ("/engine/mic", "/engine/wake", "/engine/camera"):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                body = {}
            if self.path == "/engine/mic":
                _set_mic_muted(not bool(body.get("on", True)))
                return self._json(200, {"ok": True, "mic_muted": TOGGLES["mic_muted"]})
            if self.path == "/engine/wake":
                _set_wake_mode(str(body.get("mode", "voice")))
                return self._json(200, {"ok": True, "wake_mode": TOGGLES["wake_mode"]})
            _set_camera_enabled(bool(body.get("on", True)))
            return self._json(200, {"ok": True, "camera_enabled": TOGGLES["camera_enabled"]})
        if self.path == "/engine/trigger_wake":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                body = {}
            r = _trigger_wake(str(body.get("keyword", "快捷键")))
            return self._json(200, r)
        if self.path in ("/engine/tts", "/engine/tts/stop"):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                body = {}
            if self.path == "/engine/tts":
                return self._json(200, _http_tts_speak(body))
            return self._json(200, _http_tts_stop(body))
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


def init_tts():
    """真件 TTS：Qwen3-TTS(CUDA) → sherpa vits-melo/kokoro(CPU) → fake 三级降级。"""
    sel = CFG["tts"].get("engine", "auto")

    # 1) Qwen3-TTS（CUDA，tts-server 子进程常驻 GPU）
    if sel in ("auto", "qwen3"):
        try:
            q = CFG["tts"].get("qwen3", {})
            TTS["engine"] = QwenTtsEngine(
                q["exe"], q["talker"], q["codec"],
                cuda_bin=q.get("cuda_bin"), host=q.get("host", "127.0.0.1"),
                port=q.get("port", 8310), lang=q.get("lang", "Chinese"))
            TTS["ready"] = True
            TTS["engine_name"] = "qwen3-tts-0.6b"
            print(f"[voice-engine] TTS ready: qwen3-tts-0.6b (cuda) via tts-server :{q.get('port', 8310)}", file=sys.stderr)
            return
        except Exception as e:
            if sel == "qwen3":
                TTS["engine"] = None
                TTS["ready"] = False
                TTS["engine_name"] = "fake-tts"
                print(f"[voice-engine] WARN: qwen3 TTS unavailable ({e}); falling back to fake-tts", file=sys.stderr)
                return
            print(f"[voice-engine] WARN: qwen3 TTS unavailable ({e}); falling back to sherpa cpu", file=sys.stderr)

    # 2) sherpa vits-melo / kokoro（CPU 兜底）
    if sel in ("auto", "sherpa"):
        try:
            TTS["engine"] = TtsEngine(CFG["asr"]["models_dir"], voice=CFG["tts"].get("voice", "zf_xiaoni"))
            TTS["ready"] = True
            TTS["engine_name"] = "vits-melo-tts-zh_en" if getattr(TTS["engine"], "engine", "") == "vits" else "kokoro-multi-lang-v1_0"
            print(f"[voice-engine] TTS ready: {TTS['engine_name']} (cpu) voice={TTS['engine'].voice} sid={TTS['engine'].sid}", file=sys.stderr)
            return
        except Exception as e:
            print(f"[voice-engine] WARN: sherpa TTS unavailable ({e}); falling back to fake-tts", file=sys.stderr)

    # 3) fake（真件全部缺件）
    TTS["engine"] = None
    TTS["ready"] = False
    TTS["engine_name"] = "fake-tts"
    print("[voice-engine] WARN: no TTS available; falling back to fake-tts", file=sys.stderr)


def init_barge():
    """barge-in 静音检测 VAD（silero，D4）。缺件则 barge-in 只走 debug.inject_bargein。"""
    try:
        import sherpa_onnx as so
        b = CFG.get("barge", {})
        silero = so.SileroVadModelConfig()
        silero.model = str(Path(CFG["asr"]["models_dir"]) / "silero_vad.onnx")
        silero.threshold = float(b.get("threshold", 0.5))
        silero.min_silence_duration = float(b.get("min_silence_duration", 0.3))
        silero.min_speech_duration = float(b.get("min_speech_duration", 0.1))
        cfg = so.VadModelConfig()
        cfg.silero_vad = silero
        cfg.sample_rate = 16000
        cfg.num_threads = 1
        cfg.provider = "cpu"
        BARGIN["vad"] = so.VoiceActivityDetector(cfg)
        print("[voice-engine] barge VAD ready: silero", file=sys.stderr)
    except Exception as e:
        BARGIN["vad"] = None
        print(f"[voice-engine] WARN: barge VAD unavailable ({e}); barge-in 走 debug.inject_bargein", file=sys.stderr)


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
    global LOOP
    port, hport = CFG["port"], CFG["healthz_port"]
    LOOP = asyncio.get_running_loop()
    init_pipeline()
    if PIPELINE["mode"] == "real":
        init_kws()
    init_tts()
    init_barge()
    server = ThreadingHTTPServer(("127.0.0.1", hport), HttpApi)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    async with websockets.serve(handler, "127.0.0.1", port, max_size=1 << 20):
        print(f"[voice-engine] up  ws=ws://127.0.0.1:{port}/voice  http=127.0.0.1:{hport}  asr={PIPELINE['mode']}  debug={CFG['debug']}", file=sys.stderr)
        await asyncio.Future()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    asyncio.run(main())
