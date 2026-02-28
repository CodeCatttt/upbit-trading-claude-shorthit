#!/usr/bin/env bash
#
# run-batch.sh — Batch pipeline orchestrator
# Steps: fetch candles → collect metrics → cooldown check → Claude analysis →
#         parse response → backtest → deploy (if passed)
#

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_DIR"

TIMESTAMP=$(date +"%Y-%m-%d-%H%M")
LOG_DIR="$PROJECT_DIR/logs/batch"
LOG_FILE="$LOG_DIR/$TIMESTAMP.log"
mkdir -p "$LOG_DIR"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "=============================="
echo "Batch run: $TIMESTAMP"
echo "=============================="

# Step 0: Fetch latest candle data
echo "[Step 0] Fetching candle data..."
node src/data/candle-fetcher.js
echo "[Step 0] Done."

# Step 1: Collect metrics
echo "[Step 1] Collecting metrics..."
node src/batch/collect-metrics.js > /dev/null
echo "[Step 1] Done."

# Step 2: Check 12-hour cooldown
echo "[Step 2] Checking cooldown..."
DEPLOY_LOG="$PROJECT_DIR/deploy-log.json"
if [ -f "$DEPLOY_LOG" ]; then
    LAST_TS=$(node -e "
        const log = JSON.parse(require('fs').readFileSync('$DEPLOY_LOG','utf8'));
        if (log.length > 0) {
            const last = log[log.length-1];
            if (last.success) {
                const elapsed = (Date.now() - new Date(last.timestamp).getTime()) / (1000*60*60);
                if (elapsed < 12) {
                    console.log('COOLDOWN');
                    process.exit(0);
                }
            }
        }
        console.log('OK');
    ")
    if [ "$LAST_TS" = "COOLDOWN" ]; then
        echo "[Step 2] Cooldown active. Skipping Claude analysis."
        echo "Batch complete (cooldown skip)."
        exit 0
    fi
fi
echo "[Step 2] Cooldown clear."

# Step 3: Build prompt and call Claude
echo "[Step 3] Building prompt and calling Claude..."
PROMPT=$(node src/batch/build-prompt.js)

CLAUDE_OUTPUT=$(echo "$PROMPT" | claude --model claude-opus-4-6 --allowedTools "WebSearch" -p --max-tokens 8192 2>/dev/null || true)

if [ -z "$CLAUDE_OUTPUT" ]; then
    echo "[Step 3] ERROR: Claude returned empty output."
    exit 1
fi
echo "[Step 3] Claude response received (${#CLAUDE_OUTPUT} chars)."

# Step 4: Parse response
echo "[Step 4] Parsing Claude response..."
PARSE_RESULT=$(echo "$CLAUDE_OUTPUT" | node src/batch/parse-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

VALID=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).valid))")
ACTION=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p=JSON.parse(d);console.log(p.decision?p.decision.action:'none')})")

echo "[Step 4] Valid: $VALID, Action: $ACTION"

if [ "$VALID" != "true" ]; then
    echo "[Step 4] Validation failed. Aborting."
    echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).errors))"
    exit 1
fi

if [ "$ACTION" = "keep" ]; then
    echo "Claude chose KEEP. No changes needed."
    echo "Batch complete."
    exit 0
fi

if [ "$ACTION" = "modify" ]; then
    echo "Claude chose MODIFY (parameter adjustment)."
    echo "TODO: Apply parameter modifications. Skipping for now."
    echo "Batch complete."
    exit 0
fi

# Step 5: Backtest (only for replace)
echo "[Step 5] Running backtest..."

# Write new strategy to temp file
TEMP_STRATEGY="$PROJECT_DIR/.tmp-new-strategy.js"
echo "$PARSE_RESULT" | node -e "
    process.stdin.setEncoding('utf8');
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
        const r=JSON.parse(d);
        require('fs').writeFileSync('$TEMP_STRATEGY', r.strategyCode);
    });
"

# Backtest current strategy
echo "  Backtesting current strategy..."
CURRENT_RESULT=$(node src/batch/backtest.js src/strategies/current-strategy.js 2>/dev/null || echo '{"error":"backtest failed"}')

# Backtest new strategy
echo "  Backtesting new strategy..."
NEW_RESULT=$(node src/batch/backtest.js "$TEMP_STRATEGY" 2>/dev/null || echo '{"error":"backtest failed"}')

# Compare
COMPARISON=$(node -e "
    const { compareStrategies } = require('./src/batch/backtest');
    const current = $CURRENT_RESULT;
    const newS = $NEW_RESULT;
    if (current.error || newS.error) {
        console.log(JSON.stringify({pass:false, reasons:['Backtest error']}));
    } else {
        console.log(JSON.stringify(compareStrategies(current, newS)));
    }
")

PASS=$(echo "$COMPARISON" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).pass))")

echo "[Step 5] Backtest result: pass=$PASS"
echo "$COMPARISON"

if [ "$PASS" != "true" ]; then
    echo "[Step 5] Backtest FAILED. Not deploying."
    rm -f "$TEMP_STRATEGY"
    echo "Batch complete (backtest failed)."
    exit 0
fi

# Step 6: Deploy
echo "[Step 6] Deploying new strategy..."

node -e "
    const fs = require('fs');
    const { deploy } = require('./src/batch/deploy');
    const code = fs.readFileSync('$TEMP_STRATEGY', 'utf8');
    const comparison = $COMPARISON;
    deploy(code, comparison).then(r => {
        console.log(JSON.stringify(r, null, 2));
        fs.unlinkSync('$TEMP_STRATEGY');
        process.exit(r.success ? 0 : 1);
    }).catch(e => {
        console.error('Deploy error:', e.message);
        try { fs.unlinkSync('$TEMP_STRATEGY'); } catch(_){}
        process.exit(1);
    });
"

echo "=============================="
echo "Batch complete: $TIMESTAMP"
echo "=============================="
