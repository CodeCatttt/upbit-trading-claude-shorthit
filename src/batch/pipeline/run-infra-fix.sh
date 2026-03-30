#!/usr/bin/env bash
#
# run-infra-fix.sh — Infra fix pipeline orchestrator
# Steps: build infra prompt → Claude analysis → parse response →
#         apply patches → PM2 restart → health check → rollback on failure
# Part of the 3-tier autonomous batch system (infra_fix tier)
#

set -euo pipefail

# Ensure node/claude are available in cron environment
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

PROJECT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$PROJECT_DIR"

# --- Lockfile: prevent concurrent/overlapping infra-fix runs ---
LOCKFILE="$PROJECT_DIR/data/.infra-fix-lock"
if [ -f "$LOCKFILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    if [ "$LOCK_AGE" -lt 3600 ]; then
        echo "Infra-fix already running (lock age: ${LOCK_AGE}s). Exiting."
        exit 0
    fi
    echo "Stale lock found (age: ${LOCK_AGE}s). Removing."
    rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

TIMESTAMP=$(date +"%Y-%m-%d-%H%M")
LOG_DIR="$PROJECT_DIR/logs/infra-fix"
LOG_FILE="$LOG_DIR/$TIMESTAMP.log"
mkdir -p "$LOG_DIR"

exec > >(tee -a "$LOG_FILE") 2>&1

# Discord notification helper — pipes JSON to notify.js
notify_batch() {
    echo "$1" | node src/batch/pipeline/notify.js 2>/dev/null || true
}

# --- Helper: extract JSON field via node ---
json_field() {
    echo "$1" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);const v=$2;console.log(typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('');}})"
}

echo "=============================="
echo "Infra-fix run: $TIMESTAMP"
echo "=============================="

# --- Step 1: Build infra prompt ---
TRIGGER_TYPE="${INFRA_TRIGGER:-WEEKLY_MAINTENANCE}"
echo "[Step 1] Building infra prompt (trigger: $TRIGGER_TYPE)..."
PROMPT=$(INFRA_TRIGGER="$TRIGGER_TYPE" node src/batch/prompt/build-infra-prompt.js)

if [ -z "$PROMPT" ]; then
    echo "[Step 1] ERROR: Prompt builder returned empty output."
    exit 1
fi
echo "[Step 1] Prompt built (${#PROMPT} chars)."

# --- Step 2: Call Claude ---
echo "[Step 2] Calling Claude for infra analysis..."
CLAUDE_OUTPUT=$(echo "$PROMPT" | timeout 600 env -u CLAUDECODE claude --model claude-opus-4-6 -p 2>/dev/null || true)

if [ -z "$CLAUDE_OUTPUT" ]; then
    echo "[Step 2] ERROR: Claude returned empty output."
    exit 1
fi
echo "[Step 2] Claude response received (${#CLAUDE_OUTPUT} chars)."

# --- Step 3: Parse response ---
echo "[Step 3] Parsing Claude response..."
PARSE_RESULT=$(echo "$CLAUDE_OUTPUT" | node src/batch/prompt/parse-infra-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

VALID=$(json_field "$PARSE_RESULT" "o.valid")
ACTION=$(json_field "$PARSE_RESULT" "o.decision?o.decision.action:'none'")
ERRORS=$(json_field "$PARSE_RESULT" "o.errors")

echo "[Step 3] Valid: $VALID, Action: $ACTION"

if [ "$VALID" != "true" ]; then
    echo "[Step 3] Validation failed. Aborting."
    echo "  Errors: $ERRORS"
    exit 1
fi

# --- Step 4: Handle action ---
if [ "$ACTION" = "no_action" ]; then
    echo "[Step 4] No action needed."
    REASONING=$(json_field "$PARSE_RESULT" "o.decision.reasoning||'no issues found'")

    # Send Discord notification
    NOTIFY_JSON=$(REASONING_VAL="$REASONING" node -e "
        console.log(JSON.stringify({
            type: 'infra_fix_no_action',
            reasoning: process.env.REASONING_VAL,
        }));
    ")
    notify_batch "$NOTIFY_JSON"

    # Update batch memory
    node src/batch/learning/update-memory.js '{"action":"infra_fix","reasoning":"'"$REASONING"'","confidence":0.8,"outcome":"no_action","notes":"trigger: '"$TRIGGER_TYPE"'"}'

    echo "Infra-fix complete (no action)."
    exit 0
fi

# --- Step 5: Apply patches (fix action) ---
echo "[Step 5] Applying file patches..."

REASONING=$(json_field "$PARSE_RESULT" "o.decision.reasoning||'infra fix'")
FILE_CHANGES=$(json_field "$PARSE_RESULT" "JSON.stringify(o.fileChanges||[])")
FILE_COUNT=$(json_field "$PARSE_RESULT" "(o.fileChanges||[]).length")

echo "  Files to modify: $FILE_COUNT"

# Safety check: max 3 files
if [ "$FILE_COUNT" -gt 3 ]; then
    echo "[Step 5] ERROR: Too many file changes ($FILE_COUNT > 3). Aborting."
    exit 1
fi

if [ "$FILE_COUNT" -eq 0 ]; then
    echo "[Step 5] No file changes specified. Aborting."
    exit 1
fi

# Create backup directory
BACKUP_DIR="$PROJECT_DIR/backups/infra-fix/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

# Track modified files for rollback
MODIFIED_FILES=()
BACKUP_SUCCESS=true

# Back up and apply each file change
for IDX in $(seq 0 $((FILE_COUNT - 1))); do
    FILE_PATH=$(json_field "$PARSE_RESULT" "(o.fileChanges[$IDX]||{}).path||''")
    echo "  [$((IDX + 1))/$FILE_COUNT] Processing: $FILE_PATH"

    if [ -z "$FILE_PATH" ]; then
        echo "    ERROR: Empty file path at index $IDX. Aborting."
        BACKUP_SUCCESS=false
        break
    fi

    # Resolve to absolute path (relative to PROJECT_DIR)
    FULL_PATH="$PROJECT_DIR/$FILE_PATH"

    # Create backup of original file (if it exists)
    if [ -f "$FULL_PATH" ]; then
        BACKUP_PATH="$BACKUP_DIR/$FILE_PATH"
        mkdir -p "$(dirname "$BACKUP_PATH")"
        cp "$FULL_PATH" "$BACKUP_PATH"
        echo "    Backed up: $BACKUP_PATH"
    else
        echo "    New file (no backup needed): $FULL_PATH"
        # Mark as new file for rollback (delete on rollback)
        BACKUP_PATH="$BACKUP_DIR/$FILE_PATH.__NEW__"
        mkdir -p "$(dirname "$BACKUP_PATH")"
        touch "$BACKUP_PATH"
    fi

    # Atomic write: write to .tmp, then rename
    TMP_FILE="${FULL_PATH}.tmp"
    mkdir -p "$(dirname "$FULL_PATH")"

    FILE_CHANGES_JSON="$FILE_CHANGES" FILE_IDX="$IDX" node -e "
        const fs = require('fs');
        const changes = JSON.parse(process.env.FILE_CHANGES_JSON);
        const idx = Number(process.env.FILE_IDX);
        const content = changes[idx].content;
        fs.writeFileSync('${TMP_FILE}', content, 'utf8');
    "

    if [ ! -f "$TMP_FILE" ]; then
        echo "    ERROR: Failed to write temp file. Aborting."
        BACKUP_SUCCESS=false
        break
    fi

    mv "$TMP_FILE" "$FULL_PATH"
    echo "    Applied: $FULL_PATH"

    MODIFIED_FILES+=("$FILE_PATH")
done

if [ "$BACKUP_SUCCESS" != "true" ]; then
    echo "[Step 5] ERROR: Patch application failed. Rolling back..."

    # Rollback already-applied files
    for RFILE in "${MODIFIED_FILES[@]}"; do
        RBAK="$BACKUP_DIR/$RFILE"
        RFULL="$PROJECT_DIR/$RFILE"
        if [ -f "$RBAK.__NEW__" ]; then
            rm -f "$RFULL"
            echo "  Rolled back (deleted new file): $RFULL"
        elif [ -f "$RBAK" ]; then
            cp "$RBAK" "$RFULL"
            echo "  Rolled back: $RFULL"
        fi
    done

    notify_batch '{"type":"infra_fix_fail","reasoning":"Patch application failed during backup"}'
    exit 1
fi

echo "[Step 5] All patches applied successfully."

# --- Step 6: PM2 restart ---
echo "[Step 6] Restarting PM2 upbit-day-trading-bot..."

# Record pre-restart state
PRE_RESTART_TIME=$(pm2 jlist 2>/dev/null | node -e "
    process.stdin.setEncoding('utf8');let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
        try {
            const procs=JSON.parse(d);
            const bot=procs.find(p=>p.name==='upbit-day-trading-bot');
            console.log(bot?bot.pm2_env.restart_time:'-1');
        } catch(e) { console.log('-1'); }
    });
" 2>/dev/null || echo "-1")

pm2 restart upbit-day-trading-bot --update-env 2>/dev/null || echo "  WARNING: PM2 restart command failed"

# --- Step 7: Health check ---
echo "[Step 7] Waiting 30s for health check..."
sleep 30

PM2_STATUS=$(pm2 jlist 2>/dev/null | node -e "
    process.stdin.setEncoding('utf8');let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
        try {
            const procs=JSON.parse(d);
            const bot=procs.find(p=>p.name==='upbit-day-trading-bot');
            if (!bot) { console.log('NOT_FOUND'); return; }
            const status=bot.pm2_env.status;
            const restarts=bot.pm2_env.restart_time;
            console.log(status+':'+restarts);
        } catch(e) { console.log('ERROR'); }
    });
" 2>/dev/null || echo "ERROR")

PM2_PROC_STATUS=$(echo "$PM2_STATUS" | cut -d: -f1)
PM2_RESTART_COUNT=$(echo "$PM2_STATUS" | cut -d: -f2)

echo "  PM2 status: $PM2_PROC_STATUS, restart_count: $PM2_RESTART_COUNT (pre-restart: $PRE_RESTART_TIME)"

# Health check: bot must be online and restart count should be exactly pre+1
HEALTH_OK="true"
if [ "$PM2_PROC_STATUS" != "online" ]; then
    echo "  HEALTH CHECK FAILED: Bot is not online (status: $PM2_PROC_STATUS)"
    HEALTH_OK="false"
fi

# Check if restart count increased more than expected (crash loop)
if [ "$PRE_RESTART_TIME" != "-1" ] && [ "$PM2_RESTART_COUNT" != "" ]; then
    EXPECTED_RESTARTS=$((PRE_RESTART_TIME + 1))
    if [ "$PM2_RESTART_COUNT" -gt "$((EXPECTED_RESTARTS + 1))" ] 2>/dev/null; then
        echo "  HEALTH CHECK FAILED: Unexpected restarts (expected ~$EXPECTED_RESTARTS, got $PM2_RESTART_COUNT)"
        HEALTH_OK="false"
    fi
fi

# --- Step 8: Rollback on failure ---
if [ "$HEALTH_OK" != "true" ]; then
    echo "[Step 8] ROLLING BACK all changes..."

    for RFILE in "${MODIFIED_FILES[@]}"; do
        RBAK="$BACKUP_DIR/$RFILE"
        RFULL="$PROJECT_DIR/$RFILE"
        if [ -f "$RBAK.__NEW__" ]; then
            rm -f "$RFULL"
            echo "  Rolled back (deleted new file): $RFULL"
        elif [ -f "$RBAK" ]; then
            cp "$RBAK" "$RFULL"
            echo "  Rolled back: $RFULL"
        fi
    done

    echo "  Restarting PM2 after rollback..."
    pm2 restart upbit-day-trading-bot --update-env 2>/dev/null || echo "  WARNING: PM2 restart after rollback failed"
    sleep 10

    # Notify failure
    FAIL_NOTIFY=$(REASONING_VAL="$REASONING" node -e "
        console.log(JSON.stringify({
            type: 'infra_fix_fail',
            reasoning: 'Health check failed after infra fix. Rolled back. Reason: ' + process.env.REASONING_VAL,
        }));
    ")
    notify_batch "$FAIL_NOTIFY"

    # Update batch memory with failure
    MEMORY_JSON=$(REASONING_VAL="$REASONING" TRIGGER_VAL="$TRIGGER_TYPE" FILE_COUNT_VAL="$FILE_COUNT" node -e "
        console.log(JSON.stringify({
            action: 'infra_fix',
            reasoning: process.env.REASONING_VAL,
            confidence: 0.8,
            outcome: 'rollback',
            notes: 'trigger: ' + process.env.TRIGGER_VAL + ', files: ' + process.env.FILE_COUNT_VAL + ', health check failed'
        }));
    ")
    node src/batch/learning/update-memory.js "$MEMORY_JSON"

    echo "Infra-fix complete (rolled back)."
    exit 1
fi

echo "[Step 7] Health check PASSED."

# --- Step 9: Update batch memory ---
echo "[Step 9] Updating batch memory..."
MEMORY_JSON=$(REASONING_VAL="$REASONING" TRIGGER_VAL="$TRIGGER_TYPE" FILE_COUNT_VAL="$FILE_COUNT" node -e "
    console.log(JSON.stringify({
        action: 'infra_fix',
        reasoning: process.env.REASONING_VAL,
        confidence: 0.8,
        outcome: 'applied',
        notes: 'trigger: ' + process.env.TRIGGER_VAL + ', files_modified: ' + process.env.FILE_COUNT_VAL
    }));
")
node src/batch/learning/update-memory.js "$MEMORY_JSON"

# --- Step 10: Update infra-fix-log.json ---
echo "[Step 10] Updating infra-fix-log.json..."
MODIFIED_FILES_JSON=$(printf '%s\n' "${MODIFIED_FILES[@]}" | node -e "
    process.stdin.setEncoding('utf8');let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
        const files=d.trim().split('\n').filter(Boolean);
        console.log(JSON.stringify(files));
    });
")

INFRA_LOG_FILE="$PROJECT_DIR/data/infra-fix-log.json"
REASONING_VAL="$REASONING" TRIGGER_VAL="$TRIGGER_TYPE" TIMESTAMP_VAL="$TIMESTAMP" FILES_JSON="$MODIFIED_FILES_JSON" node -e "
    const fs = require('fs');
    const logPath = process.env.REASONING_VAL ? '${INFRA_LOG_FILE}' : '${INFRA_LOG_FILE}';
    let log = [];
    try { log = JSON.parse(fs.readFileSync('${INFRA_LOG_FILE}', 'utf8')); } catch(e) {}
    if (!Array.isArray(log)) log = [];

    log.push({
        timestamp: process.env.TIMESTAMP_VAL,
        trigger: process.env.TRIGGER_VAL,
        action: 'fix',
        reasoning: process.env.REASONING_VAL,
        filesModified: JSON.parse(process.env.FILES_JSON),
        outcome: 'applied',
    });

    // Keep max 30 entries
    if (log.length > 30) log = log.slice(-30);

    const tmp = '${INFRA_LOG_FILE}.tmp';
    fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
    fs.renameSync(tmp, '${INFRA_LOG_FILE}');
    console.log('  Infra-fix log updated (' + log.length + ' entries).');
"

# --- Step 11: Git commit ---
echo "[Step 11] Committing changes to git..."
cd "$PROJECT_DIR"

for GFILE in "${MODIFIED_FILES[@]}"; do
    git add "$GFILE" 2>/dev/null || true
done
git add data/infra-fix-log.json data/batch-memory.json 2>/dev/null || true
git commit -m "infra-fix: $REASONING" 2>/dev/null || echo "  No changes to commit."
git push 2>/dev/null || echo "  Push skipped (no remote configured)."

# --- Step 12: Discord notification ---
echo "[Step 12] Sending success notification..."
SUCCESS_NOTIFY=$(REASONING_VAL="$REASONING" FILES_JSON="$MODIFIED_FILES_JSON" node -e "
    const files = JSON.parse(process.env.FILES_JSON);
    console.log(JSON.stringify({
        type: 'infra_fix_success',
        reasoning: process.env.REASONING_VAL,
        filesModified: files,
    }));
")
notify_batch "$SUCCESS_NOTIFY"

echo "=============================="
echo "Infra-fix complete: $TIMESTAMP"
echo "=============================="
