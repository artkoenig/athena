#!/usr/bin/env python3
"""
Claude Code JSONL Transcript Parser.
Parses Claude Code native session and subagent logs located in ~/.claude/projects/
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Set


def find_latest_claude_transcript() -> Optional[Path]:
    """Search for the most recent session JSONL file in ~/.claude/projects/"""
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        return None

    # Find main session JSONL files (files at depth 2: ~/.claude/projects/<proj>/<session_uuid>.jsonl)
    transcripts = []
    for proj in projects_dir.iterdir():
        if proj.is_dir():
            for f in proj.glob("*.jsonl"):
                if f.is_file():
                    transcripts.append(f)

    if not transcripts:
        return None

    return max(transcripts, key=lambda p: p.stat().st_mtime)


def truncate_payload(val: Any, max_len: int = 200) -> Any:
    if isinstance(val, str):
        if len(val) > max_len:
            return val[:max_len] + f"... [truncated {len(val) - max_len} chars]"
        return val
    elif isinstance(val, dict):
        return {k: truncate_payload(v, max_len) for k, v in val.items()}
    elif isinstance(val, list):
        return [truncate_payload(v, max_len) for v in val[:10]]
    return val


def parse_claude_file(file_path: Path, source_label: str = "main") -> Dict[str, Any]:
    events: List[Dict[str, Any]] = []

    if not file_path.exists():
        return {"events": []}

    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except Exception:
                continue

            event_type = data.get("type", "")
            status = data.get("status", "")
            is_error = status in ("ERROR", "FAILED") or "error" in data or "exception" in data

            # Extract tool calls (Claude log format uses message.content or tool_calls or planner_response)
            tool_calls = []

            # Format 1: planner_response or tool_calls
            if "tool_calls" in data:
                tool_calls = data["tool_calls"]
            elif "planner_response" in data and isinstance(data["planner_response"], dict):
                tool_calls = data["planner_response"].get("tool_calls", [])

            # Format 2: Claude Assistant message with tool_use blocks
            message = data.get("message")
            if isinstance(message, dict):
                content_blocks = message.get("content", [])
                if isinstance(content_blocks, list):
                    for block in content_blocks:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            tool_calls.append({
                                "name": block.get("name"),
                                "args": block.get("input", {})
                            })

            events.append({
                "source": source_label,
                "data": data,
                "tool_calls": tool_calls,
                "is_error": is_error,
                "status": status,
                "branch": data.get("gitBranch")
            })

    return {"events": events}


def parse_claude_transcript(transcript_path: Path, branch: Optional[str] = None) -> Dict[str, Any]:
    tool_calls_by_name: Dict[str, int] = {}
    subagents_parsed: List[str] = []
    total_errors = 0
    retry_loops = 0
    events_summary: List[Dict[str, Any]] = []

    # 1. Parse main transcript
    main_parsed = parse_claude_file(transcript_path, source_label="main")
    all_events = main_parsed["events"]

    # 2. Check for subagents directory under main session directory
    session_dir = transcript_path.parent / transcript_path.stem
    subagents_dir = session_dir / "subagents"
    if subagents_dir.exists() and subagents_dir.is_dir():
        for sa_file in subagents_dir.glob("*.jsonl"):
            sa_id = sa_file.stem
            subagents_parsed.append(sa_id)
            sa_parsed = parse_claude_file(sa_file, source_label=f"subagent:{sa_id[:12]}")
            all_events.extend(sa_parsed["events"])

    last_tool_call: Optional[str] = None
    consecutive_tool_failures = 0

    for item in all_events:
        source = item["source"]
        is_error = item["is_error"]
        status = item["status"]
        event_branch = item.get("branch")

        # If a branch filter is specified, check if event matches or contains branch
        if branch and event_branch and branch not in event_branch:
            continue

        for tool in item["tool_calls"]:
            tool_name = tool.get("name") or tool.get("ToolName") or tool.get("function", {}).get("name", "unknown")
            tool_calls_by_name[tool_name] = tool_calls_by_name.get(tool_name, 0) + 1

            if tool_name == last_tool_call and is_error:
                consecutive_tool_failures += 1
                if consecutive_tool_failures >= 2:
                    retry_loops += 1
            else:
                consecutive_tool_failures = 1 if is_error else 0

            last_tool_call = tool_name

            args = tool.get("args") or tool.get("input") or tool.get("Arguments") or {}
            events_summary.append({
                "source": source,
                "type": "tool_call",
                "tool": tool_name,
                "status": status or ("error" if is_error else "ok"),
                "args": truncate_payload(args, max_len=150)
            })

        if is_error:
            total_errors += 1
            data = item["data"]
            content = data.get("content") or data.get("error") or data.get("message")
            if content:
                events_summary.append({
                    "source": source,
                    "type": "error",
                    "details": truncate_payload(str(content), max_len=250)
                })

    return {
        "parser": "claude",
        "transcript_path": str(transcript_path),
        "subagents_parsed": subagents_parsed,
        "branch": branch or "unknown",
        "metrics": {
            "total_tool_calls": sum(tool_calls_by_name.values()),
            "tool_calls_by_name": tool_calls_by_name,
            "subagent_count": len(subagents_parsed),
            "total_errors": total_errors,
            "retry_loops": retry_loops
        },
        "summary": events_summary[-60:]
    }
