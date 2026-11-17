import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

spec = importlib.util.spec_from_file_location("ocr_inputs", Path(__file__).resolve().parents[1] / "prepare-ocr.py")
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


class OCRInputTest(unittest.TestCase):
    def test_cached_mismatch_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"user change")
            with self.assertRaises(ValueError):
                inputs.download("https://example.invalid/not-requested", path, "0" * 64, 128)
            self.assertEqual(path.read_bytes(), b"user change")
            inputs.download("https://example.invalid/not-requested", path, hashlib.sha256(path.read_bytes()).hexdigest(), 128)

    def test_toolchain_archive_cannot_escape_or_write_other_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "toolchain.zip"
            for path in ["../escaped", "/absolute", "source/user.cpp", "toolchain/../../source", "toolchain/C:/file", "toolchain\\escape"]:
                with ZipFile(archive, "w") as stream:
                    stream.writestr(path, b"data")
                with self.assertRaises(ValueError):
                    inputs.unpack_toolchain(archive, root / "out")
            with ZipFile(archive, "w") as stream:
                stream.writestr("toolchain/bin/compiler.exe", b"fixture")
            inputs.unpack_toolchain(archive, root / "out")
            self.assertEqual((root / "out/toolchain/bin/compiler.exe").read_bytes(), b"fixture")
