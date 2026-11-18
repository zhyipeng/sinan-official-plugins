"""Run the packaged Go backend with a synthetic capture helper and simulated clipboard."""
import base64
import json
import platform
import random
import shutil
import struct
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
import zlib

ROOT = Path(__file__).resolve().parents[1]
SYSTEM = {"Darwin": "darwin", "Windows": "windows"}[platform.system()]
ARCH = "arm64" if platform.machine().lower() in ("aarch64", "arm64") else "amd64"
SUFFIX = ".exe" if SYSTEM == "windows" else ""
SOURCE = ROOT / "bin/targets" / f"{SYSTEM}-{ARCH}" / "screenshot/backend" / ("plugin" + SUFFIX)


def chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def exercise(root):
    native = root / ("capture-windows.exe" if SUFFIX else "capture-macos")
    stub = root / "main.go"
    stub.write_text("""package main
import ("os"; "path/filepath")
func main() {
 executable, err := os.Executable()
 if err != nil { os.Exit(5) }
 data, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "fixture.png"))
 if err != nil || os.WriteFile(os.Args[1], data, 0600) != nil { os.Exit(6) }
 os.Exit(8)
}
""")
    linker = ["-ldflags=-H=windowsgui"] if SUFFIX else []
    subprocess.run(["go", "build", *linker, "-o", native, stub], check=True)
    entry = root / SOURCE.name
    shutil.copy2(SOURCE, entry)
    rng = random.Random(75)
    raw = b"".join(b"\0" + rng.randbytes(512 * 4) for _ in range(512))
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 512, 512, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    (root / "fixture.png").write_bytes(data)
    process = subprocess.Popen([entry], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    request_id = writes = 0

    def send(value):
        process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        process.stdin.flush()

    def rpc(method, params):
        nonlocal request_id, writes
        request_id += 1
        send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            line = process.stdout.readline()
            assert line, "plugin exited unexpectedly"
            value = json.loads(line)
            if "method" in value:
                assert value["method"] == "clipboard.write"
                content = value["params"]["content"]
                assert content["kind"] == "image" and base64.b64decode(content["data"]) == data
                writes += 1
                response = {"error": {"code": -32000, "message": "synthetic failure"}} if writes == 1 else {"result": {}}
                send({"jsonrpc": "2.0", "id": value["id"], **response})
                continue
            assert value["id"] == request_id and "error" not in value, value
            return value["result"]

    def command(name, text):
        return json.loads(rpc("command.execute", {"commandId": name, "input": text})["text"])

    try:
        rpc("initialize", {"apiVersion": "1", "pluginId": "tools.screenshot",
                           "hostCapabilities": ["clipboard.v1", "ui.window-execute.v1", "ui.plugin-handoff.v1"]})
        captured = rpc("command.execute", {"commandId": "capture-region", "input": "ocr"})
        assert captured["keepHidden"] and not captured.get("dismiss")
        result = json.loads(captured["text"])
        assert result["action"] == "ocr" and result["size"] == len(data)
        ticket = result["id"]
        read = b"".join(base64.b64decode(command("read", f"{ticket}:{offset}")["data"])
                        for offset in range(0, len(data), 36 * 1024))
        assert read == data
        assert command("copy", ticket).get("error")
        assert command("copy", ticket)["state"] == "done"
        assert command("copy", ticket).get("error"), "capture was replayed"
        assert writes == 2
        process.stdin.close()
        assert process.wait(timeout=5) == 0
        print("截图 stdio 无界面检查通过：OCR 分块、复制重试、消费限制和进程退出")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


with TemporaryDirectory() as work:
    exercise(Path(work))
