# COOP/COEP dev server for idTech3-web (adapted from CS-Web play/server.py).
# Serves the play/ tree with cross-origin isolation, HTTP Range (for streamfs pk3
# reads), and precompressed .br siblings. Usage: python3 shared/web/server.py [game]
#   game = rtcw|wolfet|jk2|jka (default rtcw) -> serves play/<game> as root.
import http.server, socketserver, os, re, sys, json

GAME = (sys.argv[1] if len(sys.argv) > 1 else 'rtcw').strip()
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'play', GAME)
ROOT = os.path.abspath(ROOT)
# Stable per-game port (keeps launch.json entries non-colliding); PORT env overrides.
_PORTS = {'rtcw': 8790, 'rtcwmp': 8791, 'wolfet': 8792, 'jk2': 8793, 'jka': 8794}
PORT = int(os.environ.get('PORT', _PORTS.get(GAME, 8790)))


class H(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def translate_path(self, path):
        # Root the server at play/<game> instead of CWD.
        rel = path.split('?', 1)[0].lstrip('/')
        return os.path.join(ROOT, rel)

    # idTech3-web: pk3 auto-discovery so the loader can lazily mount every pak present
    # (demo OR full retail: pak0..pakN, assets0..N, sp_pak*, mp_pak*, etc.) without any
    # hardcoded per-game filename list. GET /__paks?dir=main -> JSON array of *.pk3 names,
    # sorted the way the engine's FS_Startup expects (case-insensitive ascending).
    def do_GET(self):
        if self.path.split('?', 1)[0] == '/__paks':
            m = re.search(r'[?&]dir=([A-Za-z0-9_./-]+)', self.path)
            sub = (m.group(1) if m else 'main').strip('/')
            d = os.path.abspath(os.path.join(ROOT, sub))
            names = []
            if d.startswith(ROOT) and os.path.isdir(d):
                names = sorted((f for f in os.listdir(d) if f.lower().endswith('.pk3')),
                               key=str.lower)
            body = json.dumps(names).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def send_head(self):
        rng = self.headers.get('Range')
        path = self.translate_path(self.path)
        if rng and os.path.isfile(path):
            m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
            if m and (m.group(1) or m.group(2)):
                size = os.path.getsize(path)
                start = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2)))
                end = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
                end = min(end, size - 1)
                if start <= end:
                    f = open(path, 'rb'); f.seek(start)
                    self.send_response(206)
                    self.send_header('Content-Type', self.guess_type(path))
                    self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
                    self.send_header('Content-Length', str(end - start + 1))
                    self.send_header('Accept-Ranges', 'bytes')
                    self.end_headers()

                    class _Ranged:
                        def __init__(self, fp, n): self.fp, self.n = fp, n
                        def read(self, sz=-1):
                            if self.n <= 0: return b''
                            sz = self.n if sz < 0 else min(sz, self.n)
                            d = self.fp.read(sz); self.n -= len(d); return d
                        def close(self): self.fp.close()
                    return _Ranged(f, end - start + 1)
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%d' % os.path.getsize(path))
                self.end_headers()
                return None
        br = path + '.br'
        if (not path.endswith('.br') and os.path.isfile(path) and os.path.isfile(br)
                and os.path.getmtime(br) >= os.path.getmtime(path)
                and 'br' in self.headers.get('Accept-Encoding', '')):
            f = open(br, 'rb')
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Content-Length', str(os.fstat(f.fileno()).st_size))
            self.send_header('Content-Encoding', 'br')
            self.end_headers()
            return f
        return super().send_head()

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
print('idTech3-web dev server: http://localhost:%d/  (game=%s, root=%s)' % (PORT, GAME, ROOT))
socketserver.ThreadingTCPServer(('', PORT), H).serve_forever()
