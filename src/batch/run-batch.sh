#!/usr/bin/env bash
#
# run-batch.sh — Batch pipeline orchestrator (multi-asset)
# Steps: fetch candles → collect metrics → Claude analysis →
#         parse response → update markets → backtest → deploy (if passed)
#

set -euo pipefail

# Ensure node/claude are available in cron environment
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

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

# Step 2: Build prompt and call Claude
echo "[Step 2] Building prompt and calling Claude..."
PROMPT=$(node src/batch/build-prompt.js)

CLAUDE_OUTPUT=$(echo "$PROMPT" | env -u CLAUDECODE claude --model claude-opus-4-6 --allowedTools "WebSearch" -p 2>/dev/null || true)

if [ -z "$CLAUDE_OUTPUT" ]; then
    echo "[Step 2] ERROR: Claude returned empty output."
    exit 1
fi
echo "[Step 2] Claude response received (${#CLAUDE_OUTPUT} chars)."

# Step 3: Parse response
echo "[Step 3] Parsing Claude response..."
PARSE_RESULT=$(echo "$CLAUDE_OUTPUT" | node src/batch/parse-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

VALID=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).valid))")
ACTION=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const p=JSON.parse(d);console.log(p.decision?p.decision.action:'none')})")

echo "[Step 3] Valid: $VALID, Action: $ACTION"

if [ "$VALID" != "true" ]; then
    echo "[Step 3] Validation failed. Aborting."
    echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).errors))"
    exit 1
fi

# Step 3.5: Update trading-config.json if markets field is present
HAS_MARKETS=$(echo "$PARSE_RESULT" | node -e "
    process.stdin.setEncoding('utf8');let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
        const r=JSON.parse(d);
        console.log(r.decision && r.decision.markets && Array.isArray(r.decision.markets) ? 'true' : 'false');
    });
")

if [ "$HAS_MARKETS" = "true" ]; then
    echo "[Step 3.5] Updating trading-config.json with new markets..."
    node -e "
        const fs = require('fs');
        const configPath = '$PROJECT_DIR/trading-config.json';
        const statePath = '$PROJECT_DIR/bot-state.json';
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const parseResult = JSON.parse(process.argv[1]);
        let newMarkets = parseResult.decision.markets;
        // Safety: ensure currently held asset is not removed from markets
        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (state.assetHeld && state.assetHeld !== 'CASH' && !newMarkets.includes(state.assetHeld)) {
                console.log('  WARNING: Current asset ' + state.assetHeld + ' not in new list, adding back.');
                newMarkets = [state.assetHeld, ...newMarkets];
            }
        } catch(e) {}
        config.markets = newMarkets;
        config.updatedAt = new Date().toISOString();
        config.updatedBy = 'batch';
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('  Updated markets: ' + config.markets.join(', '));
    " "$PARSE_RESULT"
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
    # Update batch memory
    echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'keep',reasoning:r.reasoning,confidence:r.confidence,outcome:'kept',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes});
        });
    "
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
    node src/batch/apply-modify.js "$PARAMS"

    # Git commit the modification
    cd "$PROJECT_DIR"
    REASONING=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const r=JSON.parse(d);console.log(r.decision.reasoning||'parameter modification')})")
    git add -A src/strategies/ trading-config.json 2>/dev/null || true
    git commit -m "batch: modify strategy parameters - $REASONING" 2>/dev/null || true

    MODIFY_JSON=$(node -e "
        const p = $PARAMS;
        const r = $(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).decision)))");
        console.log(JSON.stringify({type:'modify',reasoning:r.reasoning||'',confidence:r.confidence||0,parameters:p}));
    ")
    notify_batch "$MODIFY_JSON"
    # Update batch memory
    echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'modify',reasoning:r.reasoning,confidence:r.confidence,parameters:r.parameters,outcome:'applied',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes});
        });
    "
    echo "Batch complete (parameters modified)."
    exit 0
fi

# Step 4: Backtest (only for replace)
echo "[Step 4] Running backtest..."

# Write new strategy to temp file
TEMP_STRATEGY="$PROJECT_DIR/src/strategies/.tmp-new-strategy.js"
CUSTOM_INDICATORS_FILE="$PROJECT_DIR/src/strategies/custom-indicators.js"
CUSTOM_INDICATORS_BACKUP="$PROJECT_DIR/src/strategies/.backup-custom-indicators.js"
HAS_CUSTOM_INDICATORS="false"

echo "$PARSE_RESULT" | node -e "
    process.stdin.setEncoding('utf8');
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
        const r=JSON.parse(d);
        require('fs').writeFileSync('$TEMP_STRATEGY', r.strategyCode);
        if (r.customIndicatorsCode) {
            require('fs').writeFileSync('$TEMP_STRATEGY.custom-indicators', r.customIndicatorsCode);
        }
    });
"

# Install custom indicators before backtest (with backup)
if [ -f "$TEMP_STRATEGY.custom-indicators" ]; then
    HAS_CUSTOM_INDICATORS="true"
    echo "  Installing custom indicators for backtest..."
    cp "$CUSTOM_INDICATORS_FILE" "$CUSTOM_INDICATORS_BACKUP" 2>/dev/null || true
    cp "$TEMP_STRATEGY.custom-indicators" "$CUSTOM_INDICATORS_FILE"
fi

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

echo "[Step 4] Backtest result: pass=$PASS"
echo "$COMPARISON"

if [ "$PASS" != "true" ]; then
    echo "[Step 4] Backtest FAILED. Not deploying."
    rm -f "$TEMP_STRATEGY" "$TEMP_STRATEGY.custom-indicators"
    # Restore custom indicators backup
    if [ "$HAS_CUSTOM_INDICATORS" = "true" ] && [ -f "$CUSTOM_INDICATORS_BACKUP" ]; then
        cp "$CUSTOM_INDICATORS_BACKUP" "$CUSTOM_INDICATORS_FILE"
        rm -f "$CUSTOM_INDICATORS_BACKUP"
        echo "  Custom indicators restored from backup."
    fi
    FAIL_JSON=$(node -e "
        const comp = $COMPARISON;
        const r = $(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).decision)))");
        console.log(JSON.stringify({type:'replace_fail',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp}));
    ")
    notify_batch "$FAIL_JSON"
    # Update batch memory with backtest failure
    echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const comp=$COMPARISON;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'replace',reasoning:r.reasoning,confidence:r.confidence,outcome:'backtest_failed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes});
        });
    "
    echo "Batch complete (backtest failed)."
    exit 0
fi

# Step 5: Deploy
echo "[Step 5] Deploying new strategy..."

DEPLOY_RESULT=$(node -e "
    const fs = require('fs');
    const { deploy } = require('./src/batch/deploy');
    const code = fs.readFileSync('$TEMP_STRATEGY', 'utf8');
    const comparison = $COMPARISON;
    deploy(code, comparison).then(r => {
        console.log(JSON.stringify(r));
        try { fs.unlinkSync('$TEMP_STRATEGY'); } catch(_){}
        try { fs.unlinkSync('$TEMP_STRATEGY.custom-indicators'); } catch(_){}
        try { fs.unlinkSync('$CUSTOM_INDICATORS_BACKUP'); } catch(_){}
    }).catch(e => {
        console.error('Deploy error:', e.message);
        try {
            if (fs.existsSync('$CUSTOM_INDICATORS_BACKUP')) {
                fs.copyFileSync('$CUSTOM_INDICATORS_BACKUP', '$CUSTOM_INDICATORS_FILE');
                fs.unlinkSync('$CUSTOM_INDICATORS_BACKUP');
            }
        } catch(_){}
        try { fs.unlinkSync('$TEMP_STRATEGY'); } catch(_){}
        try { fs.unlinkSync('$TEMP_STRATEGY.custom-indicators'); } catch(_){}
        console.log(JSON.stringify({success:false,reason:'deploy_exception'}));
    });
" 2>/dev/null || echo '{"success":false,"reason":"deploy_crash"}')

DEPLOY_SUCCESS=$(echo "$DEPLOY_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).success))")

echo "[Step 5] Deploy result: success=$DEPLOY_SUCCESS"
echo "$DEPLOY_RESULT"

if [ "$DEPLOY_SUCCESS" = "true" ]; then
    # Deploy success: notify + memory + git
    NOTIFY_JSON=$(node -e "
        const comp = $COMPARISON;
        const r = $(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).decision)))");
        console.log(JSON.stringify({type:'replace_success',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp}));
    ")
    notify_batch "$NOTIFY_JSON"

    echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const comp=$COMPARISON;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'replace',reasoning:r.reasoning,confidence:r.confidence,outcome:'deployed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes});
        });
    "

    # Step 6: Git commit & push
    echo "[Step 6] Committing changes to git..."
    cd "$PROJECT_DIR"
    REASONING=$(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const r=JSON.parse(d);console.log(r.decision.reasoning||'strategy replacement')})")
    git add src/strategies/current-strategy.js src/strategies/custom-indicators.js deploy-log.json trading-config.json data/batch-memory.json 2>/dev/null || true
    git commit -m "batch: replace strategy - $REASONING" 2>/dev/null || echo "  No changes to commit."
    git push 2>/dev/null || echo "  Push skipped (no remote configured)."
else
    # Deploy failed: notify failure + memory
    NOTIFY_JSON=$(node -e "
        const comp = $COMPARISON;
        const r = $(echo "$PARSE_RESULT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d).decision)))");
        const dr = $DEPLOY_RESULT;
        console.log(JSON.stringify({type:'replace_fail',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp,deployError:dr.reason||'unknown'}));
    ")
    notify_batch "$NOTIFY_JSON"

    echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const comp=$COMPARISON;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'replace',reasoning:r.reasoning,confidence:r.confidence,outcome:'deploy_failed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes});
        });
    "
fi

echo "=============================="
echo "Batch complete: $TIMESTAMP"
echo "=============================="
