"""Fetch the pinned LLVM-MinGW toolchain for the Windows capture helper."""
import hashlib
import os
from pathlib import Path
import platform
import shutil
import sys
import tarfile
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
from zipfile import ZipFile

VERSION = "20261104"
BUILDS = {
    "Darwin": ("macos-universal.tar.xz", "66cbd5178c4a71b0d473e68ede172f8eb7d15d023e67f39201d0a69e21f6bf3c"),
    "Windows-x86_64": ("x86_64.zip", "552191b5754c49a5a20723276a6fc56541ea1922c4c50b7b669022333fc1b40f"),
    "Windows-aarch64": ("aarch64.zip", "7d7f8387a8706639b0b47a629d6e23f8b3ef9acce67e9832b8cd4c5bb2816eab"),
}


def prepare(cache):
    system = platform.system()
    if system == "Windows":
        machine = platform.machine().lower()
        system += "-aarch64" if machine in ("aarch64", "arm64") else "-x86_64"
    if system not in BUILDS:
        raise ValueError("Windows 截图辅助程序可在 macOS 或 Windows 上构建")
    suffix, digest = BUILDS[system]
    name = f"llvm-mingw-{VERSION}-ucrt-{suffix}"
    folder = name.removesuffix(".zip").removesuffix(".tar.xz")
    target = cache / folder
    marker = target / "SINAN-SOURCE-SHA256.txt"
    if target.exists():
        if marker.is_file() and marker.read_text().strip() == digest:
            return target
        raise ValueError("截图工具链缓存来源未确认")
    cache.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=cache) as temp:
        work = Path(temp)
        archive = work / name
        url = f"https://github.com/mstorsjo/llvm-mingw/releases/download/{VERSION}/{name}"
        with urlopen(Request(url, headers={"User-Agent": "sinan-screenshot-build"}), timeout=90) as response:
            with archive.open("wb") as output:
                shutil.copyfileobj(response, output)
        with archive.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != digest:
                raise ValueError("截图工具链 SHA-256 不匹配")
        if suffix.endswith(".zip"):
            with ZipFile(archive) as source:
                source.extractall(work)
        else:
            with tarfile.open(archive) as source:
                source.extractall(work, filter="data")
        (work / folder / marker.name).write_text(digest)
        try:
            os.rename(work / folder, target)
        except OSError:
            if not marker.is_file() or marker.read_text().strip() != digest:
                raise
    return target


if __name__ == "__main__":
    print(prepare(Path(sys.argv[1]).resolve()))
