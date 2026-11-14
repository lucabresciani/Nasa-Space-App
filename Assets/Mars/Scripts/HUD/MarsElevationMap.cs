using System;
using System.Collections.Generic;
using NasaSpaceApp.Science;
using Unity.Collections;
using UnityEngine;

namespace NasaSpaceApp.HUD
{
    /// <summary>
    /// Real elevation map of the scene terrain (the MSL Gale HiRISE 1 m DEM around Mount Sharp), built once at runtime into
    /// a Texture2D for the compass dial: a muted hypsometric tint (dark, desaturated ochre, normalized to the terrain's
    /// min..max so white HUD ink stays readable), a soft multi-directional hillshade, contour lines every
    /// <see cref="ContourInterval"/> m and brighter index contours every <see cref="IndexInterval"/> m.
    ///
    /// Elevations are metres above the MOLA areoid when the scene has a <see cref="MarsGeoReference"/> (terrain height plus
    /// datum and the baked curvature drop, so the contours are the real ones), else plain world y.
    ///
    /// The build is incremental and allocation-bounded: <see cref="Tick"/> shades <see cref="RowsPerTick"/> texel rows per
    /// call (heights read in row blocks with TerrainData.GetInterpolatedHeights into a reused buffer), then derives the mip
    /// chain a block at a time and uploads once (Apply without mip regeneration, CPU copy released). Texture: RGBA32 sRGB,
    /// bilinear, clamp, mipmaps, about 2 m per texel, at most 2048 x 2048. The outermost texel ring is transparent, so
    /// clamped lookups outside the terrain read as "no data".
    ///
    /// Several terrain tiles of one grid are merged (tiles that touch the primary tile and share its height-post spacing);
    /// a much coarser terrain such as the 32 m Gale backdrop is left out. With no terrain the map retries a few times and
    /// then reports <see cref="MapState.NoTerrain"/>.
    ///
    /// The same pass also builds the layers of the full map screen (<see cref="MapView"/>), from the same height blocks:
    /// <list type="bullet">
    /// <item><see cref="BaseTexture"/>: neutral grey hillshade, full resolution (the base under the overlays).</item>
    /// <item><see cref="SlopeTexture"/>: traversability, HOMELINE F2/F3 slope classes 0-10 / 10-17 / 17-20 / &gt;20 deg
    /// (no-go), slope from central differences over two texels (about 4 m), the steepest of each 2x2 block. Half
    /// resolution.</item>
    /// <item><see cref="UnitTexture"/>: geologic units of Mount Sharp's flat-lying stratigraphy, with the same rule the
    /// editor uses to assign rock classes (MarsRockScience): each layered class (not caprock, abundance &gt; 0) spans the
    /// MOLA elevations of its analog samples (<see cref="RockDatabase"/>) plus <see cref="BandMarginM"/>, and fades by e every
    /// <see cref="BandFalloffM"/> m beyond; a texel takes the class of highest abundance x fade. Where every band has faded
    /// out (elevations no sample constrains) the texel stays clear. Half resolution, only with a geo-reference.</item>
    /// </list>
    /// </summary>
    public sealed class MarsElevationMap
    {
        public enum MapState { Searching, NoTerrain, Building, Mipmaps, Ready }

        /// <summary>Slope class limits in degrees (HOMELINE F2/F3): 0-10, 10-17, 17-20, above 20 = no-go.</summary>
        public static readonly float[] SlopeLimitsDeg = { 10f, 17f, 20f };
        public const int SlopeClassCount = 4;

        // Stratigraphic band rule, the values of MarsRockScience (BandMarginM, BandFalloffM).
        public const float BandMarginM = 15f;
        public const float BandFalloffM = 20f;
        private const float MinUnitFade = 0.15f;       // fainter than this: no unit drawn
        private const int MaxUnits = 16;
        private const float BaseGrey = 70f;            // sRGB grey of flat ground in the base hillshade

        public const int MaxSize = 2048;
        public const float TargetMetersPerPixel = 2f;
        public const int RowsPerTick = 8;              // texel rows shaded per Tick (about 16k texels, a few ms in the editor)
        private const int MipPixelsPerTick = 32768;    // mip texels derived per Tick
        private const int CoarseSamples = 8192;        // total samples of the min/max + slope survey
        private const int MaxTiles = 16;
        private const int MaxRetries = 5;
        private const float RetryInterval = 2f;
        private const int IndexEvery = 5;              // index contour every 5th contour
        private const float MinContourSpacingTexels = 6f;  // at the median slope; denser picks the next interval
        private const float ShadeExaggeration = 1.25f;
        private const float ShadeStrength = 0.9f;
        private const float MinorStrength = 0.22f, IndexStrength = 0.50f;
        private const float ProgressRowsShare = 0.85f;

        private static readonly float[] Intervals = { 5f, 10f, 20f, 50f, 100f, 200f, 500f };

        // Hypsometric ramp, sRGB 0..255: dark, desaturated ochre, low to high.
        private static readonly float[] RampT = { 0f, 0.30f, 0.65f, 1f };
        private static readonly Color32[] RampC =
        {
            new Color32(30, 25, 22, 255), new Color32(52, 40, 31, 255), new Color32(78, 60, 44, 255), new Color32(106, 90, 72, 255)
        };
        private const float ContourR = 226f, ContourG = 214f, ContourB = 196f;

        // Multi-directional light (azimuth clockwise from north, altitude 45 deg): NW main, W and N fill.
        private static readonly float[] LightAz = { 315f, 270f, 0f };
        private static readonly float[] LightW = { 0.5f, 0.25f, 0.25f };

        private struct Tile
        {
            public TerrainData Data;
            public float X0, Z0, SizeX, SizeZ, Y;
            public int Ia, Ib, Ra, Rb;    // covered texel columns/rows (inclusive)
            public float Du, Dv;          // normalized step per texel
        }

        private readonly Tile[] tiles = new Tile[MaxTiles];
        private int tileCount;
        private MarsGeoReference geo;
        private bool hasGeo;

        private Texture2D texture;
        private int width, height;
        private float x0, z0, mpp, invWm, invHm;
        private float minElevation, maxElevation;
        private float contourInterval = Intervals[0];

        private float[,] batch;       // GetInterpolatedHeights target, [rows, width]
        private float[] heights;      // elevations of the current block (+1 row above and below), row-major
        private Color32[] pixels;     // shaded block / mip destination
        private Color32[] mipSource;  // source rows of the previous mip level
        private float[] lutR, lutG, lutB;
        private float[] lightX, lightY;
        private float lightZ;
        private bool batchOk = true;

        // Map-screen layers (see the class summary).
        private struct Unit
        {
            public string ClassId;
            public float Lo, Hi, Abundance;   // analog sample elevations (MOLA m), class abundance
            public Color32 Rgb;
        }

        private Texture2D baseTexture, slopeTexture, unitTexture;
        private int ow, oh;                   // overlay size: half resolution, rounded up
        private Color32[] basePixels;         // grey block, like pixels
        private Color32[] slopePixels, unitPixels;  // overlay block rows
        private byte[] slopeAcc;              // steepest slope class per overlay texel of the block (255 = no data)
        private float[] elevSum;              // elevation sum per overlay texel of the block
        private byte[] elevN;                 // contributing texels (0..4)
        private readonly Color32[] slopeTexel = new Color32[SlopeClassCount];
        private readonly int[] slopeTexels = new int[SlopeClassCount];
        private float tan2A, tan2B, tan2C;    // squared tangents of the slope limits
        private readonly Unit[] units = new Unit[MaxUnits];
        private readonly int[] unitTexels = new int[MaxUnits];
        private int unitCount;
        private float unitAlpha;              // texel alpha of a unit at full weight (0..255)

        private readonly Texture2D[] mipJobs = new Texture2D[4];
        private int mipJobCount, mipJob;

        private int nextRow;
        private int mipLevel, mipRow;
        private long mipDone, mipTotal;
        private int retries;
        private float retryTimer;

        public MapState State { get; private set; } = MapState.Searching;
        public bool IsReady => State == MapState.Ready;

        /// <summary>0..1 build progress (rows, then mip chain).</summary>
        public float Progress
        {
            get
            {
                switch (State)
                {
                    case MapState.Ready: return 1f;
                    case MapState.Building: return height > 0 ? ProgressRowsShare * nextRow / height : 0f;
                    case MapState.Mipmaps:
                        return ProgressRowsShare + (1f - ProgressRowsShare) * (mipTotal > 0 ? (float)mipDone / mipTotal : 1f);
                    default: return 0f;
                }
            }
        }

        /// <summary>The map (created when the build starts; complete only when <see cref="IsReady"/>).</summary>
        public Texture2D Texture => texture;
        public int Width => width;
        public int Height => height;
        public float MetersPerPixel => mpp;

        /// <summary>World XZ rectangle covered by the texture: x = west edge (world x), y = south edge (world z), metres.</summary>
        public Rect WorldBounds => new Rect(x0, z0, width * mpp, height * mpp);

        public float ContourInterval => contourInterval;
        public float IndexInterval => contourInterval * IndexEvery;
        public float MinElevation => minElevation;
        public float MaxElevation => maxElevation;

        /// <summary>True when elevations (and contour levels) are MOLA-areoid metres, false for plain world y.</summary>
        public bool UsesMolaElevation => hasGeo;

        /// <summary>Neutral grey hillshade, same grid as <see cref="Texture"/> (complete only when <see cref="IsReady"/>).</summary>
        public Texture2D BaseTexture => baseTexture;

        /// <summary>Slope classes 0-10 / 10-17 / 17-20 / &gt;20 deg, half resolution, over <see cref="OverlayWorldBounds"/>.</summary>
        public Texture2D SlopeTexture => slopeTexture;

        /// <summary>Geologic units by stratigraphic band, half resolution; null without units (no geo-reference or data).</summary>
        public Texture2D UnitTexture => unitTexture;

        /// <summary>World XZ rectangle of the half-resolution overlays (two map texels per overlay texel, rounded up).</summary>
        public Rect OverlayWorldBounds => new Rect(x0, z0, ow * 2 * mpp, oh * 2 * mpp);

        /// <summary>Units considered by the unit layer (index order = <see cref="UnitClassId"/>).</summary>
        public int UnitCount => unitCount;

        /// <summary>Rock class id of unit <paramref name="index"/> (RockDatabase), or null.</summary>
        public string UnitClassId(int index) => (uint)index < (uint)unitCount ? units[index].ClassId : null;

        /// <summary>Overlay texels drawn in unit <paramref name="index"/> at half weight or more (0 = not on this map).</summary>
        public int UnitTexels(int index) => (uint)index < (uint)unitCount ? unitTexels[index] : 0;

        /// <summary>Overlay texels in slope class <paramref name="k"/> (0..3).</summary>
        public int SlopeTexels(int k) => (uint)k < SlopeClassCount ? slopeTexels[k] : 0;

        /// <summary>
        /// Elevation at world (<paramref name="x"/>, <paramref name="z"/>) read from the merged terrain tiles: MOLA metres
        /// with a geo-reference, else world y. False off the map's tiles (or before the build started).
        /// </summary>
        public bool TryGetElevation(float x, float z, out float elevation)
        {
            for (int t = 0; t < tileCount; t++)
            {
                Tile tile = tiles[t];
                if (x < tile.X0 || x > tile.X0 + tile.SizeX || z < tile.Z0 || z > tile.Z0 + tile.SizeZ || tile.Data == null)
                {
                    continue;
                }
                float local = tile.Data.GetInterpolatedHeight((x - tile.X0) / tile.SizeX, (z - tile.Z0) / tile.SizeZ);
                elevation = Elevation(local, tile.Y, x, z);
                return true;
            }
            elevation = 0f;
            return false;
        }

        /// <summary>Texture UV of a world position (+X east = u, +Z north = v). Outside the terrain the UV leaves 0..1.</summary>
        public Vector2 WorldToUV(Vector3 world)
        {
            return new Vector2((world.x - x0) * invWm, (world.z - z0) * invHm);
        }

        /// <summary>Advances the build by one step. <paramref name="viewer"/> picks the primary tile when nothing else does.</summary>
        public void Tick(Vector3 viewer, float dt)
        {
            switch (State)
            {
                case MapState.Searching:
                    retryTimer -= dt;
                    if (retryTimer > 0f)
                    {
                        return;
                    }
                    if (Begin(viewer))
                    {
                        State = MapState.Building;
                    }
                    else if (++retries >= MaxRetries)
                    {
                        State = MapState.NoTerrain;
                    }
                    else
                    {
                        retryTimer = RetryInterval;
                    }
                    return;
                case MapState.Building:
                    if (TexturesLost())
                    {
                        Abort();
                        return;
                    }
                    BuildRows();
                    return;
                case MapState.Mipmaps:
                    if (TexturesLost())
                    {
                        Abort();
                        return;
                    }
                    BuildMips();
                    return;
            }
        }

        /// <summary>Destroys the textures (the main one only matters when nobody else took ownership of it).</summary>
        public void Dispose()
        {
            DestroyTexture(ref texture);
            DestroyTexture(ref baseTexture);
            DestroyTexture(ref slopeTexture);
            DestroyTexture(ref unitTexture);
            ReleaseBuffers();
        }

        private static void DestroyTexture(ref Texture2D t)
        {
            if (t != null)
            {
                UnityEngine.Object.Destroy(t);
            }
            t = null;
        }

        // Unity null checks: a texture destroyed under the build (scene teardown) ends it.
        private bool TexturesLost()
        {
            return texture == null || baseTexture == null || slopeTexture == null || (unitCount > 0 && unitTexture == null);
        }

        // ---- setup

        private bool Begin(Vector3 viewer)
        {
            Terrain[] all = Terrain.activeTerrains;
            if (all == null || all.Length == 0)
            {
                return false;
            }

            // Primary tile: the one carrying the geo-reference ("Mars Terrain"), else the finest one under the viewer,
            // else the finest one.
            int primary = -1;
            for (int i = 0; i < all.Length && primary < 0; i++)
            {
                if (Valid(all[i]) && all[i].GetComponent<MarsGeoReference>() != null)
                {
                    primary = i;
                }
            }
            if (primary < 0)
            {
                primary = Finest(all, viewer, true);
            }
            if (primary < 0)
            {
                primary = Finest(all, viewer, false);
            }
            if (primary < 0)
            {
                return false;
            }

            // Grow the tile set: same post spacing (within 1.5x) and touching a selected tile.
            var used = new bool[all.Length];
            tileCount = 0;
            AddTile(all[primary]);
            used[primary] = true;
            float spacing = Spacing(all[primary].terrainData);
            bool changed = true;
            while (changed && tileCount < MaxTiles)
            {
                changed = false;
                for (int i = 0; i < all.Length && tileCount < MaxTiles; i++)
                {
                    if (used[i] || !Valid(all[i]))
                    {
                        continue;
                    }
                    float ratio = Spacing(all[i].terrainData) / spacing;
                    if (ratio < 0.67f || ratio > 1.5f || !TouchesSelection(all[i]))
                    {
                        continue;
                    }
                    AddTile(all[i]);
                    used[i] = true;
                    changed = true;
                }
            }

            // Map grid: union of the tiles at about 2 m per texel, at most MaxSize texels a side.
            float minX = float.MaxValue, minZ = float.MaxValue, maxX = float.MinValue, maxZ = float.MinValue;
            for (int t = 0; t < tileCount; t++)
            {
                minX = Mathf.Min(minX, tiles[t].X0);
                minZ = Mathf.Min(minZ, tiles[t].Z0);
                maxX = Mathf.Max(maxX, tiles[t].X0 + tiles[t].SizeX);
                maxZ = Mathf.Max(maxZ, tiles[t].Z0 + tiles[t].SizeZ);
            }
            float ex = maxX - minX, ez = maxZ - minZ;
            mpp = Mathf.Max(TargetMetersPerPixel, Mathf.Max(ex, ez) / MaxSize);
            width = Mathf.Clamp(Mathf.CeilToInt(ex / mpp - 1e-3f), 2, MaxSize);
            height = Mathf.Clamp(Mathf.CeilToInt(ez / mpp - 1e-3f), 2, MaxSize);
            x0 = minX;
            z0 = minZ;
            invWm = 1f / (width * mpp);
            invHm = 1f / (height * mpp);

            for (int t = 0; t < tileCount; t++)
            {
                Cover(ref tiles[t]);
            }

            geo = MarsGeoReference.Instance;
            hasGeo = geo != null;   // cached: no Unity null check per sample
            Survey();
            BuildTables();

            texture = new Texture2D(width, height, TextureFormat.RGBA32, true, false)
            {
                name = "HUD Elevation Map",
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
                anisoLevel = 1,
                hideFlags = HideFlags.DontSave
            };

            // Map-screen layers. Not DontSave: nothing destroys them explicitly, so a scene change may unload them once
            // the HUD that referenced them is gone.
            ow = (width + 1) / 2;
            oh = (height + 1) / 2;
            BuildUnits();
            BuildSlopeTable();
            baseTexture = NewLayer("HUD Map Base", width, height);
            slopeTexture = NewLayer("HUD Map Slope", ow, oh);
            unitTexture = unitCount > 0 ? NewLayer("HUD Map Units", ow, oh) : null;

            mipJobCount = 0;
            mipTotal = 0;
            AddMipJob(texture);
            AddMipJob(baseTexture);
            AddMipJob(slopeTexture);
            AddMipJob(unitTexture);

            batch = new float[RowsPerTick + 2, width];
            heights = new float[(RowsPerTick + 2) * width];
            pixels = new Color32[Mathf.Max(RowsPerTick * width, MipPixelsPerTick)];
            basePixels = new Color32[RowsPerTick * width];
            int overlayBlock = (RowsPerTick / 2) * ow;
            slopePixels = new Color32[overlayBlock];
            unitPixels = new Color32[overlayBlock];
            slopeAcc = new byte[overlayBlock];
            elevSum = new float[overlayBlock];
            elevN = new byte[overlayBlock];
            Array.Clear(slopeTexels, 0, slopeTexels.Length);
            Array.Clear(unitTexels, 0, unitTexels.Length);
            nextRow = 0;
            batchOk = CheckBatch(tiles[0]);
            return true;
        }

        private static Texture2D NewLayer(string name, int w, int h)
        {
            return new Texture2D(w, h, TextureFormat.RGBA32, true, false)
            {
                name = name,
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Bilinear,
                anisoLevel = 1,
                hideFlags = HideFlags.DontSaveInEditor | HideFlags.DontSaveInBuild
            };
        }

        private void AddMipJob(Texture2D t)
        {
            if (t == null || t.mipmapCount <= 1)
            {
                return;
            }
            mipJobs[mipJobCount++] = t;
            for (int k = 1; k < t.mipmapCount; k++)
            {
                mipTotal += (long)Mathf.Max(1, t.width >> k) * Mathf.Max(1, t.height >> k);
            }
        }

        // Slope class texels: tint per class, alpha from a perceptual alpha like HudTokens.Light (linear: p^2.2).
        private void BuildSlopeTable()
        {
            tan2A = Tan2(SlopeLimitsDeg[0]);
            tan2B = Tan2(SlopeLimitsDeg[1]);
            tan2C = Tan2(SlopeLimitsDeg[2]);
            for (int k = 0; k < SlopeClassCount; k++)
            {
                Color c = MapPalette.SlopeColor(k);
                float a = MapPalette.LinearAlpha(MapPalette.SlopeOverlayAlpha(k));
                slopeTexel[k] = new Color32(ToByte(c.r * 255f), ToByte(c.g * 255f), ToByte(c.b * 255f), ToByte(a * 255f));
            }
            unitAlpha = MapPalette.LinearAlpha(MapPalette.UnitOverlayAlpha) * 255f;
        }

        private static float Tan2(float deg)
        {
            float t = Mathf.Tan(deg * Mathf.Deg2Rad);
            return t * t;
        }

        // Layered rock classes and the elevation span of their analog samples (MOLA m). Needs real elevations.
        private void BuildUnits()
        {
            unitCount = 0;
            if (!hasGeo)
            {
                return;
            }
            RockDatabase db = RockDatabase.Default;
            if (db == null || db.Classes == null)
            {
                return;
            }
            float reach = BandMarginM + BandFalloffM * Mathf.Log(1f / MinUnitFade);
            for (int c = 0; c < db.Classes.Count && unitCount < MaxUnits; c++)
            {
                RockClass cls = db.Classes[c];
                // Caprock (unconformable) classes drape any elevation: the band rule does not apply to them.
                if (cls == null || string.IsNullOrEmpty(cls.Id) || cls.Abundance <= 0f || cls.Setting == "caprock")
                {
                    continue;
                }
                float lo = float.MaxValue, hi = float.MinValue;
                IReadOnlyList<RockAnalysis> list = db.AnalysesOf(cls.Id);
                for (int i = 0; i < list.Count; i++)
                {
                    RockAnalysis a = list[i];
                    if (a != null && a.UseAsAnalog && a.ElevationM.HasValue)
                    {
                        lo = Mathf.Min(lo, a.ElevationM.Value);
                        hi = Mathf.Max(hi, a.ElevationM.Value);
                    }
                }
                // No elevation data (e.g. meteorites), or a band that cannot reach this terrain.
                if (lo > hi || hi + reach < minElevation || lo - reach > maxElevation)
                {
                    continue;
                }
                Color col = MapPalette.ClassColor(cls.Id);
                units[unitCount++] = new Unit
                {
                    ClassId = cls.Id, Lo = lo, Hi = hi, Abundance = cls.Abundance,
                    Rgb = new Color32(ToByte(col.r * 255f), ToByte(col.g * 255f), ToByte(col.b * 255f), 255)
                };
            }
        }

        // Unit of highest abundance x band fade at elevation e (-1 without units); fade = that unit's band weight.
        private int PickUnit(float e, out float fade)
        {
            int best = -1;
            float bestScore = 0f, bestOutside = 0f;
            for (int u = 0; u < unitCount; u++)
            {
                float lo = units[u].Lo - BandMarginM, hi = units[u].Hi + BandMarginM;
                float outside = e < lo ? lo - e : (e > hi ? e - hi : 0f);
                float score = outside > 0f ? units[u].Abundance * Mathf.Exp(-outside / BandFalloffM) : units[u].Abundance;
                if (best < 0 || score > bestScore)
                {
                    best = u;
                    bestScore = score;
                    bestOutside = outside;
                }
            }
            fade = best < 0 ? 0f : (bestOutside > 0f ? Mathf.Exp(-bestOutside / BandFalloffM) : 1f);
            return best;
        }

        // The batched read must agree with per-sample reads (layout [row, column], world-unit heights); else fall back.
        private bool CheckBatch(in Tile t)
        {
            try
            {
                const float U0 = 0.37f, V0 = 0.61f;
                t.Data.GetInterpolatedHeights(batch, 0, 0, U0, V0, 2, 1, t.Du, t.Dv);
                float a = t.Data.GetInterpolatedHeight(U0, V0);
                float b = t.Data.GetInterpolatedHeight(U0 + t.Du, V0);
                float tol = 1e-3f + 1e-5f * t.Data.size.y;
                if (Mathf.Abs(batch[0, 0] - a) <= tol && Mathf.Abs(batch[0, 1] - b) <= tol)
                {
                    return true;
                }
                Debug.LogWarning("[HUD] Elevation map: batched height read disagrees with per-sample reads; using per-sample reads.");
            }
            catch (Exception e)
            {
                Debug.LogWarning("[HUD] Elevation map: batched height read unavailable (" + e.Message + "); using per-sample reads.");
            }
            return false;
        }

        private static bool Valid(Terrain t)
        {
            if (t == null)
            {
                return false;
            }
            TerrainData d = t.terrainData;
            return d != null && d.size.x > 0f && d.size.z > 0f && d.heightmapResolution > 1;
        }

        private static float Spacing(TerrainData d)
        {
            return d.size.x / Mathf.Max(1, d.heightmapResolution - 1);
        }

        private static int Finest(Terrain[] all, Vector3 viewer, bool underViewer)
        {
            int best = -1;
            float bestSpacing = float.MaxValue;
            for (int i = 0; i < all.Length; i++)
            {
                if (!Valid(all[i]))
                {
                    continue;
                }
                Vector3 p = all[i].transform.position;
                Vector3 s = all[i].terrainData.size;
                if (underViewer && (viewer.x < p.x || viewer.x > p.x + s.x || viewer.z < p.z || viewer.z > p.z + s.z))
                {
                    continue;
                }
                float sp = Spacing(all[i].terrainData);
                if (sp < bestSpacing)
                {
                    bestSpacing = sp;
                    best = i;
                }
            }
            return best;
        }

        private void AddTile(Terrain t)
        {
            TerrainData d = t.terrainData;
            Vector3 p = t.transform.position;
            Vector3 s = d.size;
            tiles[tileCount++] = new Tile { Data = d, X0 = p.x, Z0 = p.z, SizeX = s.x, SizeZ = s.z, Y = p.y };
        }

        private bool TouchesSelection(Terrain t)
        {
            const float Tol = 0.5f;
            Vector3 p = t.transform.position;
            Vector3 s = t.terrainData.size;
            for (int k = 0; k < tileCount; k++)
            {
                Tile o = tiles[k];
                if (p.x <= o.X0 + o.SizeX + Tol && p.x + s.x >= o.X0 - Tol && p.z <= o.Z0 + o.SizeZ + Tol && p.z + s.z >= o.Z0 - Tol)
                {
                    return true;
                }
            }
            return false;
        }

        // Texel columns/rows whose centres lie on the tile, and the normalized steps.
        private void Cover(ref Tile t)
        {
            t.Ia = Mathf.Clamp(Mathf.CeilToInt((t.X0 - x0) / mpp - 0.5f - 1e-4f), 0, width - 1);
            t.Ib = Mathf.Clamp(Mathf.FloorToInt((t.X0 + t.SizeX - x0) / mpp - 0.5f + 1e-4f), 0, width - 1);
            t.Ra = Mathf.Clamp(Mathf.CeilToInt((t.Z0 - z0) / mpp - 0.5f - 1e-4f), 0, height - 1);
            t.Rb = Mathf.Clamp(Mathf.FloorToInt((t.Z0 + t.SizeZ - z0) / mpp - 0.5f + 1e-4f), 0, height - 1);
            t.Du = mpp / t.SizeX;
            t.Dv = mpp / t.SizeZ;
        }

        private float U(in Tile t, int i) => Mathf.Clamp01((x0 + (i + 0.5f) * mpp - t.X0) / t.SizeX);
        private float V(in Tile t, int r) => Mathf.Clamp01((z0 + (r + 0.5f) * mpp - t.Z0) / t.SizeZ);

        private float Elevation(float local, float tileY, float x, float z)
        {
            float y = local + tileY;
            return hasGeo ? geo.ElevationMOLA(new Vector3(x, y, z)) : y;
        }

        // Coarse survey of every tile: elevation min..max (tint range) and the median slope (contour interval).
        private void Survey()
        {
            int n = Mathf.Clamp(Mathf.FloorToInt(Mathf.Sqrt(CoarseSamples / (float)tileCount)), 8, 96);
            var slopeHistogram = new int[91];
            float lo = float.MaxValue, hi = float.MinValue;
            float floorE = float.MaxValue, topE = float.MinValue;
            int count = 0;
            for (int t = 0; t < tileCount; t++)
            {
                Tile tile = tiles[t];
                for (int a = 0; a < n; a++)
                {
                    float v = (a + 0.5f) / n;
                    float z = tile.Z0 + v * tile.SizeZ;
                    for (int b = 0; b < n; b++)
                    {
                        float u = (b + 0.5f) / n;
                        float x = tile.X0 + u * tile.SizeX;
                        float e = Elevation(tile.Data.GetInterpolatedHeight(u, v), tile.Y, x, z);
                        lo = Mathf.Min(lo, e);
                        hi = Mathf.Max(hi, e);
                        slopeHistogram[Mathf.Clamp(Mathf.RoundToInt(tile.Data.GetSteepness(u, v)), 0, 90)]++;
                        count++;
                    }
                }
                // The tile's height range (normalized heights 0..1) bounds what the coarse grid may have missed.
                float baseE = Elevation(0f, tile.Y, tile.X0 + 0.5f * tile.SizeX, tile.Z0 + 0.5f * tile.SizeZ);
                floorE = Mathf.Min(floorE, baseE - 2f);
                topE = Mathf.Max(topE, baseE + tile.Data.size.y + 2f);
            }
            // The grid misses the extremes: widen by 2 %, within the tiles' height range.
            float span = hi - lo;
            lo = Mathf.Max(lo - 0.02f * span, floorE);
            hi = Mathf.Min(hi + 0.02f * span, topE);
            if (!(hi > lo))
            {
                hi = lo + 1f;
            }
            minElevation = lo;
            maxElevation = hi;

            int half = count / 2, acc = 0, medianDeg = 0;
            for (int d = 0; d <= 90; d++)
            {
                acc += slopeHistogram[d];
                if (acc > half)
                {
                    medianDeg = d;
                    break;
                }
            }
            float slope = Mathf.Tan(Mathf.Min(medianDeg, 85) * Mathf.Deg2Rad);
            contourInterval = Intervals[Intervals.Length - 1];
            for (int k = 0; k < Intervals.Length; k++)
            {
                // Spacing between contours at the median slope, in texels.
                if (slope <= 1e-4f || Intervals[k] / slope / mpp >= MinContourSpacingTexels)
                {
                    contourInterval = Intervals[k];
                    break;
                }
            }
        }

        private void BuildTables()
        {
            lutR = new float[256];
            lutG = new float[256];
            lutB = new float[256];
            for (int i = 0; i < 256; i++)
            {
                float t = i / 255f;
                int s = 0;
                while (s < RampT.Length - 2 && t > RampT[s + 1])
                {
                    s++;
                }
                float f = Mathf.InverseLerp(RampT[s], RampT[s + 1], t);
                lutR[i] = Mathf.Lerp(RampC[s].r, RampC[s + 1].r, f);
                lutG[i] = Mathf.Lerp(RampC[s].g, RampC[s + 1].g, f);
                lutB[i] = Mathf.Lerp(RampC[s].b, RampC[s + 1].b, f);
            }

            const float Altitude = 45f * Mathf.Deg2Rad;
            float ca = Mathf.Cos(Altitude);
            lightX = new float[LightAz.Length];
            lightY = new float[LightAz.Length];
            lightZ = Mathf.Sin(Altitude);
            for (int k = 0; k < LightAz.Length; k++)
            {
                float az = LightAz[k] * Mathf.Deg2Rad;
                lightX[k] = ca * Mathf.Sin(az);   // east
                lightY[k] = ca * Mathf.Cos(az);   // north
            }
        }

        // ---- base level

        private void BuildRows()
        {
            // RowsPerTick is even and blocks start at multiples of it, so each block holds whole overlay rows (2 map rows).
            int j0 = nextRow;
            int j1 = Mathf.Min(j0 + RowsPerTick, height);
            int o0 = j0 >> 1, oRows = ((j1 - 1) >> 1) - o0 + 1;
            ReadHeights(j0, j1);
            ClearOverlayBlock(oRows);
            Shade(j0, j1);
            ResolveOverlayBlock(o0, oRows);

            int count = (j1 - j0) * width;
            NativeArray<Color32> dst = texture.GetPixelData<Color32>(0);
            NativeArray<Color32>.Copy(pixels, 0, dst, j0 * width, count);
            NativeArray<Color32> dstBase = baseTexture.GetPixelData<Color32>(0);
            NativeArray<Color32>.Copy(basePixels, 0, dstBase, j0 * width, count);
            NativeArray<Color32> dstSlope = slopeTexture.GetPixelData<Color32>(0);
            NativeArray<Color32>.Copy(slopePixels, 0, dstSlope, o0 * ow, oRows * ow);
            if (unitTexture != null)
            {
                NativeArray<Color32> dstUnit = unitTexture.GetPixelData<Color32>(0);
                NativeArray<Color32>.Copy(unitPixels, 0, dstUnit, o0 * ow, oRows * ow);
            }

            nextRow = j1;
            if (nextRow >= height)
            {
                if (mipJobCount > 0)
                {
                    mipJob = 0;
                    mipLevel = 1;
                    mipRow = 0;
                    mipDone = 0;
                    mipSource = new Color32[4 * MipPixelsPerTick + 2 * MaxSize + 8];
                    State = MapState.Mipmaps;
                }
                else
                {
                    Finish();
                }
            }
        }

        private void ClearOverlayBlock(int oRows)
        {
            int n = oRows * ow;
            for (int i = 0; i < n; i++)
            {
                slopeAcc[i] = 255;
                elevSum[i] = 0f;
                elevN[i] = 0;
            }
        }

        // Overlay texels of the block: steepest slope class of the 2x2 texels, unit of their mean elevation. The outer ring
        // stays transparent (clamped lookups outside the terrain read as no data, like the main map).
        private void ResolveOverlayBlock(int o0, int oRows)
        {
            Color32 clear = new Color32(0, 0, 0, 0);
            for (int ob = 0; ob < oRows; ob++)
            {
                int oy = o0 + ob;
                bool edgeRow = oy == 0 || oy == oh - 1;
                int row = ob * ow;
                for (int ox = 0; ox < ow; ox++)
                {
                    int i = row + ox;
                    int n = elevN[i];
                    if (edgeRow || ox == 0 || ox == ow - 1 || n == 0)
                    {
                        slopePixels[i] = clear;
                        unitPixels[i] = clear;
                        continue;
                    }
                    int k = slopeAcc[i];
                    slopePixels[i] = slopeTexel[k];
                    slopeTexels[k]++;

                    if (unitCount > 0)
                    {
                        int u = PickUnit(elevSum[i] / n, out float fade);
                        Color32 c = units[u].Rgb;
                        // Below the fade floor the texel keeps the unit's colour at alpha 0, so bilinear edges do not darken.
                        c.a = fade >= MinUnitFade ? ToByte(unitAlpha * fade) : (byte)0;
                        unitPixels[i] = c;
                        if (fade >= 0.5f)
                        {
                            unitTexels[u]++;
                        }
                    }
                }
            }
        }

        // Elevations of rows j0-1 .. j1 (buffer row k = row - (j0 - 1)); rows off the map or off every tile stay NaN.
        private void ReadHeights(int j0, int j1)
        {
            int kBase = j0 - 1;
            int used = (j1 - j0 + 2) * width;
            for (int i = 0; i < used; i++)
            {
                heights[i] = float.NaN;
            }
            int a = Mathf.Max(0, j0 - 1), b = Mathf.Min(height - 1, j1);
            for (int t = 0; t < tileCount; t++)
            {
                Tile tile = tiles[t];
                int ra = Mathf.Max(tile.Ra, a), rb = Mathf.Min(tile.Rb, b);
                if (ra > rb || tile.Ia > tile.Ib)
                {
                    continue;
                }
                int xCount = tile.Ib - tile.Ia + 1;
                bool fast = batchOk && Batch(tile, ra - kBase, ra, xCount, rb - ra + 1);
                for (int r = ra; r <= rb; r++)
                {
                    int k = r - kBase;
                    float v = V(tile, r);
                    float z = z0 + (r + 0.5f) * mpp;
                    int row = k * width;
                    for (int i = tile.Ia; i <= tile.Ib; i++)
                    {
                        float local = fast ? batch[k, i] : tile.Data.GetInterpolatedHeight(U(tile, i), v);
                        heights[row + i] = Elevation(local, tile.Y, x0 + (i + 0.5f) * mpp, z);
                    }
                }
            }
        }

        private bool Batch(in Tile tile, int k, int ra, int xCount, int yCount)
        {
            try
            {
                tile.Data.GetInterpolatedHeights(batch, tile.Ia, k, U(tile, tile.Ia), V(tile, ra), xCount, yCount, tile.Du, tile.Dv);
                return true;
            }
            catch (Exception e)
            {
                // Unexpected layout or range: fall back to per-sample reads for the rest of the build.
                batchOk = false;
                Debug.LogWarning("[HUD] Elevation map: batched height read failed, using per-sample reads. " + e.Message);
                return false;
            }
        }

        private void Shade(int j0, int j1)
        {
            float invRange = 255f / (maxElevation - minElevation);
            float inv2 = 0.5f / mpp;
            float ci = contourInterval, invCi = 1f / ci;
            float idx = ci * IndexEvery, invIdx = 1f / idx;
            int nl = lightX.Length;
            float flat = lightZ;   // weights sum to 1: a flat texel receives sin(altitude)
            Color32 none = new Color32((byte)(lutR[0] * 0.5f), (byte)(lutG[0] * 0.5f), (byte)(lutB[0] * 0.5f), 0);
            byte greyNone = ToByte(BaseGrey * 0.5f);
            Color32 baseNone = new Color32(greyNone, greyNone, greyNone, 0);
            int o0 = j0 >> 1;

            for (int r = j0; r < j1; r++)
            {
                int k = r - (j0 - 1);
                int row = k * width;
                int outRow = (r - j0) * width;
                int overlayRow = ((r >> 1) - o0) * ow;
                bool edgeRow = r == 0 || r == height - 1;
                for (int i = 0; i < width; i++)
                {
                    float h = heights[row + i];
                    if (edgeRow || i == 0 || i == width - 1 || float.IsNaN(h))
                    {
                        pixels[outRow + i] = none;
                        basePixels[outRow + i] = baseNone;
                        continue;
                    }
                    float hl = heights[row + i - 1], hr = heights[row + i + 1];
                    float hd = heights[row - width + i], hu = heights[row + width + i];
                    if (float.IsNaN(hl)) hl = h;
                    if (float.IsNaN(hr)) hr = h;
                    if (float.IsNaN(hd)) hd = h;
                    if (float.IsNaN(hu)) hu = h;
                    float gx = (hr - hl) * inv2;   // dh/dx, east
                    float gz = (hu - hd) * inv2;   // dh/dz, north

                    // Soft multi-directional hillshade, relative to flat ground.
                    float ex = gx * ShadeExaggeration, ez = gz * ShadeExaggeration;
                    float invLen = 1f / Mathf.Sqrt(ex * ex + ez * ez + 1f);
                    float shade = 0f;
                    for (int l = 0; l < nl; l++)
                    {
                        float d = (lightZ - ex * lightX[l] - ez * lightY[l]) * invLen;
                        shade += d > 0f ? d * LightW[l] : 0f;
                    }
                    float f = 1f + ShadeStrength * (shade / flat - 1f);
                    f = f < 0.3f ? 0.3f : (f > 1.45f ? 1.45f : f);

                    // Map-screen base: the same hillshade on neutral grey.
                    byte grey = ToByte(BaseGrey * f);
                    basePixels[outRow + i] = new Color32(grey, grey, grey, 255);

                    // Slope class (steepest of the overlay texel's 2x2) and elevation sum (its unit).
                    float g2 = gx * gx + gz * gz;
                    byte sc = g2 < tan2A ? (byte)0 : (g2 < tan2B ? (byte)1 : (g2 < tan2C ? (byte)2 : (byte)3));
                    int oi = overlayRow + (i >> 1);
                    byte prev = slopeAcc[oi];
                    if (prev == 255 || sc > prev)
                    {
                        slopeAcc[oi] = sc;
                    }
                    elevSum[oi] += h;
                    elevN[oi]++;

                    int ti = (int)((h - minElevation) * invRange);
                    ti = ti < 0 ? 0 : (ti > 255 ? 255 : ti);
                    float cr = lutR[ti] * f, cg = lutG[ti] * f, cb = lutB[ti] * f;

                    // Contours: anti-aliased ~1 texel lines from the distance to the nearest level / gradient.
                    float g = Mathf.Sqrt(gx * gx + gz * gz);
                    if (g > 1e-4f)
                    {
                        float texelsPerMetre = 1f / (g * mpp);
                        float a = Coverage(h * invCi, ci, texelsPerMetre, 1f);
                        float spacing = ci * texelsPerMetre;   // texels between minor contours
                        float fade = (spacing - 2.5f) * 0.5f;
                        a *= fade < 0f ? 0f : (fade > 1f ? 1f : fade);
                        a *= MinorStrength;
                        float ai = Coverage(h * invIdx, idx, texelsPerMetre, 1.25f) * IndexStrength;
                        if (ai > a)
                        {
                            a = ai;
                        }
                        if (a > 0f)
                        {
                            cr += (ContourR - cr) * a;
                            cg += (ContourG - cg) * a;
                            cb += (ContourB - cb) * a;
                        }
                    }

                    pixels[outRow + i] = new Color32(ToByte(cr), ToByte(cg), ToByte(cb), 255);
                }
            }
        }

        // Line coverage of the nearest contour level: q = h / interval; distance in texels against the line's half width
        // plus half a texel of anti-aliasing.
        private static float Coverage(float q, float interval, float texelsPerMetre, float width)
        {
            int fl = (int)q;
            if (q < fl)
            {
                fl--;
            }
            float fr = q - fl;
            float dm = (fr < 0.5f ? fr : 1f - fr) * interval;
            float c = width - dm * texelsPerMetre;
            return c < 0f ? 0f : (c > 1f ? 1f : c);
        }

        private static byte ToByte(float v)
        {
            return v <= 0f ? (byte)0 : (v >= 255f ? (byte)255 : (byte)(v + 0.5f));
        }

        // ---- mip chains (2x2 box filter, a block of rows per Tick, read back from the previous level's pixel data), one
        // texture after the other: main map, grey base, slope, units.

        private void BuildMips()
        {
            Texture2D tex = mipJobs[mipJob];
            int tw = tex.width, th = tex.height;
            int wk = Mathf.Max(1, tw >> mipLevel), hk = Mathf.Max(1, th >> mipLevel);
            int wp = Mathf.Max(1, tw >> (mipLevel - 1)), hp = Mathf.Max(1, th >> (mipLevel - 1));
            int rows = Mathf.Min(hk - mipRow, Mathf.Max(1, MipPixelsPerTick / wk));
            rows = Mathf.Min(rows, Mathf.Max(1, mipSource.Length / (2 * wp)));
            int srcRow0 = Mathf.Min(2 * mipRow, hp - 1);
            int srcRows = Mathf.Min(2 * rows, hp - srcRow0);

            NativeArray<Color32> src = tex.GetPixelData<Color32>(mipLevel - 1);
            NativeArray<Color32>.Copy(src, srcRow0 * wp, mipSource, 0, srcRows * wp);
            for (int y = 0; y < rows; y++)
            {
                int sy0 = Mathf.Min(2 * y, srcRows - 1) * wp;
                int sy1 = Mathf.Min(2 * y + 1, srcRows - 1) * wp;
                int o = y * wk;
                for (int x = 0; x < wk; x++)
                {
                    int sx0 = Mathf.Min(2 * x, wp - 1), sx1 = Mathf.Min(2 * x + 1, wp - 1);
                    Color32 a = mipSource[sy0 + sx0], b = mipSource[sy0 + sx1], c = mipSource[sy1 + sx0], d = mipSource[sy1 + sx1];
                    pixels[o + x] = new Color32((byte)((a.r + b.r + c.r + d.r + 2) >> 2), (byte)((a.g + b.g + c.g + d.g + 2) >> 2),
                                                (byte)((a.b + b.b + c.b + d.b + 2) >> 2), (byte)((a.a + b.a + c.a + d.a + 2) >> 2));
                }
            }
            NativeArray<Color32> dst = tex.GetPixelData<Color32>(mipLevel);
            NativeArray<Color32>.Copy(pixels, 0, dst, mipRow * wk, rows * wk);
            mipDone += (long)rows * wk;

            mipRow += rows;
            if (mipRow >= hk)
            {
                mipLevel++;
                mipRow = 0;
                if (mipLevel >= tex.mipmapCount)
                {
                    mipLevel = 1;
                    if (++mipJob >= mipJobCount)
                    {
                        Finish();
                    }
                }
            }
        }

        private void Finish()
        {
            // Upload as built (mips included); drop the CPU copies.
            texture.Apply(false, true);
            baseTexture.Apply(false, true);
            slopeTexture.Apply(false, true);
            if (unitTexture != null)
            {
                unitTexture.Apply(false, true);
            }
            ReleaseBuffers();
            for (int i = 0; i < mipJobs.Length; i++)
            {
                mipJobs[i] = null;
            }
            State = MapState.Ready;
        }

        private void Abort()
        {
            ReleaseBuffers();
            // The main texture belongs to whoever took it (the dial's disc); the map-screen layers are ours.
            DestroyTexture(ref baseTexture);
            DestroyTexture(ref slopeTexture);
            DestroyTexture(ref unitTexture);
            unitCount = 0;
            for (int i = 0; i < mipJobs.Length; i++)
            {
                mipJobs[i] = null;
            }
            State = MapState.NoTerrain;
        }

        private void ReleaseBuffers()
        {
            batch = null;
            heights = null;
            pixels = null;
            mipSource = null;
            basePixels = null;
            slopePixels = null;
            unitPixels = null;
            slopeAcc = null;
            elevSum = null;
            elevN = null;
        }
    }
}
