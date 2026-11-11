"""将当前平台插件目录打包，根目录直接包含 manifest.json。"""
import hashlib
import json
from pathlib import Path
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
source = root / "bin/plugins/json-tool"
manifest = json.loads((source / "manifest.json").read_text())
def goenv(name):
    return subprocess.check_output(["go", "env", name], text=True).strip()
platform = f"{goenv('GOOS')}-{goenv('GOARCH')}"
out = root / "dist" / f"json-tool-{manifest['version']}-{platform}.zip"
out.parent.mkdir(exist_ok=True)
with ZipFile(out, "w", ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(source).as_posix())
digest = hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix(".zip.sha256").write_text(f"{digest}  {out.name}\n")
print(out.name)
