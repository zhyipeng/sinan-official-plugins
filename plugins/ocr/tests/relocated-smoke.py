"""Verify the actual ZIP after relocation, including Unicode/space paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", required=True, type=Path)
    args = parser.parse_args()
    artifacts = args.artifacts.resolve()
    records = json.loads((artifacts / "assets.json").read_text(encoding="utf-8"))
    assert len(records) == 1
    record = records[0]
    archive = artifacts / record["file"]
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == record["sha256"]
    tests = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="sinan-ocr-relocate-") as directory:
        package = Path(directory) / "中文 path" / "ocr"
        package.mkdir(parents=True)
        with zipfile.ZipFile(archive) as source:
            assert sum(item.file_size for item in source.infolist()) <= 64 << 20
            for item in source.infolist():
                path = PurePosixPath(item.filename)
                assert not path.is_absolute() and ".." not in path.parts and ":" not in item.filename and "\\" not in item.filename
                destination = package.joinpath(*path.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read(item))
                if os.name != "nt":
                    destination.chmod((item.external_attr >> 16) & 0o777)
        arguments = [sys.executable, str(tests / "stdio-smoke.py"), "--package", str(package),
                     "--corpus", str(tests / "fixtures/corpus.json"),
                     "--golden", str(tests / "fixtures/golden.json"),
                     "--out", str(artifacts / "validation.json")]
        if sys.platform == "darwin":
            arguments.append("--sandbox")
        subprocess.run(arguments, check=True, timeout=300)
    print("ZIP relocated to a Unicode/space path and real native jobs passed")


if __name__ == "__main__":
    main()
