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
            manifest = {"id": "fixture.plugin", "name": "剪贴板", "version": "1.0.0", "runtime": {"kind": "declarative"}}
            (source / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            records = [packaging.package(source, out, os, arch) for os, arch in packaging.TARGETS]
            self.assertEqual(len({item["sha256"] for item in records}), 1)
            (source / "backend").mkdir()
            manifest["runtime"] = {"kind": "process", "entry": "backend/plugin"}
            (source / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
            (source / "backend/plugin").write_bytes(executable("linux", "arm64"))
            record = packaging.package(source, out, "linux", "arm64")
            with ZipFile(out / record["file"]) as archive:
                self.assertTrue(archive.getinfo("backend/plugin").external_attr >> 16 & 0o111)
            with self.assertRaises(AssertionError):
                packaging.package(source, out, "windows", "arm64")

    def test_worker_executable_mode_and_architecture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, out = root / "source", root / "out"
            (source / "backend").mkdir(parents=True)
            manifest = {"id": "fixture.worker", "version": "1.0.0", "runtime": {"kind": "process", "entry": "backend/plugin"}}
            (source / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (source / "backend/plugin").write_bytes(executable("linux", "arm64"))
            worker = source / "backend/worker"
            worker.write_bytes(executable("linux", "arm64"))
            record = packaging.package(source, out, "linux", "arm64")
            with ZipFile(out / record["file"]) as archive:
                self.assertTrue(archive.getinfo("backend/worker").external_attr >> 16 & 0o111)
            worker.write_bytes(executable("linux", "amd64"))
            with self.assertRaises(AssertionError):
                packaging.package(source, out, "linux", "arm64")


class OCRLibraryTest(unittest.TestCase):
    def test_ocr_library_requires_matching_architecture_and_type(self):
        for os,arch in packaging.TARGETS:
            data=bytearray(executable(os,arch))
            if os=="darwin":struct.pack_into("<I",data,12,6)
            elif os=="windows":struct.pack_into("<H",data,64+22,0x2000)
            else:struct.pack_into("<H",data,16,3)
            packaging.verify_native(data,os,arch,library=True)
            with self.assertRaises(AssertionError):
                packaging.verify_native(data,os,"amd64" if arch=="arm64" else "arm64",library=True)
            with self.assertRaises(AssertionError):
                packaging.verify_native(executable(os,arch),os,arch,library=True)


class OCRConsoleTest(unittest.TestCase):
    def test_consoleless_pe_subsystem_is_required(self):
        data=bytearray(executable("windows","amd64"));data.extend(bytes(128))
        struct.pack_into("<H",data,64+24,0x20B)
        struct.pack_into("<H",data,64+24+68,2)
        packaging.verify_consoleless(data)
        struct.pack_into("<H",data,64+24+68,3)
        with self.assertRaises(AssertionError):packaging.verify_consoleless(data)
