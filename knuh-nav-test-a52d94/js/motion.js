/* 이동 추적: 걸음 검출 · 방향 계산 · 경로 진행 · 이탈 의심 판정 (센서 없이 Node에서 시험 가능)
 * 좌표는 층 이미지 픽셀(x 오른쪽, y 아래쪽). 각도는 "지도 위쪽에서 시계방향" 0~360.
 * 위치는 GPS 없이 '걸음 수 × 보폭 × 방향'으로 추정하고, 경로 위로 끌어당겨(map matching) 오차를 줄인다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Motion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const norm360 = a => ((a % 360) + 360) % 360;
  /** a−b 를 −180~180 으로 */
  const angleDiff = (a, b) => { let d = norm360(a - b); return d > 180 ? d - 360 : d; };
  const dirVec = deg => ({ x: Math.sin(deg * Math.PI / 180), y: -Math.cos(deg * Math.PI / 180) });
  const bearing = (from, to) => norm360(Math.atan2(to.x - from.x, -(to.y - from.y)) * 180 / Math.PI);

  /** 방향 센서 값 → 휴대폰이 향한 방위(북=0, 시계방향). 세워 들면 W3C 공식, 눕히면 alpha */
  function compassHeading(alpha, beta, gamma) {
    if (alpha == null) return null;
    if (beta == null || Math.abs(beta) < 25) return norm360(360 - alpha);
    const d = Math.PI / 180, a = alpha * d, b = beta * d, g = (gamma || 0) * d;
    const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
    const rA = -cA * sG - sA * sB * cG, rB = -sA * sG + cA * sB * cG;
    let h = Math.atan(rA / rB);
    if (rB < 0) h += Math.PI; else if (rA < 0) h += 2 * Math.PI;
    return norm360(h / d);
  }

  /** 각도 이동평균(0/360 경계 처리): 이전 값 쪽으로 alpha 만큼 */
  function smoothAngle(prev, next, alpha = 0.25) {
    if (prev == null) return norm360(next);
    return norm360(prev + alpha * angleDiff(next, prev));
  }

  /** 걸음 검출: 가속도 크기의 피크. push(t[ms], ax, ay, az) → 걸음이면 true */
  function createStepDetector(opt = {}) {
    const minGap = opt.minGapMs || 320, minPeak = opt.minPeak || 0.9;
    let ema = 9.8, lp = 0, p1 = 0, p2 = 0, last = -1e9, sd = 1;
    return {
      push(t, ax, ay, az) {
        const mag = Math.sqrt(ax * ax + ay * ay + az * az);
        ema += 0.02 * (mag - ema);
        const v = mag - ema;
        lp += 0.35 * (v - lp);
        sd += 0.02 * (Math.abs(lp) - sd);
        const th = Math.max(minPeak, sd * 0.9);
        // p1 이 직전 값: p2 <= p1 >= lp 인 극대점이 임계값을 넘으면 한 걸음
        const hit = p1 > th && p1 >= p2 && p1 >= lp && (t - last) > minGap;
        p2 = p1; p1 = lp;
        if (hit) { last = t; return true; }
        return false;
      },
    };
  }

  /** 폴리라인 도우미: 점들 → { pts, cum(누적 px), len } */
  function makePath(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    return { pts: points, cum, len: cum[cum.length - 1] };
  }
  function pointAt(path, s) {
    s = Math.max(0, Math.min(path.len, s));
    for (let i = 1; i < path.pts.length; i++) {
      if (s <= path.cum[i] || i === path.pts.length - 1) {
        const seg = path.cum[i] - path.cum[i - 1] || 1, t = (s - path.cum[i - 1]) / seg;
        return { x: path.pts[i - 1].x + t * (path.pts[i].x - path.pts[i - 1].x), y: path.pts[i - 1].y + t * (path.pts[i].y - path.pts[i - 1].y), seg: i - 1 };
      }
    }
    return { ...path.pts[0], seg: 0 };
  }
  /** p 를 경로에 투영: { s(px), dist(px), seg, point } */
  function project(path, p) {
    let best = { dist: Infinity };
    for (let i = 1; i < path.pts.length; i++) {
      const a = path.pts[i - 1], b = path.pts[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      const q = { x: a.x + t * dx, y: a.y + t * dy }, d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < best.dist) best = { dist: d, s: path.cum[i - 1] + t * Math.sqrt(l2), seg: i - 1, point: q };
    }
    return best;
  }
  const tangentDeg = (path, seg) => bearing(path.pts[seg], path.pts[seg + 1]);

  const SENS = { low: { n: 1.5, d: 1.3 }, mid: { n: 1, d: 1 }, high: { n: 0.7, d: 0.8 } };

  /**
   * 경로 위 진행·이탈 추적
   *   t.setRoute(points, mpp)   현재 구간(지도 픽셀 점 목록)과 축척(m/px)
   *   t.anchor(s=0)             기준점 확정(QR·구간 시작·[여기예요]) → 오차 초기화
   *   t.step(mapDeg, nowMs)     한 걸음: 걷는 방향(지도 각도) → 상태·경고 반환
   */
  function createTracker(cfg = {}) {
    const stepLenM = cfg.stepLenM || 0.65, sens = SENS[cfg.sensitivity || 'mid'] || SENS.mid, cooldownMs = cfg.cooldownMs ?? 15000;
    let path = null, mpp = 0.1, pdr = null, s = 0, steps = 0, traveled = 0, opp = 0, far = 0, lastAlert = -1e9, alerting = null;
    const st = () => ({ s: s * mpp, pos: pointAt(path, s), pdr, steps, traveled, alerting, remaining: (path.len - s) * mpp });
    return {
      setRoute(points, m) { path = makePath(points); mpp = m || 0.1; this.anchor(0); },
      anchor(at = 0) {
        s = at / mpp; const p = pointAt(path, s); pdr = { x: p.x, y: p.y };
        steps = 0; traveled = 0; opp = 0; far = 0; alerting = null;
      },
      state: () => (path ? st() : null),
      path: () => path,
      /** 현재 진행 위치에서 meters 앞 지점의 방향(지도 각도) */
      aheadBearing(meters = 6) {
        const from = pointAt(path, s), to = pointAt(path, s + meters / mpp);
        return Math.hypot(to.x - from.x, to.y - from.y) < 2 ? tangentDeg(path, from.seg) : bearing(from, to);
      },
      step(mapDeg, now) {
        if (!path) return null;
        const v = dirVec(mapDeg), px = stepLenM / mpp;
        pdr = { x: pdr.x + v.x * px, y: pdr.y + v.y * px };
        steps++; traveled += stepLenM;
        const pr = project(path, pdr), dM = pr.dist * mpp;
        const tan = tangentDeg(path, pr.seg), err = Math.abs(angleDiff(mapDeg, tan));
        // 경로 가까이 있으면 위치를 경로 쪽으로 살짝 끌어당김(복도 안에서 오차 상쇄)
        const clamped = pr.s >= path.len - 1 || pr.s <= 1;
        const pull = dM < 4 && err < 45 && !clamped ? 0.35 : 0;   // 경로 방향으로 걸을 때만 끌어당김(옆으로 걷는 것까지 흡수하지 않도록)
        pdr = { x: pdr.x + pull * (pr.point.x - pdr.x), y: pdr.y + pull * (pr.point.y - pdr.y) };
        if (err < 90) s = Math.max(s, pr.s); else s = Math.max(0, Math.min(s, pr.s));
        const thr = Math.max(6, traveled * 0.15 + 4) * sens.d;
        opp = err > 140 ? opp + 1 : 0;
        far = dM > thr ? far + 1 : 0;
        const last = path.pts.length - 2, end = path.pts[path.pts.length - 1];
        const along = (pdr.x - end.x) * dirVec(tangentDeg(path, last)).x + (pdr.y - end.y) * dirVec(tangentDeg(path, last)).y;
        const overshoot = along * mpp > 8 && dM < thr;   // 경로 끝 연장선 위에서 지나친 경우만(엉뚱한 곳이면 옆길 이탈로 판정)
        let reason = null;
        if (steps > 3) {
          if (opp >= Math.round(6 * sens.n)) reason = 'opposite';
          else if (far >= Math.round(4 * sens.n)) reason = 'lateral';
          else if (overshoot) reason = 'overshoot';
        }
        let fire = false;
        if (reason) { if (!alerting && now - lastAlert > cooldownMs) { alerting = reason; lastAlert = now; fire = true; } }
        else if (alerting && opp === 0 && far === 0 && !overshoot) alerting = null;   // 경로로 돌아오면 해제
        return { ...st(), reason, fire, devM: dM, headingErr: err };
      },
    };
  }

  return { norm360, angleDiff, bearing, dirVec, compassHeading, smoothAngle, createStepDetector, createTracker, makePath, pointAt, project, tangentDeg };
});
