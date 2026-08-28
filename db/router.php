<?php
/**
 * db/router.php — LLM Lab v30 DB REST 라우터 (공유호스팅 / PHP)
 *
 * .htaccess 매핑:  /api/db/<op>  →  db/router.php?op=<op>
 *   op ∈ { test, register, list, unregister, query, vector/search, graph/query, seed }
 *
 * 계약(_workspace/01_research_db.md §4):
 *   - 응답은 항상 HTTP 200 + { ok, provider, ... }.
 *   - provider: "server"(실행 성공) | "mock"(확장 미탑재/DB부재 강등) | "error"(요청 오류).
 *   - 확장 미탑재여도 서버는 죽지 않고 200 + provider:"mock" 로 강등.
 */

require __DIR__ . '/_bootstrap.php';

$op = isset($_GET['op']) ? trim($_GET['op'], '/') : '';
$op = strtolower($op);

try {
    switch ($op) {
        case 'test':          op_test();          break;
        case 'register':      op_register();      break;
        case 'list':          op_list();          break;
        case 'unregister':    op_unregister();    break;
        case 'query':         op_query();         break;
        case 'vector/search': op_vector_search(); break;
        case 'graph/query':   op_graph_query();   break;
        case 'seed':          op_seed();          break;
        default:
            db_json(array('ok' => false, 'provider' => 'error',
                'error' => "알 수 없는 op: '{$op}'",
                'ops' => array('test','register','list','unregister','query','vector/search','graph/query','seed')));
    }
} catch (Throwable $e) {
    // 최종 방어 — 어떤 예외도 계약 형식(200)으로 강등
    db_json(array('ok' => false, 'provider' => 'error',
        'error' => '서버 내부 오류: ' . $e->getMessage()));
}

/* ================================================================== */
/* register — 연결 등록(비밀 서버 보관, connId 발급)                    */
/* ================================================================== */
function op_register() {
    $in = db_input();
    $profile = isset($in['profile']) && is_array($in['profile']) ? $in['profile'] : null;
    if ($profile === null) {
        db_json(array('ok' => false, 'provider' => 'error', 'error' => 'profile 이 필요합니다.'));
    }
    $type = isset($profile['type']) ? $profile['type'] : '';
    $valid = array('sqlite','mysql','postgres','pgvector','neo4j');
    if (!in_array($type, $valid, true)) {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => "type 은 " . implode('|', $valid) . " 중 하나여야 합니다. (받음: '{$type}')"));
    }

    // type별 최소 필수 필드 검증
    $c = isset($profile['connection']) && is_array($profile['connection']) ? $profile['connection'] : array();
    $missing = db_required_missing($type, $c, $profile);
    if ($missing !== null) {
        db_json(array('ok' => false, 'provider' => 'error', 'error' => $missing));
    }

    // connId 결정
    $connId = isset($profile['id']) && $profile['id'] !== '' ? (string)$profile['id']
            : ('db_' . $type . '_' . substr(md5(uniqid('', true)), 0, 8));
    $profile['id'] = $connId;

    // 비밀 분리 후 저장
    list($clean, $secret) = db_split_secret($profile);
    $conns = db_load_connections();
    $conns[$connId] = $clean;
    if (!db_save_connections($conns)) {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => '연결 저장 실패(디렉터리 쓰기권한 확인: db/).'));
    }
    if (!empty($secret)) {
        $secrets = db_load_secrets();
        $secrets[$connId] = $secret;
        if (!db_save_secrets($secrets)) {
            db_json(array('ok' => false, 'provider' => 'error',
                'error' => '비밀 저장 실패(db/ 쓰기권한/config.secret.php 확인).'));
        }
    }

    $ext = db_ext_for_type($type);
    $available = db_ext_available($type);
    $resp = array(
        'ok'       => true,
        'connId'   => $connId,
        'type'     => $type,
        'driver'   => array('ext' => $ext, 'available' => $available),
        'provider' => $available ? 'server' : 'mock',
    );
    if (!$available) {
        $resp['hint'] = "이 호스팅은 {$ext} 미탑재 — 이 연결은 mock 으로 강등됩니다. "
            . ($type === 'sqlite' ? '' : 'sqlite/mysql 로 데모하거나 호스팅에 확장 요청하세요.');
    }
    db_json($resp);
}

function db_required_missing($type, $c, $profile) {
    if ($type === 'sqlite') {
        if (!isset($c['db_path']) || $c['db_path'] === '') return 'sqlite: connection.db_path 가 필요합니다.';
        return null;
    }
    if ($type === 'neo4j') {
        $hasUri  = isset($c['uri']) && $c['uri'] !== '';
        $hasHost = isset($c['host']) && $c['host'] !== '';
        if (!$hasUri && !$hasHost) return 'neo4j: connection.uri 또는 host 가 필요합니다.';
        return null;
    }
    // mysql / postgres / pgvector
    foreach (array('host','database') as $k) {
        if (!isset($c[$k]) || $c[$k] === '') return "{$type}: connection.{$k} 가 필요합니다.";
    }
    if ($type === 'pgvector') {
        $v = isset($profile['vector']) && is_array($profile['vector']) ? $profile['vector'] : array();
        foreach (array('table','embedding_column') as $k) {
            if (!isset($v[$k]) || $v[$k] === '') return "pgvector: vector.{$k} 가 필요합니다.";
        }
    }
    return null;
}

/* ================================================================== */
/* list / unregister                                                   */
/* ================================================================== */
function op_list() {
    $conns = db_load_connections();
    $out = array();
    foreach ($conns as $connId => $p) {
        $type = isset($p['type']) ? $p['type'] : '';
        $out[] = array(
            'connId' => $connId,
            'label'  => isset($p['label']) ? $p['label'] : $connId,
            'type'   => $type,
            'driver' => array(
                'ext'       => db_ext_for_type($type),
                'available' => db_ext_available($type),
            ),
        );
    }
    db_json(array('ok' => true, 'provider' => 'server', 'connections' => $out));
}

function op_unregister() {
    $in = db_input();
    $connId = isset($in['connId']) ? (string)$in['connId'] : '';
    if ($connId === '') db_json(array('ok' => false, 'provider' => 'error', 'error' => 'connId 가 필요합니다.'));
    $conns = db_load_connections();
    if (isset($conns[$connId])) { unset($conns[$connId]); db_save_connections($conns); }
    $secrets = db_load_secrets();
    if (isset($secrets[$connId])) { unset($secrets[$connId]); db_save_secrets($secrets); }
    db_json(array('ok' => true, 'provider' => 'server', 'connId' => $connId));
}

/* ================================================================== */
/* test — 연결 테스트(핸드셰이크)                                      */
/* ================================================================== */
function op_test() {
    $in = db_input();
    list($profile, $err) = db_profile_from_request($in);
    if ($profile === null) db_json(array('ok' => false, 'provider' => 'error', 'error' => $err));
    $type = isset($profile['type']) ? $profile['type'] : '';

    // demo sqlite 자동 시드(파일 없으면)
    if ($type === 'sqlite') db_seed_demo_if_needed($profile);

    if (!db_ext_available($type)) {
        $ext = db_ext_for_type($type);
        db_json(array('ok' => false, 'provider' => 'mock', 'type' => $type,
            'error' => "{$ext} 미탑재",
            'driver' => $ext,
            'checks' => array('extension' => false, 'connect' => false),
            'hint'   => "공유호스팅에 {$ext} 가 없습니다. "
                . ($type === 'neo4j' ? 'cURL 이 필요합니다.' : 'sqlite/mysql 로 데모하거나 호스팅에 확장 요청.')));
    }

    $t0 = microtime(true);
    try {
        if ($type === 'neo4j') {
            $r = neo4j_tx($profile, 'RETURN 1 AS ok', array(), 8);
            $ms = (int)round((microtime(true) - $t0) * 1000);
            if (!empty($r['errors'])) {
                db_json(array('ok' => false, 'provider' => 'error', 'type' => 'neo4j',
                    'error' => '인증/쿼리 실패: ' . json_encode($r['errors'], JSON_UNESCAPED_UNICODE),
                    'checks' => array('extension' => true, 'connect' => true, 'auth' => false)));
            }
            db_json(array('ok' => true, 'provider' => 'server', 'type' => 'neo4j', 'ms' => $ms,
                'driver' => 'curl', 'server_version' => 'Neo4j HTTP API',
                'checks' => array('extension' => true, 'connect' => true, 'auth' => true)));
        }

        // RDB (PDO)
        $pdo = db_pdo($profile);
        $checks = array('extension' => true, 'connect' => true);
        $version = '';
        if ($type === 'sqlite') {
            $version = 'SQLite ' . $pdo->query('SELECT sqlite_version()')->fetchColumn();
        } elseif ($type === 'mysql') {
            $version = 'MySQL ' . $pdo->query('SELECT version()')->fetchColumn();
        } else { // postgres / pgvector
            $version = (string)$pdo->query('SELECT version()')->fetchColumn();
            if ($type === 'pgvector') {
                $has = $pdo->query("SELECT COUNT(*) FROM pg_extension WHERE extname='vector'")->fetchColumn();
                $checks['pgvector_extension'] = ((int)$has > 0);
            }
        }
        $ms = (int)round((microtime(true) - $t0) * 1000);
        $resp = array('ok' => true, 'provider' => 'server', 'type' => $type, 'ms' => $ms,
            'server_version' => $version, 'driver' => db_ext_for_type($type), 'checks' => $checks);
        if ($type === 'pgvector' && empty($checks['pgvector_extension'])) {
            $resp['hint'] = "pgvector 확장 미활성 — DB 에서 'CREATE EXTENSION IF NOT EXISTS vector;' 실행 필요.";
        }
        db_json($resp);
    } catch (Throwable $e) {
        db_json(array('ok' => false, 'provider' => 'error', 'type' => $type,
            'error' => '연결 실패: ' . $e->getMessage(),
            'checks' => array('extension' => true, 'connect' => false)));
    }
}

/* ================================================================== */
/* query — RDB SQL 실행(PDO, 명명형 바인딩, readonly, row_cap)          */
/* ================================================================== */
function op_query() {
    $in = db_input();
    list($profile, $err) = db_profile_from_request($in);
    if ($profile === null) db_json(array('ok' => false, 'provider' => 'error', 'error' => $err));
    $type = isset($profile['type']) ? $profile['type'] : '';
    if (!in_array($type, array('sqlite','mysql','postgres','pgvector'), true)) {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => "query 는 RDB(sqlite/mysql/postgres/pgvector) 연결에만 사용 가능. (type={$type})"));
    }

    $sql    = isset($in['sql']) ? (string)$in['sql'] : '';
    $params = isset($in['params']) && is_array($in['params']) ? $in['params'] : array();
    $opts   = isset($profile['options']) && is_array($profile['options']) ? $profile['options'] : array();
    $rowCap = isset($in['row_cap']) ? (int)$in['row_cap']
            : (isset($opts['row_cap']) ? (int)$opts['row_cap'] : 200);
    if ($rowCap < 1) $rowCap = 200;

    if ($sql === '') db_json(array('ok' => false, 'provider' => 'error', 'error' => 'sql 이 필요합니다.'));

    // readonly 판정: 요청 readonly!==false 이고 프로필 readonly!==false 를 만족해야 쓰기 허용
    $reqReadonly     = !array_key_exists('readonly', $in) || $in['readonly'] !== false;
    $profileReadonly = !isset($opts['readonly']) || $opts['readonly'] !== false;
    $enforceReadonly = $reqReadonly || $profileReadonly;
    if ($enforceReadonly && !db_is_readonly_sql($sql)) {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => 'readonly: SELECT/WITH/EXPLAIN/PRAGMA/SHOW 만 허용됩니다 (INSERT/UPDATE/DELETE/DDL 금지).'));
    }

    if ($type === 'sqlite') db_seed_demo_if_needed($profile);

    if (!db_ext_available($type)) {
        db_json(array('ok' => true, 'provider' => 'mock',
            'columns' => array('(mock)'), 'rows' => array(array(db_ext_for_type($type) . ' 미탑재 — 예시행')),
            'row_count' => 1, 'truncated' => false,
            'note' => 'sqlite 는 어디서나 실동작하니 데모는 sqlite 를 권장합니다.'));
    }

    $t0 = microtime(true);
    try {
        $pdo  = db_pdo($profile);
        // statement timeout(가능한 DB만)
        $stMs = isset($opts['statement_timeout_ms']) ? (int)$opts['statement_timeout_ms'] : 0;
        if ($stMs > 0) {
            try {
                if ($type === 'mysql')      $pdo->exec('SET SESSION max_execution_time=' . $stMs);
                elseif ($type !== 'sqlite') $pdo->exec('SET statement_timeout=' . $stMs);
            } catch (Throwable $ignore) {}
        }

        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $key = (strlen($k) && $k[0] === ':') ? $k : ':' . $k;
            $stmt->bindValue($key, $v, db_param_type($v));
        }
        $stmt->execute();

        // 컬럼명 확보(0행이어도)
        $columns = array();
        $colCount = $stmt->columnCount();
        for ($i = 0; $i < $colCount; $i++) {
            $meta = @$stmt->getColumnMeta($i);
            $columns[] = ($meta && isset($meta['name'])) ? $meta['name'] : ('col' . $i);
        }

        $rows = array();
        $truncated = false;
        while (($r = $stmt->fetch(PDO::FETCH_NUM)) !== false) {
            if (count($rows) >= $rowCap) { $truncated = true; break; }
            $rows[] = $r;
        }
        $ms = (int)round((microtime(true) - $t0) * 1000);
        db_json(array('ok' => true, 'provider' => 'server', 'ms' => $ms,
            'columns' => $columns, 'rows' => $rows,
            'row_count' => count($rows), 'truncated' => $truncated));
    } catch (Throwable $e) {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => 'SQL 실행 오류: ' . $e->getMessage()));
    }
}

/* ================================================================== */
/* vector/search — pgvector 유사도 검색 (::vector 바인딩)              */
/* ================================================================== */
function op_vector_search() {
    $in = db_input();
    list($profile, $err) = db_profile_from_request($in);
    if ($profile === null) db_json(array('ok' => false, 'provider' => 'error', 'error' => $err));
    $type = isset($profile['type']) ? $profile['type'] : '';
    if ($type !== 'pgvector' && $type !== 'postgres') {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => "vector/search 는 pgvector 연결이 필요합니다. (type={$type})"));
    }

    $embedding = isset($in['embedding']) && is_array($in['embedding']) ? $in['embedding'] : null;
    $topK      = isset($in['top_k']) ? max(1, (int)$in['top_k']) : 5;
    $metric    = isset($in['metric']) ? $in['metric'] : (isset($profile['vector']['metric']) ? $profile['vector']['metric'] : 'cosine');
    $minScore  = isset($in['min_score']) ? (float)$in['min_score'] : null;

    if ($embedding === null || count($embedding) === 0) {
        // text→embedding 은 프런트 책임(활성 LLM /v1/embeddings). 서버는 벡터만 검색.
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => 'embedding(쿼리 벡터)이 필요합니다. 프런트에서 /v1/embeddings 로 생성해 전달하세요.'));
    }

    if (!db_ext_available('pgvector')) {
        db_json(array('ok' => true, 'provider' => 'mock', 'results' => array(),
            'count' => 0,
            'note' => 'pdo_pgsql 미탑재 — 브라우저 코사인 근사 사용을 권장합니다.'));
    }

    // vector.* 화이트리스트 검증
    $v = isset($profile['vector']) && is_array($profile['vector']) ? $profile['vector'] : array();
    try {
        $table = db_ident(isset($v['table']) ? $v['table'] : '');
        $idCol = db_ident(isset($v['id_column']) ? $v['id_column'] : 'id');
        $txCol = db_ident(isset($v['text_column']) ? $v['text_column'] : 'text');
        $emCol = db_ident(isset($v['embedding_column']) ? $v['embedding_column'] : 'embedding');
        $metaCols = array();
        if (isset($v['metadata_columns']) && is_array($v['metadata_columns'])) {
            foreach ($v['metadata_columns'] as $mc) $metaCols[] = db_ident($mc);
        }
    } catch (Throwable $e) {
        db_json(array('ok' => false, 'provider' => 'error', 'error' => $e->getMessage()));
    }

    // 거리 연산자 / 점수식
    $op = '<=>'; $scoreExpr = "1 - ({$emCol} <=> :vec::vector)"; // cosine
    if ($metric === 'l2')      { $op = '<->'; $scoreExpr = "-({$emCol} <-> :vec::vector)"; }
    elseif ($metric === 'ip')  { $op = '<#>'; $scoreExpr = "-({$emCol} <#> :vec::vector)"; }

    $vecStr = '[' . implode(',', array_map('floatval', $embedding)) . ']';

    // SELECT 목록
    $selCols = array($idCol, $txCol);
    foreach ($metaCols as $mc) if ($mc !== $idCol && $mc !== $txCol) $selCols[] = $mc;
    $selList = implode(', ', $selCols);

    // 필터(화이트리스트 컬럼 IN)
    $where = array();
    $bind  = array();
    if (isset($in['filter']) && is_array($in['filter'])) {
        $fi = 0;
        foreach ($in['filter'] as $col => $vals) {
            try { $col = db_ident($col); } catch (Throwable $e) { continue; }
            if (!in_array($col, $selCols, true) && $col !== $idCol) $selCols[] = $col; // 참조 허용
            $vals = is_array($vals) ? $vals : array($vals);
            if (count($vals) === 0) continue;
            $ph = array();
            foreach ($vals as $val) { $p = ':f' . ($fi++); $ph[] = $p; $bind[$p] = $val; }
            $where[] = "{$col} IN (" . implode(',', $ph) . ")";
        }
    }
    $whereSql = count($where) ? (' WHERE ' . implode(' AND ', $where)) : '';

    $sql = "SELECT {$selList}, {$scoreExpr} AS _score
            FROM {$table}{$whereSql}
            ORDER BY {$emCol} {$op} :vec::vector
            LIMIT :k";

    $t0 = microtime(true);
    try {
        $pdo  = db_pdo($profile);
        $stmt = $pdo->prepare($sql);
        $stmt->bindValue(':vec', $vecStr, PDO::PARAM_STR);
        $stmt->bindValue(':k', $topK, PDO::PARAM_INT);
        foreach ($bind as $p => $val) $stmt->bindValue($p, $val, db_param_type($val));
        $stmt->execute();

        $results = array();
        while (($row = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
            $score = isset($row['_score']) ? (float)$row['_score'] : 0.0;
            if ($minScore !== null && $score < $minScore) continue;
            $source = array();
            if (isset($row['title'])) $source['title'] = $row['title'];
            if (isset($row['loc']))   $source['loc']   = $row['loc'];
            $results[] = array(
                'chunkId' => isset($row[$idCol]) ? (string)$row[$idCol] : '',
                'docId'   => isset($row['doc_id']) ? (string)$row['doc_id'] : (isset($row['docId']) ? (string)$row['docId'] : ''),
                'text'    => isset($row[$txCol]) ? $row[$txCol] : '',
                'score'   => $score,
                'source'  => $source,
                'signals' => array('dense' => $score),
            );
        }
        $ms = (int)round((microtime(true) - $t0) * 1000);
        db_json(array('ok' => true, 'provider' => 'server', 'ms' => $ms,
            'results' => $results, 'count' => count($results),
            'table' => $table, 'index_used' => 'seqscan|hnsw'));
    } catch (Throwable $e) {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => 'pgvector 검색 오류: ' . $e->getMessage(),
            'hint'  => 'dim 불일치/테이블·컬럼명/CREATE EXTENSION vector 여부를 확인하세요.'));
    }
}

/* ================================================================== */
/* graph/query — Neo4j Cypher (HTTP API /tx/commit)                    */
/* ================================================================== */
function op_graph_query() {
    $in = db_input();
    list($profile, $err) = db_profile_from_request($in);
    if ($profile === null) db_json(array('ok' => false, 'provider' => 'error', 'error' => $err));
    $type = isset($profile['type']) ? $profile['type'] : '';
    if ($type !== 'neo4j') {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => "graph/query 는 neo4j 연결이 필요합니다. (type={$type})"));
    }

    $cypher = isset($in['cypher']) ? (string)$in['cypher'] : '';
    $params = isset($in['params']) && is_array($in['params']) ? $in['params'] : array();
    if ($cypher === '') db_json(array('ok' => false, 'provider' => 'error', 'error' => 'cypher 가 필요합니다.'));

    $reqReadonly = !array_key_exists('readonly', $in) || $in['readonly'] !== false;
    if ($reqReadonly && !db_is_readonly_cypher($cypher)) {
        db_json(array('ok' => false, 'provider' => 'error',
            'error' => 'readonly: CREATE/MERGE/DELETE/SET/REMOVE/DROP 은 금지됩니다.'));
    }

    if (!db_have()['curl']) {
        db_json(db_mock_graph('cURL 미탑재 — 데모 그래프 JSON'));
    }

    $t0 = microtime(true);
    try {
        $r = neo4j_tx($profile, $cypher, $params, 15);
        if (!empty($r['errors'])) {
            db_json(array('ok' => false, 'provider' => 'error',
                'error' => 'Neo4j 오류: ' . json_encode($r['errors'], JSON_UNESCAPED_UNICODE)));
        }
        $g = neo4j_to_graph($r, $profile);
        $g['ok'] = true; $g['provider'] = 'server';
        $g['ms'] = (int)round((microtime(true) - $t0) * 1000);
        db_json($g);
    } catch (Throwable $e) {
        // 미도달/타임아웃 → mock 강등(계약: 200)
        db_json(db_mock_graph('Neo4j 미도달(' . $e->getMessage() . ') — 데모 그래프 JSON'));
    }
}

// Neo4j Transactional Cypher HTTP API 호출 → decode 된 배열 반환
function neo4j_tx($profile, $cypher, $params, $timeout) {
    $c = $profile['connection'];
    $g = isset($profile['graph']) && is_array($profile['graph']) ? $profile['graph'] : array();
    $database = isset($g['database']) ? $g['database'] : (isset($c['database']) ? $c['database'] : 'neo4j');

    // base URL 구성
    if (isset($c['uri']) && $c['uri'] !== '') {
        $base = rtrim($c['uri'], '/');
    } else {
        $port = isset($c['port']) ? (int)$c['port'] : 7474;
        $https = (isset($c['tls']['enabled']) && $c['tls']['enabled']) || $port === 7473;
        $scheme = $https ? 'https' : 'http';
        $base = $scheme . '://' . $c['host'] . ':' . $port;
    }
    $url = $base . '/db/' . rawurlencode($database) . '/tx/commit';

    $payload = json_encode(array('statements' => array(array(
        'statement'  => $cypher,
        'parameters' => (object)$params,
        'resultDataContents' => array('row', 'graph'),
    ))), JSON_UNESCAPED_UNICODE);

    $headers = array('Content-Type: application/json', 'Accept: application/json');
    if (isset($c['user'])) {
        $headers[] = 'Authorization: Basic ' . base64_encode($c['user'] . ':' . (isset($c['password']) ? $c['password'] : ''));
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_SSL_VERIFYPEER => (isset($c['tls']['verify']) ? (bool)$c['tls']['verify'] : false),
        CURLOPT_SSL_VERIFYHOST => (isset($c['tls']['verify']) && $c['tls']['verify']) ? 2 : 0,
    ));
    $body = curl_exec($ch);
    if ($body === false) { $e = curl_error($ch); curl_close($ch); throw new RuntimeException($e); }
    curl_close($ch);
    $d = json_decode($body, true);
    return is_array($d) ? $d : array('errors' => array(array('message' => '응답 파싱 실패')));
}

// tx/commit graph 결과 → {nodes,edges,communities,records} (§8.4)
function neo4j_to_graph($r, $profile) {
    $g = isset($profile['graph']) && is_array($profile['graph']) ? $profile['graph'] : array();
    $communityLabel = isset($g['community_label']) ? $g['community_label'] : 'Community';
    $nameProp = isset($g['name_property']) ? $g['name_property'] : 'name';
    $summaryProp = isset($g['summary_property']) ? $g['summary_property'] : 'summary';

    $nodes = array(); $edges = array(); $communities = array(); $seenN = array(); $seenE = array();
    $records = array();

    $results = isset($r['results'][0]['data']) ? $r['results'][0]['data'] : array();
    foreach ($results as $rec) {
        if (isset($rec['row'])) $records[] = $rec['row'];
        if (!isset($rec['graph'])) continue;
        $graph = $rec['graph'];
        // 노드
        if (isset($graph['nodes'])) foreach ($graph['nodes'] as $n) {
            $id = (string)$n['id'];
            if (isset($seenN[$id])) continue;
            $seenN[$id] = true;
            $props  = isset($n['properties']) ? $n['properties'] : array();
            $labels = isset($n['labels']) ? $n['labels'] : array();
            $isCommunity = in_array($communityLabel, $labels, true);
            $node = array(
                'id'      => $id,
                'label'   => isset($props[$nameProp]) ? $props[$nameProp] : (isset($labels[0]) ? $labels[0] : $id),
                'type'    => isset($labels[0]) ? strtolower($labels[0]) : 'node',
                'community' => isset($props['community']) ? $props['community'] : null,
                'summary' => isset($props[$summaryProp]) ? $props[$summaryProp] : null,
            );
            $nodes[] = $node;
            if ($isCommunity) {
                $communities[] = array(
                    'id'      => $id,
                    'title'   => isset($props[$nameProp]) ? $props[$nameProp] : $id,
                    'summary' => isset($props[$summaryProp]) ? $props[$summaryProp] : '',
                    'members' => array(),
                );
            }
        }
        // 관계
        if (isset($graph['relationships'])) foreach ($graph['relationships'] as $e) {
            $id = (string)$e['id'];
            if (isset($seenE[$id])) continue;
            $seenE[$id] = true;
            $props = isset($e['properties']) ? $e['properties'] : array();
            $edges[] = array(
                'source'   => (string)$e['startNode'],
                'target'   => (string)$e['endNode'],
                'relation' => isset($e['type']) ? $e['type'] : 'REL',
                'weight'   => isset($props['weight']) ? $props['weight'] : 1,
            );
        }
    }
    return array('nodes' => $nodes, 'edges' => $edges,
        'communities' => $communities, 'records' => $records);
}

// 데모 그래프(§8.4 스키마) — Neo4j 미도달/미설정 시 강등
function db_mock_graph($note) {
    return array(
        'ok' => true, 'provider' => 'mock',
        'nodes' => array(
            array('id' => 'n1', 'label' => '박대승', 'type' => 'person', 'community' => 1, 'summary' => '연구자(데모)'),
            array('id' => 'n2', 'label' => 'LLM Lab', 'type' => 'project', 'community' => 1, 'summary' => '범용 LLM 플랫폼(데모)'),
            array('id' => 'n3', 'label' => 'pgvector', 'type' => 'tech', 'community' => 2, 'summary' => '벡터 검색(데모)'),
        ),
        'edges' => array(
            array('source' => 'n1', 'target' => 'n2', 'relation' => 'BUILDS', 'weight' => 3),
            array('source' => 'n2', 'target' => 'n3', 'relation' => 'USES', 'weight' => 2),
        ),
        'communities' => array(
            array('id' => 1, 'title' => '플랫폼', 'summary' => '박대승·LLM Lab(데모)', 'members' => array('n1', 'n2')),
            array('id' => 2, 'title' => '검색기술', 'summary' => 'pgvector(데모)', 'members' => array('n3')),
        ),
        'records' => array(),
        'note' => $note,
    );
}

/* ================================================================== */
/* seed — 동봉 데모 SQLite 생성(무설치 happy-path)                     */
/* ================================================================== */
function op_seed() {
    $path = DATA_DIR . DIRECTORY_SEPARATOR . 'demo.sqlite';
    $profile = array('type' => 'sqlite', 'connection' => array('db_path' => $path));
    $seeded = db_seed_demo_if_needed($profile, true);
    db_json(array('ok' => true, 'provider' => 'server',
        'seeded' => $seeded, 'path' => '_data/demo.sqlite'));
}

// 데모 sqlite 가 없으면 생성·시드. force=true 면 없을 때만 생성(기존 유지).
// 반환: 실제로 시드했으면 true.
function db_seed_demo_if_needed($profile, $force = false) {
    if (!isset($profile['connection']['db_path'])) return false;
    $path = $profile['connection']['db_path'];
    // 동봉 데모 경로만 자동 시드(임의 사용자 sqlite 는 건드리지 않음)
    $isDemo = (strpos($path, 'demo.sqlite') !== false) || (strpos($path, '_data') !== false);
    if (!$isDemo && !$force) return false;
    // 절대경로 해석
    if ($path !== ':memory:' && !preg_match('#^([A-Za-z]:\\\\|/)#', $path)) {
        $path = APP_ROOT . DIRECTORY_SEPARATOR . $path;
    }
    if (is_file($path)) return false;          // 이미 존재 → 유지
    if (!extension_loaded('pdo_sqlite')) return false;
    if (!is_dir(dirname($path))) @mkdir(dirname($path), 0755, true);

    try {
        $pdo = new PDO('sqlite:' . $path, null, null, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION));
        $pdo->exec('CREATE TABLE IF NOT EXISTS docs (
            id INTEGER PRIMARY KEY, title TEXT NOT NULL, lang TEXT NOT NULL,
            author TEXT, year INTEGER, body TEXT)');
        $rows = array(
            array('LLM Lab 소개', 'ko', '박대승', 2026, '범용 LLM 실험 플랫폼. RAG·Chain·Agent·Eval·Simulate 워크벤치.'),
            array('pgvector 벡터검색', 'ko', '박대승', 2026, 'PostgreSQL 에 벡터를 저장하고 코사인 유사도로 검색한다.'),
            array('Neo4j GraphRAG', 'ko', '박대승', 2026, '지식그래프를 Cypher 로 순회해 근거를 모은다.'),
            array('Getting Started', 'en', 'D.Park', 2026, 'A universal LLM lab. Connect a model profile and start chatting.'),
            array('Shared Hosting Backend', 'en', 'D.Park', 2026, 'PHP replaces the Python relay for cPanel-style hosting.'),
        );
        $stmt = $pdo->prepare('INSERT INTO docs (title, lang, author, year, body) VALUES (:t,:l,:a,:y,:b)');
        foreach ($rows as $r) {
            $stmt->execute(array(':t' => $r[0], ':l' => $r[1], ':a' => $r[2], ':y' => $r[3], ':b' => $r[4]));
        }
        return true;
    } catch (Throwable $e) {
        return false;
    }
}
