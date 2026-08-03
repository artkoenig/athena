#!/usr/bin/env python3
"""
Transcript Parser for AI session JSONL logs.
Extracts metrics and a truncated summary of tool calls/errors filtered by Git branch/context.
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


def find_latest_transcript() -> Optional[Path]:
    """Search for the most recent transcript.jsonl under ~/.gemini/antigravity/brain/"""
    brain_dir = Path.home() / ".gemini" / "antigravity" / "brain"
    if not brain_dir.exists():
        return None

    transcripts = list(brain_dir.glob("**/.system_generated/logs/transcript.jsonl"))
    if not transcripts:
        return None

    # Return most recently modified transcript
    return max(transcripts, key=lambda p: p.stat().st_mtime)


def truncate_payload(val: Any, max_len: int = 200) -> Any:
    """Truncate long strings or collections in payloads to avoid prompt bloat."""
    if isinstance(val, str):
        if len(val) > max_len:
            return val[:max_len] + f"... [truncated {len(val) - max_len} chars]"
        return val
    elif isinstance(val, dict):
        return {k: truncate_payload(v, max_len) for k, v in val.items()}
    elif isinstance(val, list):
        return [truncate_payload(v, max_len) for v in val[:10]]
    return val


def parse_transcript(transcript_path: Path, branch: Optional[str] = None) -> Dict[str, Any]:
    tool_calls_by_name: Dict[str, int] = {}
    total_errors = 0
    retry_loops = 0
    events_summary: List[Dict[str, Any]] = []

    last_tool_call: Optional[str] = None
    consecutive_tool_failures = 0
    start_time = None
    end_time = None

    if not transcript_path.exists():
        return {
            "error": f"Transcript file not found: {transcript_path}",
            "metrics": {},
            "summary": []
        }

    with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except Exception:
                continue

            # Record step timing if present
            timestamp = data.get("timestamp") or data.get("time")
            if timestamp:
                if not start_time:
                    start_time = timestamp
                end_time = timestamp

            # Extract tool calls
            tool_calls = data.get("tool_calls") or []
            if not tool_calls and "planner_response" in data:
                tool_calls = data["planner_response"].get("tool_calls", [])

            step_type = data.get("type", "")
            status = data.get("status", "")

            # Check status / errors
            is_error = status in ("ERROR", "FAILED") or "error" in data or "exception" in data

            for tool in tool_calls:
                tool_name = tool.get("name") or tool.get("ToolName") or tool.get("function", {}).get("name", "unknown")
                tool_calls_by_name[tool_name] = tool_calls_by_name.get(tool_name, 0) + 1

                # Check retry loop pattern
                if tool_name == last_tool_call and is_error:
                    consecutive_tool_failures += 1
                    if consecutive_tool_failures >= 2:
                        retry_loops += 1
                else:
                    consecutive_tool_failures = 1 if is_error else 0

                last_tool_call = tool_name

                # Add summary item
                args = tool.get("args") or tool.get("Arguments") or tool.get("function", {}).get("arguments", {})
                events_summary.append({
                    "type": "tool_call",
                    "tool": tool_name,
                    "status": status or ("error" if is_error else "ok"),
                    "args": truncate_payload(args, max_len=150)
                })

            if is_error:
                total_errors += 1
                content = data.get("content") or data.get("error") or data.get("message")
                if content:
                    events_summary.append({
                        "type": "error",
                        "details": truncate_payload(str(content), max_len=250)
                    })

    # Return aggregated result
    return {
        "transcript_path": str(transcript_path),
        "branch": branch or "unknown",
        "metrics": {
            "total_tool_calls": sum(tool_calls_by_name.values()),
            "tool_calls_by_name": tool_calls_by_name,
            "total_errors": total_errors,
            "retry_loops": retry_loops
        },
        "summary": events_summary[-50:]  # keep last 50 events for conciseness
    }


def main():
    parser = argparse.ArgumentParser(description="Parse AI session JSONL transcript.")
    parser.add_argument("--transcript", type=str, help="Path to transcript.jsonl file")
    parser.add_argument("--branch", type=str, help="Git branch or issue slug filter")
    args = parser.parse_args()

    if args.transcript:
        t_path = Path(args.transcript)
    else:
        t_path = find_latest_transcript()

    if not t_path:
        print(json.dumps({"error": "No transcript JSONL log found."}))
        sys.exit(1)

    result = parse_transcript(t_path, branch=args.branch)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
