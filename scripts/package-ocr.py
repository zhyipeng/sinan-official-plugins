"""Package only the requested OCR target; never relabel another platform's bin."""
import argparse
import importlib.util
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sinan_packaging", root / "scripts/package.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    parts = args.target.split("-")
    if len(parts) != 2 or tuple(parts) not in packaging.TARGETS:
        parser.error("目标无效")
    source = root / "bin/targets" / args.target / "ocr"
    current = json.loads((root / "plugins/ocr/manifest.json").read_text(encoding="utf-8"))
    current["runtime"]["entry"] = "backend/plugin" + (".exe" if parts[0] == "windows" else "")
    if json.loads((source / "manifest.json").read_text(encoding="utf-8")) != current:
        raise ValueError("OCR 产物清单已过期")
    engine = json.loads((source / "ENGINE.json").read_text(encoding="utf-8"))
    if engine["target"] != args.target or not engine["strictFP"]:
        raise ValueError("引擎构建信息不匹配")
    record = packaging.package(source, args.out, *parts)
    (args.out / "assets.json").write_text(json.dumps([record], indent=2) + "\n", encoding="utf-8")
    print(record["file"])


if __name__ == "__main__":
    main()
