import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location("packaging", Path(__file__).resolve().parents[1] / "package.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


def executable(os, arch):
    b = bytearray(128)
    if os == "darwin":
        b[:4] = b"\xcf\xfa\xed\xfe"
        struct.pack_into("<I", b, 4, {"arm64": 0x100000C, "amd64": 0x1000007}[arch])
        struct.pack_into("<I", b, 12, 2)
    elif os == "windows":
        b[:2] = b"MZ"
        struct.pack_into("<I", b, 60, 64)
        b[64:68] = b"PE\0\0"
        struct.pack_into("<H", b, 68, {"arm64": 0xAA64, "amd64": 0x8664}[arch])
    else:
        b[:6] = b"\x7fELF\x02\x01"
        struct.pack_into("<H", b, 16, 2)
        struct.pack_into("<H", b, 18, {"arm64": 183, "amd64": 62}[arch])
    return bytes(b)


class PackageTest(unittest.TestCase):
    def test_native_labels_match_contents(self):
        for os, arch in packaging.TARGETS:
            data = executable(os, arch)
            packaging.verify_native(data, os, arch)
            with self.assertRaises(AssertionError):
                packaging.verify_native(data, os, "amd64" if arch == "arm64" else "arm64")
            with self.assertRaises(AssertionError):
                packaging.verify_native(data[:16], os, arch)

    def test_reproducible_frontend_and_executable_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, out = root / "source", root / "out"
            source.mkdir()
            manifest = {"id": "fixture.plugin", "version": "1.0.0", "runtime": {"kind": "declarative"}}
            (source / "manifest.json").write_text(json.dumps(manifest))
            records = [packaging.package(source, out, os, arch) for os, arch in packaging.TARGETS]
            self.assertEqual(len({item["sha256"] for item in records}), 1)
            (source / "backend").mkdir()
            manifest["runtime"] = {"kind": "process", "entry": "backend/plugin"}
            (source / "manifest.json").write_text(json.dumps(manifest))
            (source / "backend/plugin").write_bytes(executable("linux", "arm64"))
            record = packaging.package(source, out, "linux", "arm64")
            with ZipFile(out / record["file"]) as archive:
                self.assertTrue(archive.getinfo("backend/plugin").external_attr >> 16 & 0o111)
            with self.assertRaises(AssertionError):
                packaging.package(source, out, "windows", "arm64")
