"""
audio_source.py — 音频源抽象（M1-A D2，26 契约 C）。

两类源，喂同一个 AsrPipeline：
  - MicSource：真麦克风（sounddevice，16k mono，回调线程→asyncio 队列）
  - WavInjectSource：WAV 文件注入（测试/自检用；可加速回放——端点按样本计数，
    加速不改变端点语义，只压缩墙钟时间，便于自动化测延迟）

WAV 任意采样率自动线性重采样到 16k。找不到麦克风不致命：降级只留注入源。
"""
import asyncio
import wave
from pathlib import Path

import numpy as np


def load_wav_16k(path) -> tuple[np.ndarray, int]:
    """读 WAV → (float32 mono 16k, 原始采样率)。"""
    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        x = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sw == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"不支持的采样宽度 {sw}")
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if rate != 16000:
        t = np.arange(len(x), dtype=np.float64) / rate
        t16 = np.arange(0, t[-1], 1 / 16000, dtype=np.float64)
        x = np.interp(t16, t, x).astype(np.float32)
    return x, rate


class WavInjectSource:
    """WAV 注入源。speed=0 尽最快（纯处理延迟），speed=1 实时（体验测试）。"""

    def __init__(self, path, speed: float = 0.0, chunk_ms: int = 32):
        self.path = Path(path)
        self.speed = max(0.0, speed)
        self.chunk = int(16000 * chunk_ms / 1000)
        self.samples, _ = load_wav_16k(self.path)
        if not self.samples.size:
            raise ValueError(f"WAV 无音频数据：{self.path}")

    async def run(self, feed, done):
        """feed(np.ndarray) 逐块喂；结束调 done()。"""
        import time
        pos = 0
        total = len(self.samples)
        while pos < total:
            block = self.samples[pos:pos + self.chunk]
            pos += self.chunk
            t0 = time.perf_counter()
            feed(block)
            if self.speed > 0:
                target = (self.chunk / 16000) / self.speed
                cost = time.perf_counter() - t0
                if target > cost:
                    await asyncio.sleep(target - cost)
            else:
                await asyncio.sleep(0)  # 让事件循环喘口气
        # 尾部补 800ms 静音，保证端点触发（样本计数语义不受 speed 影响）
        silence = np.zeros(16000 * 800 // 1000, dtype=np.float32)
        pos = 0
        while pos < len(silence):
            block = silence[pos:pos + self.chunk]
            pos += self.chunk
            feed(block)
            if self.speed > 0:
                await asyncio.sleep((self.chunk / 16000) / self.speed)
            else:
                await asyncio.sleep(0)
        done()


class MicSource:
    """真麦克风源（sounddevice 回调线程 → asyncio）。找不到设备不抛异常，返回失败原因。"""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, chunk_ms: int = 32, device=None):
        self.loop = loop
        self.queue = queue
        self.chunk = int(16000 * chunk_ms / 1000)
        self.device = device          # 指定输入设备 index；None=系统默认
        self._stream = None
        self.error = None

    def start(self) -> bool:
        try:
            import sounddevice as sd
            self._stream = sd.InputStream(
                samplerate=16000, channels=1, dtype="int16",
                blocksize=self.chunk, callback=self._cb, device=self.device)
            self._stream.start()
            return True
        except Exception as e:  # 无麦克风/驱动问题：降级，不致命
            self.error = str(e)
            self._stream = None
            return False

    def _cb(self, indata, frames, time_info, status):
        if status:
            pass  # input overflow 等瞬时状态忽略
        block = indata[:, 0].copy()
        def _put():
            self.queue.put_nowait(block)
        try:
            self.loop.call_soon_threadsafe(_put)
        except RuntimeError:
            pass  # loop 已关

    def stop(self):
        if self._stream:
            try:
                self._stream.stop(); self._stream.close()
            finally:
                self._stream = None
