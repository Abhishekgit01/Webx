"""Zero-dependency local server for the demo storefront and research form.

No CDNs, no external fonts, no network. The demo must work on bad conference Wi-Fi.
"""

from __future__ import annotations

import json
import os
import socket
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEMO_ROOT = Path(__file__).resolve().parent.parent / "demo"


class DemoRequestHandler(SimpleHTTPRequestHandler):
    server_version = "AegisDemo/1.0"

    def end_headers(self) -> None:
        if self.path.endswith((".html", "/")) or "?" not in self.path and "." not in self.path.rsplit("/", 1)[-1]:
            self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Aegis-Demo", "1")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path == "/health":
            payload = json.dumps({"ok": True, "service": "aegis-demo"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "/":
            self.send_response(302)
            self.send_header("Location", "/shop/")
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        if os.getenv("AEGIS_DEMO_LOG") == "1":
            super().log_message(format, *args)


class DemoServer:
    """Run the demo site on a background thread."""

    def __init__(self, host: str = "127.0.0.1", port: int = 4173) -> None:
        self.host = host
        self.port = port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "DemoServer":
        handler = partial(DemoRequestHandler, directory=str(DEMO_ROOT))
        try:
            self._httpd = ThreadingHTTPServer((self.host, self.port), handler)
        except OSError:
            # Port taken? Pick a free one rather than failing the demo.
            self._httpd = ThreadingHTTPServer((self.host, 0), handler)
        self.port = int(self._httpd.server_address[1])
        self._httpd.daemon_threads = True
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="aegis-demo", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def __enter__(self) -> "DemoServer":
        return self.start()

    def __exit__(self, *_exc) -> None:
        self.stop()


def free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])
