"""Serve dist/ on 127.0.0.1 with cache headers that survive rebuilds.

The page must be revalidated every time, or a browser keeps an old index.html that
points at hashed assets the last build deleted (a blank page). Hashed assets never change,
so they are cached for good.
"""
import argparse
import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # Failed requests only; a line per click fills the journal.
        n = getattr(code, "value", code)
        if isinstance(n, int) and n >= 400:
            super().log_request(code, size)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=31741)
    p.add_argument("--dir", required=True)
    a = p.parse_args()
    if not os.path.isfile(os.path.join(a.dir, "index.html")):
        sys.exit(f"no build in {a.dir}: run npm run build")
    handler = functools.partial(Handler, directory=a.dir)
    with http.server.ThreadingHTTPServer(("127.0.0.1", a.port), handler) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
