#!/usr/bin/env bash
#
# db-backup-restore.sh — Backup and restore the wiki PostgreSQL database
# using the Docker container directly (no local pg_dump/psql required).
#
# Usage:
#   ./scripts/db-backup-restore.sh          # interactive menu
#   ./scripts/db-backup-restore.sh backup   # quick backup
#   ./scripts/db-backup-restore.sh restore  # interactive restore
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$ROOT_DIR/backup"
ENV_FILE="$ROOT_DIR/.env"
CONTAINER_NAME="wiki-v2-db"

# ── Load DB credentials from .env ──────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # Source only the DB_* variables, safely
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    key=$(echo "$key" | xargs)          # trim whitespace
    value=$(echo "$value" | xargs)      # trim whitespace
    case "$key" in
      DB_HOST)     DB_HOST="$value" ;;
      DB_PORT)     DB_PORT="$value" ;;
      DB_USER)     DB_USER="$value" ;;
      DB_PASSWORD) DB_PASSWORD="$value" ;;
      DB_NAME)     DB_NAME="$value" ;;
    esac
  done < "$ENV_FILE"
fi

# Defaults (match docker-compose.yml)
DB_USER="${DB_USER:-wiki}"
DB_PASSWORD="${DB_PASSWORD:-wiki}"
DB_NAME="${DB_NAME:-wiki}"

# ── Helpers ────────────────────────────────────────────────────────────────
ensure_backup_dir() {
  mkdir -p "$BACKUP_DIR"
}

check_container() {
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container '${CONTAINER_NAME}' is not running."
    echo "Start it with: docker compose up -d wiki-db"
    exit 1
  fi
}

timestamp() {
  date +"%Y%m%d_%H%M%S"
}

# ── Backup ─────────────────────────────────────────────────────────────────
do_backup() {
  ensure_backup_dir
  check_container

  local filename="wiki_${DB_NAME}_$(timestamp).sql"
  local filepath="$BACKUP_DIR/$filename"

  echo "Backing up database '${DB_NAME}' from container '${CONTAINER_NAME}'..."
  docker exec "$CONTAINER_NAME" pg_dump -U "$DB_USER" -d "$DB_NAME" -F p --clean --if-exists > "$filepath"

  local size
  size=$(du -h "$filepath" | cut -f1)
  echo "Backup saved: $filepath ($size)"
}

# ── Restore ────────────────────────────────────────────────────────────────
do_restore() {
  ensure_backup_dir
  check_container

  # Collect backup files
  shopt -s nullglob
  local files=("$BACKUP_DIR"/*.sql)
  shopt -u nullglob

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "No backup files found in $BACKUP_DIR"
    echo "Run a backup first: $0 backup"
    exit 1
  fi

  # Show numbered list
  echo "Available backups in $BACKUP_DIR:"
  echo ""
  for i in "${!files[@]}"; do
    local f="${files[$i]}"
    local fname
    fname=$(basename "$f")
    local fsize
    fsize=$(du -h "$f" | cut -f1)
    printf "  %d) %s  (%s)\n" "$((i + 1))" "$fname" "$fsize"
  done
  echo ""

  # Prompt user
  local max=${#files[@]}
  local choice
  while true; do
    read -rp "Select a backup to restore (1-$max): " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= max )); then
      break
    fi
    echo "Invalid selection. Enter a number between 1 and $max."
  done

  local selected="${files[$((choice - 1))]}"
  local selected_name
  selected_name=$(basename "$selected")

  echo ""
  echo "WARNING: This will DROP and recreate all tables in database '${DB_NAME}'."
  read -rp "Restore '$selected_name'? (yes/no): " confirm

  if [[ "$confirm" != "yes" ]]; then
    echo "Restore cancelled."
    exit 0
  fi

  echo ""
  echo "Restoring '$selected_name' into database '${DB_NAME}'..."
  docker exec -i "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" < "$selected"

  echo "Restore complete."
}

# ── Main ───────────────────────────────────────────────────────────────────
case "${1:-menu}" in
  backup)
    do_backup
    ;;
  restore)
    do_restore
    ;;
  menu|"")
    echo "=== Wiki V2 Database Backup & Restore ==="
    echo ""
    echo "1) Backup database"
    echo "2) Restore database"
    echo ""
    read -rp "Choose an option (1/2): " opt
    case "$opt" in
      1) do_backup ;;
      2) do_restore ;;
      *) echo "Invalid option."; exit 1 ;;
    esac
    ;;
  *)
    echo "Usage: $0 [backup|restore]"
    echo ""
    echo "  backup   — Create a new backup"
    echo "  restore  — Select and restore a backup"
    echo "  (none)   — Interactive menu"
    exit 1
    ;;
esac
