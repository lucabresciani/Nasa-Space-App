# Mount Sharp terrain data - credits

- Play area heights (1 m) and HiRISE-derived textures/rocks: USGS Astrogeology Science Center, MSL Gale Merged DEM Mosaic 1 m v3 and MSL Gale Orthophoto Mosaic 25 cm v3, from MRO HiRISE imagery (NASA/JPL-Caltech/University of Arizona).
- Backdrop heights: MRO CTX stereo DTM D03_028269_1752 / K04_055011_1752 (USGS Astrogeology, controlled, geoid-adjusted; NASA/JPL-Caltech/MSSS) and the USGS Astrogeology MOLA-HRSC blended DEM v2, 200 m (Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2; MGS MOLA: NASA/GSFC, MOLA Science Team; MEX HRSC: ESA/DLR/FU Berlin), blended with the 1 m mosaic.
- Spawn position (HOMELINE pad, centroid of Curiosity's 2025-26 boxwork drive ends) and stations: Curiosity rover waypoints, NASA/JPL-Caltech MMGIS (MSL_waypoints.json).
- Elevations are metres relative to the MOLA areoid, minus the planetary curvature drop r^2/(2R), R = 3396190 m, measured from the spawn point.
- EVA map satellite layer (Resources/MarsPlayOrtho.jpg, 1 m/px over the play terrain): USGS Astrogeology MSL Gale HiRISE LRGB mosaic, 78 quads (MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif; HiRISE: NASA/JPL-Caltech/University of Arizona), via the HOMELINE web app's basemap tiles (zoom 16-17), resampled by Tools/ortho/build_play_ortho.py. Grey strips are where the mosaic has no colour.
