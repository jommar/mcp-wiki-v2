#!/usr/bin/env bash

# cd to script directory so compose commands work from anywhere
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; }
fail() { printf "  ${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
info() { printf "  ${CYAN}→${NC} %s\n" "$1"; }

echo ""
echo "wiki-v2 — starting up"
echo "─────────────────────"
echo ""

# 1. Check docker
if ! command -v docker &>/dev/null; then
  fail "Docker not found. Install from: https://docs.docker.com/get-docker/"
fi

# 2. Detect compose command
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  fail "docker compose not available. Update Docker or install docker-compose."
fi

ok "Docker ready  (compose: $COMPOSE)"
echo ""

# 3. Pull latest changes
if git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  echo "Pulling latest changes..."
  git pull || info "git pull failed (offline or no remote?) — continuing with local version"
  echo ""
fi

# 4. Restart containers
echo "Restarting containers..."
$COMPOSE down --remove-orphans
$COMPOSE up -d
echo ""

# 5. Wait for wiki-server to be running (up to 30s)
info "Waiting for wiki-server..."
READY=0
for i in $(seq 1 30); do
  STATUS=$(docker inspect --format='{{.State.Status}}' wiki-v2-server 2>/dev/null || true)
  if [ "$STATUS" = "running" ]; then
    READY=1
    break
  fi
  sleep 1
done
[ "$READY" -eq 0 ] && fail "wiki-v2-server did not start. Check: docker logs wiki-v2-server"

# 6. Install deps if missing
if [ ! -d "node_modules" ]; then
  info "node_modules missing — running npm install inside container..."
  docker exec wiki-v2-server npm install
  ok "Dependencies installed"
fi

# 7. Container status
echo "Containers:"
for name in wiki-v2-db wiki-v2-server wiki-v2-cron; do
  STATUS=$(docker inspect --format='{{.State.Status}}' "$name" 2>/dev/null || echo "not found")
  if [ "$STATUS" = "running" ]; then
    ok "$name"
  else
    printf "  ${RED}✗${NC} %s (%s)\n" "$name" "$STATUS"
  fi
done
echo ""

# 8. Wiki instances (query postgres directly)
echo "Wiki instances:"
WIKI_ROWS=$(docker exec wiki-v2-db psql -U wiki -d wiki -t -A -F'|' \
  -c "SELECT wiki_id, COUNT(*) FROM wiki_sections GROUP BY wiki_id ORDER BY wiki_id" 2>/dev/null || true)

if [ -z "$WIKI_ROWS" ]; then
  info "No wiki instances yet (empty DB)"
else
  while IFS='|' read -r wiki_id count; do
    [ -n "$wiki_id" ] && printf "  ${CYAN}%-24s${NC} %s sections\n" "$wiki_id" "$count"
  done <<< "$WIKI_ROWS"
fi
echo ""

# 9. MCP config snippet
case "$(uname -s)" in
  Darwin|Linux) CLAUDE_JSON="$HOME/.claude.json" ;;
  *)            CLAUDE_JSON="~/.claude.json  (Windows: run this from WSL)" ;;
esac

echo "MCP config — add the following under \"mcpServers\" in:"
printf "  ${CYAN}%s${NC}\n" "$CLAUDE_JSON"
echo ""
echo '  "wiki": {'
echo '    "command": "docker",'
echo '    "args": ["exec", "-i", "wiki-v2-server", "node", "src/index.js"]'
echo '  }'
echo ""
if [ ! -f "$HOME/.claude.json" ]; then
  info "~/.claude.json not found — create it if you haven't set up Claude Code yet."
fi

printf "${GREEN}Ready.${NC}\n"
echo ""
