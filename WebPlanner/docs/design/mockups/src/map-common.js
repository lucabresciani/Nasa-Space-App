// D7 mockup drafts: map compositions shared by the screens (route, stations, hover, legend).

// fit the pad and the route stations into the map element
HL.fitView = (el, pad = 1.12, extra = []) => {
  const r = el.getBoundingClientRect();
  const pts = [[HL.D.pad.pad.lon, HL.D.pad.pad.lat], ...HL.D.stations.map((s) => [s.lon, s.lat]), ...extra];
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const lon = (Math.min(...lons) + Math.max(...lons)) / 2, lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const v0 = HL.view(lon, lat, 1, r.width, r.height);
  const [ax, ay] = v0.px(Math.min(...lons), Math.max(...lats)), [bx, by] = v0.px(Math.max(...lons), Math.min(...lats));
  const mpp = Math.max((bx - ax) / r.width, (by - ay) / r.height) * pad * 1.0;
  return HL.view(lon, lat, mpp, Math.round(r.width), Math.round(r.height));
};

// route legs; opts.t: legs before t solid, coming legs at 50% (U4); opts.dim: dim all except legs in opts.focus
HL.drawRoute = (svg, view, { t = null, focus = null, opacity = 1, color = 'var(--color-text)' } = {}) => {
  for (const f of HL.D.route.features) {
    const p = f.properties;
    let op = opacity;
    if (t !== null && p.t_start_min > t) op *= 0.5;
    if (focus && !focus.includes(p.leg)) op *= 0.35;
    if (t !== null && p.t_start_min <= t && p.t_end_min > t) {
      // split the active leg at the crew position
      const i = p.times_min.findIndex((x) => x > t);
      HL.line(svg, view, f.geometry.coordinates.slice(0, i), { color, width: 2.5, opacity: op });
      HL.line(svg, view, f.geometry.coordinates.slice(i - 1), { color, width: 2.5, opacity: op * 0.5 });
      continue;
    }
    HL.line(svg, view, f.geometry.coordinates, { color, width: focus && focus.includes(p.leg) ? 3 : 2.5, opacity: op });
  }
};
HL.drawStations = (svg, view, { selected = null, dim = false, anchors = {} } = {}) => {
  for (const s of HL.D.stations) HL.station(svg, view, s, { selected: s.id === selected, dim: dim && s.id !== selected, anchor: anchors[s.id] });
};

// crew / point position on the route at plan time t (route_nom_104.geojson times_min)
HL.positionAt = (t) => {
  for (const f of HL.D.route.features) {
    const p = f.properties, c = f.geometry.coordinates;
    if (t >= p.t_start_min && t <= p.t_end_min) {
      const i = Math.max(1, p.times_min.findIndex((x) => x >= t));
      const t0 = p.times_min[i - 1], t1 = p.times_min[i], k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * k, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * k];
    }
  }
  // dwelling: last coordinate of the last leg that ended before t
  const done = HL.D.route.features.filter((f) => f.properties.t_end_min <= t).at(-1);
  return done ? done.geometry.coordinates.at(-1) : [HL.D.pad.pad.lon, HL.D.pad.pad.lat];
};

HL.thread = (svg, view, lon, lat, color = 'var(--color-safe)') => {
  const pts = HL.wayHome(lon, lat);
  HL.line(svg, view, pts, { color, width: 2, dash: '6 4' });
  return pts;
};

// hover on the route at a timeline checkpoint: crosshair, thread home, tooltip with the timeline's own numbers
HL.hoverAtTimeline = (svg, mapEl, view, tMin) => {
  const e = HL.D.timeline.find((x) => x.t_min === tMin);
  const [lo, la] = HL.positionAt(tMin);
  HL.thread(svg, view, lo, la);
  const [x, y] = view.px(lo, la);
  HL.svg('line', { x1: x - 12, x2: x + 12, y1: y, y2: y, stroke: 'var(--color-select)', 'stroke-width': 1.5 }, svg);
  HL.svg('line', { x1: x, x2: x, y1: y - 12, y2: y + 12, stroke: 'var(--color-select)', 'stroke-width': 1.5 }, svg);
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.style.left = `${x + 14}px`; tip.style.top = `${y + 10}px`;
  tip.innerHTML = `${HL.icon('thread-home', 'sm')} Home in <b class="mono">${HL.fmt(e.t_home_min, 0)} min</b> · margin <b class="mono" style="color:var(--color-safe)">${HL.fmt(e.margin_min, 0)} min</b> (${e.margin_binding}) ${HL.chip('modelled')}`;
  mapEl.appendChild(tip);
  const slope = HL.sample('slope', lo, la), th = HL.sample('t_nom', lo, la);
  const ro = document.getElementById('readout');
  if (ro) ro.innerHTML = `<span><b>LON</b>${lo.toFixed(4)}°</span><span><b>LAT</b>${la.toFixed(4)}°</span><span><b>ELEV</b>— m</span><span><b>SLOPE</b>${HL.fmt(slope)}°</span><span><b>HOME</b>${HL.fmt(th)} min</span><span>${HL.chip('modelled')}</span>`;
  return [x, y];
};

HL.legendBands = () => `
  <div class="label" style="margin-bottom:2px">Homeline · 30 min ${HL.chip('modelled')}</div>
  <div class="li"><span class="sw" style="background:color-mix(in srgb, var(--color-safe) 55%, transparent)"></span>Conservative (denser)</div>
  <div class="li"><span class="sw" style="background:color-mix(in srgb, var(--color-safe) 45%, transparent);box-shadow:inset 0 0 0 1.5px var(--color-safe)"></span>Nominal (solid edge)</div>
  <div class="li"><span class="ln" style="border-top-style:dashed;border-color:var(--color-safe)"></span>Optimistic (dashed edge)</div>
  <div class="li"><span class="ln" style="border-color:color-mix(in srgb, var(--color-safe) 45%, transparent)"></span>60 min nominal (edge only at 30)</div>
  <div class="li"><span class="sw hatch"></span>No 1 m terrain</div>
  <div class="li"><span class="ln" style="border-color:var(--color-text)"></span>Route · <span class="ln" style="border-top-style:dashed;border-color:var(--color-safe);width:14px"></span>thread home</div>
  <div class="li faint">Relief: slope field (stand-in, no imagery)</div>`;
