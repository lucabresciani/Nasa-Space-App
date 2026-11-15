# Start-point models (small version of the Mars props)

Two 3D models mark the simulation's start point: the crew rover and a habitat next to HOME.

- `Scripts/MarsProps.cs` places them at run time, like the HUD starts from code; no scene, script or setting of
  the project is edited. `Prop_CrewRover` stands about 10 m from HOME (`HomeBase`) with its front towards HOME,
  `Prop_Habitat` about 28 m from HOME, both on the side away from the science stations. They follow HOME when a
  mission moves it to the pad. Real scale, on the terrain, one box collider each, shadows on; rocks under them
  are switched off while they stand there. One log line per model starts with `[Props]`.
- `-noProps` on the command line turns them off. They are also off during the unattended tests
  (`-homelineSelfTest`, `-marvisWebTest`) unless `-propsInTests` is given.
- Plain URP Lit materials; no custom shader, no editor script.

Models: NASA Space Exploration Vehicle (https://science.nasa.gov/3d-resources/space-exploration-vehicle/, credit
NASA/LaRC/Advanced Concepts Lab) and NASA Habitat Demonstration Unit, part 1
(https://science.nasa.gov/3d-resources/habitat-demonstration-unit/), used under the NASA Images and Media Usage
Guidelines; NASA is acknowledged as the source, no endorsement is implied. The habitat's flags, logos and
lettering were painted out of its texture. The habitat is a low-detail model (about 2,300 triangles) and its
size is an estimate: it looks best from a distance. To leave it out, delete `Resources/Props/Habitat.fbx`.

The full props layer (Curiosity at the science stations, dust, wheel tracks, lights) and the tools that convert
the NASA files are on the branch `mars-props`; this folder was made from it with
`Tools/props/make_start_marker_package.py`.
