/* ============================================================
   graph-view.js — LLM Lab
   경량 force-directed 그래프 뷰어 (외부 의존성 0, Canvas 2D)
   비ES모듈: window.GraphView 네임스페이스로 노출 (IIFE).
   API:
     mount(canvasEl, opts)
     setData({ nodes, edges, communities })
     highlight({ nodeIds, edgeIds })
     setTheme(isDark)
     resize() · reheat() · stop() · destroy()
     onNodeClick(cb)  // 클릭 시 node.id 전달
   계약: 노드=엔티티, 엣지=관계(source/target=엔티티 id).
   nodes[].x,y 가 이미 있으면 물리 생략(정적 렌더).
   ============================================================ */
(function () {
  'use strict';

  // ── 팔레트 (녹색 테마와 조화 — 커뮤니티 색은 HSL 해시로 채도/명도 고정) ──
  const THEME = {
    light: {
      bg: 'transparent',
      edge: 'rgba(90,107,99,0.35)',
      edgeHi: 'rgba(4,120,87,0.9)',
      label: '#0F1F1A',
      labelDim: 'rgba(15,31,26,0.35)',
      nodeStroke: '#FFFFFF',
      tooltipBg: 'rgba(255,255,255,0.97)',
      tooltipText: '#0F1F1A',
      tooltipBorder: '#C4DDD1',
      dim: 0.12,
    },
    dark: {
      bg: 'transparent',
      edge: 'rgba(157,179,170,0.28)',
      edgeHi: 'rgba(52,211,153,0.95)',
      label: '#E6F2EC',
      labelDim: 'rgba(230,242,236,0.3)',
      nodeStroke: '#0A1512',
      tooltipBg: 'rgba(18,32,27,0.98)',
      tooltipText: '#E6F2EC',
      tooltipBorder: '#31493F',
      dim: 0.14,
    },
  };

  function communityColor(communityId, isDark) {
    // 안정적 해시 → hue. 채도/명도는 녹색 테마와 조화되도록 고정.
    const str = String(communityId == null ? 'none' : communityId);
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    // 녹색(150) 근처를 중심으로 넓게 분포하되 붉은색 회피
    const hue = (120 + h) % 360;
    const sat = isDark ? 62 : 58;
    const light = isDark ? 58 : 46;
    return `hsl(${hue} ${sat}% ${light}%)`;
  }

  const GraphView = (function () {
    let canvas = null, ctx = null, dpr = 1;
    let width = 0, height = 0;
    let nodes = [], edges = [];
    let isDark = false;
    let raf = null, alpha = 0, alphaTarget = 0;
    // 뷰 변환 (줌/팬)
    let scale = 1, tx = 0, ty = 0;
    // 인터랙션 상태
    let hoverNode = null, dragNode = null, panning = false;
    let last = { x: 0, y: 0 };
    let highlightSet = { nodes: null, edges: null };
    let clickCb = null;
    let mounted = false;

    /* ---- 좌표 변환 ---- */
    const toWorld = (px, py) => ({ x: (px - tx) / scale, y: (py - ty) / scale });

    /* ---- 데이터 주입 ---- */
    function setData(data) {
      const d = data || {};
      const inNodes = Array.isArray(d.nodes) ? d.nodes : [];
      const inEdges = Array.isArray(d.edges) ? d.edges : [];
      const cx = width / 2 || 180, cy = height / 2 || 140;
      const prev = new Map(nodes.map((n) => [n.id, n]));

      nodes = inNodes.map((n, i) => {
        const old = prev.get(n.id);
        const hasCoords = typeof n.x === 'number' && typeof n.y === 'number';
        const angle = (i / Math.max(1, inNodes.length)) * Math.PI * 2;
        return {
          id: n.id,
          name: n.name || n.id,
          type: n.type || '',
          degree: Number(n.degree) || 1,
          community: n.community != null ? n.community : (n.communityId != null ? n.communityId : null),
          rank: n.rank,
          x: hasCoords ? n.x : (old ? old.x : cx + Math.cos(angle) * (60 + Math.random() * 60)),
          y: hasCoords ? n.y : (old ? old.y : cy + Math.sin(angle) * (60 + Math.random() * 60)),
          vx: 0, vy: 0, fx: null, fy: null,
          _static: hasCoords,
        };
      });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      edges = inEdges
        .map((e) => ({
          id: e.id,
          source: byId.get(e.source),
          target: byId.get(e.target),
          weight: Number(e.weight) || 1,
          description: e.description || '',
        }))
        .filter((e) => e.source && e.target);

      highlightSet = { nodes: null, edges: null };
      const allStatic = nodes.length > 0 && nodes.every((n) => n._static);
      if (allStatic) { alpha = 0; alphaTarget = 0; draw(); }
      else reheat();
    }

    /* ---- 물리 시뮬레이션 (charge 반발 + link 스프링 + center gravity) ---- */
    function tick() {
      const cx = width / 2, cy = height / 2;
      const k = 1; // 강도 스케일
      // 반발 (N² — ≤500 노드 무난)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { d2 = 0.01; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
          const dist = Math.sqrt(d2);
          const rep = (2600 * k) / d2;
          const fx = (dx / dist) * rep, fy = (dy / dist) * rep;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      // 링크 스프링
      for (const e of edges) {
        const desired = 64 + 18 / Math.sqrt(e.weight);
        let dx = e.target.x - e.source.x, dy = e.target.y - e.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = ((dist - desired) / dist) * 0.16;
        const fx = dx * f, fy = dy * f;
        e.source.vx += fx; e.source.vy += fy;
        e.target.vx -= fx; e.target.vy -= fy;
      }
      // 중심 중력 + 적분
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.008;
        n.vy += (cy - n.y) * 0.008;
        n.vx *= 0.86; n.vy *= 0.86;
        if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; }
        else { n.x += n.vx * alpha * 2; n.y += n.vy * alpha * 2; }
      }
    }

    function loop() {
      if (alpha > alphaTarget) alpha = Math.max(alphaTarget, alpha - 0.012);
      if (alpha > 0.001) tick();
      draw();
      if (alpha > 0.001 || dragNode) raf = requestAnimationFrame(loop);
      else { raf = null; }
    }

    function nodeRadius(n) { return 4 + Math.min(14, Math.sqrt(n.degree) * 2.4); }

    /* ---- 렌더 ---- */
    function draw() {
      if (!ctx) return;
      const t = isDark ? THEME.dark : THEME.light;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(scale, scale);

      const hlN = highlightSet.nodes, hlE = highlightSet.edges;
      const hasHl = !!(hlN && hlN.size);

      // 엣지
      ctx.lineCap = 'round';
      for (const e of edges) {
        const on = !hasHl || (hlE && hlE.has(e.id)) || (hlN && hlN.has(e.source.id) && hlN.has(e.target.id));
        ctx.globalAlpha = on ? 1 : t.dim;
        ctx.strokeStyle = on && hasHl ? t.edgeHi : t.edge;
        ctx.lineWidth = Math.max(0.6, Math.min(4, e.weight * 0.7)) / scale + 0.4;
        ctx.beginPath();
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 노드
      const showLabels = scale > 0.75;
      for (const n of nodes) {
        const r = nodeRadius(n);
        const on = !hasHl || (hlN && hlN.has(n.id));
        ctx.globalAlpha = on ? 1 : t.dim;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = communityColor(n.community, isDark);
        ctx.fill();
        ctx.lineWidth = (n === hoverNode ? 2.5 : 1.5) / scale;
        ctx.strokeStyle = n === hoverNode ? t.edgeHi : t.nodeStroke;
        ctx.stroke();

        if (showLabels && (on || n === hoverNode)) {
          ctx.globalAlpha = on ? 1 : 0.5;
          ctx.fillStyle = on ? t.label : t.labelDim;
          ctx.font = `${Math.max(9, 11 / scale + 1)}px 'Pretendard',system-ui,sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const label = n.name.length > 16 ? n.name.slice(0, 15) + '…' : n.name;
          ctx.fillText(label, n.x, n.y + r + 2);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // 호버 툴팁 (스크린 좌표)
      if (hoverNode) drawTooltip(hoverNode, t);
    }

    function drawTooltip(n, t) {
      const sx = n.x * scale + tx, sy = n.y * scale + ty;
      const lines = [n.name, [n.type, 'deg ' + n.degree].filter(Boolean).join(' · ')].filter(Boolean);
      ctx.font = "12px 'Pretendard',system-ui,sans-serif";
      let w = 0;
      for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
      const pad = 8, lh = 16, bw = w + pad * 2, bh = lines.length * lh + pad;
      let bx = sx + 12, by = sy - bh - 8;
      if (bx + bw > width) bx = width - bw - 4;
      if (by < 0) by = sy + 14;
      ctx.fillStyle = t.tooltipBg;
      ctx.strokeStyle = t.tooltipBorder;
      ctx.lineWidth = 1;
      roundRect(bx, by, bw, bh, 8);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = t.tooltipText;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach((l, i) => {
        ctx.globalAlpha = i === 0 ? 1 : 0.7;
        ctx.font = i === 0 ? "600 12px 'Pretendard',system-ui,sans-serif" : "11px 'Pretendard',system-ui,sans-serif";
        ctx.fillText(l, bx + pad, by + pad / 2 + i * lh);
      });
      ctx.globalAlpha = 1;
    }
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /* ---- 히트 테스트 ---- */
    function pick(px, py) {
      const w = toWorld(px, py);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = nodeRadius(n) + 3;
        if ((n.x - w.x) ** 2 + (n.y - w.y) ** 2 <= r * r) return n;
      }
      return null;
    }

    /* ---- 포인터 이벤트 ---- */
    function relPos(e) {
      const rect = canvas.getBoundingClientRect();
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
      return { x: cx, y: cy };
    }
    function onDown(e) {
      const p = relPos(e);
      const n = pick(p.x, p.y);
      last = p;
      if (n) { dragNode = n; n.fx = n.x; n.fy = n.y; }
      else { panning = true; }
      if (e.cancelable) e.preventDefault();
    }
    function onMove(e) {
      const p = relPos(e);
      if (dragNode) {
        const w = toWorld(p.x, p.y);
        dragNode.fx = w.x; dragNode.fy = w.y; dragNode.x = w.x; dragNode.y = w.y;
        kick();
      } else if (panning) {
        tx += p.x - last.x; ty += p.y - last.y; last = p; draw();
      } else {
        const n = pick(p.x, p.y);
        if (n !== hoverNode) { hoverNode = n; canvas.style.cursor = n ? 'pointer' : 'grab'; draw(); }
      }
    }
    function onUp() {
      if (dragNode) { dragNode.fx = null; dragNode.fy = null; reheat(); }
      dragNode = null; panning = false;
    }
    let downPos = null;
    function onClick(e) {
      const p = relPos(e);
      const n = pick(p.x, p.y);
      if (n && clickCb) clickCb(n.id);
    }
    function onWheel(e) {
      e.preventDefault();
      const p = relPos(e);
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const ns = Math.max(0.25, Math.min(4, scale * factor));
      // 커서 기준 줌
      tx = p.x - (p.x - tx) * (ns / scale);
      ty = p.y - (p.y - ty) * (ns / scale);
      scale = ns;
      draw();
    }

    function kick() { if (!raf) { alpha = Math.max(alpha, 0.1); raf = requestAnimationFrame(loop); } }
    function reheat() { alpha = 0.9; alphaTarget = 0; if (!raf) raf = requestAnimationFrame(loop); }
    function stop() { alphaTarget = 0; alpha = 0; }

    /* ---- 마운트/리사이즈 ---- */
    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      width = rect.width || canvas.clientWidth || 340;
      height = rect.height || canvas.clientHeight || 280;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      draw();
    }

    function mount(canvasEl, opts) {
      opts = opts || {};
      canvas = canvasEl;
      ctx = canvas.getContext('2d');
      isDark = !!opts.isDark;
      canvas.style.cursor = 'grab';
      if (!mounted) {
        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        canvas.addEventListener('click', onClick);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('touchstart', onDown, { passive: false });
        canvas.addEventListener('touchmove', (e) => { onMove(e); if (e.cancelable) e.preventDefault(); }, { passive: false });
        canvas.addEventListener('touchend', onUp);
        mounted = true;
      }
      resize();
      return GraphView;
    }

    function highlight(sub) {
      sub = sub || {};
      const nIds = Array.isArray(sub.nodeIds) ? sub.nodeIds : [];
      const eIds = Array.isArray(sub.edgeIds) ? sub.edgeIds : [];
      highlightSet = {
        nodes: nIds.length ? new Set(nIds) : null,
        edges: eIds.length ? new Set(eIds) : null,
      };
      draw();
    }
    function setTheme(dark) { isDark = !!dark; draw(); }
    function onNodeClick(cb) { clickCb = typeof cb === 'function' ? cb : null; }
    function focusNode(id) {
      const n = nodes.find((x) => x.id === id);
      if (!n) return;
      hoverNode = n;
      highlightSet = { nodes: new Set([id]), edges: null };
      // 인접 노드도 강조
      for (const e of edges) {
        if (e.source.id === id) highlightSet.nodes.add(e.target.id);
        if (e.target.id === id) highlightSet.nodes.add(e.source.id);
      }
      draw();
    }
    function destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = null; nodes = []; edges = [];
      if (canvas && ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    }
    function resetView() { scale = 1; tx = 0; ty = 0; draw(); }

    return { mount, setData, highlight, setTheme, resize, reheat, stop, destroy, onNodeClick, focusNode, resetView };
  })();

  window.GraphView = GraphView;
})();
