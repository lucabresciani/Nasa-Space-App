"""Fetch all MSL raw-image items for given sols and cameras; save raw JSON pages; print bytes."""
import sys, json, gzip, urllib.request, os
out = sys.argv[1]; sols = sys.argv[2].split(','); cams = sys.argv[3].split(',')
total = 0
for sol in sols:
    for cam in cams:
        items = []; page = 0
        while True:
            u = (f"https://mars.nasa.gov/api/v1/raw_image_items/?order=date_taken+asc&per_page=200&page={page}"
                 f"&condition_1=msl:mission&condition_2={sol}:sol:in&search={cam}")
            req = urllib.request.Request(u, headers={'Accept-Encoding': 'gzip', 'User-Agent': 'discovery-script'})
            r = urllib.request.urlopen(req); raw = r.read(); total += len(raw)
            if r.headers.get('Content-Encoding') == 'gzip': raw = gzip.decompress(raw)
            d = json.loads(raw); items += d['items']
            if not d.get('more'): break
            page += 1
        fn = os.path.join(out, f'rawapi_msl_sol{sol}_{cam}.json')
        json.dump({'query': u.replace(f'page={page}', 'page=N'), 'total': d.get('total'), 'items': items}, open(fn, 'w'))
        print(sol, cam, 'items', len(items), 'api total', d.get('total'))
print('BYTES', total)
