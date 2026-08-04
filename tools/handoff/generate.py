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
    # Find the most recently modified directory in docs/issues/ that contains issue.md
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
    parser.add_argument('--json-data', required=True)
    args = parser.parse_args()

    import sys
    from pydantic import ValidationError
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    from tools.handoff.models import DispatcherHandoff, ImplementerHandoff, ReviewerHandoff, TestAuthorHandoff

    agent_model_map = {
        'dispatcher': DispatcherHandoff,
        'implementer': ImplementerHandoff,
        'reviewer': ReviewerHandoff,
        'test-author': TestAuthorHandoff
    }

    if args.agent not in agent_model_map:
        print(f"Unknown agent: {args.agent}", file=sys.stderr)
        sys.exit(1)

    model_class = agent_model_map[args.agent]
    
    json_string = args.json_data
    if os.path.isfile(args.json_data):
        try:
            with open(args.json_data, 'r') as f:
                json_string = f.read()
        except Exception as e:
            print(f"Error reading file {args.json_data}: {e}", file=sys.stderr)
            sys.exit(1)
            
    try:
        json_obj = json.loads(json_string)
    except json.JSONDecodeError as e:
        print(f"JSON decode error: {e}", file=sys.stderr)
        sys.exit(1)
        
    try:
        validated_model = model_class.model_validate(json_obj)
    except ValidationError as e:
        print(f"Validation error:\n{e}", file=sys.stderr)
        sys.exit(1)
    
    issue_dir = get_issue_directory()
    out_name = get_next_filename(issue_dir, args.agent)
    out_path = os.path.join(issue_dir, out_name)
    
    with open(out_path, 'w') as f:
        f.write(validated_model.model_dump_json(indent=2))
        
    print(f"Handoff saved to {out_path}")

if __name__ == '__main__':
    main()
