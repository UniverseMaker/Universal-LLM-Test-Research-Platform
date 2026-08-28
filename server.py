#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — LLM Lab v24 통합 로컬 서버 (정적 서빙 + 웹 검색 + 범용 릴레이 프록시)

역할
  1) versions/v24/ 의 정적 파일(index.html/app.js/api.js/llmlab.js/styles.css 등) 서빙
  2) GET  /api/search?q=<질의>&n=<최대개수, 기본5> → DuckDuckGo 검색 결과 JSON (v5~ 회귀 없음)
  3) POST /api/proxy → 범용 릴레이(인스펙터용): 대상 method/url/headers/body를 그대로 전달하고
     업스트림 status·headers·본문을 미러링. SSE 스트리밍도 청크 통과.
     (교차출처 응답의 status/headers/에러본문을 브라우저에서 관측 가능하게 함)

  /api/proxy 요청 형식:
    { "method":"POST"|"GET"|..., "url":"http.../v1/chat/completions",
      "headers": { "Authorization":"Bearer ...", "Content-Type":"application/json" },
      "body": "<요청 본문 문자열 또는 null>" }
  /api/proxy 응답:
    - HTTP status = 업스트림 status 미러링
    - 헤더 X-Upstream-Status / X-Upstream-Status-Text / X-Upstream-Headers(JSON)
    - 본문 = 업스트림 바이트 스트리밍(SSE 그대로 통과; HTTP/1.0 연결종료로 끝을 알림)
    - 프록시 자체 실패: 502 + 헤더 X-Proxy-Error:1 + JSON { "error": "..." }

계약: _workspace/03_websearch-contract.md 준수
  응답 형식(고정):
    {
      "query":  "질의 원문",
      "source": "ddg-html" | "ddg-lite" | null,
      "results": [ { "title": "...", "url": "https://...", "snippet": "..." } ],
      "error":  null | "사람이 읽을 에러 메시지"
    }
  - 예외/빈결과도 HTTP 200 + results:[] + error 메시지로 우아하게 강등.
  - 외부 pip 패키지 없이 표준 라이브러리만 사용.

실행법
    cd versions/v5
    python server.py
  기본 포트 5602. 브라우저에서 http://localhost:5602 접속.
  포트 변경: python server.py 5603   (또는 아래 PORT 상수 수정)
"""

import sys
import re
import json
import html as html_module
import urllib.request
import urllib.parse
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
import os

# ------------------------------------------------------------------ #
# 설정 상수                                                           #
# ------------------------------------------------------------------ #
PORT = 5602                     # 기본 포트 (실행 인자로 오버라이드 가능)
DEFAULT_N = 5                   # 기본 결과 개수
MAX_N = 20                      # 결과 개수 상한
FETCH_TIMEOUT = 15              # 외부 요청 타임아웃(초)
PROXY_TIMEOUT = 300            # /api/proxy 릴레이 타임아웃(초, 스트리밍 생성 고려)
PROXY_CHUNK = 1024            # 릴레이 스트리밍 청크 크기(바이트)
# 릴레이 시 클라이언트가 지정하면 안 되는 hop-by-hop / 위험 헤더(대소문자 무시)
PROXY_SKIP_REQ_HEADERS = {
    "host", "content-length", "connection", "accept-encoding",
    "transfer-encoding", "keep-alive", "proxy-connection", "upgrade",
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# 정적 파일 루트 = 이 스크립트가 있는 폴더 (versions/v5/)
STATIC_ROOT = os.path.dirname(os.path.abspath(__file__))


# ------------------------------------------------------------------ #
# DuckDuckGo 검색 로직                                                #
# ------------------------------------------------------------------ #
def _fetch(url, data=None):
    """POST(또는 GET) 요청 후 (status, text) 반환."""
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "User-Agent": UA,
            "Accept-Language": "ko,en;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
        return r.status, r.read().decode("utf-8", "replace")


def _strip_tags(s):
    """HTML 태그 제거 + 엔티티 디코드 + 공백 정규화."""
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", "", s)
    s = html_module.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _resolve_ddg_url(href):
    """DDG 리다이렉트 링크(//duckduckgo.com/l/?uddg=...)에서 실제 URL 복원."""
    if not href:
        return ""
    # //duckduckgo.com/l/?uddg=... 또는 /l/?uddg=... 형태
    if "uddg=" in href:
        # 스킴 보정 후 파싱
        parse_target = href
        if parse_target.startswith("//"):
            parse_target = "https:" + parse_target
        elif parse_target.startswith("/"):
            parse_target = "https://duckduckgo.com" + parse_target
        try:
            qs = urllib.parse.urlparse(parse_target).query
            params = urllib.parse.parse_qs(qs)
            if params.get("uddg"):
                return urllib.parse.unquote(params["uddg"][0])
        except Exception:
            pass
    # 스킴 없는 절대경로 보정
    if href.startswith("//"):
        return "https:" + href
    return href


def _parse_html_results(html_text, n):
    """html.duckduckgo.com/html/ 결과 파싱."""
    results = []
    seen = set()
    # 각 결과 블록: <a ... class="result__a" href="...">제목</a> ... 스니펫
    # 앵커(제목/링크)를 순서대로 뽑고, 각 앵커 뒤의 result__snippet을 매칭.
    anchor_re = re.compile(
        r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        re.S,
    )
    snippet_re = re.compile(
        r'class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>',
        re.S,
    )
    snippets = snippet_re.findall(html_text)

    for i, m in enumerate(anchor_re.finditer(html_text)):
        href_raw = m.group(1)
        title = _strip_tags(m.group(2))
        url = _resolve_ddg_url(href_raw)
        if not url or not title:
            continue
        if url in seen:
            continue
        seen.add(url)
        snippet = _strip_tags(snippets[i]) if i < len(snippets) else ""
        results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= n:
            break
    return results


def _parse_lite_results(html_text, n):
    """lite.duckduckgo.com/lite/ 결과 파싱 (폴백)."""
    results = []
    seen = set()
    # lite는 <a ... class="result-link" href="...">제목</a> + 다음 행에 result-snippet
    anchor_re = re.compile(
        r'<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        re.S,
    )
    snippet_re = re.compile(
        r'class="[^"]*result-snippet[^"]*"[^>]*>(.*?)</td>',
        re.S,
    )
    snippets = snippet_re.findall(html_text)

    matches = list(anchor_re.finditer(html_text))
    if not matches:
        # 최후 폴백: 외부 http(s) 링크 앵커 전부
        anchor_re2 = re.compile(r'<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', re.S)
        matches = list(anchor_re2.finditer(html_text))

    for i, m in enumerate(matches):
        url = _resolve_ddg_url(m.group(1))
        title = _strip_tags(m.group(2))
        if not url or not title:
            continue
        # duckduckgo 내부 링크 스킵
        if "duckduckgo.com" in url and "uddg=" not in m.group(1):
            continue
        if url in seen:
            continue
        seen.add(url)
        snippet = _strip_tags(snippets[i]) if i < len(snippets) else ""
        results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= n:
            break
    return results


def web_search(query, n):
    """계약 형식의 dict 반환. 예외를 삼켜 항상 dict를 돌려준다."""
    query = (query or "").strip()
    n = max(1, min(int(n) if n else DEFAULT_N, MAX_N))
    if not query:
        return {"query": query, "source": None, "results": [],
                "error": "검색어가 비어 있습니다."}

    body = urllib.parse.urlencode({"q": query}).encode("utf-8")

    # 1차: html.duckduckgo.com/html/
    try:
        st, html_text = _fetch("https://html.duckduckgo.com/html/", data=body)
        if st == 200:
            results = _parse_html_results(html_text, n)
            if results:
                return {"query": query, "source": "ddg-html",
                        "results": results, "error": None}
    except Exception as e:
        html_err = str(e)
    else:
        html_err = "결과 없음"

    # 폴백: lite.duckduckgo.com/lite/
    try:
        st, html_text = _fetch("https://lite.duckduckgo.com/lite/", data=body)
        if st == 200:
            results = _parse_lite_results(html_text, n)
            if results:
                return {"query": query, "source": "ddg-lite",
                        "results": results, "error": None}
    except Exception as e:
        return {"query": query, "source": None, "results": [],
                "error": "웹 검색에 실패했습니다: %s" % e}

    return {"query": query, "source": None, "results": [],
            "error": "검색 결과를 찾지 못했습니다."}


# ------------------------------------------------------------------ #
# HTTP 핸들러                                                         #
# ------------------------------------------------------------------ #
class Handler(SimpleHTTPRequestHandler):
    # SimpleHTTPRequestHandler는 directory= 인자로 정적 루트 지정 가능.

    def _send_json(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    # -------------------------------------------------------------- #
    # 범용 릴레이 프록시 (POST /api/proxy)                            #
    #  - 인스펙터가 교차출처 응답의 status/headers/에러본문을 보게 한다.#
    #  - 요청 JSON: { "method","url","headers":{},"body": <str|null> } #
    #  - 응답: 업스트림 status를 그대로 미러링 + 헤더로 메타 노출        #
    #      X-Upstream-Status / X-Upstream-Status-Text / X-Upstream-Headers(JSON)#
    #      본문은 업스트림 바이트를 그대로 스트리밍(SSE 청크 통과).       #
    #  - 프록시 자체 실패(연결불가 등): 502 + X-Proxy-Error:1 + JSON본문. #
    # -------------------------------------------------------------- #
    def _proxy_error(self, message):
        payload = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_response(502)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Proxy-Error", "1")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except Exception:
            pass

    def _relay(self):
        # 1) 클라이언트 요청 본문(JSON) 파싱
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            spec = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            return self._proxy_error("요청 JSON 파싱 실패: %s" % e)

        target = spec.get("url")
        method = (spec.get("method") or "GET").upper()
        req_headers = spec.get("headers") or {}
        body = spec.get("body")

        if not target or not isinstance(target, str):
            return self._proxy_error("url 이 필요합니다.")
        # SSRF 최소 방어: http/https 스킴만 허용
        scheme = urllib.parse.urlparse(target).scheme.lower()
        if scheme not in ("http", "https"):
            return self._proxy_error("허용되지 않는 스킴: %s" % scheme)

        data = None
        if body is not None and method in ("POST", "PUT", "PATCH", "DELETE"):
            data = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")

        # 업스트림 헤더 구성(위험/hop-by-hop 제거)
        out_headers = {}
        for k, v in req_headers.items():
            if not k or k.lower() in PROXY_SKIP_REQ_HEADERS:
                continue
            out_headers[k] = v
        out_headers.setdefault("User-Agent", UA)

        req = urllib.request.Request(target, data=data, headers=out_headers, method=method)

        # 2) 업스트림 요청 → 응답 스트리밍 미러링
        try:
            resp = urllib.request.urlopen(req, timeout=PROXY_TIMEOUT)
            status = resp.status
            up_headers = resp.headers
            fp = resp
        except urllib.error.HTTPError as e:
            # 4xx/5xx: 상태·헤더·본문 그대로 미러링(인스펙터 에러 표면화)
            status = e.code
            up_headers = e.headers
            fp = e
        except urllib.error.URLError as e:
            return self._proxy_error("대상 서버 연결 실패: %s" % (getattr(e, "reason", e)))
        except Exception as e:
            return self._proxy_error("프록시 오류: %s" % e)

        # 업스트림 헤더를 dict로 직렬화(민감치 않은 표준 헤더)
        up_dict = {}
        try:
            for k in up_headers.keys():
                up_dict[k] = up_headers.get(k)
        except Exception:
            pass

        content_type = up_dict.get("Content-Type") or up_dict.get("content-type") or "application/octet-stream"

        # 응답 헤더 전송 (업스트림 status 미러링 + 메타 헤더).
        # Content-Length 는 생략하고 HTTP/1.0 연결종료로 스트림 끝을 알린다(SSE/일반 공용).
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Upstream-Status", str(status))
        self.send_header("X-Upstream-Status-Text", str(getattr(fp, "reason", "") or ""))
        try:
            self.send_header("X-Upstream-Headers", json.dumps(up_dict, ensure_ascii=False))
        except Exception:
            self.send_header("X-Upstream-Headers", "{}")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        # 3) 본문 스트리밍(청크 통과) — 생성 스트림이 실시간으로 흐르도록 flush.
        try:
            while True:
                chunk = fp.read(PROXY_CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)
                try:
                    self.wfile.flush()
                except Exception:
                    pass
        except Exception:
            # 클라이언트 중단/연결 종료 등 — 조용히 종료
            pass
        finally:
            try:
                fp.close()
            except Exception:
                pass

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/proxy":
            try:
                self._relay()
            except Exception as e:
                try:
                    self._proxy_error("서버 내부 오류: %s" % e)
                except Exception:
                    pass
            return
        # 알 수 없는 POST 경로
        self._send_json({"error": "Not Found"}, status=404)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/search":
            params = urllib.parse.parse_qs(parsed.query)
            q = (params.get("q", [""])[0])
            n = (params.get("n", [str(DEFAULT_N)])[0])
            try:
                result = web_search(q, n)
            except Exception as e:
                # 최종 방어: 어떤 예외도 계약 형식으로 강등
                result = {"query": q, "source": None, "results": [],
                          "error": "서버 내부 오류: %s" % e}
            self._send_json(result)
            return
        # 그 외는 정적 파일 서빙
        return super().do_GET()

    def log_message(self, fmt, *args):
        # 간결한 로그
        sys.stderr.write("[server] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    handler = partial(Handler, directory=STATIC_ROOT)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print("LLM Lab v24 server: http://localhost:%d  (정적 루트: %s)" % (port, STATIC_ROOT))
    print("웹 검색 테스트: http://localhost:%d/api/search?q=대한민국+수도&n=3" % port)
    print("릴레이 프록시: POST http://localhost:%d/api/proxy" % port)
    print("Ctrl+C 로 종료.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
