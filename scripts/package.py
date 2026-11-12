"""为商店生成 macOS 平台 ZIP；纯前端内容在两种架构中相同。"""
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
source = root / "bin/plugins/json-tool"
manifest = json.loads((source / "manifest.json").read_text())
if manifest["runtime"]["kind"] != "declarative" or (source / "backend").exists():
    raise ValueError("JSON 工具必须为无后端插件")
output = root / "dist"
output.mkdir(exist_ok=True)
assets = []
for arch in ("arm64", "amd64"):
    out = output / f"{manifest['id']}-{manifest['version']}-darwin-{arch}.zip"
    with ZipFile(out, "w", ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_symlink():
                raise ValueError("发行包不能包含符号链接")
            if path.is_file():
                archive.write(path, path.relative_to(source).as_posix())
    data = out.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    out.with_suffix(".zip.sha256").write_text(f"{digest}  {out.name}\n")
    assets.append({"os": "darwin", "arch": arch, "file": out.name, "sha256": digest, "size": len(data)})
    print(out.name)
(output / "assets.json").write_text(json.dumps(assets, indent=2) + "\n")
