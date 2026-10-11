#!/usr/bin/env python3
"""本地代理服务器 - 解决百度OCR的CORS问题"""
import http.server
import urllib.request
import urllib.parse
import json
import os
import sys

BAIDU_API_KEY = os.environ.get("BAIDU_API_KEY", "")
BAIDU_SECRET_KEY = os.environ.get("BAIDU_SECRET_KEY", "")
TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token'
OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic'

_cached_token = None

def get_token():
    global _cached_token
    if _cached_token:
        return _cached_token
    params = urllib.parse.urlencode({
        'grant_type': 'client_credentials',
        'client_id': BAIDU_API_KEY,
        'client_secret': BAIDU_SECRET_KEY
    })
    url = TOKEN_URL + '?' + params
    req = urllib.request.Request(url, method='POST', data=b'')
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
        if 'access_token' in data:
            _cached_token = data['access_token']
            return _cached_token
        raise Exception('获取Token失败: ' + json.dumps(data, ensure_ascii=False))

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/ocr':
            self.handle_ocr()
        elif self.path == '/api/token':
            self.handle_token()
        else:
            self.send_error(404)

    def handle_token(self):
        try:
            token = get_token()
            self.send_json(200, {'access_token': token})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def handle_ocr(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            token = get_token()
            url = OCR_URL + '?access_token=' + token
            req = urllib.request.Request(url, data=body, method='POST')
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = resp.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(result)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode('utf-8', errors='replace')
            self.send_json(e.code, {'error': '百度API返回错误', 'detail': err_body})
        except Exception as e:
            self.send_json(500, {'error': str(e)})

    def send_json(self, code, obj):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

if __name__ == '__main__':
    port = 8080
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.HTTPServer(('localhost', port), Handler)
    print(f'服务器已启动: http://localhost:{port}')
    print(f'打开浏览器访问: http://localhost:{port}/preview.html')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务器已停止')
        server.shutdown()
