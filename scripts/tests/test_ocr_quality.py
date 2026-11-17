import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / "plugins/ocr/tests/quality.py"
spec = importlib.util.spec_from_file_location("ocr_quality", path)
quality = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quality)


class OCRQualityTest(unittest.TestCase):
    def test_correcting_an_arm_reference_error_is_an_improvement(self):
        result = quality.evaluate("go test ./...", "go test /...", "go test ./...")
        self.assertTrue(result["not_worse_than_baseline"])
        self.assertFalse(result["matches_native_baseline"])
        self.assertEqual(result["actual_edits"], 0)
        self.assertEqual(result["baseline_edits"], 1)
        equally_imperfect = quality.evaluate("go test ./...", "go test /...", "go test ./..")
        self.assertTrue(equally_imperfect["not_worse_than_baseline"])
        self.assertFalse(equally_imperfect["matches_native_baseline"])
        self.assertFalse(quality.evaluate("go test ./...", "go test /...", "go test /..")["not_worse_than_baseline"])

    def test_line_loss_and_extra_characters_cannot_hide_behind_layout_errors(self):
        source = "左栏第一行左栏第二行右栏第一行右栏第二行"
        baseline = "左栏第一行右栏第一行左栏第二行右栏第二行"
        self.assertTrue(quality.evaluate(source, baseline, source)["not_worse_than_baseline"])
        self.assertFalse(quality.evaluate(source, baseline, "左栏第一行左栏第二行右栏第一行")["not_worse_than_baseline"])
        self.assertFalse(quality.evaluate("", "", "phantom")["not_worse_than_baseline"])
        self.assertFalse(quality.evaluate("abc", "abc", "abx")["not_worse_than_baseline"])
