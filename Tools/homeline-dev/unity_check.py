"""Compile this checkout's runtime scripts against the Unity assemblies WITHOUT opening the editor.

Unity keeps a generated Assembly-CSharp.csproj in a project that has been opened at least once. It lists every
reference assembly the editor compiles against. This script borrows that reference list from such a project
(by default the main checkout next to this worktree), points the compile items at THIS checkout's Assets, and
runs `dotnet build`. It answers one question in a few seconds: would Unity compile these scripts?

It does not replace a Play test, and it writes nothing inside the project it borrows from.

    python -I Tools/homeline-dev/unity_check.py [--unity-project "C:/path/to/an/opened/Unity/project"] [--editor]

--editor checks the Editor scripts too (Assembly-CSharp-Editor), referencing the runtime assembly just built.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = Path(__file__).resolve().parent / "unity-check"
DEFAULT_UNITY_PROJECTS = [ROOT, ROOT.parent / "Nasa Space App"]


def find_unity_project(arg: str | None) -> Path:
    candidates = [Path(arg)] if arg else DEFAULT_UNITY_PROJECTS
    for c in candidates:
        if (c / "Assembly-CSharp.csproj").exists() and (c / "Library" / "ScriptAssemblies").exists():
            return c.resolve()
    sys.exit("No opened Unity project found (needs Assembly-CSharp.csproj and Library/ScriptAssemblies). "
             "Pass --unity-project.")


def is_editor_script(path: Path) -> bool:
    return "Editor" in path.relative_to(ROOT).parts


def scripts(editor: bool) -> list[Path]:
    return sorted(p for p in (ROOT / "Assets").rglob("*.cs") if is_editor_script(p) == editor)


def generate(unity: Path, source_csproj: str, name: str, files: list[Path], extra_reference: Path | None) -> Path:
    text = (unity / source_csproj).read_text(encoding="utf-8-sig")
    # Our own compile items instead of the borrowed project's.
    text = re.sub(r"[ \t]*<Compile Include=\"[^\"]*\" />\r?\n", "", text)
    text = re.sub(r"[ \t]*<None Include=\"[^\"]*\" />\r?\n", "", text)
    # Analyzers and source generators are not needed to answer "does it compile".
    text = re.sub(r"[ \t]*<Analyzer Include=\"[^\"]*\" />\r?\n", "", text)
    # References to sibling generated projects (Assembly-CSharp from the editor project): replaced below.
    text = re.sub(r"[ \t]*<ProjectReference Include=\"[^\"]*\">.*?</ProjectReference>\r?\n", "", text, flags=re.S)
    text = re.sub(r"[ \t]*<ProjectReference Include=\"[^\"]*\" />\r?\n", "", text)
    # Relative hint paths (Library\...) belong to the borrowed project.
    unity_win = str(unity).replace("/", "\\")
    text = re.sub(r"<HintPath>(?![A-Za-z]:\\)([^<]+)</HintPath>", lambda m: f"<HintPath>{unity_win}\\{m.group(1)}</HintPath>", text)
    # Build output stays under Tools/, never in a Unity folder.
    out_win = str(OUT / name).replace("/", "\\")
    # (replacement through a function: Windows paths contain backslashes, which re.sub would read as escapes)
    text = re.sub(r"<BaseIntermediateOutputPath>[^<]*</BaseIntermediateOutputPath>",
                  lambda m: f"<BaseIntermediateOutputPath>{out_win}\\obj\\</BaseIntermediateOutputPath>", text)
    text = re.sub(r"<OutputPath>[^<]*</OutputPath>", lambda m: f"<OutputPath>{out_win}\\bin\\</OutputPath>", text)

    items = "\n".join(f'    <Compile Include="{str(f)}" />' for f in files)
    extra = ""
    if extra_reference is not None:
        extra = (f'    <Reference Include="{extra_reference.stem}">\n'
                 f"      <HintPath>{extra_reference}</HintPath>\n      <Private>False</Private>\n    </Reference>\n")
    block = f"  <ItemGroup>\n{items}\n{extra}  </ItemGroup>\n"
    marker = '  <Import Project="Sdk.targets" Sdk="Microsoft.NET.Sdk" />'
    if marker not in text:
        sys.exit(f"Unexpected layout of {source_csproj}: no Sdk.targets import")
    text = text.replace(marker, block + marker)

    OUT.mkdir(parents=True, exist_ok=True)
    project = OUT / f"{name}.csproj"
    project.write_text(text, encoding="utf-8", newline="\n")
    return project


def build(project: Path) -> int:
    cmd = ["dotnet", "build", str(project), "-nologo", "-v", "q", "-clp:NoSummary", "-p:TreatWarningsAsErrors=false"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    lines = [ln for ln in (r.stdout + r.stderr).splitlines() if ": error " in ln or ": warning CS" in ln]
    errors = sorted({ln for ln in lines if ": error " in ln})
    # Warnings only for our own folders: the rest of the project is not ours to tidy.
    warnings = sorted({ln for ln in lines if ": warning CS" in ln and "Homeline" in ln})
    for ln in errors + warnings:
        print(ln.replace(str(ROOT) + "\\", ""))
    print(f"{project.stem}: {len(errors)} error(s), {len(warnings)} warning(s) in Homeline code")
    return 1 if errors or r.returncode != 0 and not lines else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--unity-project", default=None)
    ap.add_argument("--editor", action="store_true")
    args = ap.parse_args()

    unity = find_unity_project(args.unity_project)
    print(f"Reference assemblies from: {unity}")
    runtime = generate(unity, "Assembly-CSharp.csproj", "Assembly-CSharp", scripts(editor=False), None)
    code = build(runtime)
    if code == 0 and args.editor and (unity / "Assembly-CSharp-Editor.csproj").exists():
        built = OUT / "Assembly-CSharp" / "bin" / "Assembly-CSharp.dll"
        editor = generate(unity, "Assembly-CSharp-Editor.csproj", "Assembly-CSharp-Editor", scripts(editor=True), built)
        code = build(editor)
    return code


if __name__ == "__main__":
    sys.exit(main())
