<?php
/**
 * search.php — LLM Lab v30 웹 검색 프록시 (공유호스팅 / PHP · server.py /api/search 대체)
 *
 * .htaccess:  GET /api/search?q=<질의>&n=<최대개수, 기본5>  →  search.php
 *
 * 계약(server.py 와 동일 — 프런트 api.js webSearch() 무수정):
 *   {
 *     "query":  "질의 원문",
 *     "source": "ddg-html" | "ddg-lite" | null,
 *     "results": [ { "title": "...", "url": "https://...", "snippet": "..." } ],
 *     "error":  null | "사람이 읽을 에러 메시지"
 *   }
 *   - 예외/빈결과도 HTTP 200 + results:[] + error 메시지로 우아하게 강등.
 *   - cURL(대부분 有) 우선, 없으면 allow_url_fopen 폴백.
 */

@ini_set('display_errors', '0');

define('DEFAULT_N', 5);
define('MAX_N', 20);
define('FETCH_TIMEOUT', 15);
define('SEARCH_UA', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    . '(KHTML, like Gecko) Chrome/124.0 Safari/537.36');

function search_json($obj) {
    if (!headers_sent()) {
        http_response_code(200);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// POST(폼) 요청 → (status, text). cURL 우선, 없으면 file_get_contents 폴백.
function search_fetch($url, $postFields) {
    $data = http_build_query($postFields);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $data,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => FETCH_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HTTPHEADER     => array(
                'User-Agent: ' . SEARCH_UA,
                'Accept-Language: ko,en;q=0.8',
                'Content-Type: application/x-www-form-urlencoded',
            ),
        ));
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) throw new RuntimeException($err ? $err : 'curl 실패');
        return array($status, $body);
    }
    // 폴백: allow_url_fopen
    if (ini_get('allow_url_fopen')) {
        $ctx = stream_context_create(array('http' => array(
            'method'  => 'POST',
            'header'  => "Content-Type: application/x-www-form-urlencoded\r\n"
                       . 'User-Agent: ' . SEARCH_UA . "\r\nAccept-Language: ko,en;q=0.8\r\n",
            'content' => $data,
            'timeout' => FETCH_TIMEOUT,
        )));
        $body = @file_get_contents($url, false, $ctx);
        if ($body === false) throw new RuntimeException('file_get_contents 실패');
        $status = 200;
        if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
            $status = (int)$m[1];
        }
        return array($status, $body);
    }
    throw new RuntimeException('cURL 및 allow_url_fopen 모두 사용 불가');
}

function search_strip_tags($s) {
    if ($s === null || $s === '') return '';
    $s = preg_replace('#<[^>]+>#', '', $s);
    $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $s = preg_replace('/\s+/u', ' ', $s);
    return trim($s);
}

// DDG 리다이렉트 링크(//duckduckgo.com/l/?uddg=...) → 실제 URL
function search_resolve_url($href) {
    if ($href === null || $href === '') return '';
    if (strpos($href, 'uddg=') !== false) {
        $t = $href;
        if (substr($t, 0, 2) === '//') $t = 'https:' . $t;
        elseif ($t[0] === '/')         $t = 'https://duckduckgo.com' . $t;
        $qs = parse_url($t, PHP_URL_QUERY);
        if ($qs) { parse_str($qs, $p); if (!empty($p['uddg'])) return urldecode($p['uddg']); }
    }
    if (substr($href, 0, 2) === '//') return 'https:' . $href;
    return $href;
}

// html.duckduckgo.com/html/ 결과 파싱
function search_parse_html($html, $n) {
    $results = array(); $seen = array();
    preg_match_all('#<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>#s', $html, $am, PREG_SET_ORDER);
    preg_match_all('#class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>#s', $html, $sm);
    $snips = isset($sm[1]) ? $sm[1] : array();
    foreach ($am as $i => $m) {
        $url = search_resolve_url($m[1]);
        $title = search_strip_tags($m[2]);
        if ($url === '' || $title === '' || isset($seen[$url])) continue;
        $seen[$url] = true;
        $snippet = isset($snips[$i]) ? search_strip_tags($snips[$i]) : '';
        $results[] = array('title' => $title, 'url' => $url, 'snippet' => $snippet);
        if (count($results) >= $n) break;
    }
    return $results;
}

// lite.duckduckgo.com/lite/ 결과 파싱(폴백)
function search_parse_lite($html, $n) {
    $results = array(); $seen = array();
    preg_match_all('#<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>#s', $html, $am, PREG_SET_ORDER);
    preg_match_all('#class="[^"]*result-snippet[^"]*"[^>]*>(.*?)</td>#s', $html, $sm);
    $snips = isset($sm[1]) ? $sm[1] : array();
    if (count($am) === 0) {
        preg_match_all('#<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>#s', $html, $am, PREG_SET_ORDER);
    }
    foreach ($am as $i => $m) {
        $url = search_resolve_url($m[1]);
        $title = search_strip_tags($m[2]);
        if ($url === '' || $title === '') continue;
        if (strpos($url, 'duckduckgo.com') !== false && strpos($m[1], 'uddg=') === false) continue;
        if (isset($seen[$url])) continue;
        $seen[$url] = true;
        $snippet = isset($snips[$i]) ? search_strip_tags($snips[$i]) : '';
        $results[] = array('title' => $title, 'url' => $url, 'snippet' => $snippet);
        if (count($results) >= $n) break;
    }
    return $results;
}

function web_search($query, $n) {
    $query = trim((string)$query);
    $n = (int)$n; if ($n <= 0) $n = DEFAULT_N;
    $n = max(1, min($n, MAX_N));
    if ($query === '') {
        return array('query' => $query, 'source' => null, 'results' => array(), 'error' => '검색어가 비어 있습니다.');
    }

    // 1차: html.duckduckgo.com/html/
    try {
        list($st, $html) = search_fetch('https://html.duckduckgo.com/html/', array('q' => $query));
        if ($st === 200) {
            $results = search_parse_html($html, $n);
            if (count($results)) return array('query' => $query, 'source' => 'ddg-html', 'results' => $results, 'error' => null);
        }
    } catch (Throwable $e) { /* 폴백 진행 */ }

    // 폴백: lite.duckduckgo.com/lite/
    try {
        list($st, $html) = search_fetch('https://lite.duckduckgo.com/lite/', array('q' => $query));
        if ($st === 200) {
            $results = search_parse_lite($html, $n);
            if (count($results)) return array('query' => $query, 'source' => 'ddg-lite', 'results' => $results, 'error' => null);
        }
    } catch (Throwable $e) {
        return array('query' => $query, 'source' => null, 'results' => array(),
            'error' => '웹 검색에 실패했습니다: ' . $e->getMessage());
    }

    return array('query' => $query, 'source' => null, 'results' => array(),
        'error' => '검색 결과를 찾지 못했습니다.');
}

$q = isset($_GET['q']) ? $_GET['q'] : '';
$n = isset($_GET['n']) ? $_GET['n'] : DEFAULT_N;
try {
    $result = web_search($q, $n);
} catch (Throwable $e) {
    $result = array('query' => $q, 'source' => null, 'results' => array(),
        'error' => '서버 내부 오류: ' . $e->getMessage());
}
search_json($result);
