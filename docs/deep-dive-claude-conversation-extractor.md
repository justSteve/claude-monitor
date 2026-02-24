# Deep Dive: claude-conversation-extractor

Research date: 2026-02-24
Repo: [ZeroSumQuant/claude-conversation-extractor](https://github.com/ZeroSumQuant/claude-conversation-extractor)
Stars: 354 | Language: Python | License: MIT

## Summary

Production-ready Python CLI (v1.1.2, 97% test coverage) that exports Claude Code's JSONL session files to Markdown/JSON/HTML with multi-mode search. Demonstrates patterns worth porting to our Bun server.

## Architecture

```
src/
├── extract_claude_logs.py       # Core: JSONL parsing, session discovery, export
│   └── ClaudeConversationExtractor
│       ├── find_sessions()           # Recursive JSONL discovery
│       ├── extract_conversation()    # Parse + optional --detailed mode
│       ├── _extract_text_content()   # Content block handler
│       ├── save_as_markdown/json/html()
│       ├── display_conversation()    # Terminal viewer
│       └── get_conversation_preview()
│
├── search_conversations.py      # Multi-mode search engine
│   ├── ConversationSearcher
│   │   ├── search(query, mode="smart")
│   │   ├── _search_exact()       # Substring matching
│   │   ├── _search_regex()       # Pattern matching
│   │   ├── _search_semantic()    # spaCy lemma-based (optional)
│   │   ├── _search_smart()       # Orchestrator combining all
│   │   ├── _calculate_relevance()
│   │   └── create_search_index() # Pre-processing JSON index
│   └── SearchResult (dataclass)
│
├── realtime_search.py           # Live TUI search with debouncing
│   ├── RealTimeSearch
│   ├── KeyboardHandler          # Cross-platform input
│   └── TerminalDisplay          # ANSI rendering
│
├── interactive_ui.py            # Menu-driven extraction
└── search_cli.py                # Direct CLI entry
```

## JSONL Message Schema

Claude Code JSONL files have one JSON object per line:

```javascript
// User/assistant messages
{ "type": "user"|"assistant", "message": { "role": "...", "content": string|Array }, "timestamp": "ISO8601" }

// Content blocks (when content is array)
{ "type": "text", "text": "..." }
{ "type": "tool_use", "name": "tool_name", "input": {...}, "id": "tool_use_xyz" }
{ "type": "tool_result", "result": { "output": "...", "error": "..." } }

// System messages
{ "type": "system", "message": "...", "timestamp": "ISO8601" }
```

## Tool Call Extraction (--detailed flag)

When `detailed=True`, captures four types:

1. **Tool use blocks**: Tool name + fully serialized input as JSON
2. **Tool results**: Either output (success) or error (failure)
3. **Inline tool use**: Tool invocations inside assistant content arrays
4. **System messages**: Status messages and errors

Key code pattern:
```python
def _extract_text_content(self, content, detailed=False):
    if isinstance(content, str):
        return content
    elif isinstance(content, list):
        text_parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text_parts.append(item.get("text", ""))
            elif detailed and item.get("type") == "tool_use":
                tool_name = item.get("name", "unknown")
                tool_input = item.get("input", {})
                text_parts.append(f"\n Tool: {tool_name}")
                text_parts.append(f"Input: {json.dumps(tool_input, indent=2)}\n")
        return "\n".join(text_parts)
```

## Search Architecture

**Smart mode** (default) combines techniques:
- Exact match bonus: +0.5
- Token overlap (query vs content tokens): +0.4
- Proximity bonus (terms close together): +0.1
- Stop word removal
- Returns all results with relevance > 0.1

**Pre-indexing** creates a JSON manifest:
```json
{
  "conversations": {
    "conversation_id": {
      "path": "...", "modified": "...", "size": N,
      "message_count": N, "speakers": [...],
      "first_message": "...", "last_message": "..."
    }
  }
}
```

**Real-time search** uses 300ms debounce + in-memory cache.

## Session Discovery

```python
def find_sessions(self, project_path=None):
    search_dir = Path.home() / ".claude" / "projects"
    sessions = [f for f in search_dir.rglob("*.jsonl")]
    return sorted(sessions, key=lambda x: x.stat().st_mtime, reverse=True)
```

Preview generation intelligently skips noise (tool results, interruptions, XML tags, command output).

## Gaps (things it doesn't do)

- No persistent indexing (re-scans files each time)
- No vector embeddings (spaCy is lemma-based only)
- No incremental/watch mode
- No artifact-specific search (can't search just code blocks)
- No cross-project context
- No database at all

## Patterns to Port to claude-monitor

### High Priority
1. **Content block extraction** — the `_extract_text_content()` pattern for handling string vs array content with tool_use inline
2. **Multi-mode search** — exact/regex/semantic/smart with relevance scoring
3. **Session preview** — intelligent skipping of noise for session listings
4. **Message type handling** — user, assistant, tool_use, tool_result, system

### Medium Priority
5. **Pre-indexing manifest** — metadata extraction for fast filtering before full-text search
6. **Relevance scoring** — weighted formula (exact + token overlap + proximity)

### Lower Priority
7. **Real-time search debouncing** — useful if we add TUI
8. **spaCy semantic search** — we have CASS for this instead
