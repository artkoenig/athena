import argparse
import os
import glob
import json

def get_next_filename(directory, agent):
    base_name = f"{agent}.json"
    if not os.path.exists(os.path.join(directory, base_name)):
        return base_name
    
    version = 1
    while os.path.exists(os.path.join(directory, f"{agent}-v{version}.json")):
        version += 1
    return f"{agent}-v{version}.json"

def get_issue_directory():
    # Find the most recently modified directory in Issues/ that contains issue.md
    issues_dir = os.path.join(os.getcwd(), 'Issues')
    if not os.path.exists(issues_dir):
        # Fallback to docs/issues/
        issues_dir = os.path.join(os.getcwd(), 'docs', 'issues')
        if not os.path.exists(issues_dir):
            raise RuntimeError("Issues directory not found")
            
    candidates = []
    for root, dirs, files in os.walk(issues_dir):
        if 'issue.md' in files:
            candidates.append(root)
            
    if not candidates:
        raise RuntimeError("No active issue directory found")
        
    candidates.sort(key=lambda x: os.path.getmtime(os.path.join(x, 'issue.md')), reverse=True)
    return candidates[0]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--agent', required=True)
    parser.add_argument('--context', required=True)
    args = parser.parse_args()

    import sys
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    from tools.handoff.models import DispatcherHandoff, ImplementerHandoff, ReviewerHandoff, TestAuthorHandoff
    from google import genai

    agent_model_map = {
        'dispatcher': DispatcherHandoff,
        'implementer': ImplementerHandoff,
        'reviewer': ReviewerHandoff,
        'test-author': TestAuthorHandoff
    }

    if args.agent not in agent_model_map:
        raise ValueError(f"Unknown agent: {args.agent}")

    model_class = agent_model_map[args.agent]
    
    if os.environ.get('TEST_MOCK_API') == '1':
        import unittest.mock
        client = unittest.mock.MagicMock()
        mock_response = unittest.mock.MagicMock()
        mock_response.text = '{"status": "mocked"}'
        client.models.generate_content.return_value = mock_response
    else:
        client = genai.Client()
    
    prompt = f"You are the {args.agent} agent. Generate a structured handoff based on the following context:\n\n{args.context}"
    
    response = client.models.generate_content(
        model='gemini-2.5-flash',
        contents=prompt,
        config=genai.types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=model_class
        )
    )
    
    issue_dir = get_issue_directory()
    out_name = get_next_filename(issue_dir, args.agent)
    out_path = os.path.join(issue_dir, out_name)
    
    with open(out_path, 'w') as f:
        f.write(response.text)
        
    print(f"Handoff saved to {out_path}")

if __name__ == '__main__':
    main()
