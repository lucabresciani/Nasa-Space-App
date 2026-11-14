"""Create missing Unity .meta files for the HOMELINE folders, with DETERMINISTIC GUIDs.

Unity writes a .meta next to every asset the first time it imports it, with a random GUID. Two PCs importing the
same new files would then disagree. This script derives each GUID from the asset's project-relative path instead,
so every machine produces identical .meta files and they can be committed before anyone opens the editor.

Existing .meta files are never changed. Run from anywhere:  python -I Tools/homeline-dev/make_meta.py
"""

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
TARGETS = [
    "Assets/Mars/Scripts/Homeline",
    "Assets/Mars/Editor/Homeline",
    "Assets/Mars/Resources/Homeline",
]

FOLDER_META = """fileFormatVersion: 2
guid: {guid}
folderAsset: yes
DefaultImporter:
  externalObjects: {{}}
  userData:
  assetBundleName:
  assetBundleVariant:
"""

SCRIPT_META = """fileFormatVersion: 2
guid: {guid}
"""

TEXT_META = """fileFormatVersion: 2
guid: {guid}
TextScriptImporter:
  externalObjects: {{}}
  userData:
  assetBundleName:
  assetBundleVariant:
"""

TEXT_SUFFIXES = {".json", ".txt", ".md", ".js", ".html", ".css", ".csv", ".yaml", ".xml"}


def guid_for(rel: str) -> str:
    return hashlib.md5(("homeline:" + rel).encode("utf-8")).hexdigest()


def meta_text(path: Path, rel: str) -> str | None:
    guid = guid_for(rel)
    if path.is_dir():
        return FOLDER_META.format(guid=guid)
    if path.suffix == ".cs":
        return SCRIPT_META.format(guid=guid)
    if path.suffix.lower() in TEXT_SUFFIXES:
        return TEXT_META.format(guid=guid)
    return None  # other asset types: let Unity write the importer settings


def main() -> int:
    created = 0
    for target in TARGETS:
        base = ROOT / target
        if not base.exists():
            continue
        for path in [base, *sorted(base.rglob("*"))]:
            if path.name.endswith(".meta") or path.name.startswith("."):
                continue
            meta = path.with_name(path.name + ".meta")
            if meta.exists():
                continue
            rel = path.relative_to(ROOT).as_posix()
            text = meta_text(path, rel)
            if text is None:
                print("skipped (Unity will import it):", rel)
                continue
            meta.write_text(text, encoding="utf-8", newline="\n")
            created += 1
            print("meta:", rel)
    print(f"{created} .meta file(s) created")
    return 0


if __name__ == "__main__":
    sys.exit(main())
