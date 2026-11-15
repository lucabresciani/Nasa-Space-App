import sys, math, rasterio, numpy as np
from rasterio.windows import from_bounds
url, ovl = sys.argv[1], int(sys.argv[2])
k = math.pi/180*3396190
W,E,S,N = 137.37*k, 137.42*k, -4.82*k, -4.77*k
with rasterio.open(url, OVERVIEW_LEVEL=ovl) as d:
    win = from_bounds(W,S,E,N, d.transform)
    a = d.read(1, window=win, boundless=True, fill_value=0)
    m = d.read_masks(1, window=win, boundless=True)
    valid = (m>0) & (a != (d.nodata if d.nodata is not None else -1e30))
    print(url.split('/')[-1], 'ovl', ovl, 'res %.2f'%d.res[0], 'focus px', a.shape, 'valid %.1f%%'%(100*valid.mean()))
