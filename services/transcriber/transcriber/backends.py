"""Transcription backends.

Primary: faster-whisper (CTranslate2) int8 on CPU with ivrit-ai/whisper-large-v3-turbo-ct2,
language forced to Hebrew, model loaded once and kept resident.
Fallback: ivrit-ai zipformer via sherpa-onnx, only if installed and configured.
There is deliberately no paid/cloud backend here; Soniox lives behind an OFF flag in the worker.
"""

from __future__ import annotations

import os
import tempfile
import time
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Transcript:
    text: str
    duration_s: float
    elapsed_ms: int
    backend: str


class Backend(Protocol):
    name: str

    def transcribe(self, audio: bytes) -> Transcript: ...


class WhisperBackend:
    name = "faster-whisper"

    def __init__(self, model: str, compute_type: str = "int8", threads: int = 4, beam_size: int = 5):
        from faster_whisper import WhisperModel  # imported lazily so tests run without it

        self._model = WhisperModel(model, device="cpu", compute_type=compute_type, cpu_threads=threads)
        self._beam_size = beam_size

    def transcribe(self, audio: bytes) -> Transcript:
        started = time.monotonic()
        # PyAV decodes ogg/opus voice notes from a file path reliably; keep it in a private tmp dir.
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=True) as f:
            f.write(audio)
            f.flush()
            segments, info = self._model.transcribe(
                f.name,
                language="he",
                task="transcribe",
                beam_size=self._beam_size,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        return Transcript(
            text=text,
            duration_s=float(info.duration),
            elapsed_ms=int((time.monotonic() - started) * 1000),
            backend=self.name,
        )


class ZipformerBackend:
    name = "zipformer"

    def __init__(self, model_dir: str):
        import sherpa_onnx  # optional dependency

        self._recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(model_dir, "encoder.onnx"),
            decoder=os.path.join(model_dir, "decoder.onnx"),
            joiner=os.path.join(model_dir, "joiner.onnx"),
            tokens=os.path.join(model_dir, "tokens.txt"),
            num_threads=2,
        )

    def transcribe(self, audio: bytes) -> Transcript:
        import av  # PyAV, shipped with faster-whisper
        import numpy as np

        started = time.monotonic()
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=True) as f:
            f.write(audio)
            f.flush()
            container = av.open(f.name)
            resampler = av.AudioResampler(format="flt", layout="mono", rate=16000)
            chunks = []
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype="float32")
        stream = self._recognizer.create_stream()
        stream.accept_waveform(16000, samples)
        self._recognizer.decode_stream(stream)
        return Transcript(
            text=stream.result.text.strip(),
            duration_s=len(samples) / 16000.0,
            elapsed_ms=int((time.monotonic() - started) * 1000),
            backend=self.name,
        )


class FallbackChain:
    """Try the primary backend; on failure, use the fallback once (if configured)."""

    def __init__(self, primary: Backend, fallback: Backend | None = None):
        self.primary = primary
        self.fallback = fallback
        self.name = primary.name

    def transcribe(self, audio: bytes) -> Transcript:
        try:
            return self.primary.transcribe(audio)
        except Exception:
            if self.fallback is None:
                raise
            return self.fallback.transcribe(audio)
