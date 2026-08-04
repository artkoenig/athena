import unittest
import os
import tempfile
import subprocess
import argparse
import unittest.mock

class TestGenerateScript(unittest.TestCase):
    def setUp(self):
        self.script_path = os.path.join(os.path.dirname(__file__), '..', 'generate.py')

    def test_generate_script_exists(self):
        self.assertTrue(os.path.exists(self.script_path), "generate.py does not exist")

    def test_cli_execution(self):
        # The script should execute successfully with --agent and --context
        if not os.path.exists(self.script_path):
            self.fail("generate.py does not exist")
            
        env = os.environ.copy()
        env['TEST_MOCK_API'] = '1'
        result = subprocess.run(['python3', self.script_path, '--agent', 'dispatcher', '--context', 'test context'], capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, f"generate.py failed to execute: {result.stderr}")

    @unittest.mock.patch('google.genai.Client')
    @unittest.mock.patch('argparse.ArgumentParser.parse_args')
    @unittest.mock.patch('tools.handoff.generate.get_issue_directory')
    def test_structured_output_configuration(self, mock_get_issue_dir, mock_parse_args, mock_client_class):
        mock_parse_args.return_value = argparse.Namespace(agent='dispatcher', context='test context')
        import tempfile
        tmp_dir = tempfile.mkdtemp()
        mock_get_issue_dir.return_value = tmp_dir
        
        mock_client_instance = unittest.mock.MagicMock()
        mock_client_class.return_value = mock_client_instance
        mock_response = unittest.mock.MagicMock()
        mock_response.text = '{"some": "json"}'
        mock_client_instance.models.generate_content.return_value = mock_response

        # Execute main
        import tools.handoff.generate as gen_module
        gen_module.main()
        
        # Verify generate_content was called with correct config
        mock_client_instance.models.generate_content.assert_called_once()
        _, kwargs = mock_client_instance.models.generate_content.call_args
        
        self.assertIn('config', kwargs, "generate_content must be called with a config")
        config = kwargs['config']
        
        self.assertEqual(config.response_mime_type, "application/json", "response_mime_type must be application/json")
        self.assertIsNotNone(config.response_schema, "response_schema must be configured for Structured Outputs")
        
        from tools.handoff.models import DispatcherHandoff
        self.assertEqual(config.response_schema, DispatcherHandoff, "response_schema should be DispatcherHandoff")

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
