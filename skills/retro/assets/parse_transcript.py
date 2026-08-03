#!/usr/bin/env python3
"""
Unified Transcript Parser for AI session JSONL logs.
Dispatches to Claude Code parser (parse_claude) or Antigravity parser (parse_antigravity).
"""

import argparse
import json
import sys
from pathlib import Path

from parse_antigravity import find_latest_antigravity_transcript, parse_antigravity_transcript
from parse_claude import find_latest_claude_transcript, parse_claude_transcript


def main():
    parser = argparse.ArgumentParser(description="Parse AI session JSONL transcript (Claude Code & Antigravity).")
    parser.add_argument("--transcript", type=str, help="Path to transcript.jsonl file")
    parser.add_argument("--branch", type=str, help="Git branch or issue slug filter")
    parser.add_argument("--parser", type=str, choices=["auto", "claude", "antigravity"], default="auto",
                        help="Parser engine to use (default: auto)")
    args = parser.parse_args()

    engine = args.parser
    t_path = Path(args.transcript) if args.transcript else None

    # Auto-detect if path or engine not explicit
    if not t_path:
        if engine == "claude":
            t_path = find_latest_claude_transcript()
        elif engine == "antigravity":
            t_path = find_latest_antigravity_transcript()
        else:
            # Auto: prefer latest modified log between Claude and Antigravity
            c_path = find_latest_claude_transcript()
            a_path = find_latest_antigravity_transcript()
            if c_path and a_path:
                t_path = c_path if c_path.stat().st_mtime > a_path.stat().st_mtime else a_path
                engine = "claude" if t_path == c_path else "antigravity"
            elif c_path:
                t_path = c_path
                engine = "claude"
            elif a_path:
                t_path = a_path
                engine = "antigravity"

    if not t_path or not t_path.exists():
        print(json.dumps({"error": "No transcript JSONL log found."}))
        sys.exit(1)

    # If engine still auto, determine from path
    if engine == "auto":
        if ".claude" in str(t_path):
            engine = "claude"
        else:
            engine = "antigravity"

    if engine == "claude":
        result = parse_claude_transcript(t_path, branch=args.branch)
    else:
        result = parse_antigravity_transcript(t_path, branch=args.branch)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
