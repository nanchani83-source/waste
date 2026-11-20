/* 3D 전체 경로 보기 — 층별 안내도를 판으로 쌓고 경로를 입체 선으로 그린다.
 * 다른 층·건물로 가는 경로일 때만 app.js가 불러온다. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const FLOOR_GAP = 24;   // 층 간격(m) — 실제(약 4.5m)보다 넓혀 경로가 잘 보이게
const ROUTE_LIFT = 0.4; // 경로를 판 위로 띄우는 높이

export function open(container, g, route, { start }) {
  const layout = window.Route.floorLayout(g, FLOOR_GAP);
  const W = container.clientWidth, H = container.clientHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(50, 120, 80);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(45, W / H, 0.5, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 15;
  controls.maxDistance = 400;

  const world = id => {
    const n = g.nodes.get(id), L = layout.get(n.floor);
    return new THREE.Vector3(L.ox + n.x * L.mpp, L.y + ROUTE_LIFT, L.oz + n.y * L.mpp);
  };

  // ----- 층 판: 경로가 지나는 건물의 모든 층을 쌓고, 경로 층만 진하게 -----
  const routeFloors = new Set(route.segments.map(s => s.floor));
  const buildings = new Set([...routeFloors].map(f => g.floors.get(f).building));
  const lowestRouteLevel = Math.min(...[...routeFloors].map(f => g.floors.get(f).level));
  const loader = new THREE.TextureLoader();
  const disposables = [];
  const box = new THREE.Box3();

  for (const f of g.floors.values()) {
    if (!buildings.has(f.building)) continue;
    const L = layout.get(f.id);
    // 안내도의 여백·범례를 잘라내고 건물 영역(노드 범위 + 여유)만 판으로 쓴다
    const [cx1, cy1, cx2, cy2] = contentRect(g, f);
    const w = (cx2 - cx1) * L.mpp, h = (cy2 - cy1) * L.mpp;
    const x0 = L.ox + cx1 * L.mpp, z0 = L.oz + cy1 * L.mpp;
    const onRoute = routeFloors.has(f.id);
    const isLowest = f.level === lowestRouteLevel;
    const tex = loader.load(f.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.repeat.set((cx2 - cx1) / f.width, (cy2 - cy1) / f.height);
    tex.offset.set(cx1 / f.width, 1 - cy2 / f.height);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: onRoute ? (isLowest ? 1 : 0.82) : 0.2, side: THREE.DoubleSide, depthWrite: false });
    const geo = new THREE.PlaneGeometry(w, h);
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(x0 + w / 2, L.y, z0 + h / 2);
    scene.add(plane);
    disposables.push(tex, mat, geo);

    // 판 테두리(층 구분선)
    const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.01, h));
    const edgeMat = new THREE.LineBasicMaterial({ color: onRoute ? 0x60a5fa : 0x475569, transparent: true, opacity: onRoute ? 0.9 : 0.5 });
    const edge = new THREE.LineSegments(edgeGeo, edgeMat);
    edge.position.copy(plane.position);
    scene.add(edge);
    disposables.push(edgeGeo, edgeMat);

    const label = textSprite(f.name, onRoute ? '#ffffff' : '#94a3b8', onRoute ? 'rgba(29,78,216,.95)' : 'rgba(51,65,85,.8)', 2.2);
    label.position.set(x0 - 1, L.y + 3, z0 + h * 0.5);
    scene.add(label);
    disposables.push(label.material.map, label.material);
    if (onRoute) box.expandByPoint(new THREE.Vector3(x0, L.y, z0)).expandByPoint(new THREE.Vector3(x0 + w, L.y, z0 + h));
  }

  // ----- 경로(튜브) -----
  const ids = route.path.nodeIds;
  const pts = ids.map(world);
  const curve = new THREE.CurvePath();
  for (let i = 1; i < pts.length; i++) if (!pts[i].equals(pts[i - 1])) curve.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
  const tubeGeo = new THREE.TubeGeometry(curve, Math.max(64, pts.length * 12), 0.6, 10, false);
  const tubeMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, emissive: 0x1d4ed8, emissiveIntensity: 0.7, roughness: 0.4, depthTest: false, transparent: true });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.renderOrder = 5;
  scene.add(tube);
  disposables.push(tubeGeo, tubeMat);

  // 층 이동 지점 표시
  route.segments.forEach((s, i) => {
    const next = route.segments[i + 1];
    if (!next) return;
    const word = { elevator: '엘리베이터', stairs: '계단', escalator: '에스컬레이터', connector: '연결통로' }[next.via.type] || '이동';
    const p = world(s.nodeIds[s.nodeIds.length - 1]);
    const sp = textSprite(`${word} → ${next.floorName}`, '#ffffff', 'rgba(17,24,39,.92)', 0.8);
    sp.position.set(p.x, p.y + 3, p.z);
    scene.add(sp);
    disposables.push(sp.material.map, sp.material);
  });

  // 출발·도착
  const startP = world(start);
  const hereGeo = new THREE.SphereGeometry(1.1, 24, 16);
  const hereMat = new THREE.MeshStandardMaterial({ color: 0x1a73e8, emissive: 0x1a73e8, emissiveIntensity: 0.5, depthTest: false, transparent: true });
  const here = new THREE.Mesh(hereGeo, hereMat);
  here.position.copy(startP);
  here.renderOrder = 6;
  scene.add(here);
  const hereLabel = textSprite('현위치', '#ffffff', 'rgba(26,115,232,.95)');
  hereLabel.position.set(startP.x, startP.y + 3.2, startP.z);
  scene.add(hereLabel);

  const endP = world(route.dest.node);
  const pinGeo = new THREE.ConeGeometry(1.2, 3.2, 20);
  const pinMat = new THREE.MeshStandardMaterial({ color: 0xd93025, emissive: 0xd93025, emissiveIntensity: 0.4, depthTest: false, transparent: true });
  const pin = new THREE.Mesh(pinGeo, pinMat);
  pin.rotation.x = Math.PI;
  pin.renderOrder = 6;
  pin.position.set(endP.x, endP.y + 1.8, endP.z);
  scene.add(pin);
  const destLabel = textSprite(route.dest.name, '#ffffff', 'rgba(217,48,37,.95)');
  destLabel.position.set(endP.x, endP.y + 5.2, endP.z);
  scene.add(destLabel);
  disposables.push(hereGeo, hereMat, pinGeo, pinMat, hereLabel.material.map, hereLabel.material, destLabel.material.map, destLabel.material);

  // 경로를 따라 움직이는 점
  const runnerGeo = new THREE.SphereGeometry(0.75, 16, 12);
  const runnerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
  const runner = new THREE.Mesh(runnerGeo, runnerMat);
  runner.renderOrder = 7;
  scene.add(runner);
  disposables.push(runnerGeo, runnerMat);

  // ----- 카메라: 경로가 화면 가운데에 오도록, 남쪽 위에서 비스듬히 -----
  const routeBox = new THREE.Box3().setFromPoints(pts).expandByScalar(14);
  fitCamera();
  function fitCamera() {
    // 가로 화면은 층 전체, 세로(휴대폰) 화면은 경로 중심으로 맞춘다
    const portrait = camera.aspect < 1;
    const sphere = (portrait ? routeBox : box).getBoundingSphere(new THREE.Sphere());
    sphere.radius = Math.max(sphere.radius, 30);
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    // 세로 화면에서 경로가 동서로 길면, 동쪽에서 바라봐 경로가 화면 위아래로 놓이게 한다
    const rs = routeBox.getSize(new THREE.Vector3());
    const alongX = portrait && rs.x > rs.z * 1.3;
    const dist = alongX
      ? sphere.radius / Math.sin(vfov / 2) * 1.3
      : sphere.radius / Math.sin(Math.min(vfov, hfov) / 2) * (portrait ? 0.9 : 0.8);
    const dir = alongX ? new THREE.Vector3(1, 0.85, 0.25).normalize() : new THREE.Vector3(0.3, 0.55, 1).normalize();
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    controls.maxDistance = dist * 2;
    controls.update();
  }

  // ----- 렌더 루프 -----
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const total = curve.getLength();
  let t0 = performance.now(), raf = 0, alive = true;
  function frame(now) {
    if (!alive) return;
    const speed = 18; // m/s (화면용)
    const u = reduce ? 1 : ((now - t0) / 1000 * speed % (total + 15)) / total;
    // CurvePath.getPointAt은 끝점(1.0)에서 null을 줄 수 있어 0.999로 제한
    const p = u <= 1 ? curve.getPointAt(Math.min(Math.max(u, 0), 0.999)) : null;
    runner.visible = !!p;
    if (p) runner.position.copy(p);
    pin.position.y = endP.y + 1.8 + (reduce ? 0 : Math.sin(now / 300) * 0.4);
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  const onResize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); fitCamera();
  };
  window.addEventListener('resize', onResize);

  return {
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      disposables.forEach(d => d.dispose && d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** 층 이미지에서 건물이 있는 영역(px): 노드 범위 + 여유 60px */
function contentRect(g, f) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of g.nodes.values()) {
    if (n.floor !== f.id) continue;
    x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y); x2 = Math.max(x2, n.x); y2 = Math.max(y2, n.y);
  }
  if (!isFinite(x1)) return [0, 0, f.width, f.height];
  const pad = 5 / (f.metersPerPx || 0.1);   // 건물 둘레 5m 여유
  return [Math.max(0, x1 - pad), Math.max(0, y1 - pad), Math.min(f.width, x2 + pad), Math.min(f.height, y2 + pad)];
}

/** 글자 라벨(항상 카메라를 향함) */
function textSprite(text, color, bg, scale = 1) {
  const dpr = 2, fs = 28 * dpr, pad = 12 * dpr;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `700 ${fs}px "Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif`;
  ctx.font = font;
  const tw = Math.ceil(ctx.measureText(text).width);
  c.width = tw + pad * 2; c.height = fs + pad * 1.6;
  ctx.font = font;
  ctx.fillStyle = bg;
  const r = c.height / 2;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, r);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, c.height / 2 + dpr);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  const h = 2.4 * scale;
  sp.scale.set(h * c.width / c.height, h, 1);
  sp.renderOrder = 10;
  return sp;
}
