#!/usr/bin/env python3
"""Squarewise static app + small, read-only chess-platform import proxy."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import time
import threading
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "4173"))
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("SQUAREWISE_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}
RATE_LIMIT = max(1, int(os.environ.get("SQUAREWISE_RATE_LIMIT", "20")))
RATE_WINDOW_SECONDS = max(60, int(os.environ.get("SQUAREWISE_RATE_WINDOW_SECONDS", "600")))
RATE_LOCK = threading.Lock()
RATE_HISTORY: dict[str, deque[float]] = {}
UA = "Squarewise personal chess trainer/1.0 (read-only PGN import)"
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")


def read_remote(url: str, headers: dict[str, str] | None = None, timeout: int = 20) -> bytes:
    request = Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def chesscom_games(username: str, limit: int, months: int) -> dict:
    safe_name = quote(username, safe="")
    profile_url = f"https://api.chess.com/pub/player/{safe_name}"
    try:
        profile = json.loads(read_remote(profile_url).decode("utf-8"))
        archives_url = f"https://api.chess.com/pub/player/{safe_name}/games/archives"
        archives = json.loads(read_remote(archives_url).decode("utf-8")).get("archives", [])
    except HTTPError as error:
        raise RuntimeError(f"Chess.com returned HTTP {error.code}. Check the username or try again later.") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError("Could not reach the Chess.com public games API. Check your connection and retry.") from error

    collected: list[dict] = []
    # The public archive list is chronological; walk newest-to-oldest and request one month at a time.
    for archive_url in reversed(archives[-months:]):
        parsed = urlparse(archive_url)
        if parsed.scheme != "https" or parsed.netloc != "api.chess.com":
            continue
        try:
            month_data = json.loads(read_remote(archive_url).decode("utf-8"))
        except HTTPError as error:
            if error.code == 429:
                raise RuntimeError("Chess.com rate-limited this import. Wait a little, then retry with fewer games.") from error
            continue
        except (URLError, TimeoutError, json.JSONDecodeError):
            continue
        month_games = month_data.get("games", [])
        month_games.sort(key=lambda game: int(game.get("end_time", 0) or 0), reverse=True)
        for game in month_games:
            if game.get("rules") not in (None, "chess"):
                continue
            pgn = game.get("pgn")
            if pgn:
                collected.append({"pgn": pgn, "url": game.get("url", ""), "end_time": game.get("end_time", 0)})
                if len(collected) >= limit:
                    break
        if len(collected) >= limit:
            break
        # Serial requests are friendlier to the published API than parallel archive downloads.
        time.sleep(0.12)

    if not collected:
        raise RuntimeError("No standard chess PGNs were found in the requested Chess.com archives.")
    pgn_text = "\n\n".join(item["pgn"].strip() for item in collected)
    return {
        "provider": "chess.com",
        "username": profile.get("username", username),
        "count": len(collected),
        "pgn": pgn_text,
        "profileUrl": profile.get("url", ""),
    }


def lichess_games(username: str, limit: int, token: str = "") -> dict:
    safe_name = quote(username, safe="")
    query = f"max={limit}&moves=true&opening=true&clocks=true&evals=true&variant=standard"
    url = f"https://lichess.org/api/games/user/{safe_name}?{query}"
    headers = {"Accept": "application/x-chess-pgn"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        pgn_text = read_remote(url, headers=headers, timeout=45).decode("utf-8", errors="replace").strip()
    except HTTPError as error:
        if error.code in (401, 403):
            raise RuntimeError("Lichess rejected the token or this account’s game access. Check the token and required read-game permission.") from error
        if error.code == 429:
            raise RuntimeError("Lichess rate-limited this import. Wait briefly, then retry with fewer games.") from error
        raise RuntimeError(f"Lichess returned HTTP {error.code}. Check the username or try again later.") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError("Could not reach the Lichess game-export API. Check your connection and retry.") from error
    if not pgn_text:
        raise RuntimeError("No games were returned for this Lichess username and filter.")
    return {"provider": "lichess", "username": username, "pgn": pgn_text}


def origin_allowed(origin: str) -> bool:
    """Allow same-origin/local requests; restrict browser Origins when a list is configured."""
    return not origin or not ALLOWED_ORIGINS or origin.rstrip("/") in ALLOWED_ORIGINS


def request_ip(handler) -> str:
    """Best-effort client key for the in-memory public-import throttle behind a proxy."""
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded.strip():
        return forwarded.split(",", 1)[0].strip()[:80]
    return str(handler.client_address[0])


def allow_import_request(client: str) -> bool:
    now = time.monotonic()
    with RATE_LOCK:
        history = RATE_HISTORY.setdefault(client or "unknown", deque())
        while history and now - history[0] >= RATE_WINDOW_SECONDS:
            history.popleft()
        if len(history) >= RATE_LIMIT:
            return False
        history.append(now)
        if len(RATE_HISTORY) > 5000:
            expired = [key for key, entries in RATE_HISTORY.items() if not entries or now - entries[-1] >= RATE_WINDOW_SECONDS]
            for key in expired:
                RATE_HISTORY.pop(key, None)
    return True


class Handler(SimpleHTTPRequestHandler):
    server_version = "Squarewise/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json({"ok": True, "service": "Squarewise import API"})
        return super().do_GET()

    def do_OPTIONS(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/import/chesscom", "/api/import/lichess"):
            return self._json({"error": "Unknown API endpoint."}, 404)
        origin = self.headers.get("Origin", "").rstrip("/")
        if not origin or origin not in ALLOWED_ORIGINS:
            return self._json({"error": "This frontend origin is not allowed for cross-origin imports."}, 403)
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/import/chesscom", "/api/import/lichess"):
            return self._json({"error": "Unknown API endpoint."}, 404)
        origin = self.headers.get("Origin", "")
        if not origin_allowed(origin):
            return self._json({"error": "This frontend origin is not allowed to use the import API."}, 403)
        if not allow_import_request(request_ip(self)):
            return self._json({"error": "Too many import requests. Wait briefly, then try again."}, 429)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 64_000:
                return self._json({"error": "Request body is empty or too large."}, 413)
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            username = str(data.get("username", "")).strip()
            if not username or not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", username):
                return self._json({"error": "Enter a valid public username (letters, numbers, dot, underscore, or hyphen)."}, 400)
            limit = max(1, min(int(data.get("maxGames", 60)), 300))
            if parsed.path.endswith("chesscom"):
                months = max(1, min(int(data.get("months", 12)), 36))
                return self._json(chesscom_games(username, limit, months))
            token = str(data.get("token", "")).strip()
            if len(token) > 400:
                return self._json({"error": "The Lichess token looks too long."}, 400)
            return self._json(lichess_games(username, limit, token))
        except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
            return self._json({"error": "Could not read that import request."}, 400)
        except RuntimeError as error:
            return self._json({"error": str(error)}, 502)
        except Exception:
            return self._json({"error": "The import failed unexpectedly. Check the username, then retry."}, 500)

    def log_message(self, format, *args):
        # Keep user-supplied tokens and large PGN data out of logs; only log method/path/status.
        super().log_message(format, *args)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Squarewise running on http://0.0.0.0:{PORT}")
    server.serve_forever()
