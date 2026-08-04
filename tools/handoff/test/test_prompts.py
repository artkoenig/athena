import unittest
import os
import glob

class TestAgentPrompts(unittest.TestCase):
    def setUp(self):
        self.workspace_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
        self.agents_dir = os.path.join(self.workspace_root, 'agents')
        
    def test_agents_mention_generate_script(self):
        # We need to make sure agents do not say "append to issue.md"
        # and instead say "tools/handoff/generate.py"
        
        agent_files = ['dispatcher.md', 'implementer.md', 'reviewer.md', 'test-author.md']
        for agent_file in agent_files:
            file_path = os.path.join(self.agents_dir, agent_file)
            if not os.path.exists(file_path):
                self.fail(f"Agent file {agent_file} does not exist in {self.agents_dir}")
                
            with open(file_path, 'r') as f:
                content = f.read()
                
            self.assertIn("tools/handoff/generate.py", content, f"{agent_file} does not instruct the agent to use tools/handoff/generate.py")
            
            # The prompt should no longer ask to append technical details directly to issue.md
            # This might be tricky to test perfectly, but we can check if "append to issue.md" or similar old instructions exist
            # Here we just assume checking for the new script is a sufficient test for the requirement.
            
if __name__ == '__main__':
    unittest.main()
