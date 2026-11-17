import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("ocr_publish", Path(__file__).resolve().parents[1] / "publish-ocr.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class OCRPublicationTest(unittest.TestCase):
    def test_only_completed_successful_native_runs_from_own_repository_are_eligible(self):
        repo = "zhyipeng/sinan-official-plugins"
        run = {"head_repository": {"full_name": repo}, "path": ".github/workflows/ocr.yml",
               "status": "completed", "conclusion": "success", "head_sha": "a" * 40}
        self.assertEqual(publisher.verify_run(run, repo), "a" * 40)
        for change in [{"conclusion": "failure"}, {"status": "in_progress"},
                       {"path": ".github/workflows/release.yml"},
                       {"head_repository": {"full_name": "other/repo"}}, {"head_sha": "main"}]:
            with self.assertRaises(AssertionError):
                publisher.verify_run(run | change, repo)

    def test_asset_record_cannot_redirect_publication_to_a_different_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            record = {"id": "tools.ocr", "version": "0.2.0", "os": "linux", "arch": "arm64", "file": "../other.zip"}
            (path / "assets.json").write_text(json.dumps([record]))
            with self.assertRaises(AssertionError):
                publisher.validate_target(path, "linux-arm64", "0.2.0")
