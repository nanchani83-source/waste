/* 경로 계산 엔진: 그래프 구성 + Dijkstra + 층별 구간 분할 + 안내 문구
 * 브라우저(window.Route)와 Node(require) 양쪽에서 사용한다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Route = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERTICAL = { elevator: 1, stairs: 1, escalator: 1 };
  const STAIR_LIKE = { stairs: 1, escalator: 1 };
  const DEFAULT_COST = { elevator: 30, stairs: 15, escalator: 12, connector: null, outdoor: null, corridor: null };

  /** 여러 지도 파일(본 지도 + 샘플 등)을 하나로 합친다. */
  function mergeMaps(...maps) {
    const out = { buildings: [], floors: [], nodes: [], edges: [], pois: [] };
    for (const m of maps) {
      if (!m) continue;
      for (const k of Object.keys(out)) if (Array.isArray(m[k])) out[k].push(...m[k]);
      if (m.version && !out.version) out.version = m.version;
    }
    return out;
  }

  /** map → 조회용 인덱스와 인접 리스트 */
  function buildGraph(map) {
    const floors = new Map(map.floors.map(f => [f.id, f]));
    const buildings = new Map(map.buildings.map(b => [b.id, b]));
    const nodes = new Map();
    for (const n of map.nodes) {
      if (nodes.has(n.id)) throw new Error('중복 노드 ID: ' + n.id);
      if (!floors.has(n.floor)) throw new Error('없는 층을 가리키는 노드: ' + n.id + ' → ' + n.floor);
      nodes.set(n.id, n);
    }
    const adj = new Map([...nodes.keys()].map(id => [id, []]));
    for (const e of map.edges) {
      const a = nodes.get(e.a), b = nodes.get(e.b);
      if (!a || !b) throw new Error('없는 노드를 잇는 간선: ' + e.a + ' – ' + e.b);
      const type = e.type || 'corridor';
      let cost = e.cost != null ? e.cost : DEFAULT_COST[type];
      if (cost == null) cost = distanceM(a, b, floors);
      const edge = { a: e.a, b: e.b, type, cost, label: e.label || '' };
      adj.get(e.a).push({ to: e.b, edge });
      if (!e.oneway) adj.get(e.b).push({ to: e.a, edge });
    }
    const pois = new Map(map.pois.map(p => [p.id, p]));
    for (const p of map.pois) if (!nodes.has(p.node)) throw new Error('목적지가 없는 노드를 가리킴: ' + p.id);
    // 길 안내 문구에 쓸 랜드마크(층별): 이름 있는 노드 + 목적지(화장실·엘리베이터 같은 공용시설은 뒤로)
    const landmarks = new Map();
    const addLm = (floor, x, y, name, rank) => {
      if (!landmarks.has(floor)) landmarks.set(floor, []);
      landmarks.get(floor).push({ x, y, name, rank });
    };
    for (const p of map.pois) { const n = nodes.get(p.node); addLm(n.floor, n.x, n.y, p.name, p.group ? 2 : 1); }
    for (const n of map.nodes) if (n.label) addLm(n.floor, n.x, n.y, n.label, 0);
    return { map, floors, buildings, nodes, adj, pois, landmarks };
  }

  /** 노드 근처(약 6m 이내)의 알아보기 쉬운 장소 이름 */
  function landmarkNear(g, node, exclude) {
    const list = g.landmarks.get(node.floor) || [];
    const mpp = g.floors.get(node.floor).metersPerPx || 0.1;
    const r = 6 / mpp;
    let best = null, bestScore = Infinity;
    for (const l of list) {
      if (l.name === exclude) continue;
      const d = Math.hypot(l.x - node.x, l.y - node.y);
      if (d > r) continue;
      const s = d + l.rank * r * 0.5;
      if (s < bestScore) { bestScore = s; best = l.name; }
    }
    return best;
  }

  /** 두 노드 사이 실제 거리(m). 같은 층이면 픽셀거리×축척, 다른 층/건물이면 평균 축척으로 근사 */
  function distanceM(a, b, floors) {
    const fa = floors.get(a.floor), fb = floors.get(b.floor);
    const mpp = ((fa.metersPerPx || 0.1) + (fb.metersPerPx || 0.1)) / 2;
    if (a.floor === b.floor) return Math.hypot(a.x - b.x, a.y - b.y) * mpp;
    return Math.max(Math.hypot(a.x - b.x, a.y - b.y) * mpp, 5);
  }

  /** 작은 이진 힙 */
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(item) {
      const a = this.a; a.push(item);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    }
  }

  /**
   * start에서 targets(노드 ID 배열) 중 가장 가까운 곳까지의 최단경로.
   * opts.avoidStairs: 계단·에스컬레이터 제외
   * 반환: { nodeIds, edges, cost, target } 또는 null(도달 불가)
   */
  function shortestPath(g, start, targets, opts = {}) {
    if (!g.nodes.has(start)) throw new Error('출발 노드 없음: ' + start);
    const goal = new Set(targets);
    const dist = new Map([[start, 0]]), prev = new Map();
    const heap = new Heap(); heap.push([0, start]);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist.get(u)) continue;
      if (goal.has(u)) {
        const nodeIds = [u], edges = [];
        let cur = u;
        while (prev.has(cur)) { const p = prev.get(cur); edges.unshift(p.edge); nodeIds.unshift(p.from); cur = p.from; }
        return { nodeIds, edges, cost: d, target: u };
      }
      for (const { to, edge } of g.adj.get(u)) {
        if (opts.avoidStairs && STAIR_LIKE[edge.type]) continue;
        const nd = d + edge.cost;
        if (nd < (dist.has(to) ? dist.get(to) : Infinity)) { dist.set(to, nd); prev.set(to, { from: u, edge }); heap.push([nd, to]); }
      }
    }
    return null;
  }

  /** start에서 모든 노드까지의 경로 비용(검색 결과를 가까운 순으로 정렬할 때 사용) */
  function distancesFrom(g, start, opts = {}) {
    const dist = new Map([[start, 0]]);
    const heap = new Heap(); heap.push([0, start]);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist.get(u)) continue;
      for (const { to, edge } of g.adj.get(u)) {
        if (opts.avoidStairs && STAIR_LIKE[edge.type]) continue;
        const nd = d + edge.cost;
        if (nd < (dist.has(to) ? dist.get(to) : Infinity)) { dist.set(to, nd); heap.push([nd, to]); }
      }
    }
    return dist;
  }

  /** 경로를 층이 바뀌는 지점에서 잘라 구간 배열로 만든다. */
  function splitByFloor(g, path) {
    const segs = [];
    let cur = null;
    path.nodeIds.forEach((id, i) => {
      const n = g.nodes.get(id);
      if (!cur || cur.floor !== n.floor) {
        const via = i > 0 ? path.edges[i - 1] : null;
        cur = { floor: n.floor, nodeIds: [], via };
        segs.push(cur);
      }
      cur.nodeIds.push(id);
    });
    return segs;
  }

  function floorLabel(g, floorId) {
    const f = g.floors.get(floorId);
    return f ? f.name : floorId;
  }

  function nodeName(g, id) {
    const n = g.nodes.get(id);
    return (n && n.label) || '';
  }

  /** 꺾임 각도 → 방향 문구 (이미지 좌표: y가 아래로 증가) */
  function turnWord(a, b, c) {
    const h1 = Math.atan2(b.y - a.y, b.x - a.x), h2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = (h2 - h1) * 180 / Math.PI;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    if (Math.abs(d) < 35) return null;
    if (Math.abs(d) > 150) return '뒤로 돌아';
    const side = d > 0 ? '오른쪽' : '왼쪽';
    return (Math.abs(d) < 60 ? '비스듬히 ' : '') + side + '으로';
  }

  /** 한 구간(같은 층)의 단계 문구 */
  function segmentSteps(g, seg, isLast, destName, exitName) {
    const steps = [];
    const f = g.floors.get(seg.floor);
    const mpp = f.metersPerPx || 0.1;
    // 로비처럼 점이 지그재그로 놓인 곳의 자잘한 꺾임은 합친다(약 3.5m 이내의 흔들림 무시)
    const pts = simplify(seg.nodeIds.map(id => g.nodes.get(id)), 3.5 / mpp);
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      run += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) * mpp;
      if (i < pts.length - 1) {
        const w = turnWord(pts[i - 1], pts[i], pts[i + 1]);
        // 마지막 몇 m 안의 꺾임은 "도착" 문구로 충분하므로 생략
        if (w && remaining(pts, i, mpp) > 4) {
          const lm = landmarkNear(g, pts[i], isLast ? destName : null);
          const at = !lm ? '' : /(앞|복도|입구|홀|통로)(\(.*\))?$/.test(lm) ? lm + '에서 ' : lm + ' 앞에서 ';
          steps.push(`약 ${roundM(run)}m 직진 → ${at}${w}`);
          run = 0;
        }
      }
    }
    const goal = isLast ? destName : exitName;
    // 남은 직진 구간 안내(출발점이 곧 층 이동 지점처럼 아주 짧으면 생략)
    if (run >= 4 || (!steps.length && (run >= 3 || isLast))) steps.push(`약 ${roundM(run)}m 직진`);
    if (isLast) steps.push(`도착: ${goal}`);
    return steps;
  }

  /** 꺾은선 단순화(Douglas–Peucker): tol(px)보다 덜 벗어나는 중간 점을 뺀다 */
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
      let worst = -1, wd = tol;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * (pts[i].x - A.x) - dx * (pts[i].y - A.y)) / len;
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst > 0) { keep[worst] = true; stack.push([a, worst], [worst, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function remaining(pts, i, mpp) {
    let r = 0;
    for (let k = i + 1; k < pts.length; k++) r += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) * mpp;
    return r;
  }

  function roundM(m) { return m < 10 ? Math.max(1, Math.round(m)) : Math.round(m / 5) * 5; }

  /** 받침에 맞는 조사 "으로/로" */
  function ro(word) {
    const c = word.charCodeAt(word.length - 1) - 0xAC00;
    if (c < 0 || c >= 11172) return word + '(으)로';
    const jong = c % 28;
    return word + (jong === 0 || jong === 8 ? '로' : '으로');
  }

  const VIA_TEXT = {
    elevator: (to) => `엘리베이터를 타고 ${ro(to)} 이동`,
    stairs: (to) => `계단으로 ${ro(to)} 이동`,
    escalator: (to) => `에스컬레이터로 ${ro(to)} 이동`,
    connector: (to, e) => `${e.label || '연결통로'}를 지나 ${ro(to)} 이동`,
    outdoor: (to) => `건물 밖으로 나가 ${ro(to)} 이동`,
    corridor: (to) => `${ro(to)} 이동`,
  };

  /**
   * 출발 노드 → 목적지(POI ID 배열, 가장 가까운 곳)까지 안내 결과 전체
   */
  function plan(g, startNode, poiIds, opts = {}) {
    const pois = poiIds.map(id => g.pois.get(id)).filter(Boolean);
    if (!pois.length) return { ok: false, reason: '목적지를 찾을 수 없습니다' };
    return planTo(g, startNode, pois, opts);
  }

  /**
   * 출발 노드 → dests([{ node, name, ... }]) 중 가장 가까운 곳까지 안내.
   * opts.arriveText: 마지막 "도착: ○○" 대신 쓸 문구(예: 엘리베이터를 타고 5층으로 이동)
   */
  function planTo(g, startNode, dests, opts = {}) {
    const byNode = new Map();
    for (const d of dests) if (g.nodes.has(d.node) && !byNode.has(d.node)) byNode.set(d.node, d);
    if (!byNode.size) return { ok: false, reason: '목적지를 찾을 수 없습니다' };
    const path = shortestPath(g, startNode, [...byNode.keys()], opts);
    if (!path) return { ok: false, reason: opts.avoidStairs ? '계단 없이 갈 수 있는 경로가 없습니다' : '갈 수 있는 경로가 없습니다' };
    const dest = byNode.get(path.target);
    const segs = splitByFloor(g, path);
    const multiFloor = segs.length > 1;
    let meters = 0;
    path.edges.forEach(e => { if (!VERTICAL[e.type]) meters += e.cost; });
    const vertical = path.edges.filter(e => VERTICAL[e.type]).length;
    segs.forEach((s, i) => {
      s.floorName = floorLabel(g, s.floor);
      s.steps = [];
      if (s.via) s.steps.push(VIA_TEXT[s.via.type] ? VIA_TEXT[s.via.type](s.floorName, s.via) : `${ro(s.floorName)} 이동`);
      const next = segs[i + 1];
      let exitName = '';
      if (next && next.via) {
        const t = next.via.type;
        const lastNode = g.nodes.get(s.nodeIds[s.nodeIds.length - 1]);
        exitName = lastNode.label || { elevator: '엘리베이터', stairs: '계단', escalator: '에스컬레이터', connector: next.via.label || '연결통로' }[t] || '';
      }
      s.steps.push(...segmentSteps(g, s, i === segs.length - 1, dest.name, exitName));
      if (next) {
        s.exitName = exitName;
        s.steps.push(`${exitName || '다음 지점'}에 도착하면 [다음] ▶ (${floorLabel(g, next.floor)})`);
      } else if (opts.arriveText) {
        s.steps[s.steps.length - 1] = opts.arriveText;
      }
    });
    // 보행속도 0.8 m/s(고령자 고려), 층 이동 1회 45초
    const seconds = meters / 0.8 + vertical * 45;
    return { ok: true, dest, path, segments: segs, multiFloor, meters: Math.round(meters), minutes: Math.max(1, Math.round(seconds / 60)) };
  }

  /** 엘리베이터 묶음(bank)에 속한 노드 ID 목록: 그 건물의 지도에 있는 층 × 엘리베이터 키 */
  function bankNodes(g, bankId) {
    const bank = (g.map.banks || {})[bankId];
    if (!bank) return [];
    const out = [];
    for (const f of g.floors.values()) {
      if (f.building !== bank.building) continue;
      for (const k of bank.keys) if (g.nodes.has(`${f.id}-${k}`)) out.push(`${f.id}-${k}`);
    }
    return out;
  }

  const levelName = n => (n > 0 ? `${n}층` : `지하 ${-n}층`);

  /**
   * 지도가 없는 층(병동 등)의 장소 안내: 그 건물 엘리베이터까지 길안내 + "엘리베이터를 타고 N층으로".
   * entry = map.directory 항목. 결과에 dir(항목)과 bank(엘리베이터 묶음)를 붙여 돌려준다.
   */
  function planToDirectory(g, startNode, entry, opts = {}) {
    const bank = (g.map.banks || {})[entry.bank];
    const ids = bankNodes(g, entry.bank);
    if (!bank || !ids.length) return { ok: false, reason: '이 장소로 가는 엘리베이터 정보를 찾을 수 없습니다' };
    const r = planTo(g, startNode, ids.map(id => ({ node: id, name: bank.name })), {
      ...opts, arriveText: `${bank.name}를 타고 ${ro(levelName(entry.level))} 이동 → 아래 약도 참고`,
    });
    if (r.ok) { r.dir = entry; r.bank = bank; }
    return r;
  }

  /** 오늘(YYYY-MM-DD) 진행 중인 행사만 */
  function activeEvents(map, today) {
    return (map.events || []).filter(e => e.node && (!e.from || e.from <= today) && (!e.to || today <= e.to));
  }

  /** 데이터 점검: 고립 노드, 도달 불가 목적지 */
  function validate(g, fromNode) {
    const issues = [];
    for (const [id, list] of g.adj) if (!list.length) issues.push('연결 없는 노드: ' + id);
    const seen = new Set([fromNode]), q = [fromNode];
    while (q.length) { const u = q.shift(); for (const { to } of g.adj.get(u)) if (!seen.has(to)) { seen.add(to); q.push(to); } }
    for (const p of g.pois.values()) if (!seen.has(p.node)) issues.push(`도달 불가 목적지: ${p.name} (${p.node})`);
    for (const e of g.map.events || []) {
      if (!g.nodes.has(e.node)) issues.push(`행사 위치가 없는 점을 가리킴: ${e.name} (${e.node})`);
      else if (!seen.has(e.node)) issues.push(`도달 불가 행사 위치: ${e.name} (${e.node})`);
    }
    for (const d of g.map.directory || []) {
      if (!bankNodes(g, d.bank).length) issues.push(`다른 층 안내의 엘리베이터 정보 없음: ${d.name} (${d.bank})`);
    }
    return issues;
  }

  /**
   * 3D 배치: 층마다 축척·크기가 달라도 엘리베이터·계단(같은 위치)을 기준으로 위아래 층을 맞춘다.
   * 반환: Map(floorId → { ox, oz, y, mpp })  — 월드좌표(m) = (ox + x*mpp, y, oz + y_img*mpp)
   */
  function floorLayout(g, floorGap = 10) {
    const layout = new Map();
    const minLevel = Math.min(...[...g.floors.values()].map(f => f.level));
    const pairs = new Map(); // "fa|fb" → [[na, nb], ...]
    for (const e of g.map.edges) {
      // 에스컬레이터는 위·아래 끝이 서로 떨어져 있어 정렬 기준에서 뺀다
      if (e.type !== 'elevator' && e.type !== 'stairs') continue;
      const a = g.nodes.get(e.a), b = g.nodes.get(e.b);
      for (const [p, q] of [[a, b], [b, a]]) {
        const k = p.floor + '|' + q.floor;
        if (!pairs.has(k)) pairs.set(k, []);
        pairs.get(k).push([p, q]);
      }
    }
    for (const b of g.buildings.values()) {
      const fs = [...g.floors.values()].filter(f => f.building === b.id).sort((x, y) => x.level - y.level);
      if (!fs.length) continue;
      const [bx, bz] = b.offset3d || [0, 0];
      const place = (f, ox, oz) => layout.set(f.id, { ox, oz, y: (f.level - minLevel) * floorGap, mpp: f.metersPerPx || 0.1 });
      place(fs[0], bx, bz);
      const queue = [fs[0].id];
      while (queue.length) {
        const fa = queue.shift(), A = layout.get(fa);
        for (const f of fs) {
          if (layout.has(f.id)) continue;
          const list = pairs.get(fa + '|' + f.id);
          if (!list) continue;
          let sx = 0, sz = 0;
          for (const [na, nb] of list) { sx += A.ox + na.x * A.mpp - nb.x * (f.metersPerPx || 0.1); sz += A.oz + na.y * A.mpp - nb.y * (f.metersPerPx || 0.1); }
          place(f, sx / list.length, sz / list.length);
          queue.push(f.id);
        }
      }
      for (const f of fs) if (!layout.has(f.id)) place(f, bx, bz);
    }
    return layout;
  }

  /** 층 안에서 (x,y)에 가장 가까운 점(복도 점 우선, 문·화장실 등 막다른 점은 제외) — 추정 위치에서 다시 안내할 때 */
  function nearestNode(g, floorId, x, y, maxM = 25) {
    const mpp = (g.floors.get(floorId) || {}).metersPerPx || 0.1;
    let best = null, bd = maxM / mpp;
    for (const n of g.nodes.values()) {
      if (n.floor !== floorId) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      const deg = g.adj.get(n.id).length;
      if (d < bd && deg >= 2) { bd = d; best = n; }
    }
    return best;
  }

  return { nearestNode, mergeMaps, buildGraph, shortestPath, distancesFrom, splitByFloor, plan, planTo, planToDirectory, bankNodes, activeEvents, levelName, validate, turnWord, floorLayout };
});
