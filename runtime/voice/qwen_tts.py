"""
qwen_tts.py — Qwen3-TTS GPU 引擎（经 tts-server HTTP，D4 之后的主 TTS）。

选型：Qwen3-TTS 0.6B（qwen-talker Q8_0 + 12Hz codec）跑在 qwentts.cpp 的 CUDA 后端
（RTX 5070 Ti，RTF ~0.15）。引擎进程内启动 tts-server.exe 子进程：模型常驻 GPU，
synthesize 走 HTTP POST /v1/audio/speech，24kHz mono float32 输出。

生命周期（A2 可逆）：__init__ 拉起子进程并等 /health；close() 回收子进程；
atexit 兜底 + tts-server 自带 SIGINT handler（Ctrl+C 同控台同收）。
"""
import atexit
import io
import json
import os
import subprocess
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
_LOG = HERE / "tts-server.log"


def _tail(path: Path, n_bytes: int = 4000) -> str:
    """读日志尾部（启动失败时给诊断线索）。"""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - n_bytes))
            return f.read().decode(errors="replace")[-n_bytes:]
    except OSError:
        return ""


def _wav_to_float32(wav_bytes: bytes):
    """RIFF WAV（S16 mono）→ float32 数组 + 采样率。"""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        data = w.readframes(n)
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0, sr


class QwenTtsEngine:
    def __init__(self, exe, talker, codec, cuda_bin=None, host="127.0.0.1",
                 port=8310, lang="Chinese", ready_timeout=90.0):
        self.exe = str(exe)
        self.host = host
        self.port = int(port)
        self.lang = lang
        self.sample_rate = 24000
        self.engine = "qwen3"
        self.voice = "qwen3-tts-0.6b"
        self.sid = 0
        self._proc = None

        for name, p in (("exe", exe), ("talker", talker), ("codec", codec)):
            if not Path(p).exists():
                raise FileNotFoundError(f"qwen3 TTS 缺件 {name}: {p}")

        # CUDA 运行时 DLL（cudart64_12.dll / cublas64_12.dll …）进 PATH，
        # ggml-cuda.dll 才能被 tts-server 加载。
        env = dict(os.environ)
        if cuda_bin and Path(cuda_bin).is_dir():
            env["PATH"] = str(cuda_bin) + os.pathsep + env.get("PATH", "")

        cmd = [str(exe), "--model", str(talker), "--codec", str(codec),
               "--host", host, "--port", str(self.port), "--lang", lang]
        logf = open(_LOG, "ab")
        try:
            self._proc = subprocess.Popen(cmd, env=env, stdout=logf, stderr=logf, bufsize=0)
        finally:
            logf.close()

        # 等就绪：模型加载到 GPU 需数秒；超时/早退给诊断
        deadline = time.time() + ready_timeout
        while time.time() < deadline:
            if self._proc.poll() is not None:
                raise RuntimeError(f"tts-server 启动即退（rc={self._proc.returncode}）：{_tail(_LOG)}")
            if self._health():
                atexit.register(self.close)
                return
            time.sleep(0.25)
        self.close()
        raise TimeoutError(f"tts-server {ready_timeout}s 内未就绪：{_tail(_LOG)}")

    def _url(self, path):
        return f"http://{self.host}:{self.port}{path}"

    def _health(self) -> bool:
        try:
            with urllib.request.urlopen(self._url("/health"), timeout=2) as r:
                return r.status == 200
        except Exception:
            return False

    def synthesize(self, text: str, speed: float = 1.0) -> np.ndarray:
        """整句合成 → float32 PCM（24kHz mono）。speed 被 tts-server 忽略（无变速）。"""
        if self._proc is None or self._proc.poll() is not None:
            raise RuntimeError("tts-server 已退出（需重启语音引擎）")
        payload = json.dumps({"input": text, "response_format": "wav", "speed": float(speed)}).encode("utf-8")
        req = urllib.request.Request(
            self._url("/v1/audio/speech"), data=payload,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.status != 200:
                raise RuntimeError(f"tts-server 合成失败：HTTP {r.status}")
            samples, sr = _wav_to_float32(r.read())
        self.sample_rate = int(sr)
        return samples

    def close(self):
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        self._proc = None

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
