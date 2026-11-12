"""
Speech-to-text sidecar for vsl-statistic.

A tiny HTTP service around faster-whisper (CTranslate2, CPU, int8). The app
POSTs a video or audio file as the raw request body and gets back the
transcript and the detected language:

    POST /transcribe            body: the media file
    -> {"text": "...", "language": "es", "language_probability": 0.98,
        "duration": 61.2}
    GET /health                 -> {"ok": true, "model": "small"}

It only listens on the compose network — nothing outside the box reaches it.
One request is transcribed at a time: the CPU is shared with other apps on
the server, and the caller queues anyway.
"""

import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
THREADS = int(os.environ.get("WHISPER_THREADS", "2"))
PORT = int(os.environ.get("PORT", "9000"))
# Largest upload we accept; creatives are short, VSLs are tens of minutes.
MAX_BYTES = int(os.environ.get("WHISPER_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))

_model = None
_model_lock = threading.Lock()
_work_lock = threading.Lock()


def model() -> WhisperModel:
    global _model
    with _model_lock:
        if _model is None:
            print(f"loading whisper model {MODEL_NAME} ({THREADS} threads)", flush=True)
            _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=THREADS)
    return _model


def transcribe(path: str) -> dict:
    # vad_filter skips music-only stretches, which otherwise come back as
    # hallucinated "Thanks for watching!" lines.
    segments, info = model().transcribe(path, beam_size=5, vad_filter=True)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 1),
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL_NAME})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        chunked = self.headers.get("Transfer-Encoding", "").lower() == "chunked"
        if not chunked and length <= 0:
            self._json(400, {"error": "empty body"})
            return
        if length > MAX_BYTES:
            self._json(413, {"error": "file too large"})
            return

        with tempfile.NamedTemporaryFile(suffix=".media") as tmp:
            try:
                received = self._receive(tmp, length, chunked)
            except ValueError as exc:
                self._json(413, {"error": str(exc)})
                return
            tmp.flush()
            if received == 0:
                self._json(400, {"error": "empty body"})
                return
            try:
                with _work_lock:
                    result = transcribe(tmp.name)
            except Exception as exc:  # noqa: BLE001 — report any decoder failure
                self._json(422, {"error": f"transcription failed: {exc}"})
                return
        self._json(200, result)

    def _receive(self, tmp, length: int, chunked: bool) -> int:
        """Copy the body to disk without holding it in memory."""
        total = 0
        if chunked:
            while True:
                size = int(self.rfile.readline().strip() or b"0", 16)
                if size == 0:
                    self.rfile.readline()
                    break
                total += size
                if total > MAX_BYTES:
                    raise ValueError("file too large")
                tmp.write(self.rfile.read(size))
                self.rfile.readline()
            return total
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            tmp.write(chunk)
            total += len(chunk)
            remaining -= len(chunk)
        return total

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"whisper sidecar on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
