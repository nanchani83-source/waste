/* 목적지 검색: 부분일치 · 초성 · 별칭 · 오타 허용(자모 편집거리)
 * 입력 내용은 휴대폰 안에서만 처리하고 어디에도 보내거나 저장하지 않는다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Search = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

  const norm = s => (s || '').toLowerCase().replace(/[\s·\-_/().,]/g, '');

  function choseong(s) {
    let out = '';
    for (const ch of s) {
      const c = ch.charCodeAt(0) - 0xAC00;
      out += (c >= 0 && c < 11172) ? CHO[Math.floor(c / 588)] : ch;
    }
    return out;
  }

  function jamo(s) {
    let out = '';
    for (const ch of s) {
      const c = ch.charCodeAt(0) - 0xAC00;
      if (c >= 0 && c < 11172) out += CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + JONG[c % 28];
      else out += ch;
    }
    return out;
  }

  const isChoOnly = s => s.length > 0 && [...s].every(ch => CHO.includes(ch));

  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /**
   * POI 목록 → 검색 항목. 같은 group(화장실·엘리베이터·영상의학과 여러 문)은 하나로 묶는다.
   * 항목: { key, name, category, poiIds, terms:[{t, cho, jamo, alias}] , nearest }
   */
  function buildIndex(pois) {
    const byKey = new Map();
    for (const p of pois) {
      const key = p.group || p.id;
      let it = byKey.get(key);
      if (!it) { it = { key, name: p.name, category: p.category, poiIds: [], names: new Set(), aliases: new Set(), floors: new Set() }; byKey.set(key, it); }
      it.poiIds.push(p.id);
      // 이름: "채혈실(어린이병원)" → "채혈실"도 정식 이름으로 취급(다른 건물 같은 이름과 같은 점수 → 가까운 곳 우선)
      it.names.add(p.name);
      const base = p.name.replace(/\(.*?\)/g, '').trim();
      if (base) it.names.add(base);
      (p.aliases || []).forEach(a => it.aliases.add(a));
      // "어린이병원 채혈실"처럼 건물 이름을 붙여 찾을 수 있게
      if (p._building && !p.group) it.names.add(p._building + ' ' + base);
      if (p._floor) it.floors.add(p._floor);
    }
    const items = [...byKey.values()].map(it => {
      const terms = makeTerms([...it.names], [...it.aliases]);
      return { key: it.key, name: it.name, category: it.category, poiIds: it.poiIds, nearest: it.poiIds.length > 1, terms, floors: [...it.floors] };
    });
    return items;
  }

  function makeTerms(names, aliases) {
    const mk = (w, alias) => { const t = norm(w); return { t, cho: choseong(t), jamo: jamo(t), alias }; };
    return [...names.map(w => mk(w, false)), ...(aliases || []).map(w => mk(w, true))];
  }

  /**
   * 목적지(POI)가 아닌 검색 항목 만들기 — 다른 층 안내(directory), 행사(event)
   * extra 는 항목에 그대로 붙는다(예: { dir: entry } / { event: ev })
   */
  function makeItem(key, name, category, aliases, extra) {
    const base = name.replace(/\(.*?\)/g, '').trim();
    const names = [name]; if (base && base !== name) names.push(base);
    return { key, name, category, poiIds: [], nearest: false, floors: [], terms: makeTerms(names, aliases || []), ...extra };
  }

  /** 점수가 높을수록 잘 맞음. 0이면 제외 */
  function scoreTerm(q, qJamo, choQuery, term) {
    if (choQuery) {
      if (term.cho.startsWith(q)) return 80;
      if (term.cho.includes(q)) return 60;
      return 0;
    }
    if (term.t === q) return term.alias ? 95 : 100;
    if (term.t.startsWith(q)) return term.alias ? 80 : 88;
    if (term.t.includes(q)) return term.alias ? 65 : 72;
    if (q.length >= 2 && q.includes(term.t) && term.t.length >= 2) return 55; // "정형외과가는길" → 정형외과
    if (qJamo.length >= 4) {
      const max = qJamo.length >= 8 ? 2 : 1;
      const head = term.jamo.slice(0, qJamo.length);
      const d = Math.min(editDistance(qJamo, term.jamo, max), editDistance(qJamo, head, max));
      if (d <= max) return 40 - d * 10;
    }
    return 0;
  }

  /** distanceOf(item) → 숫자(작을수록 가까움). 점수가 같으면 가까운 곳을 먼저 */
  function search(items, query, limit = 8, distanceOf) {
    const q = norm(query);
    if (!q) return [];
    const choQuery = isChoOnly(q);
    const qJamo = jamo(q);
    const out = [];
    for (const it of items) {
      let best = 0, via = '';
      for (const term of it.terms) {
        const s = scoreTerm(q, qJamo, choQuery, term);
        if (s > best) { best = s; via = term.alias ? term.t : ''; }
      }
      if (best > 0) out.push({ item: it, score: best, via });
    }
    const d = distanceOf || (() => 0);
    // 점수 차이가 작으면(같은 이름의 다른 건물 등) 가까운 곳을 먼저
    out.sort((a, b) => Math.round((b.score - a.score) / 6) || d(a.item) - d(b.item) || b.score - a.score || a.item.name.length - b.item.name.length || a.item.name.localeCompare(b.item.name, 'ko'));
    return out.slice(0, limit);
  }

  return { buildIndex, makeItem, search, choseong, jamo, norm };
});
