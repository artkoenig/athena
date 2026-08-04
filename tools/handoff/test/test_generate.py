import unittest
import os
import tempfile
import subprocess

class TestGenerateScript(unittest.TestCase):
    def setUp(self):
        self.script_path = os.path.join(os.path.dirname(__file__), '..', 'generate.py')

    def test_generate_script_exists(self):
        self.assertTrue(os.path.exists(self.script_path), "generate.py does not exist")

    def test_cli_arguments(self):
        # The script should accept --agent and --context
        if not os.path.exists(self.script_path):
            self.fail("generate.py does not exist")
            
        result = subprocess.run(['python3', self.script_path, '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, "generate.py should run and display help")
        self.assertIn('--agent', result.stdout)
        self.assertIn('--context', result.stdout)

    def test_versioning_logic(self):
        # Try to import a helper function for versioning from generate.py
        try:
            from tools.handoff.generate import get_next_filename
        except ImportError:
            self.fail("Could not import get_next_filename from tools.handoff.generate")
            
        with tempfile.TemporaryDirectory() as tmpdir:
            # First file
            name1 = get_next_filename(tmpdir, "researcher")
            self.assertEqual(name1, "researcher.json")
            
            # Create that file
            with open(os.path.join(tmpdir, name1), 'w') as f:
                f.write("{}")
                
            # Second file
            name2 = get_next_filename(tmpdir, "researcher")
            self.assertEqual(name2, "researcher-v1.json")
            
            with open(os.path.join(tmpdir, name2), 'w') as f:
                f.write("{}")
                
            # Third file
            name3 = get_next_filename(tmpdir, "researcher")
            self.assertEqual(name3, "researcher-v2.json")

if __name__ == '__main__':
    unittest.main()
