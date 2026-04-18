# Root

## Database Location {#conversation-memory-database-location}

```
/home/jommar/.local/share/opencode/opencode.db
```

---

## How to Query {#conversation-memory-how-to-query}

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

---

## Key Tables {#conversation-memory-key-tables}

| Table | Purpose |
|---|---|
| `session` | Conversation sessions (id, title, directory, project_id, timestamps) |
| `message` | Message metadata (role, model, tokens, cost, parentID) |
| `part` | Actual conversation content (text, tool calls, reasoning, step events) |
| `project` | Projects/workspaces (name, directory, VCS, sandboxes) |
| `todo` | Task lists per session |
| `session_entry` | Session-level events (currently unused) |

---

## Last Synced {#conversation-memory-last-synced}

**2026-04-17** (timestamp: `1776372876`)
- Query `time_created > 1776372876` to pick up new conversations since this sync
- 353+ sessions at time of sync covering: codebase analysis, migration work, tech stack design, business brainstorming, MCP tools, wiki documentation

---

## Overview {#conversation-memory-overview}

All past OpenCode conversations are stored locally in an SQLite database. Query this to recover context from previous sessions.

---

## Useful Query Patterns {#conversation-memory-useful-query-patterns}

- **Find sessions by topic:** `SELECT title FROM session WHERE title LIKE '%keyword%'`
- **Get user messages:** Filter parts where message role is "user" (join with message table)
- **Get assistant responses:** Filter parts with `"type":"text"` from assistant messages
- **Get tool calls:** Filter parts with `"type":"tool"` to see what commands were run
- **Get reasoning:** Filter parts with `"type":"reasoning"` to see the AI's thought process
- **Get new sessions since last sync:** `SELECT * FROM session WHERE time_created > {last_sync_timestamp}`

---

## When to Use {#conversation-memory-when-to-use}

- User references something from a past conversation
- Need to recover context not captured in the wiki
- User asks "what did we do last time about X?"
- Verifying decisions or patterns established in prior sessions

---

## Test Section {#test-section}

This is a test section to verify write tools work.

---

## Agent Instructions {#user-wiki-agent-instructions}



---

## Core Strengths {#user-wiki-core-strengths}

- Clean Code
- System Architecture
- Data Migration
- Performance Optimization

---

## Domain Expertise {#user-wiki-domain-expertise}

- Healthcare
- Routing/Logistics
- SaaS
- Integrations

---

## Goals & Interests {#user-wiki-goals-interests}

- **Career:** Open to business ventures and non-pure development roles
- **Business Focus:** Software, Dev-Tools, Automation, AI, SaaS
  - Ideas must be: actionable, profitable, feasible, solve a real pain point
  - Must include: MVP scope and GTM strategy
- **Side Projects:** Building and curating MCP tools for personal workflow optimization, with potential to package and share
- **Learning:** Python (AI/ML ecosystem), AI agents, MCP ecosystem
- **Routine:** Primarily computer-bound; steps away for meals and household chores

---

## Identity {#user-wiki-identity}

- **Name:** Jommar Ilagan
- **Location:** Manila, Metro Manila, Philippines (UTC+8)
- **Role:** Senior Full Stack Developer
- **Experience:** 10 years
- **Work Setup:** Remote

---

## Profiles {#user-wiki-profiles}

- **LinkedIn:** https://www.linkedin.com/in/jommarilagan/
- **GitHub:** https://github.com/jommar

---

## Project Context (from Past Conversations) {#user-wiki-project-context-from-past-conversations}



---

## Tech Stack {#user-wiki-tech-stack}

- **Languages:** JavaScript, TypeScript, Go, Python (learning)
- **Backend:** Node.js, Express, AWS Lambda, Go/Gin
- **Frontend:** Vue, Nuxt, Pinia
- **Database:** MySQL, Redis
- **ORM/Query Builder:** Knex, Objection.js
- **Testing:** Cypress
- **Infrastructure:** Docker, Kafka
- **AI/ML Focus:** AI agents, MCP ecosystem

---

## Workstation {#user-wiki-workstation}

- **OS:** Linux Desktop
- **Displays:** Dual Monitors
- **IDE:** Antigravity
- **Hardware:** Suboptimal local hardware; uses OpenRouter for API-based AI inference
- **AI Tooling:** CLI agents (OpenCode), OpenRouter, MCP tool creation

---

