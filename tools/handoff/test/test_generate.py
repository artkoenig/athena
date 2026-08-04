import unittest
import os
import tempfile
import subprocess
import json

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

    def test_cli_execution_with_json_string(self):
        valid_json = json.dumps({
            "technical_specification": "spec",
            "module_map": "map",
            "next_steps": "steps"
        })
        result = subprocess.run(
            ['python3', self.script_path, '--agent', 'dispatcher', '--json-data', valid_json],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"generate.py failed with string: {result.stderr}")
        # Not strictly checking output file location since it writes to latest issue dir

    def test_cli_execution_with_json_file(self):
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json') as f:
            json.dump({
                "status": "st",
                "findings": "fi"
            }, f)
            json_file_path = f.name
            
        try:
            result = subprocess.run(
                ['python3', self.script_path, '--agent', 'reviewer', '--json-data', json_file_path],
                capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0, f"generate.py failed with file: {result.stderr}")
        finally:
            os.remove(json_file_path)

    def test_cli_invalid_json_validation(self):
        # Missing coverage_requirements for test-author
        invalid_json = json.dumps({
            "test_plan": "plan"
        })
        result = subprocess.run(
            ['python3', self.script_path, '--agent', 'test-author', '--json-data', invalid_json],
            capture_output=True, text=True
        )
        self.assertNotEqual(result.returncode, 0, "generate.py should fail when JSON is missing required fields")
        self.assertIn("validation", result.stderr.lower(), "Should output validation error message")

    def test_cli_malformed_json(self):
        result = subprocess.run(
            ['python3', self.script_path, '--agent', 'test-author', '--json-data', '{malformed'],
            capture_output=True, text=True
        )
        self.assertNotEqual(result.returncode, 0, "generate.py should fail when JSON is malformed")
        # Should mention json parsing error
        self.assertTrue("json" in result.stderr.lower() or "decode" in result.stderr.lower(), 
                        "Should mention JSON decoding error")

    def test_versioning_logic(self):
        try:
            from tools.handoff.generate import get_next_filename
        except ImportError:
            self.fail("Could not import get_next_filename from tools.handoff.generate")
            
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
