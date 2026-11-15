# Mount Sharp terrain data - credits

- Play area heights and HiRISE-derived textures/rocks: USGS Astrogeology Science Center, MSL Gale Merged DEM Mosaic 1 m v3 and MSL Gale Orthophoto Mosaic 25 cm v3, from MRO HiRISE imagery (NASA/JPL-Caltech/University of Arizona).
- The play area is 6.1 km x 6.1 km (6144 x 6144 pixels of the 1 m DEM: the original 4096 plus 1024 on every side) at 1.5 m per height post, resampled from the 1 m DEM by area averaging (Unity heightmaps hold at most 4097 posts). Built by Tools/mountsharp/build_play_terrain.py, which documents every step. On the original 4 km the resampled heights differ from the 1 m posts by 1.5 cm (median), 20 cm (99%).
- Backdrop heights: MRO CTX stereo DTM D03_028269_1752 / K04_055011_1752 (USGS Astrogeology, controlled, geoid-adjusted; NASA/JPL-Caltech/MSSS) and the USGS Astrogeology MOLA-HRSC blended DEM v2, 200 m (Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2; MGS MOLA: NASA/GSFC, MOLA Science Team; MEX HRSC: ESA/DLR/FU Berlin), blended with the 1 m mosaic.
- Spawn position (HOMELINE pad, centroid of Curiosity's 2025-26 boxwork drive ends) and stations: Curiosity rover waypoints, NASA/JPL-Caltech MMGIS (MSL_waypoints.json).
- Elevations are metres relative to the MOLA areoid, minus the planetary curvature drop r^2/(2R), R = 3396190 m, measured from the spawn point.
- EVA map satellite layer (Resources/MarsPlayOrtho.jpg, 1.5 m/px over the play terrain): USGS Astrogeology MSL Gale HiRISE LRGB mosaic, 78 quads (MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif; HiRISE: NASA/JPL-Caltech/University of Arizona), read from the mosaic's 1 m overview and area-averaged by Tools/ortho/build_play_ortho_cog.py. Grey strips are where the mosaic has no colour.

## Derived, not measured

- Outer 144 m of the play area: the heights are blended into the 32 m backdrop surface (weight smoothstep(distance / 144 m)) so that the border meets the backdrop without a crack, and the ground cover fades into the backdrop's. There the backdrop differs from the 1 m DEM by 0.9 m (median), 4.8 m (95%), 23 m at most.
- Ground cover (play_splat.png: dust, gravel, bedrock, dark sand): the original map is kept in the original 4 km, 144 m or more inside its border. Everywhere else in the play area it is derived by rule, not mapped: each texel gets the average ground cover that the original map has, inside the original area, for the same slope class (1 m DEM, 5 px mean, 2.5 degree classes) and the same HiRISE image brightness class. Applied to the original area, the rule gives the original map's dominant layer on 85% of it (dust 84%, gravel 84%, bedrock 91%, dark sand 72% of each layer's own texels).
- Boulders (rocks_hirise.csv): mapped on HiRISE in the original 4 km only. The added ring has no mapped boulders and none were invented.
