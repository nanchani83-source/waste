/* 이동 중 방향 안내 + 경로 이탈 경고 (센서: 방향·가속도만, 위치 권한·GPS 없음)
 * 버튼을 눌렀을 때만 app.js 가 불러온다. 계산은 motion.js, 여기서는 센서 연결과 화면·진동·소리를 맡는다. */
const Motion = window.Motion;

const REASONS = {
  opposite: '지금 가는 방향이 경로와 반대인 것 같아요',
  lateral: '경로에서 벗어났을 수 있어요',
  overshoot: '목적지(구간 끝)를 지나쳤을 수 있어요',
};

export function create(ctx) {
  const { g, root } = ctx;
  const q = (s) => root.querySelector(s);
  let tracker = Motion.createTracker({});
  const stepDet = Motion.createStepDetector();
  let on = false, seg = null, floor = null, mpp = 0.1, northDeg = 0, turns = [], headingRaw = null, headingSm = null, calib = 0;
  let audio = null, wake = null, raf = 0, lastState = null, dirty = true, trace = [];
  const debug = new URLSearchParams(location.search).get('debug') === '1';
  const cfg = load();

  function load() { try { return { sound: true, voice: true, sens: 'mid', ...JSON.parse(localStorage.getItem('wf-nav') || '{}') }; } catch (e) { return { sound: true, voice: true, sens: 'mid' }; } }
  function save() { try { localStorage.setItem('wf-nav', JSON.stringify(cfg)); } catch (e) {} }

  // ---------- 화면 ----------
  root.innerHTML = `
    <div class="nav-alert" id="navAlert" role="alert" hidden>
      <b id="navAlertText"></b>
      <div class="nav-alert-btns"><button type="button" id="navReplan">여기서 다시 안내</button><button type="button" id="navQr">가까운 QR 찍기</button></div>
    </div>
    <div class="nav-main">
      <div class="nav-arrow" aria-hidden="true"><svg viewBox="0 0 100 100" id="navArrow"><path d="M50 8 82 62 56 52 56 92 44 92 44 52 18 62Z"/></svg></div>
      <div class="nav-info"><div class="nav-dir" id="navDir">센서를 준비하고 있어요…</div><div class="nav-sub" id="navSub"></div></div>
    </div>
    <div class="nav-btns"><button type="button" id="navTurn">꺾이는 곳에 도착했어요</button><button type="button" id="navStop">끄기</button></div>
    <details class="nav-set"><summary>소리·민감도 설정</summary>
      <label><input type="checkbox" id="navSound"> 이탈 시 경고음</label>
      <label><input type="checkbox" id="navVoice"> 이탈 시 음성 안내</label>
      <label>이탈 민감도 <select id="navSens"><option value="low">낮음(덜 울림)</option><option value="mid">보통</option><option value="high">높음</option></select></label>
      <p class="nav-note">나침반·걸음 수로 추정하므로 <b>틀릴 수 있어요</b>. 이상하면 가까운 QR을 다시 찍어 주세요. 위치 정보(GPS)는 사용하지 않고, 센서 값은 휴대폰 밖으로 나가지 않아요.</p>
    </details>
    ${debug ? '<pre class="nav-debug" id="navDebug"></pre><button type="button" id="navTrace">센서 기록 내려받기</button>' : ''}`;
  q('#navSound').checked = cfg.sound; q('#navVoice').checked = cfg.voice; q('#navSens').value = cfg.sens;
  q('#navSound').onchange = e => { cfg.sound = e.target.checked; save(); if (cfg.sound) beep(1); };
  q('#navVoice').onchange = e => { cfg.voice = e.target.checked; save(); if (cfg.voice) speak('음성 안내를 켰습니다'); };
  q('#navSens').onchange = e => { cfg.sens = e.target.value; save(); rebuild(); };
  q('#navStop').onclick = () => stop();
  q('#navQr').onclick = () => ctx.onNeedQr && ctx.onNeedQr();
  q('#navReplan').onclick = () => replan();
  q('#navTurn').onclick = () => atNextTurn();
  if (debug) q('#navTrace').onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(trace)], { type: 'application/json' })); a.download = 'nav-trace.json'; a.click();
  };

  // ---------- 센서 ----------
  async function askPermission() {
    for (const E of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
      if (E && typeof E.requestPermission === 'function') { const r = await E.requestPermission(); if (r !== 'granted') throw new Error('센서 권한이 거부되었어요'); }
    }
  }
  function onOrient(e) {
    let b = null;
    if (typeof e.webkitCompassHeading === 'number') b = e.webkitCompassHeading;           // 아이폰
    else if (e.absolute || e.type === 'deviceorientationabsolute') b = Motion.compassHeading(e.alpha, e.beta, e.gamma);   // 안드로이드
    if (b == null || Number.isNaN(b)) return;
    headingRaw = b; headingSm = Motion.smoothAngle(headingSm, b, 0.2); dirty = true;
  }
  const mapHeading = () => headingSm == null ? null : Motion.norm360(headingSm + northDeg + calib);
  function onMotion(e) {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
    const t = performance.now();
    if (!stepDet.push(t, a.x, a.y, a.z)) return;
    const h = mapHeading(); if (h == null || !seg) return;
    const r = tracker.step(h, t); if (!r) return;
    lastState = r; dirty = true;
    if (debug) trace.push({ t: Math.round(t), h: Math.round(h), s: +r.s.toFixed(1), dev: +r.devM.toFixed(1), reason: r.reason });
    if (ctx.onPos) ctx.onPos({ floor, x: r.pos.x, y: r.pos.y });
    if (r.fire) raise(r.reason);
  }

  // ---------- 경고 ----------
  function raise(reason) {
    q('#navAlertText').textContent = REASONS[reason] || '경로를 벗어났을 수 있어요';
    q('#navAlert').hidden = false;
    try { navigator.vibrate && navigator.vibrate([250, 120, 250]); } catch (e) {}
    if (cfg.sound) beep(2);
    if (cfg.voice) speak('경로를 벗어났을 수 있습니다. 화면을 확인해 주세요');
  }
  function beep(n) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < n; i++) {
        const o = audio.createOscillator(), gn = audio.createGain(), t0 = audio.currentTime + i * 0.35;
        o.frequency.value = 880; gn.gain.setValueAtTime(0.0001, t0); gn.gain.exponentialRampToValueAtTime(0.25, t0 + 0.03); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
        o.connect(gn).connect(audio.destination); o.start(t0); o.stop(t0 + 0.28);
      }
    } catch (e) {}
  }
  function speak(t) { try { const u = new SpeechSynthesisUtterance(t); u.lang = 'ko-KR'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {} }

  function replan() {
    const s = tracker.state(); if (!s) return;
    const n = Route_nearest(s.pos);
    q('#navAlert').hidden = true;
    if (n && ctx.onReplan) ctx.onReplan(n.id); else if (ctx.onNeedQr) ctx.onNeedQr();
  }
  const Route_nearest = p => window.Route.nearestNode(g, floor, p.x, p.y, 25);

  // 꺾이는 곳(다음 모퉁이)에 도착했다고 알려 주면 그 자리로 위치를 확정
  function atNextTurn() {
    const s = tracker.state(); if (!s) return;
    const next = turns.find(m => m > s.s + 1) ?? (tracker.path().len * mpp);
    tracker.anchor(next); q('#navAlert').hidden = true; dirty = true; lastState = tracker.state();
    if (ctx.onPos) ctx.onPos({ floor, ...lastState.pos });
  }

  // ---------- 구간 설정 ----------
  function rebuild() {
    if (!seg) return;
    const keep = tracker.state();
    const f = g.floors.get(floor);
    tracker = Motion.createTracker({ sensitivity: cfg.sens });
    tracker.setRoute(seg.pts, f.metersPerPx);
    if (keep) tracker.anchor(keep.s);
  }

  /** 안내 구간 지정: route.segments[i] 의 점들, anchorNode(QR 등)가 있으면 그 점의 facingDeg 로 나침반 보정 */
  function setSegment(route, i, anchorNodeId) {
    const s = route.segments[i];
    floor = s.floor;
    const f = g.floors.get(floor); mpp = f.metersPerPx || 0.1; northDeg = f.northDeg || 0;
    const pts = s.nodeIds.map(id => { const n = g.nodes.get(id); return { x: n.x, y: n.y }; });
    seg = { pts, i };
    turns = [];
    let run = 0;
    for (let k = 1; k < pts.length; k++) {
      run += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y) * mpp;
      if (k < pts.length - 1 && Math.abs(Motion.angleDiff(Motion.bearing(pts[k], pts[k + 1]), Motion.bearing(pts[k - 1], pts[k]))) > 35) turns.push(run);
    }
    tracker = Motion.createTracker({ sensitivity: cfg.sens });
    tracker.setRoute(pts, mpp);
    // 방향 보정: QR을 찍을 때 사용자는 facingDeg(지도 각도) 쪽을 보고 있다고 가정 → 그때의 나침반 값으로 자기 오차 상쇄
    const an = anchorNodeId && g.nodes.get(anchorNodeId);
    calib = 0;
    if (an && typeof an.facingDeg === 'number' && headingSm != null) calib = Motion.angleDiff(an.facingDeg, headingSm + northDeg);
    q('#navAlert').hidden = true; lastState = tracker.state(); dirty = true;
  }

  // ---------- 표시 ----------
  function render() {
    raf = requestAnimationFrame(render);
    if (!dirty || !on) return; dirty = false;
    const h = mapHeading();
    const s = tracker.state();
    if (!s) return;
    if (h == null) { q('#navDir').textContent = '나침반 값을 기다리는 중… 폰을 들고 살짝 움직여 주세요'; return; }
    const ahead = tracker.aheadBearing(6), rel = Motion.angleDiff(ahead, h);
    q('#navArrow').style.transform = `rotate(${rel}deg)`;
    const a = Math.abs(rel);
    q('#navDir').textContent = a < 25 ? '앞으로 직진하세요' : a < 60 ? `${rel > 0 ? '오른쪽' : '왼쪽'} 앞으로` : a < 150 ? `${rel > 0 ? '오른쪽' : '왼쪽'}으로 도세요` : '뒤로 돌아서 가세요';
    const nextTurn = turns.find(m => m > s.s + 1);
    q('#navSub').textContent = `남은 거리 약 ${Math.max(1, Math.round(s.remaining))}m` + (nextTurn ? ` · 약 ${Math.max(1, Math.round(nextTurn - s.s))}m 앞에서 꺾임` : '') + ` · ${s.steps}걸음`;
    if (debug) q('#navDebug').textContent = `heading ${Math.round(headingRaw ?? -1)}° map ${Math.round(h)}° calib ${Math.round(calib)}° steps ${s.steps} s ${s.s.toFixed(1)}m remain ${s.remaining.toFixed(1)}m alert ${s.alerting || '-'}`;
  }

  async function start(route, i, anchorNodeId) {
    if (!on) {
      await askPermission();
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      window.addEventListener('devicemotion', onMotion, true);
      try { wake = await navigator.wakeLock.request('screen'); } catch (e) {}
      if (cfg.sound) { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume && audio.resume(); } catch (e) {} }
      on = true; root.hidden = false; raf = requestAnimationFrame(render);
      for (let k = 0; k < 12 && headingSm == null; k++) await new Promise(r => setTimeout(r, 100));   // 첫 나침반 값(방향 보정용)을 잠깐 기다림
    }
    setSegment(route, i, anchorNodeId);
  }
  function stop() {
    on = false; cancelAnimationFrame(raf);
    window.removeEventListener('deviceorientationabsolute', onOrient, true);
    window.removeEventListener('deviceorientation', onOrient, true);
    window.removeEventListener('devicemotion', onMotion, true);
    try { wake && wake.release(); } catch (e) {} wake = null;
    root.hidden = true; seg = null;
    if (ctx.onStop) ctx.onStop();
  }

  return {
    start, stop, setSegment,
    isOn: () => on,
    /** 테스트·시연용: 센서 없이 한 걸음 진행 */
    _step: (deg, t) => { const r = tracker.step(deg, t); lastState = r; dirty = true; if (r && r.fire) raise(r.reason); return r; },
    _raise: raise,
  };
}
