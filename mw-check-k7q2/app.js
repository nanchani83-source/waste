/* 의료폐기물 점검툴 - 점검자 전용 (데이터는 이 기기 IndexedDB에만 저장) */
"use strict";
const $app = document.getElementById("app");
const $title = document.getElementById("title");
const $back = document.getElementById("back");

/* ---------- IndexedDB ---------- */
let _db;
function db() {
  return _db || (_db = new Promise((res, rej) => {
    const q = indexedDB.open("mwaudit", 1);
    q.onupgradeneeded = () => { q.result.createObjectStore("kv"); q.result.createObjectStore("rec", { keyPath: "id" }); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  }));
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store), r = fn(s);
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
  });
}
const kvGet = k => tx("kv", "readonly", s => s.get(k));
const kvSet = (k, v) => tx("kv", "readwrite", s => s.put(v, k));
const recPut = r => tx("rec", "readwrite", s => s.put(r));
const recAll = () => tx("rec", "readonly", s => s.getAll());
const recGet = id => tx("rec", "readonly", s => s.get(id));
const recDel = id => tx("rec", "readwrite", s => s.delete(id));

/* ---------- 유틸 ---------- */
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtD = v => v ? String(v).slice(0, 10).replace(/-/g, ".") + "." : "";
const fmtDT = v => { const d = new Date(v); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}. ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const count = rec => { const c = { ok: 0, guide: 0, na: 0 }; ITEMS.forEach(i => { const a = rec.answers[i.id]; if (a && a.r) c[a.r]++; }); return c; };
function go(view, arg) { views[view](arg); window.scrollTo(0, 0); }
function head(t, backTo) { $title.textContent = t; $back.hidden = !backTo; $back.onclick = backTo; }

/* ---------- 서명 패드 ---------- */
function sigPad(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext("2d"); c.scale(dpr, dpr);
  c.lineWidth = 2.6; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#111";
  let draw = false, dirty = false, last, strokes = 0, plen = 0, curLen = 0, maxLen = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  const ext = q => { bx0 = Math.min(bx0, q[0]); by0 = Math.min(by0, q[1]); bx1 = Math.max(bx1, q[0]); by1 = Math.max(by1, q[1]); };
  const pt = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.onpointerdown = e => { draw = true; last = pt(e); strokes++; curLen = 0; ext(last); canvas.setPointerCapture(e.pointerId); c.beginPath(); c.moveTo(...last); c.lineTo(last[0] + .1, last[1]); c.stroke(); dirty = true; e.preventDefault(); };
  canvas.onpointermove = e => { if (!draw) return; const p = pt(e); c.beginPath(); c.moveTo(...last); c.lineTo(...p); c.stroke(); const dl = Math.hypot(p[0] - last[0], p[1] - last[1]); plen += dl; curLen += dl; if (curLen > maxLen) maxLen = curLen; ext(p); last = p; e.preventDefault(); };
  canvas.onpointerup = canvas.onpointercancel = () => { draw = false; };
  return {
    clear() { c.clearRect(0, 0, w, h); dirty = false; strokes = 0; plen = 0; curLen = 0; maxLen = 0; bx0 = by0 = 1e9; bx1 = by1 = -1e9; },
    quality() { // 정자 서명 여부를 대략 점검 (글씨 인식이 아닌 크기·획 수·꼬임 기준)
      if (!dirty) return null;
      const bw = bx1 - bx0, bh = by1 - by0, diag = Math.hypot(bw, bh) || 1;
      if (bw < w * 0.45 || bh < h * 0.35) return "서명이 너무 작습니다. 칸을 크게 사용해 주세요.";
      if (strokes < 5) return "획이 너무 적어 흘려 쓴 서명으로 보입니다.";
      if (maxLen / plen > 0.4) return "획이 길게 이어져 있어 흘림 서명으로 보입니다.";
      if (plen / diag > 5.5) return "선이 심하게 겹치거나 꼬여 있습니다.";
      return null;
    },
    isEmpty: () => !dirty,
    data() { // 투명 여백 제거 후 PNG
      const t = document.createElement("canvas"); t.width = canvas.width; t.height = canvas.height;
      const tc = t.getContext("2d"); tc.drawImage(canvas, 0, 0);
      const px = tc.getImageData(0, 0, t.width, t.height).data;
      let x0 = t.width, y0 = t.height, x1 = 0, y1 = 0;
      for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) if (px[(y * t.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const m = 6, cw = x1 - x0 + 1 + m * 2, ch = y1 - y0 + 1 + m * 2;
      const o = document.createElement("canvas"); o.width = cw; o.height = ch;
      o.getContext("2d").drawImage(t, x0 - m, y0 - m, cw, ch, 0, 0, cw, ch);
      return o.toDataURL("image/png");
    }
  };
}

/* ---------- 사진 리사이즈 (워터마크 없음) ---------- */
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function processPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const s = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    const x = c.getContext("2d"); x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.75);
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- PDF (캔버스 페이지 → JPEG → 최소 PDF 작성; 폰트·라이브러리 의존 없음) ---------- */
const PW = 1240, PH = 1754, MX = 70;
const FONT = '"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif';
function wrap(x, text, maxW) {
  const out = [];
  String(text || "").split("\n").forEach(par => {
    let line = "";
    for (const ch of par) { if (x.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch; }
    out.push(line);
  });
  return out;
}
async function renderPages(rec, set) {
  // 긴 캔버스에 그린 뒤 A4 한 장에 맞춰 축소(필요 시)
  const tall = document.createElement("canvas"); tall.width = PW; tall.height = 3600;
  const x = tall.getContext("2d"); x.textBaseline = "top"; x.fillStyle = "#000";
  let y = 0;
  const font = (sz, b) => x.font = `${b ? "bold " : ""}${sz}px ${FONT}`;
  const line = (y0, w = 2, col = "#333") => { x.strokeStyle = col; x.lineWidth = w; x.beginPath(); x.moveTo(MX, y0); x.lineTo(PW - MX, y0); x.stroke(); };
  const emb = await loadImg("emblem.png").catch(() => null);
  // 제목부: 병원마크 + KNUH (흐리게)
  if (emb) { x.globalAlpha = .35; x.drawImage(emb, MX, y, 96, 96); x.globalAlpha = 1; }
  x.globalAlpha = .3; x.fillStyle = "#1f3a8a"; font(40, true); x.textAlign = "right"; x.fillText("KNUH", PW - MX, y + 28); x.globalAlpha = 1; x.fillStyle = "#000";
  x.textAlign = "center"; font(46, true); x.fillText("의료폐기물 안전관리 지도점검표", PW / 2, y + 14);
  font(22); x.fillStyle = "#666"; x.fillText("(발생부서 자체 지도점검용)", PW / 2, y + 72); x.fillStyle = "#000"; x.textAlign = "left";
  y += 120;
  const insp = rec.insp && rec.insp.length ? rec.insp : set.inspectors.slice(0, 1);
  const info = [["점검일자", fmtD(rec.when)], ["점검부서", rec.dept], ["점검자", insp.map(i => i.name).join(", ")], ["부서 입회자", rec.witness]];
  info.forEach((r, i) => { const cx = MX + (i % 2) * 550, cy = y + Math.floor(i / 2) * 44; font(25, true); x.fillText(r[0], cx, cy); font(25); x.fillText(r[1] || "", cx + 160, cy, 380); });
  y += 96; line(y); y += 8;
  const col = { no: MX, body: MX + 80, ok: MX + 720, gd: MX + 840, na: MX + 960 };
  font(23, true); x.textAlign = "center"; y += 4;
  x.fillText("번호", col.no + 40, y); x.fillText("양호", col.ok + 60, y); x.fillText("지도", col.gd + 60, y); x.fillText("해당없음", col.na + 70, y);
  x.textAlign = "left"; x.fillText("점검 항목 / 세부 점검 내용 / 지적사항", col.body, y); y += 36; line(y);
  ITEMS.forEach(it => {
    const a = rec.answers[it.id] || {};
    font(24, true); const tl = wrap(x, it.title, 620);
    font(20); const dl = wrap(x, it.detail, 620);
    font(21); const rl = a.r === "guide" && a.note ? wrap(x, "▶ 지적사항: " + a.note, 620) : [];
    const h = 12 + tl.length * 31 + dl.length * 26 + rl.length * 28 + 12; let yy = y + 12;
    x.textAlign = "center"; font(24, true); x.fillText(it.id, col.no + 40, yy); x.textAlign = "left";
    tl.forEach(l => { font(24, true); x.fillStyle = "#000"; x.fillText(l, col.body, yy); yy += 31; });
    dl.forEach(l => { font(20); x.fillStyle = "#555"; x.fillText(l, col.body, yy); yy += 26; });
    rl.forEach(l => { font(21); x.fillStyle = "#b71c1c"; x.fillText(l, col.body, yy); yy += 28; });
    x.fillStyle = "#000"; const cy = y + h / 2;
    [["ok", col.ok + 60], ["guide", col.gd + 60], ["na", col.na + 70]].forEach(([k, cx]) => {
      x.beginPath(); x.arc(cx, cy, 14, 0, 7); x.lineWidth = 2; x.strokeStyle = "#333"; x.stroke();
      if (a.r === k) { x.beginPath(); x.arc(cx, cy, 8, 0, 7); x.fillStyle = k === "guide" ? "#c62828" : "#000"; x.fill(); x.fillStyle = "#000"; }
    });
    y += h; line(y, 1, "#bbb");
  });
  line(y); y += 20;
  const c = count(rec);
  font(26, true); x.fillText(`점검 결과: 양호 ( ${c.ok} )건 / 지도 ( ${c.guide} )건 / 해당없음 ( ${c.na} )건`, MX, y); y += 42;
  if (rec.opinion) { font(23, true); x.fillText("특기사항", MX, y); y += 32; font(23); wrap(x, rec.opinion, PW - MX * 2).forEach(l => { x.fillText(l, MX, y); y += 31; }); y += 4; }
  // A4 한 장 구성: 워터마크 + 내용(편철 여백 아래로) + 서명(페이지 하단 고정)
  const page = document.createElement("canvas"); page.width = PW; page.height = PH;
  const p = page.getContext("2d"); p.fillStyle = "#fff"; p.fillRect(0, 0, PW, PH);
  if (emb) { p.globalAlpha = .07; p.drawImage(emb, PW / 2 - 330, PH / 2 - 380, 660, 660); p.globalAlpha = .06; p.fillStyle = "#1f3a8a"; p.font = `bold 120px ${FONT}`; p.textAlign = "center"; p.textBaseline = "top"; p.fillText("KNUH", PW / 2, PH / 2 + 300); p.globalAlpha = 1; }
  // 서명 블록 (하단)
  const signers = insp.map(i => ({ label: "점검자: " + i.name, sig: i.sig })).concat([{ label: "부서 입회자(수검자): " + (rec.dept ? rec.dept + " " : "") + (rec.witness || ""), sig: rec.sig }]);
  const n = signers.length, gap = 36, cw = (PW - MX * 2 - gap * (n - 1)) / n, sigH = 110, blockH = 36 + sigH + 14 + 30 + 34;
  const bTop = PH - 80 - blockH;
  p.textBaseline = "top"; p.textAlign = "left";
  for (let k = 0; k < n; k++) {
    const sx = MX + k * (cw + gap), sg = signers[k];
    p.fillStyle = "#000"; let fs0 = n > 3 ? 21 : 24; p.font = `bold ${fs0}px ${FONT}`; while (p.measureText(sg.label).width > cw && fs0 > 14) { fs0--; p.font = `bold ${fs0}px ${FONT}`; } p.fillText(sg.label, sx, bTop, cw);
    if (sg.sig) { const im = await loadImg(sg.sig); const s2 = Math.min((cw - 20) / im.width, sigH / im.height); p.drawImage(im, sx, bTop + 36, im.width * s2, im.height * s2); }
    p.strokeStyle = "#333"; p.lineWidth = 2; p.beginPath(); p.moveTo(sx, bTop + 36 + sigH + 4); p.lineTo(sx + cw, bTop + 36 + sigH + 4); p.stroke();
    p.fillStyle = "#555"; p.font = `20px ${FONT}`;
    p.fillText(k === n - 1 ? "(서명)  서명일: " + (rec.signedAt ? fmtD(rec.signedAt.slice(0, 10)) : "") : "(서명)", sx, bTop + 36 + sigH + 14, cw);
  }
  p.fillStyle = "#555"; p.font = `18px ${FONT}`; p.fillText("※ 본 점검 결과는 최신 법령 및 병원 내부 분리배출 지침에 따라 확인한 내용입니다.", MX, bTop + blockH - 24);
  // 내용: 위쪽 편철 여백 확보 후 배치
  const top = 170, avail = bTop - 24 - top, s = Math.min(1, avail / y);
  p.drawImage(tall, 0, 0, PW, y, (PW - PW * s) / 2, top, PW * s, y * s);
  return [page];
}
function buildPdf(pages) {
  const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
  const push = b => { b = typeof b === "string" ? enc.encode(b) : b; parts.push(b); len += b.length; };
  const obj = (n, body) => { offs[n] = len; push(`${n} 0 obj\n`); push(body); push("\nendobj\n"); };
  push("%PDF-1.4\n");
  const n = pages.length;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`);
  pages.forEach((cv, i) => {
    const b = 3 + i * 3, jpg = Uint8Array.from(atob(cv.toDataURL("image/jpeg", 0.82).split(",")[1]), c => c.charCodeAt(0));
    obj(b, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im${i} ${b + 2} 0 R >> >> /Contents ${b + 1} 0 R >>`);
    const cs = `q 595.28 0 0 841.89 0 0 cm /Im${i} Do Q`; obj(b + 1, `<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`);
    offs[b + 2] = len; push(`${b + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push("\nendstream\nendobj\n");
  });
  const total = 3 + n * 3, xr = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(String(offs[i]).padStart(10, "0") + " 00000 n \n");
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`);
  return new Blob(parts, { type: "application/pdf" });
}
async function makePdf(rec) {
  const set = await getSettings();
  return buildPdf(await renderPages(rec, set));
}
function pdfName(rec) { return `MW_audit_${String(rec.when).replace(/\D/g, "").slice(0, 8)}_${rec.id.slice(-4)}.pdf`; }
async function savePdf(rec, share, open) {
  const blob = await makePdf(rec), name = pdfName(rec), file = new File([blob], name, { type: "application/pdf" });
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const url = URL.createObjectURL(blob);
  if (open) { window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 120000); return; }
  const a = document.createElement("a"); a.href = url; a.download = name; a.style.display = "none"; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
}


/* ---------- 사진 별도 저장 (PDF에는 미포함, 파일명 = 부서명_번호) ---------- */
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = ~0; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const u16 = n => [n & 255, n >> 8 & 255], u32 = n => [n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24];
  files.forEach(f => {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 33, 0, ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nm.length), 0, 0]);
    parts.push(lh, nm, f.data);
    cen.push(new Uint8Array([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 33, 0, ...u32(crc), ...u32(sz), ...u32(sz), ...u16(nm.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(off)]), nm);
    off += lh.length + nm.length + sz;
  });
  const cl = cen.reduce((a, b) => a + b.length, 0);
  return new Blob([...parts, ...cen, new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cl), ...u32(off), 0, 0])], { type: "application/zip" });
}
const photoList = rec => {
  const out = [], dept = (rec.dept || "부서").replace(/[\\/:*?"<>|]/g, "").trim(); let n = 0;
  ITEMS.forEach(it => { const a = rec.answers[it.id]; if (a && a.r === "guide") (a.photos || []).forEach(p => { n++; out.push({ name: `${dept}_${pad(n)}.jpg`, data: Uint8Array.from(atob(p.split(",")[1]), c => c.charCodeAt(0)) }); }); });
  return out;
};
async function savePhotos(rec) {
  const list = photoList(rec); if (!list.length) return alert("저장할 사진이 없습니다.");
  const files = list.map(f => new File([f.data], f.name, { type: "image/jpeg" }));
  if (navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const url = URL.createObjectURL(makeZip(list)), a = document.createElement("a");
  a.href = url; a.download = `photos_${String(rec.when).replace(/\D/g, "").slice(0, 8)}_${rec.id.slice(-4)}.zip`; a.style.display = "none"; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
}

/* ---------- 전회차 위반이력 (점검이력 페이지 참조, 읽기 전용) ---------- */
const HIST_URL = "https://nanchani83-source.github.io/waste/inspection.html";
let histMem = null, histAt = 0;
async function loadHistory() {
  if (histMem && Date.now() - histAt < 300000) return histMem;
  let list = null;
  try {
    const t = await (await fetch(HIST_URL, { cache: "no-cache" })).text();
    const m = t.match(/const\s+INSPECTIONS\s*=\s*(\[[\s\S]*?\n\]);/);
    if (m) { list = new Function("return " + m[1])(); await kvSet("hist", { at: Date.now(), list }); }
  } catch (e) { /* 오프라인이면 마지막 저장본 사용 */ }
  if (!Array.isArray(list)) { const c = await kvGet("hist"); list = c && c.list; }
  histMem = Array.isArray(list) ? list : null; histAt = Date.now(); return histMem;
}
const normDept = v => String(v || "").replace(/[\s\-_()·.]/g, "").toLowerCase();
function histMatch(a, b) { // 같거나 비슷한 부서명 (병동은 번호가 같을 때만)
  const A = normDept(a), B = normDept(b); if (!A || !B) return false;
  if (A === B) return true;
  const na = A.match(/(\d+)병동/), nb = B.match(/(\d+)병동/);
  if (na && nb) return na[1] === nb[1];
  return Math.min(A.length, B.length) >= 3 && (A.includes(B) || B.includes(A));
}
async function histHTML(dept, when) {
  const list = await loadHistory();
  if (list === null) return `<div class="histx">전회차 위반이력 조회 불가 (오프라인·미저장)</div>`;
  const ym = String(when || "").slice(0, 7);
  const hits = list.filter(x => String(x.date) < ym && (Array.isArray(x.dept) ? x.dept : [x.dept]).some(d => histMatch(dept, d)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!hits.length) return `<div class="histx">전회차 위반이력 없음</div>`;
  const rows = hits.map(h => {
    const items = Object.entries(h.items || {}).map(([id, n]) => { const it = ITEMS.find(i => i.id === id); return `${esc(id)} ${esc(it ? it.title : "")} <b>${esc(n)}건</b>`; }).join("<br>");
    return `<div class="hrow"><b>${esc(h.date)} · ${esc(Array.isArray(h.dept) ? h.dept.join(", ") : h.dept)}</b>${h.repeat ? ` <span class="rep">반복</span>` : ""}<div>${items}</div>
      ${h.action ? `<small>조치: ${esc(h.action)}</small>` : ""}${h.note ? `<br><small>비고: ${esc(h.note)}</small>` : ""}</div>`;
  }).join("");
  return `<details class="hist"><summary>⚠ 전회차 위반이력 ${hits.length}건 · 눌러서 확인</summary>${rows}</details>`;
}
function bindHist(el, getDept, getWhen, inputs) {
  let t, seq = 0;
  const upd = async () => { const n = ++seq, d = getDept(); const h = d ? await histHTML(d, getWhen()) : ""; if (n === seq) el.innerHTML = h; };
  (inputs || []).forEach(i => i.addEventListener("input", () => { clearTimeout(t); t = setTimeout(upd, 300); }));
  upd();
}

/* ---------- 점검부서 목록 (전회차 이력 + 설정 + 이전 점검 기록) + 직접 입력 ---------- */
async function deptList(set, when) {
  const names = new Set((set.depts || []).map(d => String(d).trim()));
  const hist = await loadHistory().catch(() => null) || [];
  const ym = String(when || "").slice(0, 7), warn = [];
  hist.forEach(x => (Array.isArray(x.dept) ? x.dept : [x.dept]).forEach(d => { if (d) { names.add(String(d).trim()); if (String(x.date) < ym) warn.push(String(d)); } }));
  (await recAll()).forEach(r => { if (r.dept) names.add(String(r.dept).trim()); });
  return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
    .map(n => ({ name: n, warn: warn.some(w => histMatch(n, w)) }));
}
function deptPicker(list, val) {
  const inList = !val || list.some(o => o.name === val);
  return `<select id="dsel"><option value="">부서 선택</option>${list.map(o => `<option value="${esc(o.name)}" ${o.name === val ? "selected" : ""}>${esc(o.name)}${o.warn ? "  ⚠" : ""}</option>`).join("")}<option value="__custom" ${!inList ? "selected" : ""}>✎ 직접 입력</option></select>
    <input type="text" id="dp" placeholder="부서명을 직접 입력하세요" value="${esc(val)}" style="margin-top:8px;${inList ? "display:none" : ""}">
    <small class="m">⚠ = 전회차 위반이력 있는 부서</small>`;
}
function bindDeptPicker() {
  const sel = document.getElementById("dsel"), t = document.getElementById("dp");
  sel.onchange = () => {
    if (sel.value === "__custom") { t.style.display = ""; t.value = ""; t.focus(); } else { t.style.display = "none"; t.value = sel.value; }
    t.dispatchEvent(new Event("input"));
  };
}

/* ---------- 설정 ---------- */
async function getSettings() {
  const s = (await kvGet("settings")) || {};
  if (!s.inspectors) s.inspectors = s.inspector ? [{ name: s.inspector, sig: s.sig || "" }] : [];
  s.depts = s.depts || []; return s;
}
const OPINIONS = [ // 특기사항 목록 (종합의견.docx 기준, 기재 건수 많은 순)
  { k: "mix", n: 9, t: "일반폐기물 혼입 방지 및 분리배출 철저 요청" },
  { k: "date", n: 6, t: "봉투형 용기 사용개시연월일 기재 철저 요청" },
  { k: "keep", n: 6, t: "보관기한 준수 및 기한 초과 용기 즉시 교체 지도" },
  { k: "cap", n: 6, t: "용기 적정용량(75%) 준수 및 과적재 주의 요청" },
  { k: "pack", n: 5, t: "의료소모품 포장지·일회용 기저귀 등 일반쓰레기 분리배출 안내" },
  { k: "priv", n: 5, t: "개인정보(라벨지·약봉투·종이류) 분리배출 및 파쇄 안내" },
  { k: "liq", n: 4, t: "주사기·수액팩 등 액상·내용물 제거 후 폐기 권고" },
  { k: "cut", n: 3, t: "의료폐기물 발생량 감축 및 안전관리 협조 요청" },
  { k: "judge", n: 2, t: "의료폐기물 해당 여부 확인·안내" },
  { k: "edu", n: 1, t: "인턴·전공의 등 대상 분리배출 교육 안내" },
  { k: "spec", n: 1, t: "검체 배출주기 확인 안내" }
];
function opinionUI(rec) {
  const sel = rec.opSel || [], custom = rec.opSel ? (rec.opCustom || "") : (rec.opinion || ""), cOn = rec.opSel ? !!rec.opCustomOn : !!rec.opinion;
  return `<div class="chk-box" id="opbox">${OPINIONS.map(o => `<label class="chk"><input type="checkbox" data-op="${o.k}" ${sel.includes(o.k) ? "checked" : ""}> <span>${esc(o.t)}</span></label>`).join("")}
    <label class="chk"><input type="checkbox" id="opc" ${cOn ? "checked" : ""}> <span>직접 입력</span></label></div>
    <textarea id="opt" placeholder="특기사항을 직접 입력하세요" style="margin-top:8px;${cOn ? "" : "display:none"}">${esc(custom)}</textarea>`;
}
function readOpinion(rec) {
  rec.opSel = [...document.querySelectorAll("[data-op]:checked")].map(c => c.dataset.op);
  rec.opCustomOn = document.getElementById("opc").checked; rec.opCustom = document.getElementById("opt").value.trim();
  const lines = OPINIONS.filter(o => rec.opSel.includes(o.k)).map(o => o.t);
  if (rec.opCustomOn && rec.opCustom) lines.push(rec.opCustom);
  rec.opinion = lines.length > 1 ? lines.map((l, i) => `${i + 1}. ${l}`).join("\n") : lines.join("");
}
function bindOpinion(rec, autosave) {
  const box = document.getElementById("opbox"), t = document.getElementById("opt");
  box.onchange = () => { t.style.display = document.getElementById("opc").checked ? "" : "none"; readOpinion(rec); if (autosave) save(); };
  t.oninput = () => { readOpinion(rec); if (autosave) save(); };
}
const POS = ["수간호사", "부서장", "팀장", "간호사", "직원"];
const posSelect = v => `<select id="wt"><option value="">직위 선택</option>${(POS.includes(v) || !v ? POS : POS.concat([v])).map(o => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
const inspNames = r => (r.insp || []).map(i => i.name).join(", ");
const inspChecks = (set, sel) => set.inspectors.map((it, i) => `<label class="chk"><input type="checkbox" name="ip" value="${i}" ${sel.includes(it.name) ? "checked" : ""}> ${esc(it.name)}</label>`).join("");
const pickInsp = set => [...document.querySelectorAll('input[name="ip"]:checked')].map(c => set.inspectors[+c.value]);

/* ---------- 화면 ---------- */
let cur; // 작성 중 점검 기록
let editing = false; // 완료된 점검 수정 모드
const save = () => recPut(cur);
const views = {
  async home() {
    head("의료폐기물 안전관리 점검");
    const set = await getSettings(), all = (await recAll()).sort((a, b) => b.when.localeCompare(a.when));
    const draft = all.find(r => r.status === "draft"), done = all.filter(r => r.status === "done");
    const ready = set.inspectors.length && set.inspectors.every(i => i.name && i.sig);
    $app.innerHTML = `
      ${ready ? "" : `<div class="card">처음 사용: <b>설정</b>에서 점검자 이름과 <b>고정 서명</b>을 먼저 등록하세요.</div>`}
      ${draft ? `<div class="card"><b>작성 중인 점검</b><br><small class="m">${esc(draft.dept || "부서 미입력")} · ${fmtD(draft.when)}</small><button class="btn" id="resume">이어서 점검</button><button class="btn sec" id="dropDraft">삭제</button></div>` : ""}
      <button class="btn" id="new" ${ready ? "" : "disabled"}>＋ 새 점검 시작</button>
      <button class="btn sec" id="set">설정 (점검자·서명·부서)</button>
      <h3 class="sec-t">지난 점검 (${done.length})</h3>
      <div class="card list">${done.length ? done.map(r => `<div class="li" data-id="${r.id}"><div><b>${esc(r.dept)}</b><br><small class="m">${fmtD(r.when)} · 입회 ${esc(r.witness)}</small></div><span class="tag ${count(r).guide ? "guide" : "ok"}">지도 ${count(r).guide}</span></div>`).join("") : "<small class='m'>아직 없습니다.</small>"}</div>`;
    document.getElementById("new").onclick = async () => {
      if (draft && !confirm("작성 중인 점검이 삭제됩니다. 새로 시작할까요?")) return;
      if (draft) await recDel(draft.id);
      cur = { id: "r" + Date.now(), status: "draft", when: nowLocal(), dept: "", witness: "", answers: {}, opinion: "" }; await save(); go("info");
    };
    if (draft) {
      document.getElementById("resume").onclick = () => { cur = draft; go("checklist"); };
      document.getElementById("dropDraft").onclick = async () => { if (confirm("작성 중인 점검을 삭제할까요?")) { await recDel(draft.id); go("home"); } };
    }
    document.getElementById("set").onclick = () => go("settings");
    $app.querySelectorAll(".li").forEach(e => e.onclick = () => go("detail", e.dataset.id));
  },

  async settings() {
    head("설정", () => go("home"));
    const set = await getSettings();
    let list = set.inspectors.length ? set.inspectors.map(i => ({ ...i })) : [{ name: "", sig: "" }];
    let depts = (set.depts || []).join("\n"), pads = [];
    const collect = () => { list.forEach((it, i) => { it.name = document.getElementById("nm" + i).value; if (!pads[i].isEmpty()) it.sig = pads[i].data(); }); depts = document.getElementById("dp").value; };
    const paint = () => {
      $app.innerHTML = list.map((it, i) => `<div class="card"><label>점검자 ${i + 1} 이름</label><input type="text" id="nm${i}" value="${esc(it.name)}">
        <label>고정 서명 (한 번 등록하면 모든 점검에 자동 사용)</label>${it.sig ? `<img class="sigimg" src="${it.sig}">` : ""}
        <canvas class="sig" id="sg${i}"></canvas>
        <div class="row"><button class="btn sec" data-clr="${i}">지우기</button>${list.length > 1 ? `<button class="btn red" data-rm="${i}">점검자 삭제</button>` : ""}</div>
        <small class="m">${it.sig ? "새로 서명하면 교체되고, 비워두면 기존 서명이 유지됩니다." : "칸 안에 서명하세요."}</small></div>`).join("") +
        `<button class="btn sec" id="add" style="margin:0 0 12px">＋ 점검자 추가</button>
        <div class="card"><label>자주 쓰는 부서 (한 줄에 하나)</label><textarea id="dp" style="min-height:120px">${esc(depts)}</textarea>
        <button class="btn" id="sv">저장</button></div>
        <div class="card"><b>백업</b><br><small class="m">브라우저 저장소가 지워질 때를 대비해 기록 전체를 파일로 보관하세요.</small><button class="btn sec" id="bk">전체 기록 내보내기(JSON)</button></div>`;
      pads = list.map((_, i) => sigPad(document.getElementById("sg" + i)));
      $app.querySelectorAll("[data-clr]").forEach(b => b.onclick = () => pads[+b.dataset.clr].clear());
      $app.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { if (!confirm("이 점검자를 삭제할까요?")) return; collect(); list.splice(+b.dataset.rm, 1); paint(); });
      document.getElementById("add").onclick = () => { collect(); list.push({ name: "", sig: "" }); paint(); window.scrollTo(0, 0); };
      document.getElementById("sv").onclick = async () => {
        collect();
        for (let i = 0; i < list.length; i++) { if (!list[i].name.trim()) return alert(`점검자 ${i + 1} 이름을 입력하세요.`); if (!list[i].sig) return alert(`점검자 ${i + 1} 서명을 등록하세요.`); }
        for (let i = 0; i < list.length; i++) { const q = pads[i].quality(); if (q && confirm(`점검자 ${i + 1} 서명: ${q}\n정자로 또박또박 다시 서명하시겠습니까?\n[확인] 다시 서명   [취소] 그대로 사용`)) { pads[i].clear(); return; } }
        list.forEach(it => it.name = it.name.trim());
        await kvSet("settings", { inspectors: list, depts: depts.split("\n").map(v => v.trim()).filter(Boolean), lastSel: set.lastSel });
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); go("home");
      };
      document.getElementById("bk").onclick = async () => {
        const blob = new Blob([JSON.stringify({ settings: await getSettings(), records: await recAll() })], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `mwaudit_backup_${nowLocal().slice(0, 10)}.json`; a.click();
      };
    };
    paint();
  },

  async info() {
    head("점검 정보", () => go("home"));
    const set = await getSettings(), dlist = await deptList(set, cur.when);
    $app.innerHTML = `<div class="card"><label>점검일자</label><input type="date" id="wh" value="${esc(String(cur.when).slice(0, 10))}">
      <label>점검부서</label>${deptPicker(dlist, cur.dept)}<div id="hist" style="margin-top:8px"></div>
      <label>점검자 (해당자 모두 선택)</label><div class="chk-box">${inspChecks(set, set.lastSel || [set.inspectors[0] && set.inspectors[0].name])}</div>
      <button class="btn" id="nx">점검 시작</button></div>`;
    bindDeptPicker();
    bindHist(document.getElementById("hist"), () => document.getElementById("dp").value.trim(), () => document.getElementById("wh").value || nowLocal(), [document.getElementById("dp"), document.getElementById("wh")]);
    document.getElementById("nx").onclick = async () => {
      cur.when = document.getElementById("wh").value || nowLocal(); cur.dept = document.getElementById("dp").value.trim();
      if (!cur.dept) return alert("점검부서를 입력하세요.");
      const sel = pickInsp(set); if (!sel.length) return alert("점검자를 1명 이상 선택하세요.");
      cur.insp = sel.map(i => ({ name: i.name, sig: i.sig })); set.lastSel = sel.map(i => i.name); await kvSet("settings", set);
      await save(); go("checklist");
    };
  },

  checklist() {
    head(`${cur.dept} 점검`, () => go(editing ? "edit" : "home", editing ? cur.id : undefined));
    const answered = () => ITEMS.filter(i => cur.answers[i.id] && cur.answers[i.id].r).length;
    $app.innerHTML = `<div id="hist" style="margin-bottom:10px"></div><button class="btn sec" id="allok" style="margin:0 0 12px">✓ 전체 양호로 선택</button>` + ITEMS.map(it => `<div class="card item" id="c_${it.id}"></div>`).join("") +
      `<div class="card"><label>특기사항 (선택 · 복수 선택 가능)</label>${opinionUI(cur)}</div>` +
      `<div class="prog"><div class="in"><div class="bar"><i id="pb"></i></div><div class="row prow"><span id="pt"></span><button class="btn" id="go">${editing ? "수정 완료 ›" : "수검자 확인 ›"}</button></div></div></div>`;
    const paint = id => {
      const it = ITEMS.find(i => i.id === id), a = cur.answers[id] || (cur.answers[id] = {});
      const el = document.getElementById("c_" + id);
      el.innerHTML = `<h3><em>${it.id}</em>${esc(it.title)}</h3><div class="d">${esc(it.detail)}</div>
        <div class="seg">${["ok", "guide", "na"].map(k => `<button class="${k} ${a.r === k ? "on" : ""}" data-k="${k}">${RESULTS[k]}</button>`).join("")}</div>
        ${a.r === "guide" ? `<label>지적사항(비고)</label><textarea data-note>${esc(a.note || "")}</textarea>
          <div class="photos">${(a.photos || []).map((p, i) => `<div class="ph"><img src="${p}"><b data-del="${i}">×</b></div>`).join("")}</div>
          <input type="file" accept="image/*" capture="environment" hidden data-file>
          <button class="btn sec" data-cam>＋ 사진 촬영·추가 (${(a.photos || []).length}장)</button>` : ""}`;
      el.classList.remove("miss");
      el.querySelectorAll(".seg button").forEach(b => b.onclick = async () => { a.r = b.dataset.k; await save(); paint(id); prog(); });
      const ta = el.querySelector("[data-note]"); if (ta) ta.oninput = () => { a.note = ta.value; save(); };
      const fi = el.querySelector("[data-file]"); if (fi) {
        el.querySelector("[data-cam]").onclick = () => fi.click();
        fi.onchange = async () => { for (const f of fi.files) { (a.photos = a.photos || []).push(await processPhoto(f)); } await save(); paint(id); };
        el.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { a.photos.splice(+b.dataset.del, 1); await save(); paint(id); });
      }
    };
    const prog = () => { const n = answered(); document.getElementById("pb").style.width = n * 10 + "%"; document.getElementById("pt").textContent = `${n} / ${ITEMS.length} 완료`; };
    ITEMS.forEach(i => paint(i.id)); prog();
    bindOpinion(cur, true); bindHist(document.getElementById("hist"), () => cur.dept, () => cur.when);
    document.getElementById("allok").onclick = async () => {
      if (answered() > 0 && !confirm("이미 선택한 항목도 모두 '양호'로 바뀝니다. 계속할까요?")) return;
      ITEMS.forEach(i => { (cur.answers[i.id] = cur.answers[i.id] || {}).r = "ok"; });
      await save(); ITEMS.forEach(i => paint(i.id)); prog();
    };
    document.getElementById("go").onclick = () => {
      readOpinion(cur);
      const miss = ITEMS.filter(i => !(cur.answers[i.id] && cur.answers[i.id].r));
      if (miss.length) { miss.forEach(i => document.getElementById("c_" + i.id).classList.add("miss")); document.getElementById("c_" + miss[0].id).scrollIntoView({ behavior: "smooth", block: "center" }); return alert(`체크하지 않은 문항 ${miss.length}개가 있습니다.`); }
      const noPh = ITEMS.filter(i => cur.answers[i.id].r === "guide" && !(cur.answers[i.id].photos || []).length);
      if (noPh.length && !confirm(`사진이 없는 지도 항목(${noPh.map(i => i.id).join(", ")})이 있습니다. 그대로 진행할까요?`)) return;
      if (editing) { save().then(() => go("edit", cur.id)); return; }
      go("review");
    };
  },

  async review() {
    head("수검자 확인·서명", () => go("checklist"));
    const set = await getSettings(), c = count(cur);
    $app.innerHTML = `<div class="card"><b>${esc(cur.dept)}</b> · ${fmtD(cur.when)}<br><small class="m">점검자 ${esc(inspNames(cur) || set.inspectors.map(i => i.name).slice(0, 1).join(""))}</small>
      <div class="sum"><div class="ok">양호 ${c.ok}</div><div class="guide">지도 ${c.guide}</div><div class="na">해당없음 ${c.na}</div></div></div>
      ${ITEMS.map(it => { const a = cur.answers[it.id]; return `<div class="card item"><b>${it.id}. ${esc(it.title)}</b> <span class="tag ${a.r}">${RESULTS[a.r]}</span>
        ${a.r === "guide" && a.note ? `<div class="note">${esc(a.note)}</div>` : ""}
        ${a.r === "guide" && (a.photos || []).length ? `<div class="photos">${a.photos.map(p => `<div class="ph"><img src="${p}"></div>`).join("")}</div>` : ""}</div>`; }).join("")}
      ${cur.opinion ? `<div class="card"><b>특기사항</b>${cur.opinion.split("\n").map(l => `<div class="sp">${esc(l)}</div>`).join("")}</div>` : ""}
      <div class="card">      <label>부서 입회자(수검자) 직위</label>${posSelect(cur.witness)}
      <label>서명 — 위 내용을 확인했습니다</label><canvas class="sig" id="sg"></canvas>
      <div class="row"><button class="btn sec" id="clr">지우기</button></div>
      <button class="btn" id="fin">서명 완료 · PDF 저장</button></div>`;
    const p = sigPad(document.getElementById("sg"));
    document.getElementById("clr").onclick = () => p.clear();
    document.getElementById("fin").onclick = async e => {
      cur.witness = document.getElementById("wt").value.trim();
      if (!cur.witness) return alert("수검자 직위를 선택하세요.");
      if (p.isEmpty()) return alert("수검자 서명을 받아주세요.");
      { const q = p.quality(); if (q && confirm(`수검자 서명: ${q}\n정자로 또박또박 다시 서명하시겠습니까?\n[확인] 다시 서명   [취소] 그대로 사용`)) { p.clear(); return; } }
      e.target.disabled = true; e.target.textContent = "PDF 생성 중...";
      editing = false; cur.sig = p.data(); cur.signedAt = new Date().toISOString(); cur.status = "done"; await save();
      go("detail", cur.id);
    };
  },

  async edit(id) {
    head("점검 내용 수정", () => { editing = false; go("detail", id); });
    cur = await recGet(id); const set = await getSettings(), dlist = await deptList(set, cur.when);
    $app.innerHTML = `<div class="card"><label>점검일자</label><input type="date" id="wh" value="${esc(String(cur.when).slice(0, 10))}">
      <label>점검부서</label>${deptPicker(dlist, cur.dept)}
      <label>점검자</label><div class="chk-box">${inspChecks(set, (cur.insp || []).map(i => i.name))}</div>
      <label>부서 입회자(수검자) 직위</label>${posSelect(cur.witness)}
      <label>특기사항 (복수 선택 가능)</label>${opinionUI(cur)}
      <button class="btn sec" id="it">점검 항목 수정 (체크·지적사항·사진)</button>
      <button class="btn sec" id="rs">수검자 서명 다시 받기</button>
      <button class="btn" id="sv">저장</button></div>`;
    bindOpinion(cur, false); bindDeptPicker();
    const grab = () => { cur.when = document.getElementById("wh").value || cur.when; cur.dept = document.getElementById("dp").value.trim() || cur.dept; cur.witness = document.getElementById("wt").value.trim(); readOpinion(cur); const sel = pickInsp(set); if (sel.length) cur.insp = sel.map(i => ({ name: i.name, sig: i.sig })); };
    document.getElementById("it").onclick = async () => { grab(); await save(); editing = true; go("checklist"); };
    document.getElementById("rs").onclick = async () => { grab(); await save(); editing = false; go("review"); };
    document.getElementById("sv").onclick = async () => { grab(); await save(); editing = false; go("detail", id); };
  },

  async detail(id) {
    head("점검 결과", () => go("home"));
    const r = await recGet(id), c = count(r);
    $app.innerHTML = `<div class="card"><b>${esc(r.dept)}</b><br><small class="m">${fmtD(r.when)} · 입회 ${esc(r.witness)}</small>
      <div class="sum"><div class="ok">양호 ${c.ok}</div><div class="guide">지도 ${c.guide}</div><div class="na">해당없음 ${c.na}</div></div>
      ${ITEMS.filter(i => r.answers[i.id].r === "guide").map(i => `<div>▶ ${i.id} ${esc(i.title)}${r.answers[i.id].note ? " — " + esc(r.answers[i.id].note) : ""}</div>`).join("")}
      <button class="btn" id="sh">PDF 공유 / 저장</button>${photoList(r).length ? `<button class="btn sec" id="ph">사진 저장 (${photoList(r).length}장 · 부서명)</button>` : ""}<button class="btn sec" id="ed">내용 수정</button><button class="btn sec" id="dl">PDF 다운로드</button><button class="btn sec" id="opn">PDF 열기 (새 탭)</button><button class="btn red" id="rm">기록 삭제</button></div>`;
    document.getElementById("sh").onclick = () => savePdf(r, true);
    const ph = document.getElementById("ph"); if (ph) ph.onclick = () => savePhotos(r);
    document.getElementById("ed").onclick = () => go("edit", id);
    document.getElementById("dl").onclick = () => savePdf(r, false);
    document.getElementById("opn").onclick = () => savePdf(r, false, true);
    document.getElementById("rm").onclick = async () => { if (confirm("이 점검 기록을 삭제할까요? (PDF를 따로 저장하지 않았다면 복구 불가)")) { await recDel(id); go("home"); } };
  }
};

if ("serviceWorker" in navigator) {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (had && !window.__reloaded) { window.__reloaded = true; location.reload(); } });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {});
}
go("home");
