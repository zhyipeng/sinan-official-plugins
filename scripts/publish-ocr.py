"""Manually publish six OCR artifacts from one successful native validation run.

Only parses archives and metadata. Never runs downloaded native programs.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ocr_packaging", ROOT / "scripts/package.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)
TARGETS = [f"{os}-{arch}" for os, arch in packaging.TARGETS]
MODELS = {"det.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
          "rec.onnx": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
          "dictionary.txt": "f7aa897ca828a4c7c9e2739c30f9161a33306d532f020bcdb91dcfb664a5507e"}


def gh(*args, allow_failure=False):
    result = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
    if result.returncode:
        if allow_failure:
            return None
        raise RuntimeError(f"GitHub {args[0]} operation failed ({result.returncode})")
    return result.stdout


def verify_run(run, repository):
    assert repository == "zhyipeng/sinan-official-plugins", "发布仓库不符"
    assert run["head_repository"]["full_name"] == repository, "不能从其他仓库发布"
    assert run["path"] == ".github/workflows/ocr.yml", "不是 OCR 原生验证工作流"
    assert run["status"] == "completed" and run["conclusion"] == "success", "六目标验证未全部成功"
    assert re.fullmatch(r"[a-f0-9]{40}", run["head_sha"]), "源码提交无效"
    return run["head_sha"]


def validate_target(directory, target, version):
    records = json.loads((directory / "assets.json").read_text(encoding="utf-8"))
    assert len(records) == 1
    record = records[0]
    os_name, arch = target.split("-")
    expected = f"tools.ocr-{version}-{target}.zip"
    assert record["id"] == "tools.ocr" and record["version"] == version
    assert record["os"] == os_name and record["arch"] == arch and record["file"] == expected
    archive = directory / expected
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert archive.stat().st_size == record["size"] <= 64 << 20
    assert digest == record["sha256"]
    assert (directory / (expected + ".sha256")).read_text().split()[0] == digest
    report = json.loads((directory / "validation.json").read_text(encoding="utf-8"))
    assert len(report["cases"]) == 11
    assert {case["name"] for case in report["cases"]} == {"light", "dark", "small_12px", "low_contrast", "rotated_3deg", "transparent", "terminal", "dense", "two_columns", "table", "blank"}
    assert all(case["quality"]["not_worse_than_baseline"] and case["stable_repeated_output"] for case in report["cases"])
    for key in ["normal_open_did_not_read_clipboard", "single_worker_enforced", "session_image_without_clipboard_read",
                "non_image_rejected", "explicit_cancel_reaped_worker", "backend_kill_worker_exited"]:
        assert report[key] is True, key
    assert report["real_clipboard_accessed"] is False
    if os_name == "darwin":
        assert report["os_network_denied"] is True
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        assert len(entries) <= 2048 and sum(item.file_size for item in entries) <= 64 << 20
        names = [item.filename for item in entries]
        assert len(set(name.casefold() for name in names)) == len(names), "归档路径重复"
        for item in entries:
            path = PurePosixPath(item.filename)
            assert not path.is_absolute() and ".." not in path.parts and ":" not in item.orig_filename and "\\" not in item.orig_filename
            assert (item.external_attr >> 16) & 0o170000 != 0o120000
        manifest = json.loads(package.read("manifest.json"))
        suffix = ".exe" if os_name == "windows" else ""
        assert manifest["id"] == "tools.ocr" and manifest["version"] == version
        assert manifest["runtime"] == {"kind": "process", "entry": "backend/plugin" + suffix}
        for name in ["backend/plugin" + suffix, "backend/ocr-worker" + suffix]:
            payload = package.read(name)
            packaging.verify_native(payload, os_name, arch)
            if os_name == "windows":
                packaging.verify_ocr_consoleless(payload)
            assert package.getinfo(name).external_attr >> 16 & 0o111
        for name in names:
            if name.endswith((".dll", ".dylib", ".so")) or ".so." in name:
                packaging.verify_native(package.read(name), os_name, arch, library=True)
        for name, sha in MODELS.items():
            assert hashlib.sha256(package.read("models/" + name)).hexdigest() == sha
        for name in ["THIRD_PARTY_NOTICES.txt", "APACHE-2.0.txt", "GO-LICENSE.txt", "LICENSE"]:
            assert len(package.read(name)) > 500
        engine = json.loads(package.read("ENGINE.json"))
        assert engine["target"] == target and engine["strictFP"] and engine["utf8FilesystemPaths"]
        assert engine["commit"] == "63bef543c782a0d81db2af056e1dfba550c6dd87"
        if os_name == "windows":
            assert "RUNTIME-LICENSES/LLVM-LICENSE.txt" in names and "RUNTIME-LICENSES/COPYING.MinGW-w64-runtime.txt" in names
    return record, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-run", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--artifacts", type=Path, default=ROOT / "dist/ocr-native")
    args = parser.parse_args()
    repository = os.environ.get("GH_REPO", "")
    run_id = os.environ.get("OCR_NATIVE_RUN_ID", "")
    assert re.fullmatch(r"[0-9]{1,20}", run_id), "原生验证 run ID 无效"
    run = json.loads(gh("api", f"repos/{repository}/actions/runs/{run_id}"))
    commit = verify_run(run, repository)
    if args.check_run:
        print("成功的 OCR 原生 run 与源码身份已核验")
        return
    source = json.loads(gh("api", f"repos/{repository}/contents/plugins/ocr/manifest.json?ref={commit}"))
    manifest = json.loads(base64.b64decode(source["content"]))
    version = manifest["version"]
    assert manifest["id"] == "tools.ocr" and re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version)
    records, reports = [], {}
    for target in TARGETS:
        record, report = validate_target(args.artifacts / ("ocr-" + target), target, version)
        records.append(record)
        reports[target] = report
    if args.validate_only:
        print("六目标 ZIP、模型、运行库、质量与回收报告均通过静态核验")
        return
    output = ROOT / "dist/ocr-release"
    output.mkdir(parents=True, exist_ok=True)
    files = []
    for record in records:
        directory = args.artifacts / ("ocr-" + record["os"] + "-" + record["arch"])
        for name in [record["file"], record["file"] + ".sha256"]:
            destination = output / name
            shutil.copyfile(directory / name, destination)
            files.append(destination)
    for name, value in [("assets.json", records), ("VALIDATION.json", {"commit": commit, "nativeRunId": int(run_id), "targets": reports})]:
        destination = output / name
        destination.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        files.append(destination)
    sums = output / "SHA256SUMS.txt"
    sums.write_text("".join(f"{record['sha256']}  {record['file']}\n" for record in records), encoding="utf-8")
    files.append(sums)
    tag = "tools.ocr-v" + version
    existing = gh("release", "view", tag, "--json", "isDraft,assets", allow_failure=True)
    if existing is not None:
        assert json.loads(existing)["isDraft"], "已公开发行禁止覆盖"
    tagged = gh("api", f"repos/{repository}/commits/{tag}", "--jq", ".sha", allow_failure=True)
    if tagged is None:
        gh("api", "--method", "POST", f"repos/{repository}/git/refs", "-f", "ref=refs/tags/" + tag, "-f", "sha=" + commit)
    else:
        assert tagged.strip() == commit, "已有标签对应其他源码，拒绝发布"
    notes = output / "release-notes.md"
    notes.write_text(f"""文字识别 {version}：六目标原生发行。\n\n最低宿主 Sinan 0.3.1。提供 macOS、Windows、Linux 的 arm64/amd64 六个独立原生包。macOS 采用 12.0 构建目标（旧系统实机未验收）；Windows 使用 UCRT 与包内运行库；Linux 基线为 Ubuntu 24.04/glibc 2.39，系统 libstdc++ 需满足该基线。Linux 剪贴板另需 X11/xclip 或 Wayland/wl-clipboard。\n\n[原生验证](https://github.com/{repository}/actions/runs/{run_id})：各 runner 从含中文/空格路径的实际 ZIP 运行真实 worker；11 张合成图每图两次，源文本错误与字符差不劣于既有基准，并核验取消及父进程退出回收。ARM 与 x86 的终端样本均可能漏一个点，位置不同；阅读顺序和标点仍需人工检查。差异见 VALIDATION.json。macOS 系统级禁网通过，Windows/Linux 未执行 OS 级禁网。\n\n没有进行真实桌面/WebView、输入法、系统剪贴板、权限或多屏交互验收。模型、引擎、字典及运行库来源与许可均在包内。SHA-256 见 SHA256SUMS.txt；已有 0.1.0 资产保持不变。\n""", encoding="utf-8")
    if existing is None:
        gh("release", "create", tag, "--draft", "--verify-tag", "--title", "文字识别 " + version, "--notes-file", str(notes))
    pending = files
    if existing is not None:
        uploaded = {asset["name"]: asset for asset in json.loads(existing)["assets"]}
        assert set(uploaded) <= {file.name for file in files}, "草稿有未知资产，拒绝修改"
        pending = []
        for file in files:
            if file.name not in uploaded:
                pending.append(file)
            else:
                assert uploaded[file.name]["size"] == file.stat().st_size
                assert uploaded[file.name]["digest"] == "sha256:" + hashlib.sha256(file.read_bytes()).hexdigest(), "草稿已有资产不匹配，拒绝覆盖"
    if pending:
        gh("release", "upload", tag, *map(str, pending))  # Never use --clobber.

    gh("release", "edit", tag, "--draft=false", "--latest=false", "--notes-file", str(notes))
    published = json.loads(gh("api", f"repos/{repository}/releases/tags/{tag}"))
    assert not published["draft"] and not published["prerelease"]
    remote = {asset["name"]: asset for asset in published["assets"]}
    assert set(remote) == {file.name for file in files}
    for file in files:
        assert remote[file.name]["size"] == file.stat().st_size
        assert remote[file.name]["digest"] == "sha256:" + hashlib.sha256(file.read_bytes()).hexdigest()
    published["sourceCommit"] = commit
    published["nativeRunId"] = int(run_id)
    published["minHostVersion"] = "0.3.1"
    (output / "published.json").write_text(json.dumps(published, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(published["html_url"])


if __name__ == "__main__":
    main()
