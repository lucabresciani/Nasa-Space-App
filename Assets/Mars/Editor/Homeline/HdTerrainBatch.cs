using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using NasaSpaceApp.MarsGen;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace NasaSpaceApp.Homeline.EditorTools
{
    /// <summary>
    /// Headless terrain refresh after Assets/Mars/Data/MountSharp changed (Tools/mountsharp/build_play_terrain.py):
    ///
    ///   Unity.exe -batchmode -quit -projectPath DIR -logFile LOG
    ///             -executeMethod NasaSpaceApp.Homeline.EditorTools.HdTerrainBatch.Apply
    ///   Unity.exe ... -executeMethod NasaSpaceApp.Homeline.EditorTools.HdTerrainBatch.Verify
    ///             [-hdVerifyPoints FILE.csv] [-hdVerifyOut FILE.txt]
    ///
    /// Apply rebuilds the two TerrainData assets with the existing loader (MarsTerrain.Generate) and updates the
    /// scene IN PLACE: the terrains keep their GameObjects (so nothing that references them breaks and the scene
    /// diff stays small), the play terrain moves to its new south-west corner, MarsGeoReference gets the new
    /// corner, and every boulder and the player are shifted vertically by the change of the ground under them.
    /// Tools > Mars > Apply Mount Sharp Terrain (Open Scene) does the same from scratch (it re-creates the terrains
    /// and re-scatters every boulder); use that one when boulders must be re-placed.
    ///
    /// Verify reopens the scene and writes what a reviewer needs: the play terrain's world box, the ground at the
    /// world origin (the spawn), the backdrop hole against the play box, the height step across the play border,
    /// and, with -hdVerifyPoints (lines "x,z,y": world position and expected world height), the height differences.
    /// </summary>
    public static class HdTerrainBatch
    {
        const string ScenePath = "Assets/Scenes/MarsLandscape.unity";
        const string TerrainFolder = "Assets/Mars/Generated/Terrain";

        public static void Apply()
        {
            Exit(() =>
            {
                Scene scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
                Terrain play = FindTerrain(MountSharpTerrain.PlayName), backdrop = FindTerrain(MountSharpTerrain.BackdropName);

                // The ground under everything that stands on it, before the heights change.
                var standing = new List<Transform>();
                GameObject rocks = GameObject.Find("Rocks");
                if (rocks != null)
                    foreach (Transform rock in rocks.transform) standing.Add(rock);
                GameObject player = GameObject.FindWithTag("Player");
                if (player != null) standing.Add(player.transform);
                var before = new float[standing.Count];
                for (int i = 0; i < standing.Count; i++) before[i] = Ground(play, standing[i].position);

                TerrainLayer[] layers = play.terrainData.terrainLayers;
                MarsTerrain.Result r = MarsTerrain.Generate(TerrainFolder, layers);
                EditorUtility.ClearProgressBar();
                if (r.play != play.terrainData || r.backdrop != backdrop.terrainData)
                    throw new InvalidOperationException("the scene's terrains do not use the TerrainData assets in " + TerrainFolder);

                play.transform.position = r.playPosition;
                backdrop.transform.position = r.backdropPosition;
                MarsTerrain.Info info = r.info;
                MarsGeoReference geo = play.GetComponent<MarsGeoReference>();
                if (geo == null) geo = play.gameObject.AddComponent<MarsGeoReference>();
                geo.Configure(info.spawn.elevation, info.planetRadius, info.play.swLat, info.play.swLon, info.metersPerDegree, info.eastScale, r.playSwWorld);
                EditorUtility.SetDirty(geo);
                EditorUtility.SetDirty(play.transform);
                EditorUtility.SetDirty(backdrop.transform);
                play.Flush();
                backdrop.Flush();

                int moved = 0;
                float largest = 0f;
                for (int i = 0; i < standing.Count; i++)
                {
                    float delta = Ground(play, standing[i].position) - before[i];
                    largest = Mathf.Max(largest, Mathf.Abs(delta));
                    if (Mathf.Abs(delta) < 0.005f) continue;
                    standing[i].position += new Vector3(0f, delta, 0f);
                    EditorUtility.SetDirty(standing[i]);
                    moved++;
                }

                EditorSceneManager.MarkSceneDirty(scene);
                if (!EditorSceneManager.SaveScene(scene)) throw new IOException("scene not saved: " + ScenePath);
                AssetDatabase.SaveAssets();
                Debug.Log("[HD terrain] applied: " + r.Describe() + "; play terrain at " + F(play.transform.position) + " size " + F(play.terrainData.size) +
                          ", " + moved + " of " + standing.Count + " standing object(s) re-seated (largest ground change " + largest.ToString("0.000", CultureInfo.InvariantCulture) + " m)");
            });
        }

        public static void Verify()
        {
            Exit(() =>
            {
                EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
                Terrain play = FindTerrain(MountSharpTerrain.PlayName), backdrop = FindTerrain(MountSharpTerrain.BackdropName);
                TerrainData pd = play.terrainData, bd = backdrop.terrainData;
                Vector3 p0 = play.transform.position, b0 = backdrop.transform.position;
                MarsGeoReference geo = play.GetComponent<MarsGeoReference>();
                var sb = new StringBuilder();
                void Line(string s) { sb.AppendLine(s); Debug.Log("[HD terrain verify] " + s); }

                Line("play heightmap " + pd.heightmapResolution + " posts, alphamap " + pd.alphamapResolution + ", size " + F(pd.size) + ", post spacing " +
                     N(pd.size.x / (pd.heightmapResolution - 1)) + " x " + N(pd.size.z / (pd.heightmapResolution - 1)) + " m");
                Line("play world box x " + N(p0.x) + " .. " + N(p0.x + pd.size.x) + ", z " + N(p0.z) + " .. " + N(p0.z + pd.size.z) + ", y " + N(p0.y) + " .. " + N(p0.y + pd.size.y));
                Line("ground at the world origin (spawn): y = " + N(Ground(play, Vector3.zero)));
                GameObject player = GameObject.FindWithTag("Player");
                if (player != null) Line("player at " + F(player.transform.position));
                if (geo != null)
                {
                    MarsCoordinates c = geo.ToMapCoordinates(Vector3.zero);
                    Line("geo-reference: sw " + geo.SwLat.ToString("0.00000000", CultureInfo.InvariantCulture) + ", " + geo.SwLon.ToString("0.00000000", CultureInfo.InvariantCulture) +
                         " playSwWorld " + N(geo.PlaySwWorld.x) + ", " + N(geo.PlaySwWorld.y) + "; origin = " + c.ToDecimalString() + " datum " + N(geo.DatumElevation));
                }

                // Backdrop hole in world coordinates.
                int hr = bd.holesResolution;
                bool[,] solid = bd.GetHoles(0, 0, hr, hr);
                int x0 = hr, x1 = -1, z0 = hr, z1 = -1, holes = 0;
                for (int z = 0; z < hr; z++)
                for (int x = 0; x < hr; x++)
                {
                    if (solid[z, x]) continue;
                    holes++;
                    x0 = Mathf.Min(x0, x); x1 = Mathf.Max(x1, x); z0 = Mathf.Min(z0, z); z1 = Mathf.Max(z1, z);
                }
                float cx = bd.size.x / hr, cz = bd.size.z / hr;
                Line("backdrop at " + F(b0) + " size " + F(bd.size) + "; hole cells x " + x0 + ".." + (x1 + 1) + ", z " + z0 + ".." + (z1 + 1) + " (" + holes + " cells, " +
                     (holes == (x1 + 1 - x0) * (z1 + 1 - z0) ? "a full rectangle" : "NOT a full rectangle") + ") = world x " + N(b0.x + x0 * cx) + " .. " + N(b0.x + (x1 + 1) * cx) +
                     ", z " + N(b0.z + z0 * cz) + " .. " + N(b0.z + (z1 + 1) * cz));

                // Height step across the play border: play just inside against the backdrop just outside.
                float worst = 0f, sum = 0f;
                int count = 0;
                for (int i = 0; i <= 400; i++)
                {
                    float t = i / 400f;
                    float x = Mathf.Lerp(p0.x, p0.x + pd.size.x, t), z = Mathf.Lerp(p0.z, p0.z + pd.size.z, t);
                    foreach (Vector3 edge in new[] { new Vector3(x, 0f, p0.z), new Vector3(x, 0f, p0.z + pd.size.z), new Vector3(p0.x, 0f, z), new Vector3(p0.x + pd.size.x, 0f, z) })
                    {
                        float d = Mathf.Abs(Ground(play, edge) - Ground(backdrop, edge));
                        worst = Mathf.Max(worst, d);
                        sum += d;
                        count++;
                    }
                }
                Line("play border against the backdrop surface, " + count + " points: mean |step| " + N(sum / count) + " m, max " + N(worst) + " m");

                string points = Arg("-hdVerifyPoints");
                if (points != null && File.Exists(points))
                {
                    var diffs = new List<float>();
                    foreach (string line in File.ReadLines(points))
                    {
                        string[] parts = line.Split(',');
                        if (parts.Length < 3) continue;
                        if (!float.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out float x) ||
                            !float.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out float z) ||
                            !float.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out float y)) continue;
                        diffs.Add(Mathf.Abs(Ground(play, new Vector3(x, 0f, z)) - y));
                    }
                    diffs.Sort();
                    if (diffs.Count > 0)
                        Line("height against " + diffs.Count + " reference points: median |d| " + N(diffs[diffs.Count / 2]) + " m, 95% " + N(diffs[(int)(diffs.Count * 0.95f)]) +
                             " m, max " + N(diffs[diffs.Count - 1]) + " m");
                }

                string output = Arg("-hdVerifyOut");
                if (output != null) File.WriteAllText(output, sb.ToString());
            });
        }

        // ------------------------------------------------------------------ helpers

        /// <summary>World height of a terrain's surface at a world XZ.</summary>
        static float Ground(Terrain terrain, Vector3 world)
        {
            return terrain.SampleHeight(world) + terrain.transform.position.y;
        }

        static Terrain FindTerrain(string name)
        {
            GameObject go = GameObject.Find(name);
            Terrain terrain = go != null ? go.GetComponent<Terrain>() : null;
            if (terrain == null || terrain.terrainData == null) throw new InvalidOperationException("no terrain named '" + name + "' in " + ScenePath);
            return terrain;
        }

        static void Exit(Action work)
        {
            int code = 1;
            try
            {
                work();
                code = 0;
            }
            catch (Exception e)
            {
                Debug.LogError("[HD terrain] " + e);
            }
            if (Application.isBatchMode) EditorApplication.Exit(code);
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }

        static string N(float v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }

        static string F(Vector3 v) { return "(" + N(v.x) + ", " + N(v.y) + ", " + N(v.z) + ")"; }
    }
}
