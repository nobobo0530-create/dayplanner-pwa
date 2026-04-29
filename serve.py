#!/usr/bin/env python3
import http.server, socketserver, os

PORT = 3001
os.chdir(os.path.join(os.path.dirname(__file__), 'public'))

MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png'}

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()
    def do_GET(self):
        p = self.path.split('?')[0]
        if not os.path.exists('.' + p) and '.' not in p.split('/')[-1]:
            self.path = '/index.html'
        ext = os.path.splitext(self.path.split('?')[0])[1]
        if ext in MIME: self.extensions_map[ext] = MIME[ext]
        super().do_GET()
    def log_message(self, *a): pass

print(f'http://localhost:{PORT}')
with socketserver.TCPServer(('', PORT), Handler) as s:
    s.serve_forever()
