<?php
/**
 * proxy.php — LLM Lab v30 범용 릴레이 프록시 (공유호스팅 / PHP · server.py /api/proxy 대체)
 *
 * .htaccess:  POST /api/proxy  →  proxy.php
 *
 * 역할(server.py 응답 규약 그대로 유지 — 프런트 relayFetch() 무수정):
 *   요청 JSON: { "method","url","headers":{},"body": <str|null> }
 *   응답:
 *     - HTTP status = 업스트림 status 미러링
 *     - 헤더 X-Upstream-Status / X-Upstream-Status-Text / X-Upstream-Headers(JSON)
 *     - 본문 = 업스트림 바이트 스트리밍(SSE `data:` 청크 실시간 통과)
 *     - 프록시 자체 실패: 502 + 헤더 X-Proxy-Error:1 + JSON { "error": "..." }
 *
 * SSE 통과(공유호스팅 버퍼링 대응):
 *   - 출력버퍼/압축 해제 + ob_implicit_flush + set_time_limit(0)
 *   - cURL CURLOPT_WRITEFUNCTION 콜백마다 echo+flush()
 *   - X-Accel-Buffering: no (Nginx 프록시 버퍼 해제)
 *   호스팅이 FastCGI 버퍼를 강제하면 실시간이 늦어질 수 있으나, 프런트에 non-stream 폴백이 있어 답변은 완결됨.
 */

// 클라이언트가 지정하면 안 되는 hop-by-hop / 위험 헤더(대소문자 무시)
$PROXY_SKIP_REQ_HEADERS = array(
    'host', 'content-length', 'connection', 'accept-encoding',
    'transfer-encoding', 'keep-alive', 'proxy-connection', 'upgrade',
);
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    . '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
$PROXY_TIMEOUT = 300; // 릴레이 타임아웃(초, 스트리밍 생성 고려)

@ini_set('display_errors', '0');

function proxy_error($message, $status = 502) {
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Proxy-Error: 1');
        header('Cache-Control: no-store');
    }
    echo json_encode(array('error' => $message), JSON_UNESCAPED_UNICODE);
    exit;
}

// cURL 필수(공유호스팅 대부분 有). 없으면 프록시 부재로 강등(프런트가 direct 폴백).
if (!function_exists('curl_init')) {
    proxy_error('이 호스팅에는 cURL 이 없습니다. 프런트가 직접 호출(direct)로 폴백합니다.');
}

// 1) 요청 JSON 파싱
$raw = file_get_contents('php://input');
$spec = json_decode($raw ? $raw : '{}', true);
if (!is_array($spec)) proxy_error('요청 JSON 파싱 실패');

$target  = isset($spec['url']) ? $spec['url'] : '';
$method  = strtoupper(isset($spec['method']) ? $spec['method'] : 'GET');
$reqHdrs = isset($spec['headers']) && is_array($spec['headers']) ? $spec['headers'] : array();
$body    = array_key_exists('body', $spec) ? $spec['body'] : null;

if (!is_string($target) || $target === '') proxy_error('url 이 필요합니다.');
$scheme = strtolower((string)parse_url($target, PHP_URL_SCHEME));
if ($scheme !== 'http' && $scheme !== 'https') proxy_error('허용되지 않는 스킴: ' . $scheme);

// 2) 업스트림 헤더 구성(위험/hop-by-hop 제거)
$outHeaders = array();
$hasUA = false;
foreach ($reqHdrs as $k => $v) {
    if (!is_string($k) || $k === '') continue;
    if (in_array(strtolower($k), $PROXY_SKIP_REQ_HEADERS, true)) continue;
    $outHeaders[] = $k . ': ' . $v;
    if (strtolower($k) === 'user-agent') $hasUA = true;
}
if (!$hasUA) $outHeaders[] = 'User-Agent: ' . $UA;

// 3) 스트리밍 준비 — 버퍼 최소화
@ini_set('output_buffering', '0');
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
@set_time_limit(0);
while (ob_get_level() > 0) { @ob_end_flush(); }
ob_implicit_flush(true);

// 업스트림 응답 상태를 담을 공유 상태(HEADERFUNCTION → WRITEFUNCTION 사이)
$STATE = array(
    'status'      => 0,
    'statusText'  => '',
    'headers'     => array(),   // 원본 순서 보존 {name: value}
    'sent'        => false,     // 우리 응답 헤더를 이미 내보냈는가
);

// 우리 응답 헤더를 (한 번만) 내보낸다 — 업스트림 헤더 수신 완료 시점
function proxy_emit_headers(&$STATE) {
    if ($STATE['sent']) return;
    $STATE['sent'] = true;
    $status = $STATE['status'] > 0 ? $STATE['status'] : 502;
    $ct = 'application/octet-stream';
    foreach ($STATE['headers'] as $k => $v) {
        if (strtolower($k) === 'content-type') { $ct = $v; break; }
    }
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: ' . $ct);
        header('X-Upstream-Status: ' . $status);
        header('X-Upstream-Status-Text: ' . $STATE['statusText']);
        $j = json_encode($STATE['headers'], JSON_UNESCAPED_UNICODE);
        header('X-Upstream-Headers: ' . ($j !== false ? $j : '{}'));
        header('X-Accel-Buffering: no');      // Nginx 프록시 버퍼 해제
        header('Cache-Control: no-store');
    }
}

$ch = curl_init($target);
curl_setopt_array($ch, array(
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => $outHeaders,
    CURLOPT_FOLLOWLOCATION => false,          // 리다이렉트 미추적(SSRF 축소)
    CURLOPT_TIMEOUT        => $PROXY_TIMEOUT,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_RETURNTRANSFER => false,          // 스트리밍(콜백으로 즉시 출력)
    // 업스트림 응답 헤더 수신 콜백 — status line/헤더 캡처, 마지막 빈 줄에서 우리 헤더 flush
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$STATE) {
        $len = strlen($line);
        $trim = trim($line);
        if (preg_match('#^HTTP/\S+\s+(\d{3})\s*(.*)$#', $trim, $m)) {
            // 새 응답 시작(리다이렉트 등) → 상태 초기화
            $STATE['status'] = (int)$m[1];
            $STATE['statusText'] = isset($m[2]) ? $m[2] : '';
            $STATE['headers'] = array();
            return $len;
        }
        if ($trim === '') {
            // 헤더 끝 → 우리 응답 헤더 확정 후 방출
            proxy_emit_headers($STATE);
            return $len;
        }
        $pos = strpos($line, ':');
        if ($pos !== false) {
            $name = trim(substr($line, 0, $pos));
            $val  = trim(substr($line, $pos + 1));
            if ($name !== '') $STATE['headers'][$name] = $val;
        }
        return $len;
    },
    // 본문 청크 — 헤더가 아직이면 방출 후, echo + flush 로 실시간 통과
    CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) use (&$STATE) {
        if (!$STATE['sent']) proxy_emit_headers($STATE);
        echo $chunk;
        @flush();
        return strlen($chunk);
    },
));

// POST/PUT/PATCH/DELETE 에 본문 부착
if ($body !== null && in_array($method, array('POST', 'PUT', 'PATCH', 'DELETE'), true)) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, is_string($body) ? $body : json_encode($body));
}

$ok = curl_exec($ch);

if ($ok === false && !$STATE['sent']) {
    // 헤더도 못 받고 실패 → 연결 자체 실패
    $err = curl_error($ch);
    curl_close($ch);
    proxy_error('대상 서버 연결 실패: ' . $err);
}
curl_close($ch);

// 헤더는 왔으나 본문이 0바이트인 경우에도 헤더는 방출되도록 보장
if (!$STATE['sent']) proxy_emit_headers($STATE);
@flush();
