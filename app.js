'use strict';
// ===================================================================== //
//  BSI Risk Simulator — blinded day-by-day replay of the 14-day models
// ===================================================================== //
const SVGNS = 'http://www.w3.org/2000/svg';
const ORGS = ['ecoli', 'entero'];
const ORG_NAME = { ecoli: 'E. coli', entero: 'Enterococcus' };
const GUTTER = 150, PAD_R = 14;
const H = { risk: 104, comp: 120, lane: 13, anc: 78, temp: 84, axis: 22, gap: 10 };
const T_MIN = 96, T_MAX = 104, FEVER = 100.4;
const RISK_MIN = 0.001, RISK_MAX = 0.6;            // log axis for probabilities
const ANC_MIN = 0.05, ANC_MAX = 30;
const DRUG_SHORT = { glycopeptide_antibiotics: 'Vancomycin', penicillins: 'Penicillins', quinolones: 'Fluoroquinolones',
  sulfonamides: 'TMP-SMX', cephalosporins: 'Cephalosporins', carbapenems: 'Carbapenems', macrolide_derivatives: 'Macrolides',
  metronidazole: 'Metronidazole', oxazolidinone_antibiotics: 'Linezolid', aztreonam: 'Aztreonam', aminoglycosides: 'Aminoglycosides',
  lincomycin_derivatives: 'Lincosamides', tetracyclines: 'Tetracyclines', glycylcyclines: 'Tigecycline', leprostatics: 'Leprostatics' };
const CHOICES = ['Continue routine monitoring', 'Repeat stool sample sooner', 'Review / narrow antibiotics',
                 'Change prophylaxis', 'Blood cultures / closer watch', 'Other'];

const S = {
  meta: null, cohort: null, cases: [], thr: {}, sens: 0.9,
  pat: null, label: '', category: null, replay: [], cursor: 0, revealed: false, 
  bsiFirst: {}, caseEnd: null,
};
const $ = (id) => document.getElementById(id);
const cvar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() ||
                    getComputedStyle(document.body).getPropertyValue(n).trim();
const pct = (p, d = 1) => p == null ? '—' : (p * 100 < 0.1 && p > 0 ? '<0.1%' : (p * 100).toFixed(d) + '%');
const fmtDay = (d) => (d > 0 ? '+' : '') + d;
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }

// ------------------------------------------------------------------ data
const BUILD = document.querySelector('meta[name="build"]')?.content || '';
async function getJSON(u) {          // versioned URL: a cached file from an older build is never mixed in
  const r = await fetch(u + (BUILD ? `?v=${BUILD}` : '')); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json();
}

async function init() {
  const saved = store('bsi-theme'); if (saved) document.documentElement.setAttribute('data-theme', saved);
  [S.meta, S.cohort, S.cases] = await Promise.all([getJSON('data/meta.json'), getJSON('data/cohort.json'), getJSON('data/cases.json')]);
  prepCohort();
  setupUI();
  computeThresholds();
  const c0 = S.cases[0];
  await loadPatient(c0.pid, c0.label, c0.category);
  if (!store('bsi-help-seen')) $('helpModal').classList.remove('hidden');
}

function prepCohort() {
  const s = S.cohort.samples;
  S.cohort.n = s.day.length;
  for (const o of ORGS) {
    const p = s[o + '_p'], y = s[o + '_y'];
    const pos = [], all = [];
    for (let i = 0; i < p.length; i++) if (p[i] != null) { all.push(p[i]); if (y[i] === 1) pos.push(p[i]); }
    S.cohort[o] = { pos: pos.sort((a, b) => b - a), nScored: all.length, all: all.sort((a, b) => a - b) };
  }
}

function computeThresholds() {
  for (const o of ORGS) {
    const pos = S.cohort[o].pos;
    S.thr[o] = pos[Math.ceil(S.sens * pos.length) - 1];
  }
  $('thrNote').innerHTML =
    `Alert when the 14-day risk is at or above <b class="ec">${pct(S.thr.ecoli, 2)}</b> for E. coli or ` +
    `<b class="en">${pct(S.thr.entero, 2)}</b> for Enterococcus — the cut-offs at which each model flagged ` +
    `${Math.round(S.sens * 100)}% of stool samples taken in the 14 days before an infection in this cohort ` +
    `(for reference, ${pct(S.cohort.ecoli.pos.length / S.cohort.ecoli.nScored)} and ${pct(S.cohort.entero.pos.length / S.cohort.entero.nScored)} of all samples preceded such an infection).`;
}

// ------------------------------------------------------------------ patient
async function loadPatient(pid, label, category) {
  const seq = S.loadSeq = (S.loadSeq || 0) + 1;
  const p = await getJSON(`data/patients/${encodeURIComponent(pid)}.json`);
  if (seq !== S.loadSeq) return;       // a newer selection was made while this one loaded
  S.pat = p; S.label = label || `Patient ${pid}`; S.category = category || null;
  S.bsiFirst = {};
  for (const o of ORGS) {
    const ds = p.infections.filter(([, a]) => S.meta.orgs[o].agents.includes(a)).map(([d]) => d);
    S.bsiFirst[o] = ds.length ? Math.min(...ds) : null;
  }
  const firsts = ORGS.map(o => S.bsiFirst[o]).filter(d => d != null);
  S.stop = firsts.length ? Math.min(...firsts) : null;        // first E. coli / Enterococcus BSI
  S.replay = p.samples.slice();                               // every sample, to the last one
  S.blindable = S.stop == null || p.samples[0].day < S.stop;
  S.caseEnd = S.replay[S.replay.length - 1].day;
  S.revealed = !S.blindable;          // every case opens blinded
  S.autoRevealed = false;
  S.cursor = 0;
  const sc = $('scrub'); sc.max = S.replay.length - 1; sc.value = 0;
  render();
}

// ------------------------------------------------------------------ UI wiring
function setupUI() {
  const cs = $('caseSelect');
  for (const c of S.cases) cs.add(new Option(c.label, c.pid));
  cs.add(new Option('— other patient (search) —', ''));
  cs.onchange = () => {
    const c = S.cases.find(x => x.pid === cs.value);
    if (c) loadPatient(c.pid, c.label, c.category);
  };
  const dl = $('pidList');
  for (const p of S.cohort.patients) dl.appendChild(new Option(p.pid));
  $('pidInput').onchange = (e) => {
    const v = e.target.value.trim();
    if (S.cohort.patients.some(p => p.pid === v)) {
      const c = S.cases.find(x => x.pid === v);
      cs.value = c ? c.pid : '';
      loadPatient(v, c ? c.label : null, c ? c.category : null);
    }
  };
  const openPid = (pid, label) => {
    const c = S.cases.find(x => x.pid === pid);
    cs.value = c ? c.pid : ''; $('pidInput').value = '';
    loadPatient(pid, c ? c.label : (label || `Patient ${pid}`), c ? c.category : null);
  };
  const FILTERS = {
    all: () => true, ecoli: (p) => p.bsi.ecoli != null, entero: (p) => p.bsi.entero != null,
    either: (p) => p.bsi.ecoli != null || p.bsi.entero != null, both: (p) => p.bsi.ecoli != null && p.bsi.entero != null,
    none: (p) => p.bsi.ecoli == null && p.bsi.entero == null };
  const filtered = () => S.cohort.patients.filter(FILTERS[$('pFilter').value]);
  const fillList = () => {
    const f = $('pFilter').value, pl = $('pList'), ps = filtered();
    pl.replaceChildren(new Option(`— choose (${ps.length}) —`, ''));
    for (const p of ps) {
      const tags = ORGS.filter(o => p.bsi[o] != null && f !== 'all').map(o => `${ORG_NAME[o]} BSI day ${fmtDay(p.bsi[o])}`);
      pl.add(new Option(`${p.pid} · ${p.n} samples${tags.length ? ' · ' + tags.join(', ') : ''}`, p.pid));
    }
  };
  $('pFilter').onchange = fillList;
  $('pList').onchange = (e) => { if (e.target.value) openPid(e.target.value); };
  fillList();
  $('randomBtn').onclick = () => {             // random patient (≥ 3 stool samples) from the filtered list, blinded
    const ps = filtered(), big = ps.filter(p => p.n >= 3), pool = big.length ? big : ps;
    const p = pool[Math.floor(Math.random() * pool.length)];
    $('pList').value = p.pid;
    openPid(p.pid, `Random patient (${p.pid})`);
  };
  $('sensSelect').onchange = (e) => { S.sens = +e.target.value; computeThresholds(); render(); renderWard(); };
  $('prevBtn').onclick = () => step(-1);
  $('nextBtn').onclick = () => step(1);
  $('scrub').oninput = (e) => { S.cursor = +e.target.value; render(); };
  $('revealBtn').onclick = toggleReveal;
  $('themeBtn').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const nxt = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', nxt); store('bsi-theme', nxt); render(); renderWard();
  };
  $('helpBtn').onclick = () => $('helpModal').classList.remove('hidden');
  $('helpClose').onclick = () => { $('helpModal').classList.add('hidden'); store('bsi-help-seen', true); };
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tabpane').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'ward') renderWard();
    if (b.dataset.tab === 'replay') render();
  });
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { render(); renderWard(); }, 120); });
  renderAbout();
}
function step(d) { S.cursor = Math.max(0, Math.min(S.replay.length - 1, S.cursor + d)); render(); }
function toggleReveal() {
  if (!S.blindable) return;
  if (!S.revealed && !confirm('Reveal the outcome for this case?')) return;
  S.revealed = !S.revealed; S.autoRevealed = false;
  if (!S.revealed && S.stop != null && S.replay[S.cursor].day >= S.stop)   // hiding: step back before the infection
    S.cursor = Math.max(0, S.replay.findLastIndex(x => x.day < S.stop));
  render();
}

// ------------------------------------------------------------------ render replay
function render() {
  if (!S.pat) return;
  const cur = S.replay[S.cursor];
  if (!S.revealed && S.stop != null && cur.day >= S.stop) { S.revealed = true; S.autoRevealed = true; }
  $('scrub').value = S.cursor;
  $('dayLabel').textContent = `${S.label} · day ${fmtDay(cur.day)} · sample ${S.cursor + 1} of ${S.replay.length}`;
  const rb = $('revealBtn');
  rb.textContent = S.revealed ? (S.blindable ? 'Hide outcome' : 'Outcome shown') : 'Reveal outcome';
  rb.classList.toggle('done', S.revealed);
  renderTimeline();
  renderToday();
  renderDecision();
  renderOutcome();
}

function xDomain() {
  const days = S.pat.samples.map(s => s.day);
  const d0 = Math.min(...days) - 2;
  let d1 = S.caseEnd + 15;
  if (S.revealed) d1 = Math.max(d1, ...S.pat.infections.map(([d]) => d + 3));
  return [d0, d1];
}

function renderTimeline() {
  const host = $('timeline');
  const W = Math.max(520, host.clientWidth || 900);
  const p = S.pat, cur = S.replay[S.cursor], cd = cur.day;
  const vis = (d) => S.revealed || d <= cd;
  const drugsUsed = [...new Set(p.drugs.filter(([, a]) => vis(a)).map(([c]) => c))].sort((a, b) => a - b);
  const laneN = Math.max(1, drugsUsed.length);
  const rows = [
    { key: 'ecoli', h: H.risk }, { key: 'entero', h: H.risk }, { key: 'comp', h: H.comp },
    { key: 'drugs', h: laneN * H.lane + 22 }, { key: 'anc', h: H.anc }, { key: 'temp', h: H.temp }];
  let y = 20; for (const r of rows) { r.y = y; y += r.h + H.gap; }
  const totalH = y + H.axis;
  const [d0, d1] = xDomain();
  const x = (d) => GUTTER + (d - d0) / (d1 - d0) * (W - GUTTER - PAD_R);
  const pxPerDay = (W - GUTTER - PAD_R) / (d1 - d0);
  const svg = el('svg', { viewBox: `0 0 ${W} ${totalH}`, role: 'img', 'aria-label': 'Patient timeline' });
  const cp = el('clipPath', { id: 'plotclip' }, el('defs', {}, svg));
  el('rect', { x: GUTTER, y: 0, width: W - GUTTER - PAD_R, height: totalH }, cp);
  const plot = el('g', { 'clip-path': 'url(#plotclip)' });

  // day grid + axis
  const tickStep = (d1 - d0) > 120 ? 20 : (d1 - d0) > 60 ? 10 : 7;
  const t0 = Math.ceil(d0 / tickStep) * tickStep;
  const gA = el('g', { class: 'axis' }, svg);
  for (let t = t0; t <= d1; t += tickStep) {
    el('line', { x1: x(t), x2: x(t), y1: 4, y2: totalH - H.axis, class: 'gridline' }, gA);
    el('text', { x: x(t), y: totalH - 6, 'text-anchor': 'middle', class: 'tick' }, gA).textContent = fmtDay(t);
  }
  if (d0 < 0 && d1 > 0) {
    el('line', { x1: x(0), x2: x(0), y1: 4, y2: totalH - H.axis, stroke: cvar('--muted'), 'stroke-width': 1 }, svg);
    el('text', { x: x(0) + 3, y: totalH - H.axis - 3, class: 'small' }, svg).textContent = 'HCT';
  }
  el('text', { x: GUTTER - 8, y: totalH - 6, 'text-anchor': 'end', class: 'tick' }, svg).textContent = 'day vs transplant';

  // ---- risk tracks
  for (const o of ORGS) {
    const r = rows.find(r => r.key === o);
    const col = cvar('--' + o);
    const ly = (pv) => r.y + r.h - (Math.log10(Math.max(RISK_MIN, Math.min(RISK_MAX, pv))) - Math.log10(RISK_MIN)) /
      (Math.log10(RISK_MAX) - Math.log10(RISK_MIN)) * r.h;
    el('rect', { x: GUTTER, y: r.y, width: W - GUTTER - PAD_R, height: r.h, class: 'trk-bg' }, svg);
    lbl(svg, r, ORG_NAME[o], 'risk of BSI in 14 d', col);
    for (const v of [0.001, 0.01, 0.1]) {
      el('line', { x1: GUTTER, x2: W - PAD_R, y1: ly(v), y2: ly(v), class: 'gridline' }, svg);
      el('text', { x: GUTTER - 6, y: ly(v) + 3, 'text-anchor': 'end', class: 'tick' }, svg).textContent = pct(v, v < 0.01 ? 1 : 0);
    }
    // forecast window for current sample
    el('rect', { x: x(cd), y: r.y, width: Math.max(0, x(Math.min(cd + 14, d1)) - x(cd)), height: r.h, class: 'window' }, svg);
    el('line', { x1: GUTTER, x2: W - PAD_R, y1: ly(S.thr[o]), y2: ly(S.thr[o]), class: 'thr-line' }, svg);
    el('text', { x: GUTTER + 4, y: ly(S.thr[o]) - 4, class: 'small' }, svg).textContent = `alert threshold ${pct(S.thr[o], 2)}`;
    const pts = p.samples.filter(s => s['p_' + o] != null && vis(s.day));
    if (pts.length) {
      let dpath = '';
      pts.forEach((s, i) => {
        const X = x(s.day), Y = ly(s['p_' + o]);
        if (i === 0) dpath += `M${X},${Y}`;
        else dpath += `H${X}V${Y}`;
      });
      const last = pts[pts.length - 1];
      const endX = S.revealed ? x(Math.min(last.day + 3, d1)) : x(Math.max(last.day, Math.min(cd, d1)));
      dpath += `H${endX}`;
      el('path', { d: dpath, fill: 'none', stroke: col, 'stroke-width': 2 }, svg);
      for (const s of pts) {
        const pv = s['p_' + o], on = pv >= S.thr[o];
        const c = el('circle', { cx: x(s.day), cy: ly(pv), r: on ? 5 : 4, fill: on ? col : cvar('--panel'),
          stroke: on ? cvar('--panel') : col, 'stroke-width': 2 }, svg);
        hover(c, () => `<b>${ORG_NAME[o]}</b> · day ${fmtDay(s.day)}<br>risk of BSI in 14 d: <b>${pct(pv, 2)}</b>` +
          (on ? '<br>⚠ above alert threshold' : '<br>below alert threshold') +
          `<br><span class="muted">abundance: ${pct(s['ab_' + o], 1)} (${S.meta.orgs[o].abundance})</span>`);
        if (s.day === cd) el('circle', { cx: x(s.day), cy: ly(pv), r: 9, fill: 'none', stroke: col, 'stroke-width': 1.2, opacity: .6 }, svg);
      }
    }
  }

  // ---- composition
  {
    const r = rows.find(r => r.key === 'comp');
    el('rect', { x: GUTTER, y: r.y, width: W - GUTTER - PAD_R, height: r.h, class: 'trk-bg' }, svg);
    lbl(svg, r, 'Stool microbiome', 'relative abundance', null);
    const bw = Math.max(3, Math.min(12, pxPerDay * 0.85));
    for (const s of p.samples) {
      if (!vis(s.day) || !s.comp) continue;
      let yy = r.y + r.h;
      const g = el('g', {}, svg);
      s.comp.forEach((v, gi) => {
        if (v <= 0) return;
        const hh = v * r.h; yy -= hh;
        el('rect', { x: x(s.day) - bw / 2, y: yy, width: bw, height: Math.max(0.5, hh), fill: S.meta.genera[gi].color }, g);
      });
      hover(g, () => {
        const top = s.comp.map((v, i) => [v, i]).filter(([v]) => v > 0.01).sort((a, b) => b[0] - a[0]).slice(0, 6);
        return `<b>Stool sample</b> · day ${fmtDay(s.day)}<br>` + top.map(([v, i]) =>
          `<span class="sw" style="background:${S.meta.genera[i].color}"></span>${S.meta.genera[i].name} ${pct(v, 0)}`).join('<br>');
      });
    }
  }

  // ---- antibiotics
  {
    const r = rows.find(r => r.key === 'drugs');
    el('rect', { x: GUTTER, y: r.y, width: W - GUTTER - PAD_R, height: r.h, class: 'trk-bg' }, svg);
    el('text', { x: 6, y: r.y + 11, class: 'gutter-lbl strong' }, svg).textContent = 'Antibiotics';
    if (!drugsUsed.length) el('text', { x: GUTTER + 6, y: r.y + 30, class: 'small' }, svg).textContent = 'none recorded so far';
    drugsUsed.forEach((c, li) => {
      const yy = r.y + 18 + li * H.lane;
      el('text', { x: GUTTER - 6, y: yy + 9, 'text-anchor': 'end', class: 'tick' }, svg).textContent = DRUG_SHORT[S.meta.drugs[c].key] || S.meta.drugs[c].name;
      for (const [ci, a, b] of p.drugs) {
        if (ci !== c || !vis(a)) continue;
        const bEnd = S.revealed ? b : Math.min(b, cd);
        const rr = el('rect', { x: x(a - 0.4), y: yy + 1, width: Math.max(2, x(bEnd + 0.4) - x(a - 0.4)), height: H.lane - 3, rx: 2,
          fill: cvar('--drug') }, plot);
        hover(rr, () => `<b>${S.meta.drugs[c].name}</b><br>day ${fmtDay(a)} to ${fmtDay(b <= cd || S.revealed ? b : cd)}${!S.revealed && b > cd ? ' (ongoing)' : ''}`);
      }
    });
  }

  // ---- ANC
  {
    const r = rows.find(r => r.key === 'anc');
    const ly = (v) => r.y + r.h - (Math.log10(Math.max(ANC_MIN, Math.min(ANC_MAX, v))) - Math.log10(ANC_MIN)) /
      (Math.log10(ANC_MAX) - Math.log10(ANC_MIN)) * r.h;
    el('rect', { x: GUTTER, y: r.y, width: W - GUTTER - PAD_R, height: r.h, class: 'trk-bg' }, svg);
    el('rect', { x: GUTTER, y: ly(0.5), width: W - GUTTER - PAD_R, height: r.y + r.h - ly(0.5), fill: cvar('--neutro') }, svg);
    el('text', { x: W - PAD_R - 2, y: r.y + r.h - 3, 'text-anchor': 'end', class: 'small' }, svg).textContent = 'neutropenia (< 0.5)';
    lbl(svg, r, 'Neutrophils (ANC)', '×10³/µL, log scale', null);
    for (const v of [0.1, 1, 10]) {
      el('text', { x: GUTTER - 6, y: ly(v) + 3, 'text-anchor': 'end', class: 'tick' }, svg).textContent = v;
      el('line', { x1: GUTTER, x2: W - PAD_R, y1: ly(v), y2: ly(v), class: 'gridline' }, svg);
    }
    const pts = p.anc.filter(([d]) => vis(d));
    if (pts.length) {
      // some days carry 2-3 conflicting readings: the line follows each day's highest; every reading is a dot
      const byDay = new Map();
      for (const pt of pts) { if (!byDay.has(pt[0])) byDay.set(pt[0], []); byDay.get(pt[0]).push(pt); }
      const days = [...byDay.keys()].sort((a, b) => a - b);
      el('path', { d: days.map((d, i) => `${i ? 'L' : 'M'}${x(d)},${ly(Math.max(...byDay.get(d).map(q => q[1])))}`).join(''),
        fill: 'none', stroke: cvar('--text-2'), 'stroke-width': 1.5 }, plot);
      for (const [d, v, c] of pts) {
        const same = byDay.get(d), top = v === Math.max(...same.map(q => q[1]));
        const ci = el('circle', { cx: x(d), cy: ly(v), r: top ? 2.6 : 2, fill: c ? cvar('--panel') : cvar('--text-2'),
          stroke: cvar('--text-2'), 'stroke-width': 1, opacity: top ? 1 : 0.45 }, plot);
        hover(ci, () => `<b>ANC</b> · day ${fmtDay(d)}: ` + same.map(([, vv, cc]) => `${cc ? '&lt;' : ''}${vv}`).join(' / ') +
          ' ×10³/µL' + (same.length > 1 ? '<br><span class="muted">several readings that day; line shows the highest</span>' : ''));
      }
    }
  }

  // ---- temperature (daily max)
  {
    const r = rows.find(r => r.key === 'temp');
    const ly = (v) => r.y + r.h - (Math.max(T_MIN, Math.min(T_MAX, v)) - T_MIN) / (T_MAX - T_MIN) * r.h;
    el('rect', { x: GUTTER, y: r.y, width: W - GUTTER - PAD_R, height: r.h, class: 'trk-bg' }, svg);
    el('rect', { x: GUTTER, y: r.y, width: W - GUTTER - PAD_R, height: ly(FEVER) - r.y, fill: cvar('--alert-bg') }, svg);
    el('text', { x: W - PAD_R - 2, y: r.y + 10, 'text-anchor': 'end', class: 'small' }, svg).textContent = 'fever (≥ 100.4 °F / 38.0 °C)';
    lbl(svg, r, 'Temperature', 'daily max, °F', null);
    el('text', { x: 6, y: r.y + 42, class: 'gutter-lbl' }, svg).textContent = '(not a model input)';
    for (const v of [98, 100, 102]) {
      el('text', { x: GUTTER - 6, y: ly(v) + 3, 'text-anchor': 'end', class: 'tick' }, svg).textContent = v;
      el('line', { x1: GUTTER, x2: W - PAD_R, y1: ly(v), y2: ly(v), class: 'gridline' }, svg);
    }
    const pts = (p.temp || []).filter(([d]) => vis(d));
    if (pts.length) {
      el('path', { d: pts.map(([d, v], i) => `${i ? 'L' : 'M'}${x(d)},${ly(v)}`).join(''), fill: 'none',
        stroke: cvar('--text-2'), 'stroke-width': 1.3 }, plot);
      for (const [d, v] of pts) {
        const f = v >= FEVER;
        const ci = el('circle', { cx: x(d), cy: ly(v), r: f ? 3.2 : 2.2, fill: f ? cvar('--alert') : cvar('--text-2'),
          stroke: cvar('--panel'), 'stroke-width': f ? 1 : 0 }, plot);
        hover(ci, () => `<b>Temperature</b> · day ${fmtDay(d)}<br>daily max ${v} °F (${((v - 32) * 5 / 9).toFixed(1)} °C)${f ? '<br>fever' : ''}`);
      }
    }
  }

  svg.appendChild(plot);
  // ---- future shade, cursor, infections
  const top = rows[0].y, bot = rows[rows.length - 1].y + rows[rows.length - 1].h;
  if (!S.revealed) {
    el('rect', { x: x(cd) + 6, y: top, width: Math.max(0, W - PAD_R - x(cd) - 6), height: bot - top, class: 'future' }, svg);
    el('text', { x: Math.min(x(cd) + 12, W - 150), y: rows[2].y + 16, class: 'small' }, svg).textContent = 'not yet observed →';
  }
  el('line', { x1: x(cd), x2: x(cd), y1: top - 4, y2: bot + 2, class: 'cursor' }, svg);
  if (!S.revealed) el('text', { x: x(cd), y: top - 8, 'text-anchor': 'middle', class: 'small' }, svg).textContent = 'today';
  {
    for (const [d, a] of p.infections) {
      if (!S.revealed && d > cd) continue;
      const org = ORGS.find(o => S.meta.orgs[o].agents.includes(a));
      const col = org ? cvar('--' + org) : cvar('--other-bsi');
      el('line', { x1: x(d), x2: x(d), y1: top - 4, y2: bot, stroke: col, 'stroke-width': 2.2 }, svg);
      const t = el('text', { x: x(d), y: top - 8, 'text-anchor': 'middle', class: 'small', fill: col, 'font-weight': 700 }, svg);
      t.textContent = `BSI · ${a.replace(/_/g, ' ')}`;
      t.style.fill = col;
    }
  }
  host.replaceChildren(svg);
  renderLegend();
}

function lbl(svg, r, title, sub, col) {
  const t = el('text', { x: 6, y: r.y + 14, class: 'gutter-lbl strong' }, svg); t.textContent = title;
  if (col) t.style.fill = col;
  el('text', { x: 6, y: r.y + 28, class: 'gutter-lbl' }, svg).textContent = sub;
}

function renderLegend() {
  const shown = S.meta.genera.map((g, i) => [g, i]).filter(([, i]) =>
    S.pat.samples.some(s => s.comp && s.comp[i] > 0.03 && (S.revealed || s.day <= S.replay[S.cursor].day)));
  $('compLegend').innerHTML = shown.map(([g]) => `<span><span class="sw" style="background:${g.color}"></span>${g.name}</span>`).join('') +
    `<span class="muted">· abundant genera named; the rest grouped by family, order or phylum (paler shade); hover a bar for detail</span>`;
}

// ------------------------------------------------------------------ tooltip
const tip = () => $('tooltip');
function hover(node, html) {
  node.style.cursor = 'default';
  node.addEventListener('mouseenter', (e) => { tip().innerHTML = html(); tip().classList.remove('hidden'); moveTip(e); });
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', () => tip().classList.add('hidden'));
}
function moveTip(e) {
  const t = tip(), w = t.offsetWidth, h = t.offsetHeight;
  let X = e.clientX + 14, Y = e.clientY + 14;
  if (X + w > innerWidth - 8) X = e.clientX - w - 14;
  if (Y + h > innerHeight - 8) Y = e.clientY - h - 14;
  t.style.left = X + 'px'; t.style.top = Y + 'px';
}

// ------------------------------------------------------------------ today card
function prevScored(o) {
  for (let i = S.cursor - 1; i >= 0; i--) if (S.replay[i]['p_' + o] != null) return S.replay[i]['p_' + o];
  return null;
}
function renderToday() {
  const cur = S.replay[S.cursor];
  let h = `<h3>Day ${fmtDay(cur.day)} — stool sample ${S.cursor + 1}</h3>
    <div class="sub">Risk of a bloodstream infection in the next 14 days, from everything observed up to today.</div>`;
  for (const o of ORGS) {
    const pv = cur['p_' + o], prev = prevScored(o);
    const on = pv != null && pv >= S.thr[o];
    const after = S.bsiFirst[o] != null && cur.day >= S.bsiFirst[o];
    const chip = pv == null ? `<span class="chip na">${after ? 'not scored · after BSI' : 'not scored'}</span>` :
      on ? '<span class="chip alert">⚠ ALERT</span>' : '<span class="chip ok">✓ below threshold</span>';
    const delta = (pv != null && prev != null) ?
      ` · ${pv > prev ? '↑' : pv < prev ? '↓' : '→'} from ${pct(prev, 2)} at previous sample` : '';
    h += `<div class="orgrow"><div class="orghead"><span class="orgname" style="color:var(--${o})">${ORG_NAME[o]}</span>${chip}
      <span class="risknum">${pct(pv, pv != null && pv < 0.1 ? 2 : 1)}</span></div>
      <div class="facts">${pv != null ? `higher than ${pctRank(o, pv)}% of all stool samples` : ''}${delta}<br>
      Pathogen abundance today: <b>${pct(cur['ab_' + o], 1)}</b> <span class="muted">(${S.meta.orgs[o].abundance})</span></div>`;
    const dv = cur['drv_' + o];
    if (dv && S.meta.groups[o]) h += driversHTML(o, dv);
    else if (pv != null) h += `<div class="muted" style="font-size:12px">Driver breakdown not available for this model yet.</div>`;
    h += `</div>`;
  }
  if (S.cursor === S.replay.length - 1 && !S.revealed)
    h += `<div class="endnote"><b>Last stool sample.</b> Reveal the outcome to see what happened.</div>`;
  $('todayCard').innerHTML = h;
}

function pctRank(o, v) {
  const a = S.cohort[o].all; let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return Math.round(lo / a.length * 100);
}
function driversHTML(o, dv) {
  const names = S.meta.groups[o];
  const g = dv.g.map((v, i) => [v, i]).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).slice(0, 5);
  const m = Math.max(0.5, ...g.map(([v]) => Math.abs(v)));
  const col = `var(--${o})`;
  let h = `<div class="drv"><div class="sub" style="margin-bottom:3px">What moved this score (vs. an average sample):</div>`;
  for (const [v, i] of g) {
    const w = Math.abs(v) / m * 50;
    const left = v >= 0 ? 50 : 50 - w;
    h += `<div class="drv-row" title="${names[i]}"><span class="lbl">${names[i]}</span>
      <span class="drv-bar"><span class="mid"></span><span class="b" style="left:${left}%;width:${w}%;background:${v >= 0 ? col : 'var(--muted)'}"></span></span>
      <span class="val">×${Math.exp(v).toFixed(2)}</span></div>`;
  }
  h += `</div><details class="feats"><summary>Top individual inputs</summary><table>` +
    dv.f.map(([nm, unit, gi, c, val]) => `<tr><td>${nm}</td><td class="num">${fmtVal(val, unit)}</td>
      <td class="num" style="color:${c >= 0 ? col : 'var(--muted)'}">×${Math.exp(c).toFixed(2)}</td></tr>`).join('') +
    `</table></details>`;
  return h;
}
function fmtVal(v, unit) {
  if (v == null) return '—';
  if (v >= 999) return 'none so far';
  if (unit === 'pct') return pct(v, v < 0.01 ? 2 : 1);
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : (+v.toPrecision(3)).toString();
}

// ------------------------------------------------------------------ decision log
function decKey() { return `bsi-dec-${S.pat.pid}-${S.replay[S.cursor].day}`; }
function renderDecision() {
  const cur = S.replay[S.cursor];
  const alerts = ORGS.filter(o => cur['p_' + o] != null && cur['p_' + o] >= S.thr[o]);
  const rec = store(decKey()) || { choices: [], note: '' };
  const head = alerts.length
    ? `<h3>⚠ ${alerts.map(o => ORG_NAME[o]).join(' and ')} alert — what would you do?</h3>`
    : `<h3>Log a decision (optional)</h3><div class="sub">No alert at this sample.</div>`;
  $('decisionCard').innerHTML = head +
    `<div class="choices">${CHOICES.map(c => `<button class="choice ${rec.choices.includes(c) ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}</div>
     <textarea id="decNote" placeholder="Notes (optional)">${rec.note || ''}</textarea>
     <div class="row"><span id="decSaved" class="saved grow"></span>
       <button class="ghost sm" id="decClear" title="Delete all decisions logged in this browser">Clear log</button>
       <button class="ghost sm" id="decExport" title="Download all logged decisions">Download log</button></div>`;
  const save = () => {
    const r = { choices: [...document.querySelectorAll('.choice.on')].map(b => b.dataset.c), note: $('decNote').value,
      case: S.label, pid: S.pat.pid, day: cur.day, revealed_when_logged: S.revealed,
      risk: Object.fromEntries(ORGS.map(o => [o, cur['p_' + o]])), alert: alerts, threshold_sens: S.sens, t: new Date().toISOString() };
    store(decKey(), r); $('decSaved').textContent = 'saved';
  };
  document.querySelectorAll('.choice').forEach(b => b.onclick = () => { b.classList.toggle('on'); save(); });
  $('decNote').oninput = save;
  $('decExport').onclick = exportLog;
  $('decClear').onclick = () => {
    if (!confirm('Delete every decision logged in this browser?')) return;
    try { Object.keys(localStorage).filter(k => k.startsWith('bsi-dec-')).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    renderDecision();
  };
}
function exportLog() {
  const rows = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('bsi-dec-')) rows.push(JSON.parse(localStorage.getItem(k))); } } catch (e) {}
  const cols = ['case', 'pid', 'day', 'alert', 'risk_ecoli', 'risk_entero', 'choices', 'note', 'revealed_when_logged', 'threshold_sens', 't'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(',')].concat(rows.map(r => [r.case, r.pid, r.day, (r.alert || []).join(' '), r.risk?.ecoli, r.risk?.entero,
    (r.choices || []).join('; '), r.note, r.revealed_when_logged, r.threshold_sens, r.t].map(esc).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'bsi_simulator_decisions.csv'; a.click();
}

// ------------------------------------------------------------------ outcome
function renderOutcome() {
  const c = $('outcomeCard');
  if (!S.revealed) { c.classList.add('hidden'); return; }
  c.classList.remove('hidden'); c.classList.add('outcome');
  const p = S.pat;
  let h = `<h3>Outcome</h3>` + (S.autoRevealed ?
    `<div class="catlabel" style="margin:0 0 8px">Revealed automatically: the replay has passed the day of the infection.</div>` : '');
  if (!p.infections.length) h += `<div>No bloodstream infection recorded.</div>`;
  else h += `<ul>${p.infections.map(([d, a]) => `<li>BSI on day <b>${fmtDay(d)}</b>: ${a.replace(/_/g, ' ')}</li>`).join('')}</ul>`;
  h += '<ul>';
  for (const o of ORGS) {
    const sc = p.samples.filter(s => s['p_' + o] != null);
    const al = sc.filter(s => s['p_' + o] >= S.thr[o]);
    let line = `<b style="color:var(--${o})">${ORG_NAME[o]}</b>: ${al.length} of ${sc.length} scored samples alerted`;
    const b = S.bsiFirst[o];
    if (b != null) {
      const pre = sc.filter(s => s.day < b && s.day >= b - 14);
      const fa = pre.filter(s => s['p_' + o] >= S.thr[o]);
      line += !pre.length ? '; no stool sample in the 14 days before this infection'
        : fa.length ? `; first alert in the 14 days before infection: day ${fmtDay(fa[0].day)} (<b>${b - fa[0].day} days ahead</b>)`
        : '; <b>missed</b> — no alert in the 14 days before infection';
    }
    h += `<li>${line}</li>`;
  }
  h += '</ul>';
  if (S.category) h += `<div class="catlabel">Why this case was chosen: ${S.category}</div>`;
  if (!S.blindable) h += `<div class="catlabel">Infection occurred before the first stool sample here, so this case cannot be replayed blinded.</div>`;
  c.innerHTML = h;
}

// ------------------------------------------------------------------ ward view
function wardStats(o) {
  const s = S.cohort.samples, P = S.cohort.patients, thr = S.thr[o];
  const p = s[o + '_p'], y = s[o + '_y'];
  const idx = []; for (let i = 0; i < p.length; i++) if (p[i] != null) idx.push(i);
  const n = idx.length, flagged = idx.filter(i => p[i] >= thr);
  const k = flagged.length;
  const npos = idx.filter(i => y[i] === 1).length;
  const tp = flagged.filter(i => y[i] === 1).length;
  // patients
  const byPat = new Map();
  for (const i of idx) { const pi = s.pid[i]; if (!byPat.has(pi)) byPat.set(pi, []); byPat.get(pi).push(i); }
  let alerted = 0, warned = 0, eligible = 0; const leads = [];
  for (const [pi, rows] of byPat) {
    if (rows.some(i => p[i] >= thr)) alerted++;
    const b = P[pi].bsi[o];
    if (b == null) continue;
    const pre = rows.filter(i => s.day[i] < b && s.day[i] >= b - 14);
    if (!pre.length) continue;
    eligible++;
    const fl = pre.filter(i => p[i] >= thr);
    if (fl.length) { warned++; leads.push(b - Math.min(...fl.map(i => s.day[i]))); }
  }
  leads.sort((a, b) => a - b);
  return { n, k, npos, tp, nPat: byPat.size, alerted, warned, eligible,
    medLead: leads.length ? leads[Math.floor(leads.length / 2)] : null, idx, p, y };
}

function renderWard() {
  if (!S.cohort || !$('tab-ward').classList.contains('active')) return;
  let tiles = '', table = '';
  const stats = {};
  for (const o of ORGS) {
    const w = stats[o] = wardStats(o);
    tiles += `<div class="panel wt"><h3 style="color:var(--${o})">${ORG_NAME[o]} model · alert ≥ ${pct(S.thr[o], 2)}</h3><div class="tiles">
      ${tile('Samples alerting', pct(w.k / w.n, 0), `${w.k.toLocaleString()} of ${w.n.toLocaleString()} stool samples`)}
      ${tile('Alerts followed by BSI ≤ 14 d', pct(w.tp / w.k, 1), `about 1 in ${Math.round(w.k / w.tp)} alerts`)}
      ${tile('Patients ever alerted', pct(w.alerted / w.nPat, 0), `${w.alerted} of ${w.nPat}`)}
      ${tile('Pre-infection samples caught', pct(w.tp / w.npos, 0), `${w.tp} of ${w.npos} samples taken ≤ 14 d before a BSI`)}
      ${tile('Infected patients warned', `${w.warned} / ${w.eligible}`, `≥ 1 alert in the 14 d before infection`)}
      ${tile('Median warning time', w.medLead != null ? `${w.medLead} days` : '—', 'first alert → BSI, warned patients')}
      </div></div>`;
    table += `<tr><td>${ORG_NAME[o]}</td><td>${pct(S.thr[o], 2)}</td><td>${pct(w.k / w.n, 1)}</td><td>${pct(w.tp / w.npos, 1)}</td>
      <td>${pct(w.tp / w.k, 2)}</td><td>${pct(w.alerted / w.nPat, 1)}</td><td>${w.warned} / ${w.eligible}</td><td>${w.medLead ?? '—'}</td></tr>`;
  }
  $('wardTiles').innerHTML = tiles;
  $('wardTable').innerHTML = `<table class="data"><thead><tr><th>Model</th><th>Alert threshold</th><th>Samples alerting</th><th>Sensitivity (samples)</th>
    <th>PPV</th><th>Patients ever alerted</th><th>Infected patients warned</th><th>Median warning (days)</th></tr></thead><tbody>${table}</tbody></table>
    <p class="muted" style="font-size:12px">"Infected patients warned" counts patients with at least one stool sample in the 14 days before their first infection
    with that organism, and at least one alert among those samples. Sensitivity and PPV are per stool sample; the outcome is a BSI with that organism within 14 days.</p>`;
  $('wardCharts').innerHTML = '';
  for (const o of ORGS) tradeoffChart(o, stats[o]);
}
function tile(k, v, c) { return `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="c">${c}</div></div>`; }

function curve(score, idx, y) {
  // (fraction flagged, sensitivity) with ties handled as straight segments
  const arr = idx.map(i => [score[i], y[i]]).sort((a, b) => b[0] - a[0]);
  const npos = arr.filter(a => a[1] === 1).length, n = arr.length;
  const pts = [[0, 0]]; let tp = 0;
  for (let i = 0; i < n; i++) {
    tp += arr[i][1] === 1 ? 1 : 0;
    if (i === n - 1 || arr[i + 1][0] !== arr[i][0]) pts.push([(i + 1) / n, tp / npos]);
  }
  return pts;
}
function tradeoffChart(o, w) {
  const box = document.createElement('div'); box.className = 'panel';
  box.innerHTML = `<h4 style="color:var(--${o})">${ORG_NAME[o]}: alerts vs. infections caught</h4>
    <div class="muted" style="font-size:12px">Each point on the line is one possible threshold. Dot = the selected threshold.</div>`;
  $('wardCharts').appendChild(box);
  const W = Math.max(320, box.clientWidth - 24), Ht = 260, L = 46, B = 34, T = 10, R = 12;
  const svg = el('svg', { viewBox: `0 0 ${W} ${Ht}`, style: 'width:100%;height:auto;display:block' });
  const X = (v) => L + v * (W - L - R), Y = (v) => T + (1 - v) * (Ht - T - B);
  for (let v = 0; v <= 1.001; v += 0.2) {
    el('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'gridline' }, svg);
    el('text', { x: L - 6, y: Y(v) + 3, 'text-anchor': 'end', class: 'tick' }, svg).textContent = Math.round(v * 100) + '%';
    el('text', { x: X(v), y: Ht - B + 14, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = Math.round(v * 100) + '%';
  }
  el('text', { x: L + (W - L - R) / 2, y: Ht - 4, 'text-anchor': 'middle', class: 'small' }, svg).textContent = 'stool samples that would alert';
  const yl = el('text', { x: 12, y: T + (Ht - T - B) / 2, 'text-anchor': 'middle', class: 'small', transform: `rotate(-90 12 ${T + (Ht - T - B) / 2})` }, svg);
  yl.textContent = 'pre-infection samples caught';
  const col = cvar('--' + o);
  const cm = curve(w.p, w.idx, w.y);
  const path = (pts) => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${X(a)},${Y(b)}`).join('');
  el('path', { d: path(cm), fill: 'none', stroke: col, 'stroke-width': 2 }, svg);
  const fx = w.k / w.n;
  el('line', { x1: X(fx), x2: X(fx), y1: T, y2: Ht - B, stroke: cvar('--border'), 'stroke-width': 1 }, svg);
  const dm = el('circle', { cx: X(fx), cy: Y(w.tp / w.npos), r: 5, fill: col, stroke: cvar('--panel'), 'stroke-width': 2 }, svg);
  hover(dm, () => `<b>Model</b> at selected threshold<br>${pct(fx, 0)} of samples alert · catches ${pct(w.tp / w.npos, 0)}`);
  box.appendChild(svg);
}

// ------------------------------------------------------------------ about
function renderAbout() {
  $('aboutText').innerHTML = `
  <h2>What the scores are</h2>
  <p>Two gradient-boosted survival models (XGBoost, Cox objective) estimate, at each stool sample, the probability of a bloodstream
  infection (BSI) with <span class="ec">E. coli</span> or with <span class="en">Enterococcus</span> (E. faecium, E. faecalis, VRE) within the next 14 days.
  Inputs are only what was known on the day of the sample: 16S rRNA microbiome composition and its recent trajectory
  (e.g. the pathogen's 14-day mean, maximum and slope), antibiotic exposure, neutrophil counts and day relative to transplant.
  The E. coli model uses 61 inputs; the Enterococcus model 640. The models were found with an AI-agent-assisted search
  ("autoresearch") over model designs and engineered features.</p>
  <h2>How the scores in this tool were produced</h2>
  <ul>
    <li><b>Out-of-fold.</b> Patients were split into five groups; each patient's scores come from models trained on the other four groups only. This was repeated for five different groupings and the probabilities averaged.</li>
    <li><b>Probabilities.</b> The models' Cox risk scores were converted to 14-day probabilities by logistic (Platt) recalibration, also fitted out-of-fold.</li>
    <li><b>Drivers</b> are SHAP values from the same models: how much each group of inputs moved the score relative to an average sample, shown as a multiplier on the hazard. They describe the model, not biology; they are not causal.</li>
    <li><b>Alert thresholds</b> are set so the model would have flagged a chosen share (75–95%) of all stool samples taken in the 14 days before an infection. These thresholds were picked on the same cohort.</li>
  </ul>
  <h2>Performance in this cohort (14-day outcome, AUC)</h2>
  <ul>
    <li>E. coli: 0.897.</li>
    <li>Enterococcus: 0.816.</li>
  </ul>
  <p class="muted">Pooled out-of-fold AUC, mean over five patient groupings. 176 stool samples preceded an E. coli BSI within 14 days (49 patients) and 266 an Enterococcus BSI (91 patients), out of ~9,500 scored samples from ~1,170 patients.</p>
  <h2>Limits</h2>
  <ul>
    <li>Single center (MSK), retrospective. No external or prospective validation.</li>
    <li>Thresholds and model design were chosen on this cohort.</li>
    <li>Infections are rare, so most alerts are not followed by infection (see Ward view).</li>
    <li>Samples taken on or after a patient's first BSI with an organism are not scored for that organism.</li>
    <li>"&lt;" neutrophil values are shown at the reported limit (hollow points), as the model sees them.</li>
    <li>Antibiotic classes come from administration records; route is not shown.</li>
    <li>Temperature is shown for context only; it is not an input to either model.</li>
  </ul>
  <h2>Data</h2>
  <p>De-identified MSK allo-HCT data from the Xavier lab (see Schluter et al., <i>Scientific Data</i> 2020). Patients appear under random codes; days are relative to transplant (HCT = day 0).</p>
  <p class="muted">Xavier Lab, MSKCC · research prototype · not for clinical use.</p>`;
}

init().catch(err => {
  document.querySelector('main').innerHTML = `<div class="panel" style="padding:16px">Could not load data: ${err.message}.
  If you opened this file directly from disk, serve the folder instead (e.g. <code>python3 -m http.server</code>) or use the hosted page.</div>`;
});
