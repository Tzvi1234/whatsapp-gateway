"""Entry point: python -m transcriber

Env:
  TRANSCRIBER_SOCKET   unix socket path (default $XDG_RUNTIME_DIR/gateway-transcriber.sock)
  TRANSCRIBER_MODEL    default ivrit-ai/whisper-large-v3-turbo-ct2
  TRANSCRIBER_COMPUTE  default int8
  TRANSCRIBER_THREADS  default 4
  TRANSCRIBER_ZIPFORMER_DIR  optional local fallback model dir (sherpa-onnx)
"""

from __future__ import annotations

import json
import os
import sys
import time

from .backends import FallbackChain, WhisperBackend, ZipformerBackend
from .server import make_server, peak_rss_mb


def main() -> None:
    runtime = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    sock = os.environ.get("TRANSCRIBER_SOCKET", os.path.join(runtime, "gateway-transcriber.sock"))
    model = os.environ.get("TRANSCRIBER_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
    started = time.monotonic()
    primary = WhisperBackend(
        model,
        compute_type=os.environ.get("TRANSCRIBER_COMPUTE", "int8"),
        threads=int(os.environ.get("TRANSCRIBER_THREADS", "4")),
    )
    fallback = None
    zdir = os.environ.get("TRANSCRIBER_ZIPFORMER_DIR")
    if zdir:
        fallback = ZipformerBackend(zdir)
    srv = make_server(sock, FallbackChain(primary, fallback))
    sys.stderr.write(
        json.dumps({"event": "ready", "model": model, "load_ms": int((time.monotonic() - started) * 1000), "rss_mb": peak_rss_mb()}) + "\n"
    )
    srv.serve_forever()


if __name__ == "__main__":
    main()
