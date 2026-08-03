#!/usr/bin/env python3
"""
Unified Transcript Parser for AI session JSONL logs.
Dispatches to Claude Code parser (parse_claude) or Antigravity parser (parse_antigravity),
and produces normalized JSON or Markdown intermediate reports.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

from parse_antigravity import find_latest_antigravity_transcript, parse_antigravity_transcript
from parse_claude import find_latest_claude_transcript, parse_claude_transcript


def to_markdown(data: Dict[str, Any]) -> str:
    lines = []
    engine = data.get("parser", "unknown")
    branch = data.get("branch", "unknown")
    t_path = data.get("transcript_path", "")
    subagents = data.get("subagents_parsed", [])
    metrics = data.get("metrics", {})
    summary = data.get("summary", [])

    lines.append("# AI Session Transcript Report")
    lines.append("")
    lines.append("## Session Metadata")
    lines.append(f"- **Engine**: `{engine}`")
    lines.append(f"- **Branch / Context**: `{branch}`")
    lines.append(f"- **Transcript Path**: `{t_path}`")
    lines.append(f"- **Subagents Parsed**: {len(subagents)} ({', '.join(subagents[:5]) if subagents else 'None'})")
    lines.append("")
    lines.append("## Execution Metrics")
    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Total Tool Calls | {metrics.get('total_tool_calls', 0)} |")
    lines.append(f"| Total Errors | {metrics.get('total_errors', 0)} |")
    lines.append(f"| Retry Loops | {metrics.get('retry_loops', 0)} |")
    lines.append(f"| Subagent Count | {metrics.get('subagent_count', 0)} |")
    lines.append("")

    tool_counts = metrics.get("tool_calls_by_name", {})
    if tool_counts:
        lines.append("### Tool Usage Breakdown")
        lines.append("| Tool | Calls |")
        lines.append("| --- | --- |")
        for tool_name, count in sorted(tool_counts.items(), key=lambda x: x[1], reverse=True):
            lines.append(f"| `{tool_name}` | {count} |")
        lines.append("")

    lines.append("## Activity Timeline & Tool Execution Log")
    for event in summary:
        src = event.get("source", "main")
        ev_type = event.get("type", "")
        if ev_type == "tool_call":
            tool_name = event.get("tool", "unknown")
            status = event.get("status", "ok")
            args = json.dumps(event.get("args", {}))
            lines.append(f"- **[{src}]** `{tool_name}` (status: {status}) — `{args}`")
        elif ev_type == "error":
            details = event.get("details", "")
            lines.append(f"- ⚠️ **[{src}] ERROR**: {details}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Parse AI session JSONL transcript (Claude Code & Antigravity).")
    parser.add_argument("--transcript", type=str, help="Path to transcript.jsonl file")
    parser.add_argument("--branch", type=str, help="Git branch or issue slug filter")
    parser.add_argument("--parser", type=str, choices=["auto", "claude", "antigravity"], default="auto",
                        help="Parser engine to use (default: auto)")
    parser.add_argument("--format", type=str, choices=["json", "markdown"], default="markdown",
                        help="Output format (default: markdown)")
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
        if args.format == "json":
            print(json.dumps({"error": "No transcript JSONL log found."}))
        else:
            print("# AI Session Transcript Report\n\n⚠️ No transcript JSONL log found.")
        sys.exit(1)

    if engine == "auto":
        if ".claude" in str(t_path):
            engine = "claude"
        else:
            engine = "antigravity"

    if engine == "claude":
        result = parse_claude_transcript(t_path, branch=args.branch)
    else:
        result = parse_antigravity_transcript(t_path, branch=args.branch)

    if args.format == "markdown":
        print(to_markdown(result))
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
