# Conversation Memory Database

## Overview
All past OpenCode conversations are stored locally in an SQLite database. Query this to recover context from previous sessions.

## Database Location
```
/home/jommar/.local/share/opencode/opencode.db
```

## Key Tables
| Table | Purpose |
|---|---|
| `session` | Conversation sessions (id, title, directory, project_id, timestamps) |
| `message` | Message metadata (role, model, tokens, cost, parentID) |
| `part` | Actual conversation content (text, tool calls, reasoning, step events) |
| `project` | Projects/workspaces (name, directory, VCS, sandboxes) |
| `todo` | Task lists per session |
| `session_entry` | Session-level events (currently unused) |

## How to Query
Use Python (`sqlite3` CLI is not available):

```python
import sqlite3, json

conn = sqlite3.connect('/home/jommar/.local/share/opencode/opencode.db')
cursor = conn.cursor()

# List all sessions
cursor.execute('SELECT id, title, directory, time_created FROM session ORDER BY time_created DESC')
for s in cursor.fetchall():
    print(s)

# Get text content from a specific session
cursor.execute('''
    SELECT p.data, p.time_created
    FROM part p
    WHERE p.session_id = ? AND p.data LIKE '%"type":"text"%'
    ORDER BY p.time_created ASC
''', (session_id,))
for p in cursor.fetchall():
    data = json.loads(p[0])
    print(data.get('text', ''))

conn.close()
```

## Useful Query Patterns
- **Find sessions by topic:** `SELECT title FROM session WHERE title LIKE '%keyword%'`
- **Get user messages:** Filter parts where message role is "user" (join with message table)
- **Get assistant responses:** Filter parts with `"type":"text"` from assistant messages
- **Get tool calls:** Filter parts with `"type":"tool"` to see what commands were run
- **Get reasoning:** Filter parts with `"type":"reasoning"` to see the AI's thought process
- **Get new sessions since last sync:** `SELECT * FROM session WHERE time_created > {last_sync_timestamp}`

## When to Use
- User references something from a past conversation
- Need to recover context not captured in the wiki
- User asks "what did we do last time about X?"
- Verifying decisions or patterns established in prior sessions

## Last Synced
**2026-04-17** (timestamp: `1776372876`)
- Query `time_created > 1776372876` to pick up new conversations since this sync
- 353+ sessions at time of sync covering: codebase analysis, migration work, tech stack design, business brainstorming, MCP tools, wiki documentation
