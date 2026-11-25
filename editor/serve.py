#!/usr/bin/env python3
"""Local server for the COMMAND ROOM editor (standard library only).

Serves the editor (editor/ + the renderer's vendored three.js) and the user's footage, which never leaves the PC:
  GET  /editor/...            the app
  GET  /api/sessions          recordings in --raw (manifest, the game's messages, and the inspector summary if one exists)
  GET  /raw/<name>.zip        a recording
  POST /api/upload?name=      a dropped zip -> --raw
  POST /api/export?name=      an exported video -> --edits
  GET  /api/projects, GET/POST /api/project?name=   saved edits in --projects

  python editor/serve.py --raw <footage/raw> --edits <footage/edits> --projects <footage/projects> [--sheets DIR] [--port 8577] [--open]
Listens on 127.0.0.1 only. Stops when its console window is closed (or Ctrl+C).
"""
import argparse
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
import zipfile
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the repo
ALLOWED = ('editor/', 'render/vendor/', 'render/page/')
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.json': 'application/json', '.ogg': 'audio/ogg', '.svg': 'image/svg+xml', '.png': 'image/png', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8',
         '.mp4': 'video/mp4', '.webm': 'video/webm'}
SAFE = re.compile(r'[^\w\-. ()]+')
cache = {}


def safe_name(name, ext=None):
    name = os.path.basename(urllib.parse.unquote(name or '')).strip()
    name = SAFE.sub('_', name).strip(' .')
    if not name:
        name = 'file'
    if ext and not name.lower().endswith(ext):
        name += ext
    return name


def unique(folder, name):
    base, ext = os.path.splitext(name)
    p, n = os.path.join(folder, name), 2
    while os.path.exists(p):
        p = os.path.join(folder, f'{base}-{n}{ext}')
        n += 1
    return p


def session_info(path, sheets):
    st = os.stat(path)
    key = (path, st.st_mtime, st.st_size)
    if key in cache:
        return cache[key]
    info = {'name': os.path.basename(path), 'size': st.st_size, 'mtime': st.st_mtime, 'manifest': None, 'messages': [], 'inspect': None}
    try:
        with zipfile.ZipFile(path) as z:
            m = json.loads(z.read('manifest.json'))
            info['manifest'] = {k: m.get(k) for k in ('format', 'version', 'title', 'durationSec', 'recorded', 'frames', 'status', 'commit')}
            info['manifest']['hasAudio'] = bool(m.get('audio') and m['audio'].get('file'))
            with z.open(m['files']['defs']) as f:
                for line in f:
                    if b'"k":"ev"' in line and b'"msg"' in line:
                        try:
                            d = json.loads(line)
                            info['messages'].append({'t': d['t'] / 1000.0, 'text': d.get('text', '')})
                        except Exception:
                            pass
    except Exception as e:
        info['error'] = str(e)
    if sheets:
        stem = os.path.splitext(os.path.basename(path))[0]
        ip = os.path.join(sheets, stem + '.inspect.json')
        if os.path.exists(ip):
            try:
                with open(ip, encoding='utf-8') as f:
                    j = json.load(f)
                info['inspect'] = {'runs': j.get('runs'), 'best': j.get('best'), 'totals': j.get('totals'), 'durationSec': j.get('durationSec')}
            except Exception:
                pass
    cache[key] = info
    return info


class Handler(BaseHTTPRequestHandler):
    server_version = 'CommandRoomEditor/1'

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write('  ' + fmt % args + '\n')

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b)

    def send_file(self, p):
        if not os.path.isfile(p):
            return self.send_error(404)
        size = os.path.getsize(p)
        self.send_response(200)
        self.send_header('Content-Type', TYPES.get(os.path.splitext(p)[1].lower()) or mimetypes.guess_type(p)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        with open(p, 'rb') as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return

    def read_body_to(self, path):
        n = int(self.headers.get('Content-Length') or 0)
        tmp = path + '.part'
        with open(tmp, 'wb') as f:
            left = n
            while left > 0:
                chunk = self.rfile.read(min(left, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left > 0:
            os.remove(tmp)
            raise IOError('upload cut short')
        os.replace(tmp, path)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        p = urllib.parse.unquote(u.path)
        S = self.server
        if p in ('/', '/editor'):
            self.send_response(302)
            self.send_header('Location', '/editor/')
            self.end_headers()
            return
        if p == '/api/sessions':
            out = []
            for n in sorted(os.listdir(S.raw)):
                if n.lower().endswith('.zip'):
                    out.append(session_info(os.path.join(S.raw, n), S.sheets))
            return self.send_json({'sessions': out, 'raw': S.raw, 'edits': S.edits})
        if p.startswith('/raw/'):
            return self.send_file(os.path.join(S.raw, safe_name(p[5:])))
        if p == '/api/projects':
            out = []
            for n in sorted(os.listdir(S.projects)):
                if n.endswith('.json'):
                    out.append({'name': n[:-len('.crproj.json')] if n.endswith('.crproj.json') else n[:-5], 'mtime': os.path.getmtime(os.path.join(S.projects, n))})
            out.sort(key=lambda x: -x['mtime'])
            return self.send_json({'projects': out})
        if p == '/api/project':
            name = safe_name((q.get('name') or ['edit'])[0])
            for cand in (name + '.crproj.json', name + '.json'):
                fp = os.path.join(S.projects, cand)
                if os.path.exists(fp):
                    return self.send_file(fp)
            return self.send_error(404)
        rel = p.lstrip('/')
        if rel.endswith('/'):
            rel += 'index.html'
        if not rel.startswith(ALLOWED) or '..' in rel:
            return self.send_error(404)
        return self.send_file(os.path.join(ROOT, *rel.split('/')))

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        S = self.server
        try:
            if u.path == '/api/upload':
                name = safe_name((q.get('name') or ['recording.zip'])[0], '.zip')
                dest = os.path.join(S.raw, name)
                n = int(self.headers.get('Content-Length') or 0)
                if os.path.exists(dest) and os.path.getsize(dest) == n:   # the same file again
                    self.rfile.read(n)
                    return self.send_json({'name': name, 'path': dest, 'existed': True})
                dest = unique(S.raw, name)
                self.read_body_to(dest)
                if not zipfile.is_zipfile(dest):
                    os.remove(dest)
                    return self.send_json({'error': 'not a zip'}, 400)
                return self.send_json({'name': os.path.basename(dest), 'path': dest})
            if u.path == '/api/export':
                name = safe_name((q.get('name') or ['edit.mp4'])[0])
                if not name.lower().endswith(('.mp4', '.webm')):
                    name += '.mp4'
                dest = unique(S.edits, name)
                self.read_body_to(dest)
                return self.send_json({'name': os.path.basename(dest), 'path': dest})
            if u.path == '/api/project':
                name = safe_name((q.get('name') or ['edit'])[0])
                dest = os.path.join(S.projects, name + '.crproj.json')
                self.read_body_to(dest)
                return self.send_json({'name': name, 'path': dest})
        except Exception as e:
            return self.send_json({'error': str(e)}, 500)
        self.send_error(404)


def main():
    ap = argparse.ArgumentParser(description='COMMAND ROOM editor server')
    ap.add_argument('--raw', required=True)
    ap.add_argument('--edits', required=True)
    ap.add_argument('--projects', required=True)
    ap.add_argument('--sheets', default=None)
    ap.add_argument('--port', type=int, default=8577)
    ap.add_argument('--open', action='store_true')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()
    for d in (a.raw, a.edits, a.projects):
        os.makedirs(d, exist_ok=True)
    port = a.port
    for _ in range(20):
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                break
        port += 1
    srv = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    srv.daemon_threads = True
    srv.raw, srv.edits, srv.projects = os.path.abspath(a.raw), os.path.abspath(a.edits), os.path.abspath(a.projects)
    srv.sheets = os.path.abspath(a.sheets) if a.sheets else None
    srv.verbose = a.verbose
    url = f'http://127.0.0.1:{port}/editor/'
    print(f'COMMAND ROOM editor running at {url}')
    print(f'  recordings: {srv.raw}')
    print(f'  exports:    {srv.edits}')
    print(f'  projects:   {srv.projects}')
    print('Close this window to stop the editor.')
    sys.stdout.flush()
    if a.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()
