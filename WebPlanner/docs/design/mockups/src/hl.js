// D7 mockup drafts: shared data + map painter. Not production code; WS15/WS16 build the real thing.
// Every number shown comes from web/public/data (manifest.json, pad.json, stations.json, timeline/route files,
// field PNGs). The map is painted from our own published field PNGs (slope, t_home, o2_home, cell state):
// no imagery, no copied art.
const DATA = '../../../../web/public/data/';
const SPRITE = '../../../../web/src/ui/icons/sprite.svg';
const R_MARS = 3396190; // m, DESIGN U1 (Mars radius 3,396.19 km)
const M_PER_DEG = (2 * Math.PI * R_MARS) / 360;

const HL = (window.HL = {});
HL.icon = (id, cls = '') => `<svg class="i ${cls}"><use href="${SPRITE}#i-${id}"/></svg>`;
HL.css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
HL.rgb = (name) => {
  const h = HL.css(name).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

// ---------- data ----------
async function json(p) { return (await fetch(DATA + p)).json(); }
async function raster(p, scale) {
  const blob = await (await fetch(DATA + p)).blob();
  const bm = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bm.width, bm.height);
  const x = c.getContext('2d');
  x.drawImage(bm, 0, 0);
  const d = x.getImageData(0, 0, bm.width, bm.height).data;
  const v = new Float32Array(bm.width * bm.height);
  for (let i = 0; i < v.length; i++) v[i] = d[i * 4 + 3] === 0 ? NaN : (d[i * 4] * 256 + d[i * 4 + 1]) * scale;
  return { w: bm.width, h: bm.height, v };
}
HL.load = async (want = {}) => {
  const [manifest, stations, pad, route, timeline, index] = await Promise.all([
    json('manifest.json'), json('stations.json'), json('pad.json'), json('route_nom_104.geojson'),
    json('timeline_nom_104.json'), json('fields/index.json'),
  ]);
  const D = { manifest, stations, pad, route, timeline, index };
  const fieldGrid = { bounds: index.bounds, w: index.width, h: index.height };
  const cs = await json('terrain/cellstate.json');
  const jobs = {
    slope: ['fields/shared/slope.png', 0.01, fieldGrid],
    t_nom: ['fields/nom_104/t_home.png', 0.1, fieldGrid],
    cell: ['terrain/cellstate.png', 1, { bounds: cs.bounds, w: cs.width, h: cs.height }],
  };
  if (want.variants) { jobs.t_con = ['fields/con_104/t_home.png', 0.1, fieldGrid]; jobs.t_opt = ['fields/opt_104/t_home.png', 0.1, fieldGrid]; }
  if (want.o2) jobs.o2 = ['fields/nom_104/o2_home.png', 0.01, fieldGrid];
  if (want.pointer) {
    const m = index.fields['nom_104/pointer'];
    jobs.ptr = ['fields/nom_104/pointer.png', 1, { bounds: m.bounds, w: m.width, h: m.height }];
    D.stencil = m.stencil;
  }
  D.f = {};
  await Promise.all(Object.entries(jobs).map(async ([k, [p, s, g]]) => { D.f[k] = Object.assign(await raster(p, s), { bounds: g.bounds }); }));
  HL.D = D;
  return D;
};

// manifest value; throws when missing so no number is ever invented
HL.m = (key) => {
  const e = HL.D.manifest[key];
  if (e === undefined) throw new Error('manifest key missing: ' + key);
  return typeof e === 'object' && e !== null && 'value' in e ? e.value : e;
};
HL.chip = (kind) => {
  const g = { real: '●', modelled: '◐', sim: '○', live: '◆', visual: '✦' }[kind];
  const t = { real: 'Real', modelled: 'Modelled', sim: 'Simulated', live: 'Live', visual: 'Visual' }[kind];
  return `<span class="chip ${kind === 'live' ? 'live' : ''} ${kind === 'sim' ? 'sim' : ''}" title="${t}">${g}</span>`;
};
HL.fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d).replace('-', '−'));
HL.hhmm = (min) => { const m = Math.round(min); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// ---------- projection ----------
// view = { lon, lat, mpp (metres per screen px), W, H }
HL.view = (lon, lat, mpp, W, H) => {
  const k = Math.cos((lat * Math.PI) / 180);
  return {
    lon, lat, mpp, W, H,
    px: (lo, la) => [W / 2 + ((lo - lon) * M_PER_DEG * k) / mpp, H / 2 - ((la - lat) * M_PER_DEG) / mpp],
    ll: (x, y) => [lon + ((x - W / 2) * mpp) / (M_PER_DEG * k), lat - ((y - H / 2) * mpp) / M_PER_DEG],
  };
};
function sampler(r) {
  const [x0, y0, x1, y1] = r.bounds; // lon min, lat min, lon max, lat max
  return (lo, la) => {
    const fx = ((lo - x0) / (x1 - x0)) * r.w - 0.5, fy = ((y1 - la) / (y1 - y0)) * r.h - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix >= r.w - 1 || iy >= r.h - 1) return NaN;
    const tx = fx - ix, ty = fy - iy, i = iy * r.w + ix;
    const a = r.v[i], b = r.v[i + 1], c = r.v[i + r.w], d = r.v[i + r.w + 1];
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
      return r.v[Math.round(fy) * r.w + Math.round(fx)];
    }
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  };
}
HL.sample = (key, lo, la) => sampler(HL.D.f[key])(lo, la);

// ---------- map painter ----------
// opts.mode: 'bands' | 'margin' | 'base'; opts.dim: 0..1 overlay strength; opts.margin: {t,o2Left,reserve,tau,tEva}
HL.paint = (canvas, view, opts = {}) => {
  const { W, H } = view;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  const bg = HL.rgb('--color-bg'), faint = HL.rgb('--color-text-faint'), shadow = HL.rgb('--color-shadow');
  const safe = HL.rgb('--color-safe'), caution = HL.rgb('--color-caution'), limit = HL.rgb('--color-limit'), unk = HL.rgb('--color-unknown');
  const aMin = parseFloat(HL.css('--overlay-opacity-min')), aMax = parseFloat(HL.css('--overlay-opacity-max'));
  const dim = opts.dim ?? 1;
  const S = sampler(HL.D.f.slope), T = sampler(HL.D.f.t_nom), C = sampler(HL.D.f.cell);
  const TC = HL.D.f.t_con && sampler(HL.D.f.t_con), TO = HL.D.f.t_opt && sampler(HL.D.f.t_opt), O = HL.D.f.o2 && sampler(HL.D.f.o2);
  const val = new Float32Array(W * H), valO = new Float32Array(W * H);
  const mg = opts.margin;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, [lo, la] = view.ll(x + 0.5, y + 0.5);
      const s = S(lo, la);
      let c;
      if (Number.isNaN(s)) c = bg.slice();
      else { // slope as a quiet relief stand-in: flat = bg, steep = toward text-faint; tinted with the shadow token
        const k = Math.min(1, s / 32) * 0.55;
        c = [0, 1, 2].map((j) => bg[j] + (faint[j] - bg[j]) * k + (shadow[j] - bg[j]) * 0.15);
      }
      const cell = Math.round(C(lo, la));
      const t = T(lo, la);
      let fill = null, a = 0;
      if (cell === 2) { // unknown: grey hatch in screen space
        if ((x + y) % 6 < 2) { fill = unk; a = aMax; }
        val[i] = NaN;
      } else if (opts.mode === 'bands') {
        const tc = TC ? TC(lo, la) : NaN;
        val[i] = t; valO[i] = TO ? TO(lo, la) : NaN;
        if (tc <= 30) { fill = safe; a = aMax; }
        else if (t <= 30) { fill = safe; a = (aMin + aMax) / 2; }
        else if (t <= 60 && opts.budget === 60) { fill = safe; a = aMin; }
      } else if (opts.mode === 'margin' && !Number.isNaN(t)) {
        const o2 = O(lo, la);
        const m = Math.min((mg.o2Left - mg.reserve - o2) / 1.35, mg.tau - t, mg.tEva - mg.t - t);
        val[i] = m;
        fill = m < 0 ? limit : m < 10 ? caution : safe;
        a = (aMin + aMax) / 2;
      } else val[i] = NaN;
      if (fill) { a *= dim; c = c.map((v, j) => v * (1 - a) + fill[j] * a); }
      px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
    }
  }
  // crisp edges (screen-space, ~1.5 px): nominal solid, optimistic dashed; margin zero line in limit
  const edge = (arr, th, col, dashed, alpha) => {
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const i = y * W + x, a = arr[i], b = arr[i + 1], d = arr[i + W];
      if (Number.isNaN(a)) continue;
      const cross = (!Number.isNaN(b) && (a <= th) !== (b <= th)) || (!Number.isNaN(d) && (a <= th) !== (d <= th));
      if (!cross) continue;
      if (dashed && ((x + y) % 10) >= 5) continue;
      for (const j of [i, i + 1]) {
        const al = alpha * dim;
        for (let k = 0; k < 3; k++) px[j * 4 + k] = px[j * 4 + k] * (1 - al) + col[k] * al;
      }
    }
  };
  if (opts.mode === 'bands') { edge(val, 30, safe, false, 1); edge(valO, 30, safe, true, 0.9); edge(val, 60, safe, false, 0.45); }
  if (opts.mode === 'margin') { edge(val, 0, limit, false, 1); edge(val, 10, caution, false, 0.8); }
  ctx.putImageData(img, 0, 0);
  return { val };
};

// way home from (lon, lat) by following the published pointer field (same rule as web/src/hud/wayhome.ts)
HL.wayHome = (lon, lat) => {
  const r = HL.D.f.ptr, st = HL.D.stencil, [x0, y0, x1, y1] = r.bounds;
  let col = Math.floor(((lon - x0) / (x1 - x0)) * r.w), row = Math.floor(((y1 - lat) / (y1 - y0)) * r.h);
  const pts = [[lon, lat]];
  for (let n = 0; n < 20000; n++) {
    const k = r.v[row * r.w + col];
    if (Number.isNaN(k)) break;
    row += st[k][0]; col += st[k][1];
    pts.push([x0 + ((col + 0.5) / r.w) * (x1 - x0), y1 - ((row + 0.5) / r.h) * (y1 - y0)]);
  }
  return pts;
};

// ---------- SVG overlay helpers ----------
HL.svg = (tag, attrs = {}, parent) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
HL.path = (view, coords) => coords.map(([lo, la], i) => { const [x, y] = view.px(lo, la); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('');
HL.line = (svg, view, coords, { color = 'var(--color-text)', width = 2, casing = true, dash = null, opacity = 1 } = {}) => {
  const d = HL.path(view, coords);
  if (casing) HL.svg('path', { d, fill: 'none', stroke: 'var(--color-bg)', 'stroke-width': width + 2.5, 'stroke-opacity': 0.7 * opacity, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  return HL.svg('path', { d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-opacity': opacity, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(dash ? { 'stroke-dasharray': dash } : {}) }, svg);
};
// map pill label (U13): yellow mono uppercase on black 70%
HL.label = (svg, x, y, text, { selected = false, anchor = 'left', color = 'var(--color-select)' } = {}) => {
  const w = text.length * 6.8 + 8, h = 18;
  const gx = anchor === 'left' ? x + 12 : anchor === 'right' ? x - 12 - w : x - w / 2;
  const gy = anchor === 'below' ? y + 12 : y - h / 2;
  const g = HL.svg('g', {}, svg);
  HL.svg('rect', { x: gx, y: gy, width: w, height: h, rx: 4, fill: 'var(--color-label-pill)', ...(selected ? { stroke: 'var(--color-select)', 'stroke-width': 1 } : {}) }, g);
  const t = HL.svg('text', { x: gx + 4, y: gy + 13, class: 'maplabel', fill: color }, g);
  t.textContent = text;
  return g;
};
HL.station = (svg, view, s, { selected = false, dim = false, label = true, anchor } = {}) => {
  const [x, y] = view.px(s.lon, s.lat);
  const rw = 1.5 + (s.value - 0.4) * 6; // ring thickness encodes science value (stations.json value)
  const g = HL.svg('g', { opacity: dim ? 0.45 : 1 }, svg);
  if (selected) HL.svg('circle', { cx: x, cy: y, r: 14, fill: 'none', stroke: 'var(--color-select)', 'stroke-width': 2 }, g);
  HL.svg('circle', { cx: x, cy: y, r: 7, fill: 'var(--color-bg)', 'fill-opacity': 0.6, stroke: 'var(--color-science)', 'stroke-width': rw.toFixed(2) }, g);
  HL.svg('circle', { cx: x, cy: y, r: 2.5, fill: 'var(--color-science)' }, g);
  if (label) HL.label(g, x, y, s.id, { selected, anchor });
  return [x, y];
};
HL.pad = (svg, view, lon, lat, { label = 'PAD', ghost = false, selected = false } = {}) => {
  const [x, y] = view.px(lon, lat);
  const g = HL.svg('g', { opacity: ghost ? 0.5 : 1 }, svg);
  if (selected) HL.svg('circle', { cx: x, cy: y, r: 17, fill: 'none', stroke: 'var(--color-select)', 'stroke-width': 2 }, g);
  HL.svg('rect', { x: x - 11, y: y - 11, width: 22, height: 22, rx: 5, fill: 'var(--color-bg)', stroke: 'var(--color-text)', 'stroke-width': 1.5, ...(ghost ? { 'stroke-dasharray': '3 3' } : {}) }, g);
  const u = HL.svg('use', { href: `${SPRITE}#i-pad`, x: x - 8, y: y - 8, width: 16, height: 16, color: 'var(--color-text)' }, g);
  u.style.color = 'var(--color-text)';
  if (label) HL.label(g, x, y, label, { selected, anchor: 'below' });
  return [x, y];
};
HL.scalebar = (el, view) => {
  const target = view.mpp * 120;
  const nice = [100, 200, 250, 500, 1000, 2000].reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
  el.innerHTML = `${nice >= 1000 ? nice / 1000 + ' km' : nice + ' m'}<i style="width:${(nice / view.mpp).toFixed(0)}px"></i>`;
};
HL.ready = () => { document.documentElement.dataset.ready = '1'; };
