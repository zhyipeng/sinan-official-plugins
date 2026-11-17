"""Test exit observation without a live worker or a psutil installation."""
import ast
from pathlib import Path
import types
import unittest
from unittest.mock import Mock

class Gone(Exception):
    pass

class ProcessObservationTests(unittest.TestCase):
    def function(self):
        script = Path(__file__).resolve().parents[2] / 'plugins/ocr/tests/stdio-smoke.py'
        function = next(node for node in ast.parse(script.read_text(encoding='utf-8')).body if isinstance(node, ast.FunctionDef) and node.name == 'wait_exit')
        namespace = {'psutil': types.SimpleNamespace(NoSuchProcess=Gone, STATUS_ZOMBIE='zombie'), 'time': types.SimpleNamespace(monotonic=Mock(side_effect=[0, .1, 6]), sleep=Mock())}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(script), 'exec'), namespace)
        return namespace['wait_exit'], namespace

    def test_exit_between_observations_is_success(self):
        wait, _ = self.function()
        wait(types.SimpleNamespace(is_running=lambda: True, status=Mock(side_effect=Gone())))

    def test_surviving_worker_still_fails(self):
        wait, _ = self.function()
        with self.assertRaisesRegex(AssertionError, 'orphan worker'):
            wait(types.SimpleNamespace(is_running=lambda: True, status=lambda: 'running'))

    def test_permission_errors_are_not_hidden(self):
        wait, _ = self.function()
        with self.assertRaises(PermissionError):
            wait(types.SimpleNamespace(is_running=lambda: True, status=Mock(side_effect=PermissionError())))
