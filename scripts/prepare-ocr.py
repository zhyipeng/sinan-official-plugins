"""Fetch fixed OCR build inputs; no inference, clipboard access or desktop UI."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import subprocess
import urllib.request
import zipfile

COMMIT = "63bef543c782a0d81db2af056e1dfba550c6dd87"
MODEL_ROOT = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/"
MODELS = {
    "PP-OCRv6_det_small.onnx": ("onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx", "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f"),
    "PP-OCRv6_rec_small.onnx": ("onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx", "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"),
    "dictionary.source.txt": ("paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt", "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d"),
}
TOOLCHAINS = {
    "amd64": ("x86_64", "552191b5754c49a5a20723276a6fc56541ea1922c4c50b7b669022333fc1b40f"),
    "arm64": ("aarch64", "7d7f8387a8706639b0b47a629d6e23f8b3ef9acce67e9832b8cd4c5bb2816eab"),
}


def download(url, destination, sha, limit):
    if destination.exists():
        if hashlib.sha256(destination.read_bytes()).hexdigest() == sha:
            return
        raise ValueError(f"已有文件摘要不符，拒绝覆盖：{destination.name}")
    temporary = destination.with_suffix(destination.suffix + ".partial")
    digest, total = hashlib.sha256(), 0
    try:
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as stream:
            while chunk := response.read(1 << 20):
                total += len(chunk)
                if total > limit:
                    raise ValueError("下载超过固定输入预算")
                stream.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != sha:
            raise ValueError(f"下载摘要不符：{destination.name}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def unpack_toolchain(archive, directory):
    # Python's extractall is deliberately not used for external archives.
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > 60000 or sum(item.file_size for item in entries) > 2 << 30:
            raise ValueError("工具链解压预算超限")
        for item in entries:
            path = PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in item.orig_filename or ":" in item.orig_filename or not path.parts or path.parts[0] != archive.stem:
                raise ValueError("工具链归档路径无效")
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("工具链归档不允许符号链接")
            target = directory.joinpath(*path.parts)
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(item) as inp, target.open("wb") as out:
                    import shutil
                    shutil.copyfileobj(inp, out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("bin/ocr-inputs"))
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    source, models = root / "source", root / "models"
    if not source.exists():
        subprocess.run(["git", "init", str(source)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-C", str(source), "remote", "add", "origin", "https://github.com/RapidAI/RapidOCRLite.git"], check=True)
        subprocess.run(["git", "-C", str(source), "fetch", "--depth=1", "origin", COMMIT], check=True)
        subprocess.run(["git", "-C", str(source), "-c", "core.autocrlf=false", "checkout", "--detach", COMMIT], check=True)
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True)
    if actual != COMMIT or dirty:
        raise ValueError("已有上游源码不是固定的干净提交，拒绝覆盖")
    models.mkdir(exist_ok=True)
    for filename, (relative, sha) in MODELS.items():
        download(MODEL_ROOT + relative, models / filename, sha, 64 << 20)
    dictionary = (models / "dictionary.source.txt").read_bytes().removesuffix(b"\n")
    if hashlib.sha256(dictionary).hexdigest() != "f7aa897ca828a4c7c9e2739c30f9161a33306d532f020bcdb91dcfb664a5507e":
        raise ValueError("字典仅移除末尾换行后摘要不符")
    destination = models / "dictionary.txt"
    if destination.exists() and destination.read_bytes() != dictionary:
        raise ValueError("已有字典已变更，拒绝覆盖")
    destination.write_bytes(dictionary)
    result = {"source": str(source), "models": str(models)}
    if os.name == "nt":
        arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "amd64"
        machine, sha = TOOLCHAINS[arch]
        name = f"llvm-mingw-20261104-ucrt-{machine}"
        archive = root / (name + ".zip")
        download(f"https://github.com/mstorsjo/llvm-mingw/releases/download/20261104/{name}.zip", archive, sha, 256 << 20)
        toolchain = root / name
        marker = toolchain / "SINAN-SOURCE-SHA256.txt"
        if toolchain.exists():
            if not marker.exists() or marker.read_text() != sha:
                raise ValueError("已有工具链来源未确认，拒绝覆盖")
        else:
            unpack_toolchain(archive, root)
            marker.write_text(sha)
        result["toolchain"] = str(toolchain)
    (root / "inputs.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("固定源码、模型、字典与当前平台工具链已校验")


if __name__ == "__main__":
    main()
