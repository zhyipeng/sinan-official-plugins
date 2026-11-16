# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["psutil==7.2.2"]
# ///
"""Real plugin/worker integration with a synthetic Host API, never the clipboard."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

import psutil


class Host:
    def __init__(self, package, sandbox):
        suffix = ".exe" if sys.platform == "win32" else ""
        command = [str(package / "backend" / ("plugin" + suffix))]
        if sandbox:
            if sys.platform != "darwin":
                raise RuntimeError("OS network wrapper requires macOS")
            command = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)", *command]
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR") if key in os.environ}
        self.p = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=env)
        self.incoming = queue.Queue()
        self.image = b""
        self.next_id = 0
        self.kind = "image"
        self.reads = 0

        def receive():
            for line in self.p.stdout:
                self.incoming.put(json.loads(line))
            self.incoming.put(None)

        self.reader = threading.Thread(target=receive, daemon=True)
        self.reader.start()
        self.rpc("initialize", {"apiVersion": "1", "pluginId": "tools.ocr", "hostCapabilities": ["clipboard.v1", "ui.image-command.v1"]})

    def send(self, message):
        self.p.stdin.write((json.dumps(message) + "\n").encode())
        self.p.stdin.flush()

    def rpc(self, method, params):
        self.next_id += 1
        current = self.next_id
        self.send({"jsonrpc": "2.0", "id": current, "method": method, "params": params})
        while True:
            message = self.incoming.get(timeout=4)
            assert message is not None, "plugin exited before replying"
            if message.get("method"):
                assert message["method"] == "clipboard.read"
                self.reads += 1
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": {
                    "sequence": 1, "content": {"kind": self.kind, "data": base64.b64encode(self.image).decode()}}})
                continue
            assert message["id"] == current and "error" not in message
            return message["result"]

    def command(self, command, value=""):
        return json.loads(self.rpc("command.execute", {"commandId": command, "input": value})["text"])

    def recognize(self, image, snapshot=False):
        self.image = image
        started = time.perf_counter()
        task = json.loads(self.rpc("command.executeImage", {"commandId": "start", "input": "", "image": base64.b64encode(image).decode()})["text"]) if snapshot else self.command("start")
        start_ms = (time.perf_counter() - started) * 1000
        assert task["state"] == "running" and start_ms < 500
        while True:
            value = self.command("poll", task["id"])
            if value["state"] != "running":
                return value, start_ms
            time.sleep(0.1)

    def close(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        self.reader.join(timeout=1)
        self.p.stdout.close()


def wait_worker(host):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        children = psutil.Process(host.p.pid).children()
        if children:
            return children[0]
        time.sleep(0.005)
    raise AssertionError("native worker did not start")


def wait_exit(process):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
            return
        time.sleep(0.01)
    raise AssertionError("orphan worker remained alive")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("package", "corpus", "golden", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--sandbox", action="store_true")
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_text())
    golden = json.loads(args.golden.read_text())["strict_fp"]["cases"]
    normalize = lambda text: "".join(text.split())
    cases = []
    host = Host(args.package.resolve(), args.sandbox)
    try:
        assert host.reads == 0, "normal activation read clipboard without an explicit command"
        for fixture, expected in zip(corpus, golden):
            assert fixture["name"] == expected["name"]
            image = (args.corpus.parent / "images" / (fixture["name"] + ".png")).read_bytes()
            result, start_ms = host.recognize(image)
            assert result["state"] == "done", result.get("error")
            assert normalize(result.get("text", "")) == normalize(expected["actual"]), fixture["name"]
            cases.append({"name": fixture["name"], "matches_native_baseline": True, "start_ms": start_ms,
                          "text_sha256": hashlib.sha256(result.get("text", "").encode()).hexdigest()})
            host.command("cancel", result["id"])
        # The session snapshot must win even if the system clipboard has changed.
        reads = host.reads
        host.kind = "text"
        image = (args.corpus.parent / "images/light.png").read_bytes()
        result, _ = host.recognize(image, snapshot=True)
        assert result["state"] == "done" and host.reads == reads
        assert normalize(result.get("text", "")) == normalize(golden[0]["actual"])
        host.command("cancel", result["id"])
        assert not psutil.Process(host.p.pid).children()
        host.kind = "text"
        result, _ = host.recognize(b"synthetic text")
        assert result["state"] == "failed"
        host.kind = "image"
        dense = (args.corpus.parent / "images/dense.png").read_bytes()
        host.image = dense
        task = host.command("start")
        host.command("poll", task["id"])
        child = wait_worker(host)
        assert host.command("start")["state"] == "failed", "parallel workers admitted"
        assert host.command("cancel", task["id"])["state"] == "cancelled"
        wait_exit(child)
        cancellation = True
    finally:
        host.close()

    host = Host(args.package.resolve(), args.sandbox)
    try:
        host.image = dense
        task = host.command("start")
        host.command("poll", task["id"])
        child = wait_worker(host)
        time.sleep(0.15)
        assert child.is_running()
        started = time.perf_counter()
        host.p.kill()
        host.p.wait(timeout=5)
        wait_exit(child)
        parent_death_ms = (time.perf_counter() - started) * 1000
    finally:
        host.close()

    report = {"cases": cases, "normal_open_did_not_read_clipboard": True,
              "single_worker_enforced": True, "session_image_without_clipboard_read": True, "non_image_rejected": True,
              "explicit_cancel_reaped_worker": cancellation, "backend_kill_worker_exited": True,
              "backend_kill_to_worker_exit_ms": parent_death_ms,
              "os_network_denied": args.sandbox, "real_clipboard_accessed": False}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print("11 synthetic stdio jobs, native baseline, cancellation and backend-death guard passed")


if __name__ == "__main__":
    main()
