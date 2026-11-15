# 🏔️ WS8 brief — 3D first-person view

**Mission:** the 3D first-person replay on rails: eye-level terrain along the route with the shared HUD, honest about resolution, with an automatic 2D fallback.

**Human owner:** R (working with the agent) · **Feature:** F20 (decided, D11) · **SPEC:** §2.3 F20, §6.1 3D files

## Owns

`web/src/fp3d/`, `pipeline/export/terrain_chunks.py`, `far_mesh.py`, `ortho_chunks.py`, `web/public/data/fp3d/`

## Reads

WS1 `dem_1m.tif` and ortho; WS2 route; WS3 `horizon_ring.json` and station horizons; WS4 sun API; the WS7 HUD panel component and position interface.

## Produces

`fp3d/index.json`, `near/{i}_{j}.f32.gz` (256 × 256 at 1 m, corridor ≈ 300 m wide along the route), `near_tex/{i}_{j}.jpg`, `far.f32.gz` (8 m over the planning extent), and the `/hud3d` view.

## Tasks (target time)

1. **H2–G0 (dummy data):** Three.js scene shell (WebGL2), chunk loader, camera at 1.7 m on a test path, frame-rate meter, 2D fallback.
2. **After G0:** chunk export from the real DEM window and ortho; far mesh.
3. **H10–H16:** sky gradient, sun from the WS4 API at the simulated LMST, distance haze; far skyline ring; mount the WS7 HUD panel.
4. **H16–H23:** camera on the real route with the shared playback clock; performance pass (≥ 30 fps, ≤ 30 MB); loading screen.
5. **G2:** F20 on rails complete, else ship as "preview" or cut per SPEC.
6. **Sun morning:** one 2 s first-person capture for the video option.

## Tests

Eye height 1.7 ± 0.1 m above terrain along the route; rendered skyline at each station within 0.5° of the WS3 horizon; ≥ 30 fps on the reference laptop; fallback triggers without WebGL2 or under 20 fps; total download ≤ 30 MB.

## Don't

Use Unity or Cesium; hide the caption "1 m terrain: ridges under ~3 m are not resolved"; present the render as validation (the Navcam photo is the proof).
