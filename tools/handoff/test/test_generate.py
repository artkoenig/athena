import unittest
import os
import sys
import tempfile
import json
from unittest.mock import patch
import io
from contextlib import redirect_stderr

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from tools.handoff.generate import main, get_next_filename

class TestGenerateScript(unittest.TestCase):
    def setUp(self):
        self.script_path = os.path.join(os.path.dirname(__file__), '..', 'generate.py')

    def test_generate_script_exists(self):
        self.assertTrue(os.path.exists(self.script_path), "generate.py does not exist")

    def test_no_api_calls_in_source(self):
        with open(self.script_path, 'r') as f:
            content = f.read()
        self.assertNotIn('genai', content, "The script should not import genai")
        self.assertNotIn('TEST_MOCK_API', content, "The script should not mock APIs")
        self.assertNotIn('client.models.generate_content', content, "The script should not call API")

    @patch('tools.handoff.generate.get_issue_directory')
    def test_cli_execution_with_json_string(self, mock_get_issue_dir):
        with tempfile.TemporaryDirectory() as tmpdir:
            mock_get_issue_dir.return_value = tmpdir
            valid_json = json.dumps({
                "technical_specification": "spec",
                "module_map": "map",
                "next_steps": "steps"
            })
            
            test_args = ['generate.py', '--agent', 'dispatcher', '--json-data', valid_json]
            with patch.object(sys, 'argv', test_args):
                main()
                
            self.assertTrue(os.path.exists(os.path.join(tmpdir, 'dispatcher.json')))

    @patch('tools.handoff.generate.get_issue_directory')
    def test_cli_execution_with_json_file(self, mock_get_issue_dir):
        with tempfile.TemporaryDirectory() as tmpdir:
            mock_get_issue_dir.return_value = tmpdir
            
            with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as f:
                json.dump({
                    "status": "rejected",
                    "findings": "fi"
                }, f)
                json_file_path = f.name
                
            try:
                test_args = ['generate.py', '--agent', 'reviewer', '--json-data', json_file_path]
                with patch.object(sys, 'argv', test_args):
                    main()
                    
                self.assertTrue(os.path.exists(os.path.join(tmpdir, 'reviewer.json')))
            finally:
                os.remove(json_file_path)

    def test_cli_invalid_json_validation(self):
        invalid_json = json.dumps({
            "test_plan": "plan"
        })
        test_args = ['generate.py', '--agent', 'test-author', '--json-data', invalid_json]
        
        f = io.StringIO()
        with patch.object(sys, 'argv', test_args), redirect_stderr(f):
            with self.assertRaises(SystemExit) as cm:
                main()
            self.assertEqual(cm.exception.code, 1)
            
        self.assertIn("validation", f.getvalue().lower())

    def test_cli_malformed_json(self):
        test_args = ['generate.py', '--agent', 'test-author', '--json-data', '{malformed']
        
        f = io.StringIO()
        with patch.object(sys, 'argv', test_args), redirect_stderr(f):
            with self.assertRaises(SystemExit) as cm:
                main()
            self.assertEqual(cm.exception.code, 1)
            
        err_out = f.getvalue().lower()
        self.assertTrue("json" in err_out or "decode" in err_out)

    def test_versioning_logic(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            name1 = get_next_filename(tmpdir, "researcher")
            self.assertEqual(name1, "researcher.json")
            
            with open(os.path.join(tmpdir, name1), 'w') as f:
                f.write("{}")
                
            name2 = get_next_filename(tmpdir, "researcher")
            self.assertEqual(name2, "researcher-v1.json")
            
            with open(os.path.join(tmpdir, name2), 'w') as f:
                f.write("{}")
                
            name3 = get_next_filename(tmpdir, "researcher")
            self.assertEqual(name3, "researcher-v2.json")

if __name__ == '__main__':
    unittest.main()
