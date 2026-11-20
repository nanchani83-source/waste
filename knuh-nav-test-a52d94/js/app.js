/* 내원객 화면: QR(?at=) → 현위치 → 목적지 입력 → 2D 층별 안내, 층/건물 이동 경로는 3D 보기 제공 */
(async function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const DIR_CAT = '병동·다른 층', EVT_CAT = '행사';
  const CATEGORIES = ['진료과', '검사', '원무·수납', '편의시설', '출입구', DIR_CAT];
  const APP_VERSION = '2026-11-18e';   // 배포 시 올리면 휴대폰 캐시가 새 3D 코드를 받는다

  // ---------- 데이터 ----------
  let map;
  try {
    // 편집기의 [미리보기]: 저장하지 않은 편집 내용(같은 브라우저의 임시저장)으로 보기
    if (params.get('draft') === '1') {
      try { const d = localStorage.getItem('wf-editor-draft'); if (d) map = JSON.parse(d); } catch (e) {}
    }
    if (!map) {
      const res = await fetch('data/map.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      map = await res.json();
    }
  } catch (e) {
    showMsg('지도 데이터를 불러오지 못했습니다. 잠시 후 다시 시도하거나 안내데스크에 문의해 주세요.');
    return;
  }
  const g = Route.buildGraph(map);
  map.pois.forEach(p => {
    p._floor = g.nodes.get(p.node).floor;
    p._building = g.buildings.get(g.floors.get(p._floor).building).name;
  });
  const index = Search.buildIndex(map.pois);
  // 지도가 없는 층(병동 등): 홈페이지 원내 배치도 기준으로 층과 대략 위치만 안내
  for (const d of map.directory || []) {
    index.push(Search.makeItem(d.id, d.name, DIR_CAT, [...(d.aliases || []), d.floorName + ' ' + d.name.replace(/\(.*?\)/g, '')], { dir: d }));
  }
  // 오늘 진행 중인 행사(편집기에서 등록) — 기간이 지나면 자동으로 사라진다
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const events = Route.activeEvents(map, today).filter(e => g.nodes.has(e.node));
  for (const e of events) index.push(Search.makeItem(e.id, e.name, EVT_CAT, [...(e.aliases || []), '행사'], { event: e, floors: [g.nodes.get(e.node).floor] }));
  if (events.length) CATEGORIES.unshift(EVT_CAT);

  // 항목의 도착 지점들(목적지 문 / 엘리베이터 / 행사 위치)
  const itemNodes = it => it.dir ? Route.bankNodes(g, it.dir.bank) : it.event ? [it.event.node] : it.poiIds.map(id => g.pois.get(id).node);
  // 현위치에서 각 지점까지의 거리(같은 이름이 여러 건물에 있을 때 가까운 곳을 먼저 보여 줌)
  let distMap = null;
  const distanceOf = it => {
    if (!state.start) return 0;
    if (!distMap) distMap = Route.distancesFrom(g, state.start, { avoidStairs: state.avoidStairs });
    let best = Infinity;
    for (const id of itemNodes(it)) { const d = distMap.get(id); if (d != null && d < best) best = d; }
    return best + (it.dir ? 60 : 0);   // 같은 이름이면 지도에 있는 곳을 먼저
  };
  // 현위치를 직접 고를 때의 목록: QR 위치 먼저, 그다음 이름이 있는 지점(출입구·엘리베이터 홀 등)
  const startNodes = [...map.nodes.filter(n => n.qr), ...map.nodes.filter(n => !n.qr && n.label && !/엘리베이터( \d)?$|엘리베이터\(/.test(n.label))];

  // ---------- 상태 ----------
  const state = {
    start: null,          // 현위치 노드 ID
    floor: null,          // 지도에 보이는 층
    route: null,          // Route.plan 결과
    seg: 0,               // 보고 있는 구간
    item: null,           // 선택한 검색 항목
    avoidStairs: params.get('easy') === '1',
  };
  $('#avoidStairs').checked = state.avoidStairs;

  const atParam = params.get('at');
  if (atParam && g.nodes.has(atParam)) state.start = atParam;
  else state.start = null;
  state.floor = state.start ? g.nodes.get(state.start).floor : map.floors[0].id;

  // ---------- 지도(Leaflet, 이미지 좌표) ----------
  const lmap = L.map('map', {
    crs: L.CRS.Simple, minZoom: -4, maxZoom: 1.5, zoomSnap: 0.25, zoomDelta: 0.5,
    attributionControl: false, zoomControl: false, tap: true,
  });
  L.control.zoom({ position: 'topright', zoomInTitle: '확대', zoomOutTitle: '축소' }).addTo(lmap);
  let overlay = null;
  const layer = L.layerGroup().addTo(lmap);

  const fl = id => g.floors.get(id);
  const ll = n => [fl(n.floor).height - n.y, n.x];
  const floorBounds = f => [[0, 0], [f.height, f.width]];

  function sheetPad() {
    const sheet = $('#sheet');
    const wide = window.matchMedia('(min-width: 760px)').matches;
    return wide
      ? { paddingTopLeft: [sheet.offsetWidth + 40, 80], paddingBottomRight: [30, 30] }
      : { paddingTopLeft: [24, 80], paddingBottomRight: [24, sheet.offsetHeight + 16] };
  }

  function showFloor(fid, fitTo) {
    const f = fl(fid);
    state.floor = fid;
    if (overlay) lmap.removeLayer(overlay);
    overlay = L.imageOverlay(f.image, floorBounds(f), { alt: f.name + ' 평면도' }).addTo(lmap);
    lmap.setMaxBounds(L.latLngBounds(floorBounds(f)).pad(0.5));
    drawLayers();
    renderFloorTabs();
    // 경로가 있으면 경로 구간, 없으면 건물 영역(노드가 있는 범위)에 맞춘다 — 안내도의 여백·범례는 제외
    const pts = fitTo && fitTo.length ? fitTo : map.nodes.filter(n => n.floor === fid).map(ll);
    let b = pts.length ? L.latLngBounds(pts).pad(0.12) : L.latLngBounds(floorBounds(f));
    // 짧은 구간도 주변이 보이도록 최소 범위(약 30m) 확보
    const minSpan = 35 / (f.metersPerPx || 0.1), c = b.getCenter();
    if (b.getNorth() - b.getSouth() < minSpan && b.getEast() - b.getWest() < minSpan) {
      b = L.latLngBounds([c.lat - minSpan / 2, c.lng - minSpan / 2], [c.lat + minSpan / 2, c.lng + minSpan / 2]);
    }
    lmap.fitBounds(b, { ...sheetPad(), maxZoom: 0, animate: false });
  }

  const hereIcon = label => L.divIcon({
    className: 'here-pin', iconSize: [0, 0],
    html: `<span class="pulse"></span><span class="core"></span><span class="pin-label">${esc(label)}</span>`,
  });
  const destIcon = label => L.divIcon({
    className: 'dest-pin', iconSize: [34, 44], iconAnchor: [17, 44],
    html: `<span class="pin-label">${esc(label)}</span><svg viewBox="0 0 34 44"><path d="M17 1C8.2 1 1 8 1 16.6 1 28.4 17 43 17 43s16-14.6 16-26.4C33 8 25.8 1 17 1Z" fill="#d93025" stroke="#fff" stroke-width="2"/><circle cx="17" cy="16.5" r="6" fill="#fff"/></svg>`,
  });
  const hopIcon = text => L.divIcon({ className: 'hop-pin', iconSize: [0, 0], html: `<span class="bubble">${esc(text)}</span>` });

  function drawLayers() {
    layer.clearLayers();
    const r = state.route;
    if (r) {
      r.segments.forEach((s, i) => {
        if (s.floor !== state.floor) return;
        const pts = s.nodeIds.map(id => ll(g.nodes.get(id)));
        const active = i === state.seg;
        L.polyline(pts, { color: '#fff', weight: active ? 13 : 9, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer);
        L.polyline(pts, { color: active ? '#1d4ed8' : '#93a8d8', weight: active ? 7 : 5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer);
        if (active) L.polyline(pts, { color: '#fff', weight: 3, className: 'route-anim', interactive: false }).addTo(layer);
        const next = r.segments[i + 1];
        if (next) {
          const end = g.nodes.get(s.nodeIds[s.nodeIds.length - 1]);
          const word = { elevator: '엘리베이터', stairs: '계단', escalator: '에스컬레이터', connector: '연결통로', outdoor: '밖으로' }[next.via.type] || '이동';
          const arrow = fl(next.floor).level > fl(s.floor).level ? '↑' : fl(next.floor).level < fl(s.floor).level ? '↓' : '→';
          L.marker(ll(end), { icon: hopIcon(`${word} ${arrow} ${fl(next.floor).name}`), interactive: false, zIndexOffset: 500 }).addTo(layer);
        }
        const st = g.nodes.get(s.nodeIds[0]), dn0 = g.nodes.get(r.dest.node);
        const nearDest = dn0.floor === s.floor && Math.hypot(dn0.x - st.x, dn0.y - st.y) * (fl(s.floor).metersPerPx || 0.1) < 12;
        if (i > 0 && s.via && !nearDest) {
          L.marker(ll(st), { icon: hopIcon(`${fl(r.segments[i - 1].floor).name}에서 도착`), interactive: false }).addTo(layer);
        }
      });
      const dn = g.nodes.get(r.dest.node);
      const pinText = r.dir ? `엘리베이터 → ${Route.levelName(r.dir.level)}` : r.dest.name;
      if (dn.floor === state.floor) L.marker(ll(dn), { icon: destIcon(pinText), interactive: false, zIndexOffset: 800 }).addTo(layer);
    }
    if (state.start) {
      const sn = g.nodes.get(state.start);
      if (sn.floor === state.floor) L.marker(ll(sn), { icon: hereIcon('현위치'), interactive: false, zIndexOffset: 1000 }).addTo(layer);
    }
  }

  // 건물 선택
  const bldSel = $('#bldSel');
  bldSel.innerHTML = map.buildings.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  bldSel.addEventListener('change', () => {
    const fs = map.floors.filter(f => f.building === bldSel.value);
    const onRoute = state.route && state.route.segments.findIndex(s => fl(s.floor).building === bldSel.value);
    if (state.route && onRoute >= 0) { goSeg(onRoute); return; }
    // 현위치가 있는 층 → 경로 층 → 가장 낮은 층 순으로 보여 준다
    const here = state.start && g.nodes.get(state.start).floor;
    const pick = fs.find(f => f.id === here) || fs.slice().sort((a, b) => a.level - b.level)[0];
    showFloor(pick.id);
  });

  function renderFloorTabs() {
    const cur = fl(state.floor);
    bldSel.value = cur.building;
    const floors = map.floors.filter(f => f.building === cur.building).sort((a, b) => b.level - a.level);
    const onRoute = new Set(state.route ? state.route.segments.map(s => s.floor) : []);
    $('#floorTabs').innerHTML = floors.map(f => {
      const short = f.level > 0 ? `${f.level}층` : `B${-f.level}`;
      const dot = onRoute.has(f.id) ? '<span class="dot" aria-label="경로 있음"></span>' : '';
      return `<button type="button" role="tab" data-floor="${f.id}" aria-selected="${f.id === state.floor}">${short}${dot}</button>`;
    }).join('');
  }
  $('#floorTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-floor]');
    if (!b) return;
    const fid = b.dataset.floor;
    if (state.route) {
      const i = state.route.segments.findIndex(s => s.floor === fid);
      if (i >= 0) { goSeg(i); return; }
    }
    showFloor(fid);
  });

  // ---------- 현위치 ----------
  function renderHere(picking) {
    const el = $('#hereLine');
    if (state.start && !picking) {
      const n = g.nodes.get(state.start);
      el.innerHTML = `<span class="dot"></span><span>현위치 <b>${esc(fl(n.floor).name)} · ${esc(n.label || '이 안내판 앞')}</b></span>
        <button type="button" class="link-btn" id="btnChangeHere">현위치 바꾸기</button>`;
      $('#btnChangeHere').addEventListener('click', () => renderHere(true));
    } else {
      const opts = startNodes.map(n => `<option value="${n.id}"${n.id === state.start ? ' selected' : ''}>${esc(fl(n.floor).name)} · ${esc(n.label || n.id)}</option>`).join('');
      el.innerHTML = `<span>${state.start ? '바뀐 현위치를 고르세요' : '현위치를 고르세요 (QR을 찍으면 자동으로 표시됩니다)'}</span>
        <select id="pickStart" aria-label="현위치 선택"><option value="">— 현위치 선택 —</option>${opts}</select>
        ${state.start ? '<button type="button" class="link-btn" id="btnCancelHere">취소</button>' : ''}`;
      if (state.start) $('#btnCancelHere').addEventListener('click', () => renderHere());
      $('#pickStart').addEventListener('change', e => {
        if (!e.target.value) return;
        state.start = e.target.value;
        distMap = null;
        updateUrl();
        renderHere();
        showFloor(g.nodes.get(state.start).floor, aroundHere());
        if (state.item) routeTo(state.item);
      });
    }
  }

  // ---------- 검색 ----------
  const q = $('#q'), results = $('#results');
  let activeIdx = -1, lastList = [];

  function itemMeta(it) {
    if (it.dir) return it.dir.floorName;
    if (it.event) return '행사 · ' + (fl(it.floors[0]) ? fl(it.floors[0]).name : '');
    if (it.nearest) return '가장 가까운 곳';
    const f = fl(it.floors[0]);
    return f ? f.name : '';
  }
  function renderResults(list, emptyText) {
    lastList = list; activeIdx = -1;
    if (!list.length) { results.innerHTML = emptyText ? `<li class="empty">${emptyText}</li>` : ''; return; }
    results.innerHTML = list.map((r, i) => {
      const it = r.item || r;
      const via = r.via && r.via !== Search.norm(it.name) ? `<div class="via">'${esc(r.via)}' 관련</div>` : '';
      return `<li><button type="button" role="option" data-i="${i}"><span><span class="name">${esc(it.name)}</span>${via}</span><span class="meta">${esc(itemMeta(it))}</span></button></li>`;
    }).join('');
  }
  q.addEventListener('input', () => {
    setChip(null);
    const v = q.value.trim();
    if (!v) { renderResults([]); return; }
    const list = Search.search(index, v, 8, distanceOf);
    renderResults(list, `'${esc(v)}'에 맞는 곳을 찾지 못했습니다. 아래 분류에서 고르거나 <b>안내데스크</b>를 검색해 보세요.`);
  });
  q.addEventListener('keydown', e => {
    if (!lastList.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + lastList.length) % lastList.length;
      results.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(lastList[Math.max(0, activeIdx)]);
    }
  });
  results.addEventListener('click', e => {
    const b = e.target.closest('button[data-i]');
    if (b) pick(lastList[+b.dataset.i]);
  });
  function pick(r) {
    const it = r.item || r;
    q.blur();
    routeTo(it);
  }

  // 분류 버튼
  $('#chips').innerHTML = CATEGORIES.map(c => `<button type="button" data-cat="${c}" aria-pressed="false">${c}</button>`).join('');
  function setChip(cat) {
    $('#chips').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cat === cat)));
  }
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('button[data-cat]');
    if (!b) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    setChip(on ? b.dataset.cat : null);
    q.value = '';
    // 분류 목록은 가까운 순(묶음 항목은 맨 위)
    renderResults(on ? index.filter(it => it.category === b.dataset.cat).sort((a, b2) => (b2.nearest - a.nearest) || distanceOf(a) - distanceOf(b2) || a.name.localeCompare(b2.name, 'ko')) : []);
  });

  $('#avoidStairs').addEventListener('change', e => {
    state.avoidStairs = e.target.checked;
    distMap = null;
    updateUrl();
  });

  // ---------- 경로 ----------
  function routeTo(item) {
    state.item = item;
    hideMsg();
    if (!state.start) {
      showMsg(`'${item.name}'(으)로 안내하려면 먼저 현위치를 골라 주세요.`);
      const sel = $('#pickStart'); if (sel) sel.focus();
      return;
    }
    const opt = { avoidStairs: state.avoidStairs };
    const r = item.dir ? Route.planToDirectory(g, state.start, item.dir, opt)
      : item.event ? Route.planTo(g, state.start, [{ node: item.event.node, name: item.event.name }], opt)
      : Route.plan(g, state.start, item.poiIds, opt);
    if (!r.ok) { showMsg(r.reason + '. 안내데스크에 문의해 주세요.'); return; }
    state.route = r; state.seg = 0;
    updateUrl();
    $('#findView').hidden = true;
    $('#routeView').hidden = false;
    const hops = r.segments.length - 1;
    const walk = `약 ${r.meters}m · 걸어서 약 ${r.minutes}분` + (hops ? ` · 층 이동 ${hops}회` : '') + (state.avoidStairs ? ' · 계단 없음' : '');
    if (r.dir) {
      $('#destName').textContent = r.dir.name;
      $('#summary').textContent = `${r.dir.floorName} · 엘리베이터까지 ${walk}`;
    } else {
      $('#destName').textContent = r.dest.name + (item.nearest ? ' (가장 가까운 곳)' : '');
      $('#summary').textContent = (item.event ? '행사 · ' : '') + walk;
    }
    renderDirCard(r, item);
    $('#btn3d').hidden = !(r.multiFloor && webglOK());
    $('#segTabs').innerHTML = r.segments.length > 1
      ? r.segments.map((s, i) => `<li><button type="button" data-seg="${i}">${i + 1}. ${esc(s.floorName)}</button></li>`).join('')
      : '';
    goSeg(0);
    setFold(false);   // 새 경로는 펼쳐서 보여 주고, 일정 시간 뒤 내려간다
  }

  // 행사 현장 사진(photos: [{src, cap, at?}]) — at 이 있으면 그 출발점에서 올 때만 보여 준다
  function eventPhotos(e) {
    const list = (e.photos || []).filter(p => !p.at || p.at === state.start);
    if (!list.length) return '';
    return '<div class="evt-photos">' + list.map(p => `<figure><img src="${esc(p.src)}" alt="${esc(p.cap || '')}" loading="lazy" data-zoom="1"><figcaption>${esc(p.cap || '')}</figcaption></figure>`).join('') + '</div>';
  }
  $('#dirCard').addEventListener('click', ev => {
    const im = ev.target.closest('img[data-zoom]');
    if (!im) return;
    const ov = document.createElement('div');
    ov.className = 'photo-zoom';
    ov.innerHTML = '<img src="' + im.getAttribute('src') + '" alt=""><span>탭하면 닫힙니다</span>';
    ov.addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
  });

  // 다른 층 안내 카드(층 약도 + 대략 위치) / 행사 설명
  function renderDirCard(r, item) {
    const el = $('#dirCard');
    if (r.dir) {
      const d = r.dir;
      el.innerHTML = `<div class="dir-title">${esc(d.name)} <span>${esc(d.floorName)}</span></div>
        <p>이 층은 상세 지도가 없어 <b>층과 대략적인 위치</b>만 안내합니다. ${esc(r.bank.name)}에서 내린 뒤 아래 약도의 <b class="dir-key">●</b> 표시 쪽으로 가세요.</p>
        ${d.image ? `<div class="dir-map"><img src="${esc(d.image)}" alt="${esc(d.floorName)} 약도" loading="lazy"><span class="dir-dot" style="left:${(d.x * 100).toFixed(1)}%;top:${(d.y * 100).toFixed(1)}%"></span></div>
        <div class="dir-src">약도 출처: 병원 홈페이지 원내 배치도</div>` : ''}`;
      el.hidden = false;
    } else if (item.event && (item.event.desc || item.event.to)) {
      const e = item.event;
      el.innerHTML = `<div class="dir-title">${esc(e.name)} <span>행사</span></div>
        ${e.desc ? `<p>${esc(e.desc)}</p>` : ''}${e.from || e.to ? `<div class="dir-src">기간: ${esc(e.from || '')} ~ ${esc(e.to || '')}</div>` : ''}${eventPhotos(e)}`;
      el.hidden = false;
    } else { el.hidden = true; el.innerHTML = ''; }
  }

  function goSeg(i) {
    const r = state.route;
    state.seg = i;
    const s = r.segments[i];
    $('#steps').innerHTML = s.steps.map((t, k) => {
      let cls = '';
      if (k === 0 && s.via) cls = 'via';
      else if (t.startsWith('도착') || (r.dir && i === r.segments.length - 1 && k === s.steps.length - 1)) cls = 'arrive';
      else if (t.includes('[다음]')) cls = 'next';
      return `<li class="${cls}">${esc(t.replace(' [다음] ▶', ' [다음]을 누르세요'))}</li>`;
    }).join('');
    $('#segTabs').querySelectorAll('button').forEach((b, k) => {
      if (k === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    $('#btnPrev').disabled = i === 0;
    const last = i === r.segments.length - 1;
    $('#btnNext').disabled = last;
    $('#btnNext').textContent = last ? (r.dir ? '엘리베이터 도착 구간' : '도착 구간') : `다음: ${r.segments[i + 1].floorName} ▶`;
    $('#sheet').scrollTop = 0;
    navSync(i);
    showFloor(s.floor, s.nodeIds.map(id => ll(g.nodes.get(id))));
  }
  $('#segTabs').addEventListener('click', e => { const b = e.target.closest('button[data-seg]'); if (b) goSeg(+b.dataset.seg); });
  $('#btnPrev').addEventListener('click', () => state.seg > 0 && goSeg(state.seg - 1));
  $('#btnNext').addEventListener('click', () => state.seg < state.route.segments.length - 1 && goSeg(state.seg + 1));
  $('#btnReset').addEventListener('click', () => {
    if (nav && nav.isOn()) nav.stop();
    state.route = null; state.item = null;
    setFold(false);
    updateUrl();
    $('#routeView').hidden = true; $('#findView').hidden = false;
    q.value = ''; renderResults([]); setChip(null);
    const sn = state.start && g.nodes.get(state.start);
    showFloor(sn ? sn.floor : state.floor, aroundHere());
    q.focus();
  });

  // ---------- 걸으면서 방향 안내(센서) ----------
  let nav = null;
  const estLayer = L.layerGroup().addTo(lmap);
  const estIcon = L.divIcon({ className: 'est-pin', iconSize: [0, 0], html: '<span class="est"></span>' });
  function showEst(p) {
    estLayer.clearLayers();
    if (p && p.floor === state.floor) L.marker(ll({ floor: p.floor, x: p.x, y: p.y }), { icon: estIcon, interactive: false, zIndexOffset: 900 }).addTo(estLayer);
  }
  async function startNav() {
    const r = state.route; if (!r) return;
    const btn = $('#btnNav'); btn.disabled = true; btn.textContent = '센서를 켜는 중…';
    try {
      if (!nav) {
        const mod = await import('./nav.js?v=' + encodeURIComponent(APP_VERSION));
        nav = mod.create({
          g, root: $('#navBox'),
          onPos: showEst,
          onStop: () => { estLayer.clearLayers(); $('#btnNav').hidden = false; armFold(); },
          onNeedQr: () => showMsg('가까운 안내판의 QR을 찍으면 현위치가 정확해져요. 찍은 뒤 목적지를 다시 고르면 됩니다.'),
          onReplan: nodeId => { state.start = nodeId; distMap = null; updateUrl(); renderHere(); if (state.item) routeTo(state.item); },
        });
      }
      const s = r.segments[state.seg];
      await nav.start(r, state.seg, state.seg === 0 && s.nodeIds[0] === state.start ? state.start : null);
      btn.hidden = true;
      setFold(false);   // 방향 안내 중에는 자동으로 내려가지 않는다
    } catch (e) {
      showMsg('방향 안내를 켤 수 없어요: ' + (e.message || '이 휴대폰·주소(https)에서는 센서를 쓸 수 없습니다') + '. 지도 안내는 그대로 이용하실 수 있어요.');
    }
    btn.disabled = false; btn.textContent = '🧭 걸으면서 방향 안내 받기';
  }
  $('#btnNav').addEventListener('click', startNav);
  function navSync(i) { if (nav && nav.isOn()) { nav.setSegment(state.route, i, i === 0 && state.route.segments[0].nodeIds[0] === state.start ? state.start : null); estLayer.clearLayers(); } }

  // ---------- 안내 패널 자동 내리기(휴대폰) ----------
  // 경로 화면을 가리지 않도록 일정 시간 만지지 않으면 얇은 막대로 내려가고, 막대를 누르면 다시 올라온다.
  const FOLD_MS = 10000;
  let foldTimer = null;
  const mobileLayout = () => !window.matchMedia('(min-width: 760px)').matches;
  function refitRoute() {
    if (!state.route) return;
    const s = state.route.segments[state.seg];
    if (!s || s.floor !== state.floor) return;
    const f = fl(s.floor), pts = s.nodeIds.map(id => ll(g.nodes.get(id)));
    let b = L.latLngBounds(pts).pad(0.12);
    const minSpan = 35 / (f.metersPerPx || 0.1), c = b.getCenter();
    if (b.getNorth() - b.getSouth() < minSpan && b.getEast() - b.getWest() < minSpan) {
      b = L.latLngBounds([c.lat - minSpan / 2, c.lng - minSpan / 2], [c.lat + minSpan / 2, c.lng + minSpan / 2]);
    }
    lmap.fitBounds(b, { ...sheetPad(), maxZoom: 0, animate: true });
  }
  function armFold() {
    clearTimeout(foldTimer);
    if (!state.route || !mobileLayout() || (nav && nav.isOn()) || !$('#view3d').hidden) return;
    foldTimer = setTimeout(() => setFold(true), FOLD_MS);
  }
  function setFold(on) {
    clearTimeout(foldTimer);
    const sheet = $('#sheet');
    if (on && (!state.route || !mobileLayout())) on = false;
    if (sheet.classList.contains('mini') === on) { if (!on) armFold(); return; }
    if (on) $('#sheetMiniText').textContent = $('#destName').textContent + ' · 약 ' + state.route.meters + 'm';
    sheet.classList.toggle('mini', on);
    if (!on) armFold();
    requestAnimationFrame(refitRoute);
  }
  $('#sheetMini').addEventListener('click', () => setFold(false));
  $('#btnFold').addEventListener('click', () => setFold(true));
  ['pointerdown', 'scroll', 'keydown'].forEach(ev =>
    $('#sheet').addEventListener(ev, () => { if (!$('#sheet').classList.contains('mini')) armFold(); }, { passive: true }));

  // ---------- 3D ----------
  let view3d = null;
  function webglOK() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }
  $('#btn3d').addEventListener('click', async () => {
    const box = $('#view3dCanvas');
    $('#view3d').hidden = false;
    $('#view3dTitle').textContent = `${fl(g.nodes.get(state.start).floor).name} → ${state.route.dir ? state.route.dir.name + ' (엘리베이터까지)' : state.route.dest.name}`;
    box.innerHTML = '<div class="view3d-loading">3D 화면을 준비하고 있습니다…</div>';
    try {
      const mod = await import('./view3d.js?v=' + encodeURIComponent(APP_VERSION));
      box.innerHTML = '';
      view3d = mod.open(box, g, state.route, { start: state.start });
    } catch (e) {
      console.error(e);
      box.innerHTML = '<div class="view3d-loading">3D 화면을 열 수 없습니다. 2D 안내를 이용해 주세요.</div>';
    }
  });
  $('#btnClose3d').addEventListener('click', () => {
    if (view3d) { view3d.dispose(); view3d = null; }
    $('#view3d').hidden = true;
  });

  // ---------- 공통 ----------
  function updateUrl() {
    const p = new URLSearchParams();
    if (params.get('draft') === '1') p.set('draft', '1');
    if (state.start) p.set('at', state.start);
    if (state.item) p.set('to', state.item.key);
    if (state.avoidStairs) p.set('easy', '1');
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
  }
  function showMsg(t) { const m = $('#msg'); m.textContent = t; m.hidden = false; try { setFold(false); } catch (e) {} }
  function hideMsg() { $('#msg').hidden = true; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // 현위치 둘레 약 60m 범위(지도 맞춤용)
  function aroundHere() {
    if (!state.start) return null;
    const n = g.nodes.get(state.start), r = 30 / (fl(n.floor).metersPerPx || 0.1);
    return [ll({ floor: n.floor, x: n.x - r, y: n.y - r }), ll({ floor: n.floor, x: n.x + r, y: n.y + r })];
  }

  // ---------- 행사 알림 ----------
  function renderEvents() {
    const el = $('#eventBar');
    if (!events.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = events.map(e => `<button type="button" data-evt="${esc(e.id)}"><span class="evt-badge">행사</span><span class="evt-name">${esc(e.name)}</span><span class="evt-where">${esc(fl(g.nodes.get(e.node).floor).name)} · 길안내 ▶</span></button>`).join('');
  }
  $('#eventBar').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-evt]');
    if (b) routeTo(index.find(it => it.key === b.dataset.evt));
  });

  // ---------- 시작 ----------
  renderEvents();
  renderHere();
  showFloor(state.floor, aroundHere());   // QR을 찍으면 현위치 주변(약 60m)을, 아니면 층 전체를 보여 준다
  if (q.value.trim()) q.dispatchEvent(new Event('input'));   // 로딩 중에 입력한 글자 반영
  if (atParam && !state.start) showMsg('QR 위치 정보를 찾을 수 없습니다. 현위치를 직접 골라 주세요.');
  const toKey = params.get('to');
  if (/^EVT-/.test(toKey || '')) document.body.classList.add('evt-only');   // 행사 안내 화면: 다른 곳 검색 메뉴 숨김
  const toItem = toKey && index.find(it => it.key === toKey);
  if (toItem) {
    routeTo(toItem);                    // 현위치가 없으면(포스터 QR 등) 현위치를 고르게 한 뒤 이어서 안내
    // 고정 목적지 QR(?at=…&to=…): 이 QR이 정해 준 목적지임을 알려 준다
    if (state.route && atParam) $('#summary').textContent = 'QR 안내 · ' + $('#summary').textContent;
  } else if (toKey) {
    showMsg(/^EVT-/.test(toKey)
      ? '이 행사는 종료되었거나 아직 시작하지 않았습니다. 가고 싶은 곳을 검색해 주세요.'
      : '이 QR이 가리키는 목적지를 찾을 수 없습니다. 가고 싶은 곳을 검색해 주세요.');
  }
  window.addEventListener('resize', () => { if (state.route) goSeg(state.seg); });
})();
