import http.client
import json
import os
import socket
import tempfile
import threading
import unittest

from transcriber.backends import FallbackChain, Transcript
from transcriber.server import make_server


class FakeBackend:
    name = "fake"

    def __init__(self, fail=False):
        self.fail = fail
        self.calls = 0

    def transcribe(self, audio: bytes) -> Transcript:
        self.calls += 1
        if self.fail:
            raise RuntimeError("boom")
        return Transcript(text="שלום", duration_s=len(audio) / 1000.0, elapsed_ms=1, backend=self.name)


class UnixConn(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self.path_ = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path_)


class ServerTest(unittest.TestCase):
    def start(self, backend):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "t.sock")
        srv = make_server(path, backend)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return path

    def request(self, path, method, url, body=None):
        c = UnixConn(path)
        c.request(method, url, body=body)
        r = c.getresponse()
        return r.status, json.loads(r.read())

    def test_socket_is_private(self):
        path = self.start(FakeBackend())
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_transcribe_ok(self):
        path = self.start(FakeBackend())
        status, body = self.request(path, "POST", "/transcribe", b"x" * 3000)
        self.assertEqual(status, 200)
        self.assertEqual(body["text"], "שלום")
        self.assertEqual(body["duration_s"], 3.0)

    def test_empty_body_rejected(self):
        path = self.start(FakeBackend())
        status, body = self.request(path, "POST", "/transcribe", b"")
        self.assertEqual(status, 400)

    def test_failure_reports_class_only(self):
        path = self.start(FakeBackend(fail=True))
        status, body = self.request(path, "POST", "/transcribe", b"abc")
        self.assertEqual(status, 500)
        self.assertEqual(body, {"error": "transcription_failed", "detail": "RuntimeError"})

    def test_health(self):
        path = self.start(FakeBackend())
        status, body = self.request(path, "GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertFalse(body["busy"])

    def test_fallback_chain(self):
        primary, fb = FakeBackend(fail=True), FakeBackend()
        t = FallbackChain(primary, fb).transcribe(b"abcd")
        self.assertEqual(t.text, "שלום")
        self.assertEqual((primary.calls, fb.calls), (1, 1))


if __name__ == "__main__":
    unittest.main()
