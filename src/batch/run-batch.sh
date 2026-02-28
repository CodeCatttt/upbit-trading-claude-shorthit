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

# Discord notification helper — pipes JSON to notify.js
notify_batch() {
    echo "$1" | node src/batch/notify.js 2>/dev/null || true
}

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

CLAUDE_OUTPUT=$(echo "$PROMPT" | env -u CLAUDECODE claude --model claude-opus-4-6 --allowedTools "WebSearch" -p 2>/dev/null || true)

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
    KEEP_JSON=$(echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            console.log(JSON.stringify({type:'keep',reasoning:r.reasoning||'',confidence:r.confidence||0}));
        });
    ")
    notify_batch "$KEEP_JSON"
    echo "Batch complete."
    exit 0
fi

if [ "$ACTION" = "modify" ]; then
    echo "Claude chose MODIFY (parameter adjustment)."

    # Extract parameters and apply to current strategy's DEFAULT_CONFIG
    PARAMS=$(echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d);
            const p = r.decision.parameters;
            if (!p || Object.keys(p).length === 0) {
                console.log('EMPTY');
            } else {
                console.log(JSON.stringify(p));
            }
        });
    ")

    if [ "$PARAMS" = "EMPTY" ]; then
        echo "  No parameters to modify. Skipping."
        echo "Batch complete."
        exit 0
    fi

    echo "  Applying parameter modifications: $PARAMS"

    # Read current strategy, update DEFAULT_CONFIG values
    node -e "
        const fs = require('fs');
        const params = $PARAMS;
        const strategyPath = 'src/strategies/current-strategy.js';
        let code = fs.readFileSync(strategyPath, 'utf8');

        // If re-export, resolve to actual file
        const reExport = code.match(/module\.exports\s*=\s*require\(['\"](\.\\/[^'\"]+)['\"]\)/);
        let targetPath = strategyPath;
        if (reExport) {
            targetPath = require('path').resolve('src/strategies', reExport[1] + '.js');
            if (!fs.existsSync(targetPath)) targetPath = require('path').resolve('src/strategies', reExport[1]);
            code = fs.readFileSync(targetPath, 'utf8');
        }

        // Replace values in DEFAULT_CONFIG
        for (const [key, value] of Object.entries(params)) {
            const regex = new RegExp('(' + key + '\\\\s*:\\\\s*)([\\\\d.]+)');
            if (regex.test(code)) {
                code = code.replace(regex, '\\$1' + value);
                console.log('  Updated ' + key + ' = ' + value);
            } else {
                console.log('  WARNING: key ' + key + ' not found in strategy');
            }
        }

        fs.writeFileSync(targetPath, code);
        console.log('  Strategy parameters updated: ' + targetPath);
    "

    # Git commit the modification
    cd "$PROJECT_DIR"
    REASONING=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const r=JSON.parse(d);console.log(r.decision.reasoning||'parameter modification')})")
    git add -A src/strategies/ 2>/dev/null || true
    git commit -m "batch: modify strategy parameters - $REASONING" 2>/dev/null || true

    MODIFY_JSON=$(node -e "
        const p = $PARAMS;
        const r = $(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).decision)))");
        console.log(JSON.stringify({type:'modify',reasoning:r.reasoning||'',confidence:r.confidence||0,parameters:p}));
    ")
    notify_batch "$MODIFY_JSON"
    echo "Batch complete (parameters modified)."
    exit 0
fi

# Step 5: Backtest (only for replace)
echo "[Step 5] Running backtest..."

# Write new strategy to temp file
TEMP_STRATEGY="$PROJECT_DIR/src/strategies/.tmp-new-strategy.js"
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
    FAIL_JSON=$(node -e "
        const comp = $COMPARISON;
        const r = $(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).decision)))");
        console.log(JSON.stringify({type:'replace_fail',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp}));
    ")
    notify_batch "$FAIL_JSON"
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

SUCCESS_JSON=$(node -e "
    const comp = $COMPARISON;
    const r = $(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).decision)))");
    console.log(JSON.stringify({type:'replace_success',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp}));
")
notify_batch "$SUCCESS_JSON"

# Step 7: Git commit & push
echo "[Step 7] Committing changes to git..."
cd "$PROJECT_DIR"
REASONING=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const r=JSON.parse(d);console.log(r.decision.reasoning||'strategy replacement')})")
git add src/strategies/current-strategy.js deploy-log.json 2>/dev/null || true
git commit -m "batch: replace strategy - $REASONING" 2>/dev/null || echo "  No changes to commit."
git push 2>/dev/null || echo "  Push skipped (no remote configured)."

echo "=============================="
echo "Batch complete: $TIMESTAMP"
echo "=============================="
