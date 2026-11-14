# HOMELINE logic: conventions

The HOMELINE logic used by the Unity simulator lives in `Assets/Mars/Scripts/Homeline/` and is split in two:

| Folder | Depends on Unity | Compiled by |
| --- | --- | --- |
| `Core/` (planner data and formulas), `Net/` (local web server, browser process, Win32 window calls) | No | Unity (Assembly-CSharp) **and** `dotnet` (`Tools/homeline-core/lib`) |
| `Sim/`, `Flow/`, `World/`, `Ui/` (MonoBehaviours) | Yes | Unity only |

The pure folders are built and tested outside Unity in seconds:

```
dotnet run --project Tools/homeline-core/tests              # every suite
dotnet run --project Tools/homeline-core/tests -- --only bundle
```

The tests read the planner's official fixture (`plan_bundle.zip`, `world_pack.zip`) and, for the server suite, the
built web app. They are looked for in a `home-line` clone next to this repository; override with the environment
variables `HOMELINE_FIXTURE` (fixture folder) and `HOMELINE_WEB` (the planner's `web/dist`).

## Rules for the pure folders

1. **C# 9, .NET Standard 2.1, no `UnityEngine`.** No records, no `init`, no file-scoped namespaces, no
   `ArgumentNullException.ThrowIfNull`, no `Convert.ToHexString`, no `Process.Kill(true)`. Namespace
   `NasaSpaceApp.Homeline`.
2. **`double` everywhere, `System.Math`** (never `float`/`Mathf`): the golden tolerances are 1e-6 at a magnitude of 482.
3. **Culture-invariant.** Parse and format numbers with `CultureInfo.InvariantCulture` (use `HlJson`); the test
   runner deliberately runs under `it-IT`.
4. **Never recompute what the planner exports.** T_home, O2_home, bearing and the way-home pointer are looked up in
   the bundle grids by nearest cell (`GridF32.ValueAt`). Unknown stays unknown: `null`, never 0 and never infinity.
5. **Constants come from the bundle** (`config_snapshot.json`, `physio/golden.json` `config`, `plan.json`), not from
   the source code of this repository.
6. **Every value the planner does not define is an assumption**: name it `Assumed...`, keep it in one place, and
   say so in its doc comment, so the HUD can label it.
7. **Ports cite their source** (`pipeline/engine/margin.py`, `web/src/hud/alarms.ts`, ...) in the class comment.

## Adding a test suite

Add `XxxTests.cs` in `Tools/homeline-core/tests` with a `public static void Run(string fixtureFolder)`. It is
discovered by name; nothing else needs registering. Use `T.Near`, `T.Eq`, `T.True`, `T.Golden`.

## Unity .meta files

`python -I Tools/homeline-dev/make_meta.py` writes the missing `.meta` files with GUIDs derived from the asset path,
so every machine gets identical files. Run it after adding files, before committing.
