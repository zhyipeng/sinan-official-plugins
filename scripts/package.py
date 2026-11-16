"""生成经过原生入口校验的跨平台包；不运行插件，不修改已发布资产。"""
import hashlib
import json
import struct
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

TARGETS = [(os, arch) for os in ("darwin", "windows", "linux") for arch in ("arm64", "amd64")]
ROOT = Path(__file__).resolve().parents[1]


def verify_native(data, os, arch):
    """Do not trust filenames or the environment to label a native executable."""
    if os == "darwin":
        assert len(data) >= 32 and data[:4] == b"\xcf\xfa\xed\xfe", "不是 Mach-O 64 原生入口"
        assert struct.unpack_from("<I", data, 4)[0] == {"arm64": 0x100000C, "amd64": 0x1000007}[arch], "Mach-O 架构不符"
        assert struct.unpack_from("<I", data, 12)[0] == 2, "Mach-O 入口不是可执行程序"
    elif os == "windows":
        assert len(data) >= 64 and data[:2] == b"MZ", "不是 PE 原生入口"
        offset = struct.unpack_from("<I", data, 60)[0]
        assert offset + 24 <= len(data) and data[offset:offset + 4] == b"PE\0\0", "PE 头无效"
        assert struct.unpack_from("<H", data, offset + 4)[0] == {"arm64": 0xAA64, "amd64": 0x8664}[arch], "PE 架构不符"
    else:
        assert len(data) >= 64 and data[:6] == b"\x7fELF\x02\x01", "不是 ELF 64 小端入口"
        assert struct.unpack_from("<H", data, 18)[0] == {"arm64": 183, "amd64": 62}[arch], "ELF 架构不符"
        assert struct.unpack_from("<H", data, 16)[0] in (2, 3), "ELF 入口不是可执行程序"


def package(source, output, os, arch):
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    entry = manifest["runtime"].get("entry")
    if manifest["runtime"]["kind"] == "process":
        assert entry == "backend/plugin" + (".exe" if os == "windows" else ""), "原生入口与目标系统不符"
        assert not (source / entry).is_symlink(), "原生入口不能是符号链接"
        verify_native((source / entry).read_bytes(), os, arch)
    else:
        assert manifest["runtime"]["kind"] == "declarative" and not (source / "backend").exists(), "声明式包不能混入后端"
    files = list(source.rglob("*"))
    assert len(files) <= 2048 and sum(f.stat().st_size for f in files if f.is_file()) <= 64 << 20, "插件解压内容超过宿主预算"
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"{manifest['id']}-{manifest['version']}-{os}-{arch}.zip"
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for file in sorted(source.rglob("*")):
            assert not file.is_symlink(), "发行包不能包含符号链接"
            if file.is_file():
                name = file.relative_to(source).as_posix()
                payload = file.read_bytes()
                library = file.name.endswith((".dll", ".dylib", ".so")) or ".so." in file.name
                # Infer native helpers from bytes, not POSIX mode bits, so
                # Windows packaging/tests preserve Unix worker execution too.
                executable = name == entry or (
                    file.parent == source / "backend" and not library and
                    payload.startswith((b"MZ", b"\x7fELF", b"\xcf\xfa\xed\xfe"))
                )
                if executable:
                    verify_native(payload, os, arch)
                # Identical pure frontend packages have identical bytes on every OS.
                info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (0o100755 if executable else 0o100644) << 16
                info.compress_type = ZIP_DEFLATED
                archive.writestr(info, payload)
    data = path.read_bytes()
    assert len(data) <= 64 << 20, "插件 ZIP 超过宿主预算"
    digest = hashlib.sha256(data).hexdigest()
    path.with_suffix(".zip.sha256").write_text(f"{digest}  {path.name}\n", encoding="utf-8")
    return {"id": manifest["id"], "version": manifest["version"], "os": os, "arch": arch, "file": path.name, "sha256": digest, "size": len(data)}


def main():
    output = ROOT / "dist"
    assets = []
    json_source = ROOT / "bin/plugins/json-tool"
    current_json = json.loads((ROOT / "plugins/json-tool/manifest.json").read_text(encoding="utf-8"))
    assert json.loads((json_source / "manifest.json").read_text(encoding="utf-8")) == current_json, "JSON 包清单已过期，请重新构建"
    for os, arch in TARGETS:
        assets.append(package(json_source, output, os, arch))
    current_clipboard = json.loads((ROOT / "plugins/clipboard/manifest.json").read_text(encoding="utf-8"))
    for os, arch in TARGETS:
        source = ROOT / "bin/targets" / f"{os}-{arch}" / "clipboard"
        if not source.exists():
            continue
        built = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
        expected = json.loads(json.dumps(current_clipboard))
        expected["runtime"]["entry"] = "backend/plugin" + (".exe" if os == "windows" else "")
        assert built == expected, f"{os}-{arch} 剪贴板清单已过期，请重新构建"
        assets.append(package(source, output, os, arch))
    current_translate = json.loads((ROOT / "plugins/translate/manifest.json").read_text(encoding="utf-8"))
    for os, arch in TARGETS:
        source = ROOT / "bin/targets" / f"{os}-{arch}" / "translate"
        if not source.exists():
            continue
        built = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
        expected = json.loads(json.dumps(current_translate))
        expected["runtime"]["entry"] = "backend/plugin" + (".exe" if os == "windows" else "")
        assert built == expected, f"{os}-{arch} 翻译清单已过期，请重新构建"
        assets.append(package(source, output, os, arch))
    calendar_source = ROOT / "bin/plugins/calendar"
    current_calendar = json.loads((ROOT / "plugins/calendar/manifest.json").read_text(encoding="utf-8"))
    assert json.loads((calendar_source / "manifest.json").read_text(encoding="utf-8")) == current_calendar, "日历清单已过期，请重新构建"
    for os, arch in TARGETS:
        assets.append(package(calendar_source, output, os, arch))
    current_calculator = json.loads((ROOT / "plugins/calculator/manifest.json").read_text(encoding="utf-8"))
    for os, arch in TARGETS:
        source = ROOT / "bin/targets" / f"{os}-{arch}" / "calculator"
        if not source.exists():
            continue
        built = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
        expected = json.loads(json.dumps(current_calculator))
        expected["runtime"]["entry"] = "backend/plugin" + (".exe" if os == "windows" else "")
        assert built == expected, f"{os}-{arch} 计算清单已过期，请重新构建"
        assets.append(package(source, output, os, arch))
    current_ocr = json.loads((ROOT / "plugins/ocr/manifest.json").read_text(encoding="utf-8"))
    for os, arch in TARGETS:
        source = ROOT / "bin/targets" / f"{os}-{arch}" / "ocr"
        if not source.exists():
            continue
        expected = json.loads(json.dumps(current_ocr))
        expected["runtime"]["entry"] = "backend/plugin" + (".exe" if os == "windows" else "")
        assert json.loads((source / "manifest.json").read_text(encoding="utf-8")) == expected, "OCR 清单已过期，请重新构建"
        assets.append(package(source, output, os, arch))
    (output / "assets.json").write_text(json.dumps(assets, indent=2) + "\n", encoding="utf-8")
    for asset in assets:
        print(asset["file"])


if __name__ == "__main__":
    main()
