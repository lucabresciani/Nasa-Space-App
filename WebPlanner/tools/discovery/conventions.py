"""Attitude/CAHVOR convention checks, Navcam C height, LMST longitude fit, from saved raw-image API JSON."""
import json, sys, math, statistics as st, re
from datetime import datetime, timezone
R = sys.argv[1]
mm = {f['properties']['RMC']: f['properties'] for f in json.load(open(f'{R}/mmgis_MSL_waypoints.json'))['features']}
def tup(s): return tuple(float(x) for x in s.strip('()').split(','))
items = []
for sol in (5073, 5070, 5069, 5045, 5041):
    for cam in ('NAV_LEFT_B', 'NAV_RIGHT_B'):
        items += json.load(open(f'{R}/rawapi_msl_sol{sol}_{cam}.json'))['items']
print('== 1. attitude quaternion vs MMGIS yaw/pitch/roll at drive ends')
def euler_zyx(w, x, y, z):
    yaw = math.degrees(math.atan2(2*(w*z + x*y), 1 - 2*(y*y + z*z)))
    pitch = math.degrees(math.asin(max(-1, min(1, 2*(w*y - z*x)))))
    roll = math.degrees(math.atan2(2*(w*x + y*z), 1 - 2*(x*x + y*y)))
    return yaw, pitch, roll
for rmc in ('125_2490', '125_2274', '125_2082', '125_1326', '125_1194'):
    s, d = map(int, rmc.split('_'))
    it = [i for i in items if i['site'] == s and i['drive'] == d]
    q = tup(it[0]['attitude'])
    qs = {i['attitude'] for i in it}
    y, p, r = euler_zyx(*q)
    m = mm[rmc]
    print(f' {rmc}: q(w,x,y,z)={q} -> yaw {y:.2f} pitch {p:.2f} roll {r:.2f} | MMGIS yaw {m["yaw"]} pitch {m["pitch"]} roll {m["roll"]} | distinct q at stop: {len(qs)}')
print('== attitude varies during drive?')
dur = sorted([i for i in items if i['sol'] == 5069 and 1326 < i['drive'] < 2082 and i['instrument'] == 'NAV_LEFT_B' and i['extended']['sample_type'] == 'downsampled'], key=lambda i: i['drive'])
print(' distinct attitudes over', len(dur), 'TRAV frames:', len({i['attitude'] for i in dur}), '; distinct xyz:', len({i['xyz'] for i in dur}))
print(' first/last yaw:', [round(euler_zyx(*tup(i['attitude']))[0], 2) for i in (dur[0], dur[-1])])
print('== 2. CAHVOR frame: A vs mast az/el (rover frame +X fwd, +Y right, +Z down?)')
seen = set()
for i in items:
    if i['extended']['sample_type'] != 'full' or i['instrument'] != 'NAV_LEFT_B': continue
    az, el = float(i['extended']['mast_az']), float(i['extended']['mast_el'])
    key = (round(az), round(el))
    if key in seen or len(seen) >= 6: continue
    seen.add(key)
    c = i['camera_model_component_list'].split(';'); C, A = tup(c[0]), tup(c[1])
    pred = (math.cos(math.radians(el))*math.cos(math.radians(az)), math.cos(math.radians(el))*math.sin(math.radians(az)), -math.sin(math.radians(el)))
    print(f' {i["imageid"]} az {az:.1f} el {el:.1f}  A={tuple(round(a,3) for a in A)}  pred(Z down)={tuple(round(a,3) for a in pred)}  angle={math.degrees(math.acos(max(-1,min(1,sum(a*b for a,b in zip(A,pred)))))):.2f} deg  C={C}')
print('== 3. Navcam -C_z (height above rover-frame origin, Z down)')
full = [i for i in items if i['extended']['sample_type'] == 'full']
vals = []
for i in full:
    C = tup(i['camera_model_component_list'].split(';')[0]); vals.append((-C[2], float(i['extended']['mast_el']), i['imageid']))
for v in sorted(vals, key=lambda v: abs(v[1]))[:3] + sorted(vals, key=lambda v: v[1])[:1]:
    print(f' {v[2]} el {v[1]:.1f}  -C_z {v[0]:.3f} m')
allc = [-tup(i['camera_model_component_list'].split(';')[0])[2] for i in items]
nh = [v[0] for v in vals if abs(v[1]) < 12]
print(f' all {len(allc)} frames: -C_z range {min(allc):.3f}-{max(allc):.3f}; full frames |el|<12: n={len(nh)} median {st.median(nh) if nh else None}')
print('== 4. LMST: label vs Mars24 at candidate longitudes')
def mars24_lmst_h(dt, lon_e):
    jd_ut = dt.timestamp()/86400 + 2440587.5
    # TT-UTC = 69.184 s (leap seconds 37 + 32.184)
    jd_tt = jd_ut + 69.184/86400
    d = jd_tt - 2451545.0
    M = math.radians((19.3871 + 0.52402073*d) % 360)
    alpha = 270.3871 + 0.524038496*d
    pbs = sum(A*math.cos(math.radians(0.985626*d/t + p)) for A, t, p in ((0.0071,2.2353,49.409),(0.0057,2.7543,168.173),(0.0039,1.1177,191.837),(0.0037,15.7866,21.736),(0.0021,2.1354,15.704),(0.0020,2.4694,95.528),(0.0018,32.8493,49.095)))
    nu_m = (10.691 + 3.0e-7*d)*math.sin(M) + 0.623*math.sin(2*M) + 0.050*math.sin(3*M) + 0.005*math.sin(4*M) + 0.0005*math.sin(5*M) + pbs
    msd = (((jd_tt - 2451549.5)/1.0274912517) + 44796.0 - 0.0009626)
    mst = (24*msd) % 24
    lmst = (mst - lon_e*24/360) % 24  # lon_e as west longitude convention below
    return mst
def lmst_label_h(s):
    m = re.search(r'M(\d+):(\d+):([\d.]+)', s); return int(m[1]) + int(m[2])/60 + float(m[3])/3600
pts = []
for i in items:
    lm = i['extended'].get('lmst')
    if not lm: continue
    dt = datetime.strptime(i['date_taken'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
    pts.append((mars24_lmst_h(dt, 0), lmst_label_h(lm)))
def err_s(lon):
    e = []
    for mst, lab in pts:
        lm = (mst + lon/15) % 24  # east longitude: LMST = MST + lon_E/15
        x = (lab - lm + 12) % 24 - 12; e.append(x*3600)
    return e
best = min((abs(st.median(err_s(l/10000))), l/10000) for l in range(1370000, 1376000, 5))[1]
for lon in (best, 137.39, 137.4417):
    e = err_s(lon); print(f' lon {lon:.4f}E: n={len(e)} median err {st.median(e):+.2f} s, median|err| {st.median([abs(x) for x in e]):.2f} s, max|err| {max(abs(x) for x in e):.2f} s')
