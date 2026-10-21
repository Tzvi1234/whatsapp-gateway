"""HTTP over a unix domain socket. No TCP port is ever opened (ARCH §7.4: no inbound ports).

POST /transcribe   body = raw audio bytes (ogg/opus voice note), header X-Message-Id optional
                   -> 200 {"text", "duration_s", "elapsed_ms", "backend"}
GET  /health       -> 200 {"ok": true, "backend", "busy", "served", "rss_mb"}

Requests are handled one at a time (concurrency 1). The worker owns retries (retry once,
then relay with transcript null) — this service never retries on its own.
"""

from __future__ import annotations

import json
import os
import resource
import socketserver
import sys
import time
from http.server import BaseHTTPRequestHandler

from .backends import Backend

MAX_AUDIO_BYTES = 25 * 1024 * 1024


class _State:
    backend: Backend
    busy = False
    served = 0


def peak_rss_mb() -> float:
    # ru_maxrss is KiB on Linux
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1)


class Handler(BaseHTTPRequestHandler):
    server_version = "gateway-transcriber/0.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: D401 - never log paths/bodies with PII
        sys.stderr.write(json.dumps({"ts": time.time(), "event": "http", "status": args[1] if len(args) > 1 else None}) + "\n")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            return self._json(404, {"error": "not_found"})
        st: _State = self.server.state  # type: ignore[attr-defined]
        self._json(200, {"ok": True, "backend": st.backend.name, "busy": st.busy, "served": st.served, "rss_mb": peak_rss_mb()})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/transcribe":
            return self._json(404, {"error": "not_found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._json(400, {"error": "empty_body"})
        if length > MAX_AUDIO_BYTES:
            return self._json(413, {"error": "too_large"})
        audio = self.rfile.read(length)
        st: _State = self.server.state  # type: ignore[attr-defined]
        st.busy = True
        try:
            t = st.backend.transcribe(audio)
        except Exception as e:  # report the class only; never the audio or text
            return self._json(500, {"error": "transcription_failed", "detail": type(e).__name__})
        finally:
            st.busy = False
        st.served += 1
        sys.stderr.write(
            json.dumps({"ts": time.time(), "event": "transcribed", "duration_s": t.duration_s, "elapsed_ms": t.elapsed_ms, "backend": t.backend, "rss_mb": peak_rss_mb()})
            + "\n"
        )
        self._json(200, {"text": t.text, "duration_s": t.duration_s, "elapsed_ms": t.elapsed_ms, "backend": t.backend})


class UnixHTTPServer(socketserver.UnixStreamServer):
    # BaseHTTPRequestHandler expects a (host, port) client address
    def get_request(self):
        request, _ = super().get_request()
        return request, ("unix", 0)


def make_server(socket_path: str, backend: Backend) -> UnixHTTPServer:
    if os.path.exists(socket_path):
        os.unlink(socket_path)
    old = os.umask(0o077)
    try:
        srv = UnixHTTPServer(socket_path, Handler)
    finally:
        os.umask(old)
    os.chmod(socket_path, 0o600)
    state = _State()
    state.backend = backend
    srv.state = state  # type: ignore[attr-defined]
    return srv
