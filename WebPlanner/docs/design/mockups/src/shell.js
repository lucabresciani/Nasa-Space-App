// D7 mockup drafts: shell fragments (top bar, left rail, timeline dock) shared by the six screens.
const EVA_MIN = 6.5 * 60; // config/crew.yaml eva_h: 6.5

HL.top = (mode, { live = false } = {}) => {
  const modes = [['Plan', 'P'], ['Fly', 'Y'], ['Report', 'R'], ['Evidence', 'E']];
  return `<header class="top">
    <span class="wordmark">HOMELINE</span>
    <nav class="modes">${modes.map(([m, k]) => `<a class="${m === mode ? 'on' : ''}">${m}<kbd>${k}</kbd></a>`).join('')}</nav>
    <span class="plan-id"><span class="code plain">NOM_104</span><span class="long">Nominal · suit 104 kg · pad rank 1</span>
      <span class="status">${HL.chip('modelled')} Precomputed · official plan</span></span>
    <span class="spacer"></span>
    <span class="search">${HL.icon('search', 'sm')} Search or run a command<kbd>Ctrl K</kbd></span>
    <button class="btn ghost">${HL.icon('share-2', 'sm')} Share</button>
    ${live ? `<span class="status live"><span class="dot"></span>Live</span>` : `<span class="status">${HL.icon('wifi-off', 'sm')} Live off</span>`}
  </header>`;
};

HL.stamp = () => `<div class="stamp">DRAFT — provisional (D73), awaiting team lead + D</div>`;

// plan summary + budgets + route list + layers (left rail, Plan mode)
HL.rail = ({ selected = null, variant = 'nominal', compact = false } = {}) => {
  const m = HL.m, f = HL.fmt;
  const route = HL.D.timeline.filter((e) => e.event === 'arrive');
  const st = Object.fromEntries(HL.D.stations.map((s) => [s.id, s]));
  return `
  <section class="sec">
    <h3>${HL.icon('map', 'sm')} Plan</h3>
    <div class="ro big"><div class="l">Reachable in 30 min ${HL.chip('modelled')}</div>
      <div class="v">${f(m('reachable_pct.nom_104.30'))}<small>%</small> <span class="label">(${f(m('reachable_pct_range.nom_104.30.low'))}–${f(m('reachable_pct_range.nom_104.30.high'))})</span></div>
      <div class="s">of the flat 30-min disc · range = optimistic–conservative</div></div>
    <div class="ros tab-hide">
      <div class="ro"><div class="l">Feasible EVAs ${HL.chip('modelled')}</div><div class="v">${m('pad.score')}</div></div>
      <div class="ro"><div class="l">EVA ${HL.chip('modelled')}</div><div class="v">${HL.hhmm(m('route.nom_104.total_min'))}</div></div>
    </div>
  </section>
  <section class="sec">
    <h3>${HL.icon('crew', 'sm')} Crew and budgets</h3>
    <div class="kv"><span class="k">Variant</span><span class="seg" style="margin-left:auto"><span class="${variant === 'optimistic' ? 'on' : ''}">Opt</span><span class="${variant === 'nominal' ? 'on' : ''}">Nom</span><span class="${variant === 'conservative' ? 'on' : ''}">Con</span></span></div>
    <div class="kv"><span class="k">Homeline</span><span class="seg" style="margin-left:auto"><span class="on">30 min</span><span>60 min</span></span></div>
    <div class="kv tab-hide"><span class="k">Suit mass</span><span class="v">104 kg ${HL.chip('sim')}</span></div>
    <div class="kv tab-hide"><span class="k">O₂ budget · reserve</span><span class="v">${f(m('margin.o2_budget_L'))} L · ${f(m('margin.o2_reserve_L'))} L ${HL.chip('modelled')}</span></div>
  </section>
  ${compact ? '' : `<section class="sec">
    <h3>${HL.icon('station', 'sm')} Stations and route <span class="r faint">arrive · margin</span></h3>
    <div class="list">
      <div class="row"><span class="code plain">PAD</span><span class="n">Rover pad · depart</span><span class="t">00:00</span><span></span></div>
      ${route.map((e) => { const c = `card.${e.station}`; return `<div class="row ${selected === e.station ? 'hl' : ''}" ${selected === e.station ? 'style="box-shadow: inset 0 0 0 1px var(--color-select)"' : ''}>
        <span class="code">${e.station}</span><span class="n">${st[e.station].name}</span>
        <span class="t">${HL.hhmm(e.t_min)}</span><span class="t" style="color:var(--color-safe)">${f(m(c + '.margin_min'), 0)} min ${HL.chip('modelled')}</span></div>`; }).join('')}
      <div class="row"><span class="code plain">PAD</span><span class="n">Return</span><span class="t">${HL.hhmm(m('route.nom_104.total_min'))}</span><span></span></div>
    </div>
  </section>
  <section class="sec">
    <h3>${HL.icon('layers', 'sm')} Layers</h3>
    <div class="layer"><span class="sw" style="background:color-mix(in srgb, var(--color-safe) 45%, transparent)"></span>Homeline bands ${HL.chip('modelled')}<span class="tg on"></span></div>
    <div class="layer"><span class="sw" style="background:var(--color-text-faint)"></span>Slope relief ${HL.chip('real')}<span class="tg on"></span></div>
    <div class="layer"><span class="sw" style="background:color-mix(in srgb, var(--color-limit) 45%, transparent)"></span>Blocked slope ${HL.chip('modelled')}<span class="tg"></span></div>
    <div class="layer"><span class="sw" style="background:color-mix(in srgb, var(--color-science) 45%, transparent)"></span>Mineral hints ${HL.chip('real')}<span class="tg"></span></div>
    <div class="layer"><span class="sw hatch"></span>No 1 m terrain (none here) ${HL.chip('real')}<span class="tg on"></span></div>
  </section>`}`;
};

HL.mapctl = () => `<div class="mapctl">
  <span class="b">3D</span><span class="b">${HL.icon('compass')}</span><span class="gap"></span>
  <span class="b">${HL.icon('zoom-in')}</span><span class="b">${HL.icon('zoom-out')}</span><span class="gap"></span>
  <span class="b">${HL.icon('maximize')}</span></div>`;

// timeline dock: station dwell blocks, margin curve (timeline_nom_104.json), turn-back ticks, playhead
HL.dock = (el, { t = 0, storm = null, playing = false } = {}) => {
  const box = el.getBoundingClientRect();
  const W = box.width, H = box.height;
  el.innerHTML = `<div class="ctl"><div class="clock">${HL.hhmm(t)}<span class="label"> EVA</span></div>
    <div class="btns"><span class="btn ghost" style="padding:0 6px">${HL.icon('skip-back', 'sm')}</span><span class="btn" style="padding:0 6px">${HL.icon(playing ? 'pause' : 'play', 'sm')}</span><span class="btn ghost" style="padding:0 6px">${HL.icon('skip-forward', 'sm')}</span></div></div><svg class="chart"></svg>`;
  const svg = el.querySelector("svg.chart");
  const sw = W - 112, L = 16, Rr = sw - 16;
  const X = (min) => L + ((Rr - L) * min) / EVA_MIN;
  const top = 22, laneH = 18, cTop = 48, cBot = H - 22, mMax = 120;
  const Y = (mm) => cBot - ((cBot - cTop) * Math.min(mm, mMax)) / mMax;
  const tl = HL.D.timeline;
  // hour grid
  for (let h = 0; h <= 6.5; h += 0.5) {
    HL.svg('line', { x1: X(h * 60), x2: X(h * 60), y1: top - 6, y2: cBot, stroke: 'var(--color-card-border)', 'stroke-width': h % 1 ? 0.5 : 1 }, svg);
    if (h % 1 === 0) { const tx = HL.svg('text', { x: X(h * 60) + 3, y: H - 6, fill: 'var(--color-text-faint)', class: 'mono', style: 'font-size:var(--font-size-label)' }, svg); tx.textContent = HL.hhmm(h * 60); }
  }
  // legs lane
  HL.svg('line', { x1: X(0), x2: X(HL.m('route.nom_104.total_min')), y1: top + laneH / 2, y2: top + laneH / 2, stroke: 'var(--color-text-muted)', 'stroke-width': 2 }, svg);
  const arr = tl.filter((e) => e.event === 'arrive');
  for (const a of arr) {
    const lv = tl.find((e) => e.event === 'leave' && e.station === a.station);
    HL.svg('rect', { x: X(a.t_min), y: top, width: X(lv.t_min) - X(a.t_min), height: laneH, rx: 3, fill: 'color-mix(in srgb, var(--color-science) 45%, transparent)', stroke: 'var(--color-science)' }, svg);
    const tx = HL.svg('text', { x: X(a.t_min) + 4, y: top + 13, class: 'maplabel', fill: 'var(--color-text)' }, svg); tx.textContent = a.station;
  }
  // EVA limit
  HL.svg('line', { x1: X(EVA_MIN), x2: X(EVA_MIN), y1: top - 6, y2: cBot, stroke: 'var(--color-limit)', 'stroke-width': 1.5 }, svg);
  // turn-back ticks
  for (const e of tl.filter((e) => e.event === 'turn_back')) {
    HL.svg('line', { x1: X(e.t_min), x2: X(e.t_min), y1: top - 4, y2: top + laneH + 4, stroke: 'var(--color-caution)', 'stroke-width': 1.5 }, svg);
  }
  // margin curve (clipped at 120 min) with caution line at 10 min
  HL.svg('line', { x1: L, x2: Rr, y1: Y(10), y2: Y(10), stroke: 'var(--color-caution)', 'stroke-dasharray': '3 3', 'stroke-width': 1 }, svg);
  const pts = tl.filter((e) => e.event !== 'turn_back' && e.t_min <= HL.m('route.nom_104.total_min')).sort((a, b) => a.t_min - b.t_min);
  const d = pts.map((e, i) => `${i ? 'L' : 'M'}${X(e.t_min).toFixed(1)},${Y(e.margin_min).toFixed(1)}`).join('');
  HL.svg('path', { d: d + `L${X(pts.at(-1).t_min)},${cBot}L${X(0)},${cBot}Z`, fill: 'color-mix(in srgb, var(--color-safe) 35%, transparent)' }, svg);
  HL.svg('path', { d, fill: 'none', stroke: 'var(--color-safe)', 'stroke-width': 1.5 }, svg);
  const lab = HL.svg('text', { x: L + 2, y: cTop - 2, fill: 'var(--color-text-muted)', style: 'font-size:var(--font-size-label)' }, svg);
  lab.textContent = 'Margin (min, clipped at 120) ◐';
  if (storm) storm(svg, { X, Y, cTop, cBot, top, L, Rr });
  // playhead
  HL.svg('line', { x1: X(t), x2: X(t), y1: 4, y2: cBot + 4, stroke: 'var(--color-text)', 'stroke-width': 2 }, svg);
  HL.svg('rect', { x: X(t) - 5, y: 2, width: 10, height: 8, rx: 2, fill: 'var(--color-text)' }, svg);
  return { X, Y };
};
