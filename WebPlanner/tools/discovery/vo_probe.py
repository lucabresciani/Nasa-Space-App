"""X8 probe input: Navcam L/R frames during drives, from saved raw-image API JSON."""
import json, sys, math, re, statistics as st, collections
R = sys.argv[1]
drives = [(5073, 125, 2274, 2490), (5070, 125, 2082, 2274), (5069, 125, 1326, 2082), (5045, 125, 1194, 1326), (5041, 125, 558, 1194)]
mm = {f['properties']['RMC']: f['properties'] for f in json.load(open(f'{R}/mmgis_MSL_waypoints.json'))['features']}
def tup(s): return tuple(float(x) for x in s.strip('()').split(',')) if s else None
def dims(i):
    x, y, w, h = tup(i["subframe_rect"]); s = 1  # subframe_rect is in output pixels (verified on a JPG)
    return (int(w / s), int(h / s))
def cahvor_ok(i):
    c = i.get('camera_model_component_list') or ''
    return i.get('camera_model_type') == 'CAHVOR' and len(c.split(';')) == 6
summary = []
for sol, site, d0, d1 in drives:
    L = json.load(open(f'{R}/rawapi_msl_sol{sol}_NAV_LEFT_B.json'))['items']
    Rt = json.load(open(f'{R}/rawapi_msl_sol{sol}_NAV_RIGHT_B.json'))['items']
    allit = L + Rt
    during = [i for i in allit if i['site'] == site and d0 < i['drive'] < d1]
    at_end = [i for i in allit if i['site'] == site and i['drive'] == d1]
    print(f'\n=== sol {sol} drive {site}_{d0} -> {site}_{d1}  MMGIS dist_m {mm[f"{site}_{d1}"]["dist_m"]}')
    print(' all items L/R', len(L), len(Rt), '| during', len(during), '| at end stop', len(at_end))
    c = collections.Counter((i['instrument'][4], i['extended'].get('sample_type'), dims(i)) for i in during)
    for k, v in sorted(c.items()): print('   during', k, v)
    # pairs by sclk
    res = {}
    for st_ in sorted({(i['extended'].get('sample_type'), dims(i)) for i in during}):
        Ls = sorted([i for i in during if i['instrument'] == 'NAV_LEFT_B' and (i['extended'].get('sample_type'), dims(i)) == st_], key=lambda i: i['spacecraft_clock'])
        Rs = [i for i in during if i['instrument'] == 'NAV_RIGHT_B' and (i['extended'].get('sample_type'), dims(i)) == st_]
        pairs = []
        for l in Ls:
            m = [r for r in Rs if abs(r['spacecraft_clock'] - l['spacecraft_clock']) < 1.0]
            if m: pairs.append((l, m[0]))
        if not pairs: continue
        poses = []
        for l, r in pairs:
            key = l['drive']
            if not poses or poses[-1][0] != key: poses.append((key, tup(l['xyz']), l, r))
        sp = [math.dist(poses[k][1], poses[k + 1][1]) for k in range(len(poses) - 1)]
        dc = [poses[k + 1][0] - poses[k][0] for k in range(len(poses) - 1)]
        run = best = 1 if poses else 0
        for s in sp:
            run = run + 1 if s <= 2.0 else 1; best = max(best, run)
        dt = [poses[k + 1][2]['spacecraft_clock'] - poses[k][2]['spacecraft_clock'] for k in range(len(poses) - 1)]
        cam = all(cahvor_ok(l) and cahvor_ok(r) for l, r in pairs)
        att = all(l.get('attitude') and len(tup(l['attitude'])) == 4 for l, r in pairs)
        az = collections.Counter((round(float(l['extended']['mast_az'])), round(float(l['extended']['mast_el']))) for l, r in pairs).most_common(2)
        seq = collections.Counter(l['imageid'][23:31] for l, r in pairs).most_common(3)
        info = dict(sample=st_[0], dims=st_[1], pairs=len(pairs), poses=len(poses),
                    spacing_median_m=round(st.median(sp), 3) if sp else None, spacing_max_m=round(max(sp), 3) if sp else None,
                    drive_count_step=collections.Counter(dc).most_common(2), dt_median_s=round(st.median(dt), 1) if dt else None,
                    longest_run_le2m=best, cahvor_all=cam, attitude_all=att, mast_az_el=az, seq=seq)
        print('   PAIRS', info)
        res[f'{st_[0]}_{st_[1][0]}x{st_[1][1]}'] = info
    summary.append(dict(sol=sol, drive=f'{site}_{d0}->{site}_{d1}', dist_m=mm[f'{site}_{d1}']['dist_m'], n_during=len(during), pairs=res))
json.dump(summary, open(f'{R}/d0_vo_probe_summary.json', 'w'), indent=1, default=str)
