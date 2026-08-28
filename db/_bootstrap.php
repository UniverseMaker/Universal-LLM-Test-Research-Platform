<?php
/**
 * db/_bootstrap.php — LLM Lab v30 DB 라우터 공통 유틸 (공유호스팅 / PHP 백엔드)
 *
 * 역할: 확장 탐지 · JSON I/O · 연결 프로필(비밀 분리) 영속 · 식별자 화이트리스트 ·
 *       PDO 연결 팩토리 · readonly 가드.
 *
 * 상주 프로세스가 없는 공유호스팅 전제 → 연결은 요청마다 파일에서 로드/저장한다.
 *   - db/connections.json      : 비밀 제외 프로필 (flock 보호)
 *   - db/config.secret.php      : 비밀(비밀번호 등). PHP 배열 반환 → 직접 GET 시 코드로 실행되어 내용 노출 안 됨.
 *   두 파일 모두 루트 .htaccess 의 FilesMatch 로 웹 접근 차단(Require all denied).
 *
 * 계약: _workspace/01_research_db.md §4 (전부 HTTP 200 + {ok, provider, ...} 강등)
 */

// ------------------------------------------------------------------ //
// 0. 실행 환경 (버퍼 최소화, 에러를 응답에 안 흘림)                    //
// ------------------------------------------------------------------ //
@ini_set('display_errors', '0');          // 에러 본문이 JSON 을 오염시키지 않게
error_reporting(E_ALL);

// 경로 상수 -------------------------------------------------------- //
if (!defined('DB_DIR'))     define('DB_DIR', __DIR__);
if (!defined('APP_ROOT'))   define('APP_ROOT', dirname(__DIR__));
if (!defined('DATA_DIR'))   define('DATA_DIR', APP_ROOT . DIRECTORY_SEPARATOR . '_data');
if (!defined('CONN_FILE'))  define('CONN_FILE', DB_DIR . DIRECTORY_SEPARATOR . 'connections.json');
if (!defined('SECRET_FILE'))define('SECRET_FILE', DB_DIR . DIRECTORY_SEPARATOR . 'config.secret.php');

// ------------------------------------------------------------------ //
// 1. 확장 가용성 (요청당 1회)                                         //
// ------------------------------------------------------------------ //
function db_have() {
    static $h = null;
    if ($h === null) {
        $h = array(
            'pdo_sqlite' => extension_loaded('pdo_sqlite'),
            'pdo_mysql'  => extension_loaded('pdo_mysql'),
            'pdo_pgsql'  => extension_loaded('pdo_pgsql'),
            'curl'       => function_exists('curl_init'),
        );
    }
    return $h;
}

// type → 필요한 드라이버 확장 이름
function db_ext_for_type($type) {
    switch ($type) {
        case 'sqlite':   return 'pdo_sqlite';
        case 'mysql':    return 'pdo_mysql';
        case 'postgres':
        case 'pgvector': return 'pdo_pgsql';
        case 'neo4j':    return 'curl';
        default:         return null;
    }
}

function db_ext_available($type) {
    $ext = db_ext_for_type($type);
    if ($ext === null) return false;
    $h = db_have();
    return !empty($h[$ext]);
}

// ------------------------------------------------------------------ //
// 2. JSON I/O                                                         //
// ------------------------------------------------------------------ //
function db_json($obj, $status = 200) {
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo json_encode($obj, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// 요청 본문(JSON) → assoc array. 비어있으면 [].
function db_input() {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return array();
    $d = json_decode($raw, true);
    return is_array($d) ? $d : array();
}

// ------------------------------------------------------------------ //
// 3. 연결 저장소 (프로필 + 비밀 분리, flock 보호)                     //
// ------------------------------------------------------------------ //

// connections.json → { "<connId>": <profile(비밀 제외)> }
function db_load_connections() {
    if (!is_file(CONN_FILE)) return array();
    $fp = @fopen(CONN_FILE, 'rb');
    if (!$fp) return array();
    @flock($fp, LOCK_SH);
    $raw = stream_get_contents($fp);
    @flock($fp, LOCK_UN);
    fclose($fp);
    $d = json_decode($raw, true);
    if (!is_array($d) || !isset($d['connections']) || !is_array($d['connections'])) return array();
    return $d['connections'];
}

// config.secret.php → { "<connId>": { "password": "...", ... } }
function db_load_secrets() {
    if (!is_file(SECRET_FILE)) return array();
    $d = @include SECRET_FILE;   // 배열 반환 파일
    return is_array($d) ? $d : array();
}

// 원자적 쓰기(임시파일 → rename) + 배타락
function db_atomic_write($path, $contents) {
    $dir = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $tmp = $path . '.tmp.' . getmypid() . '.' . mt_rand();
    $ok = @file_put_contents($tmp, $contents, LOCK_EX);
    if ($ok === false) return false;
    if (!@rename($tmp, $path)) { @unlink($tmp); return false; }
    @chmod($path, 0640);
    return true;
}

function db_save_connections($conns) {
    $payload = json_encode(array('connections' => $conns),
        JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    return db_atomic_write(CONN_FILE, $payload);
}

function db_save_secrets($secrets) {
    $body = "<?php\n"
          . "// 자동 생성 — DB 자격증명(비밀). 웹 접근은 .htaccess 로 차단됨.\n"
          . "// 직접 GET 시 PHP 가 이 파일을 코드로 실행 → 배열만 반환(내용 노출 안 됨).\n"
          . "return " . var_export($secrets, true) . ";\n";
    return db_atomic_write(SECRET_FILE, $body);
}

// 프로필에서 비밀 필드만 분리 → [비밀제외프로필, 비밀맵]
function db_split_secret($profile) {
    $secret = array();
    if (isset($profile['connection']) && is_array($profile['connection'])) {
        $c = $profile['connection'];
        if (isset($c['password']) && $c['password'] !== '' && $c['password'] !== '<secret>' && $c['password'] !== '<REDACTED>') {
            $secret['password'] = $c['password'];
        }
        // uri 에 자격증명이 박혀 있을 수 있음 → 비밀로 취급(전체 uri 보관)
        $profile['connection']['password'] = '<REDACTED>';
    }
    return array($profile, $secret);
}

// 비밀을 합쳐 실행용 완전 프로필 복원
function db_merge_secret($profile, $connId) {
    $secrets = db_load_secrets();
    if (isset($secrets[$connId]) && is_array($secrets[$connId])) {
        foreach ($secrets[$connId] as $k => $v) {
            $profile['connection'][$k] = $v;
        }
    }
    return $profile;
}

// connId → 실행용 완전 프로필 (없으면 null)
function db_resolve_conn($connId) {
    $conns = db_load_connections();
    if (!isset($conns[$connId])) return null;
    return db_merge_secret($conns[$connId], $connId);
}

// 요청에서 프로필을 얻는다: connId(저장) 우선, 없으면 1회성 profile.
// 반환 [profile|null, errStr|null]
function db_profile_from_request($in) {
    if (isset($in['connId']) && $in['connId'] !== '') {
        $p = db_resolve_conn($in['connId']);
        if ($p === null) return array(null, "등록되지 않은 connId: " . $in['connId']);
        return array($p, null);
    }
    if (isset($in['profile']) && is_array($in['profile'])) {
        return array($in['profile'], null);
    }
    return array(null, "connId 또는 profile 이 필요합니다.");
}

// ------------------------------------------------------------------ //
// 4. 식별자 화이트리스트 (테이블/컬럼명 — 바인딩 불가라 검증 후 삽입)  //
// ------------------------------------------------------------------ //
function db_ident($name) {
    if (!is_string($name) || !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
        throw new RuntimeException("허용되지 않는 식별자: " . (is_string($name) ? $name : gettype($name)));
    }
    return $name;
}

// ------------------------------------------------------------------ //
// 5. PDO 연결 팩토리 (RDB)                                            //
// ------------------------------------------------------------------ //
function db_pdo($profile) {
    $type = isset($profile['type']) ? $profile['type'] : '';
    $c    = isset($profile['connection']) && is_array($profile['connection']) ? $profile['connection'] : array();
    $opts = isset($profile['options']) && is_array($profile['options']) ? $profile['options'] : array();
    $connectTimeout = isset($opts['connect_timeout_ms']) ? max(1, (int)round($opts['connect_timeout_ms'] / 1000)) : 10;

    $pdoOpts = array(
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT            => $connectTimeout,
    );

    if ($type === 'sqlite') {
        $path = isset($c['db_path']) ? $c['db_path'] : '';
        if ($path === '') throw new RuntimeException('sqlite: connection.db_path 가 필요합니다.');
        if ($path !== ':memory:') {
            // 상대경로는 앱 루트 기준으로 해석 (웹루트 밖 _data 권장)
            if (!preg_match('#^([A-Za-z]:\\\\|/)#', $path)) {
                $path = APP_ROOT . DIRECTORY_SEPARATOR . $path;
            }
            $real = realpath($path);
            if ($real !== false) $path = $real;
        }
        $dsn = 'sqlite:' . $path;
        return new PDO($dsn, null, null, $pdoOpts);
    }

    if ($type === 'mysql') {
        $host = isset($c['host']) ? $c['host'] : 'localhost';
        $port = isset($c['port']) ? (int)$c['port'] : 3306;
        $db   = isset($c['database']) ? $c['database'] : '';
        $dsn  = "mysql:host={$host};port={$port};dbname={$db};charset=utf8mb4";
        return new PDO($dsn, isset($c['user']) ? $c['user'] : null,
                            isset($c['password']) ? $c['password'] : null, $pdoOpts);
    }

    if ($type === 'postgres' || $type === 'pgvector') {
        $host = isset($c['host']) ? $c['host'] : 'localhost';
        $port = isset($c['port']) ? (int)$c['port'] : 5432;
        $db   = isset($c['database']) ? $c['database'] : '';
        $dsn  = "pgsql:host={$host};port={$port};dbname={$db}";
        $tls  = isset($c['tls']) && is_array($c['tls']) ? $c['tls'] : array();
        if (!empty($tls['enabled'])) {
            $mode = isset($tls['mode']) ? $tls['mode'] : 'require';
            $dsn .= ";sslmode={$mode}";
        }
        return new PDO($dsn, isset($c['user']) ? $c['user'] : null,
                            isset($c['password']) ? $c['password'] : null, $pdoOpts);
    }

    throw new RuntimeException("PDO 미지원 type: " . $type);
}

// ------------------------------------------------------------------ //
// 6. readonly 가드 (RDB SQL)                                          //
// ------------------------------------------------------------------ //
// 첫 유효 토큰이 화이트리스트에 없으면 거부. 주석/공백 스킵.
function db_is_readonly_sql($sql) {
    $s = preg_replace('#/\*.*?\*/#s', ' ', (string)$sql);   // 블록주석 제거
    $s = preg_replace('#--[^\n]*#', ' ', $s);               // 라인주석 제거
    $s = ltrim($s);
    if (!preg_match('/^([A-Za-z]+)/', $s, $m)) return false;
    $first = strtoupper($m[1]);
    $allow = array('SELECT', 'WITH', 'EXPLAIN', 'PRAGMA', 'SHOW', 'DESCRIBE', 'DESC');
    return in_array($first, $allow, true);
}

// Cypher readonly: 쓰기 키워드 포함 시 false
function db_is_readonly_cypher($cypher) {
    return !preg_match('/\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP|DETACH|LOAD\s+CSV|CALL\s+\{)\b/i', (string)$cypher);
}

// PDO bindValue 시 PHP 값 → PDO 파라미터 타입
function db_param_type($v) {
    if (is_int($v))  return PDO::PARAM_INT;
    if (is_bool($v)) return PDO::PARAM_BOOL;
    if (is_null($v)) return PDO::PARAM_NULL;
    return PDO::PARAM_STR;
}
