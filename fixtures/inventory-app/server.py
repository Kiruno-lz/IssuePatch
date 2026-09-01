from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import json
import os

ROOT = Path(__file__).parent
ITEMS = [f"Item {i}" for i in range(1, 11)]
PAGE_SIZE = 5


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            body = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/api/items":
            page = int(parse_qs(parsed.query).get("page", ["1"])[0])
            start = (page - 1) * PAGE_SIZE
            payload = {"page": page, "pages": 2, "items": ITEMS[start:start + PAGE_SIZE]}
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_error(404)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "3000"))), Handler).serve_forever()
