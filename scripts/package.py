"""打包平台无关的纯前端插件，ZIP 根目录包含 manifest.json。"""
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
source = root / "bin/plugins/json-tool"
manifest = json.loads((source / "manifest.json").read_text())
if manifest["runtime"]["kind"] != "declarative" or (source / "backend").exists():
    raise ValueError("JSON 工具必须为无后端插件")
out = root / "dist" / f"json-tool-{manifest['version']}-universal.zip"
out.parent.mkdir(exist_ok=True)
with ZipFile(out, "w", ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(source).as_posix())
digest = hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix(".zip.sha256").write_text(f"{digest}  {out.name}\n")
print(out.name)
