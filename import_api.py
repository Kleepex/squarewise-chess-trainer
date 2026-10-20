#!/usr/bin/env python3
"""Public API-only entry point for deploying Squarewise's read-only import proxy."""
from __future__ import annotations

import os
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

from server import Handler


class ImportAPIHandler(Handler):
    """Expose only health and import routes; never serve the app or repository files."""

    server_version = "Squarewise-Import-API/1.0"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return super().do_GET()
        return self._json({"error": "Not found."}, 404)

    def do_HEAD(self):
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


def create_server(port: int | None = None) -> ThreadingHTTPServer:
    listen_port = int(port if port is not None else os.environ.get("PORT", "10000"))
    return ThreadingHTTPServer(("0.0.0.0", listen_port), ImportAPIHandler)


if __name__ == "__main__":
    httpd = create_server()
    print(f"Squarewise import API listening on 0.0.0.0:{httpd.server_address[1]}")
    httpd.serve_forever()
