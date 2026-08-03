#!/usr/bin/env python3
"""
Antigravity / Gemini JSONL Transcript Parser.
Parses Antigravity session and subagent logs located in ~/.gemini/antigravity/brain/
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Set


def find_latest_antigravity_transcript() -> Optional[Path]:
    """Search for the most recent transcript.jsonl under ~/.gemini/antigravity/brain/"""
    brain_dir = Path.home() / ".gemini" / "antigravity" / "brain"
    if not brain_dir.exists():
        return None

    transcripts = list(brain_dir.glob("**/.system_generated/logs/transcript.jsonl"))
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


def parse_single_file(file_path: Path, source_label: str = "main") -> Dict[str, Any]:
    events: List[Dict[str, Any]] = []
    subagent_ids: Set[str] = set()

    if not file_path.exists():
        return {"events": [], "subagent_ids": []}

    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except Exception:
                continue

            tool_calls = data.get("tool_calls") or []
            if not tool_calls and "planner_response" in data:
                tool_calls = data["planner_response"].get("tool_calls", [])

            status = data.get("status", "")
            is_error = status in ("ERROR", "FAILED") or "error" in data or "exception" in data

            for tool in tool_calls:
                name = tool.get("name") or tool.get("ToolName") or tool.get("function", {}).get("name", "")
                if name in ("invoke_subagent", "default_api:invoke_subagent"):
                    res = data.get("content") or tool.get("result") or ""
                    if isinstance(res, str):
                        for word in res.split():
                            clean_word = word.strip('",:{}[]')
                            if len(clean_word) == 36 and "-" in clean_word:
                                subagent_ids.add(clean_word)

            events.append({
                "source": source_label,
                "data": data,
                "tool_calls": tool_calls,
                "is_error": is_error,
                "status": status
            })

    return {"events": events, "subagent_ids": list(subagent_ids)}


def parse_antigravity_transcript(transcript_path: Path, branch: Optional[str] = None) -> Dict[str, Any]:
    tool_calls_by_name: Dict[str, int] = {}
    subagents_parsed: List[str] = []
    total_errors = 0
    retry_loops = 0
    events_summary: List[Dict[str, Any]] = []

    brain_dir = Path.home() / ".gemini" / "antigravity" / "brain"
    main_parsed = parse_single_file(transcript_path, source_label="main")
    all_parsed_events = main_parsed["events"]

    subagent_ids_to_check = set(main_parsed["subagent_ids"])

    if brain_dir.exists():
        main_mtime = transcript_path.stat().st_mtime if transcript_path.exists() else 0
        for sub_log in brain_dir.glob("*/.system_generated/logs/transcript.jsonl"):
            if sub_log.resolve() != transcript_path.resolve():
                if abs(sub_log.stat().st_mtime - main_mtime) < 7200:
                    conv_id = sub_log.parent.parent.parent.name
                    subagent_ids_to_check.add(conv_id)

    for sa_id in subagent_ids_to_check:
        sa_path = brain_dir / sa_id / ".system_generated" / "logs" / "transcript.jsonl"
        if sa_path.exists():
            subagents_parsed.append(sa_id)
            sa_parsed = parse_single_file(sa_path, source_label=f"subagent:{sa_id[:8]}")
            all_parsed_events.extend(sa_parsed["events"])

    last_tool_call: Optional[str] = None
    consecutive_tool_failures = 0

    for item in all_parsed_events:
        source = item["source"]
        is_error = item["is_error"]
        status = item["status"]

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

            args = tool.get("args") or tool.get("Arguments") or tool.get("function", {}).get("arguments", {})
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
        "parser": "antigravity",
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
