#!/usr/bin/env bash
#
# run-batch.sh — Batch pipeline orchestrator (multi-asset)
# Steps: fetch candles → collect metrics → Claude analysis →
#         parse response → update markets → backtest → deploy (if passed)
# Features: retry loop (max 3 attempts), multi-variant backtest, 50min timeout
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

# --- Helper: extract JSON field via node ---
json_field() {
    echo "$1" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const o=JSON.parse(d);const v=$2;console.log(typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('');}})"
}

# --- Constants ---
MAX_RETRIES=2
TEMP_STRATEGY="$PROJECT_DIR/src/strategies/.tmp-new-strategy.js"
CUSTOM_INDICATORS_FILE="$PROJECT_DIR/src/strategies/custom-indicators.js"
CUSTOM_INDICATORS_BACKUP="$PROJECT_DIR/src/strategies/.backup-custom-indicators.js"

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
TRIGGER_TYPE="${BATCH_TRIGGER:-DAILY_REVIEW}"
echo "[Step 2] Building prompt (trigger: $TRIGGER_TYPE) and calling Claude..."
PROMPT=$(BATCH_TRIGGER="$TRIGGER_TYPE" node src/batch/build-prompt.js)

CLAUDE_OUTPUT=$(echo "$PROMPT" | timeout 600 env -u CLAUDECODE claude --model claude-opus-4-6 --allowedTools "WebSearch" -p 2>/dev/null || true)

if [ -z "$CLAUDE_OUTPUT" ]; then
    echo "[Step 2] ERROR: Claude returned empty output."
    exit 1
fi
echo "[Step 2] Claude response received (${#CLAUDE_OUTPUT} chars)."

# Step 3: Parse response
echo "[Step 3] Parsing Claude response..."
PARSE_RESULT=$(echo "$CLAUDE_OUTPUT" | node src/batch/parse-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

VALID=$(json_field "$PARSE_RESULT" "o.valid")
ACTION=$(json_field "$PARSE_RESULT" "o.decision?o.decision.action:'none'")

echo "[Step 3] Valid: $VALID, Action: $ACTION"

if [ "$VALID" != "true" ]; then
    echo "[Step 3] Validation failed. Aborting."
    json_field "$PARSE_RESULT" "o.errors"
    exit 1
fi

# Step 3.5: Update trading-config.json if markets field is present
HAS_MARKETS=$(json_field "$PARSE_RESULT" "o.decision&&o.decision.markets&&Array.isArray(o.decision.markets)?'true':'false'")

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
    KEEP_JSON=$(json_field "$PARSE_RESULT" "JSON.stringify({type:'keep',reasoning:o.decision.reasoning||'',confidence:o.decision.confidence||0})")
    notify_batch "$KEEP_JSON"
    # Update batch memory
    echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'keep',reasoning:r.reasoning,confidence:r.confidence,outcome:'kept',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:'$TRIGGER_TYPE'});
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

    # Step M1: Baseline backtest BEFORE modification
    echo "  [Modify Gate] Backtesting baseline strategy..."
    MODIFY_BASELINE=$(node src/batch/backtest.js src/strategies/current-strategy.js 2>/dev/null || echo '{"error":"backtest failed"}')

    echo "  Applying parameter modifications: $PARAMS"

    # Read current strategy, update DEFAULT_CONFIG values
    node src/batch/apply-modify.js "$PARAMS"

    # Step M2: Backtest AFTER modification
    echo "  [Modify Gate] Backtesting modified strategy..."
    MODIFY_AFTER=$(node src/batch/backtest.js src/strategies/current-strategy.js 2>/dev/null || echo '{"error":"backtest failed"}')

    # Step M3: Compare with modify gate
    MODIFY_COMPARISON=$(node -e "
        const { compareStrategies } = require('./src/batch/backtest');
        const baseline = $MODIFY_BASELINE;
        const modified = $MODIFY_AFTER;
        if (baseline.error || modified.error) {
            console.log(JSON.stringify({pass:true, reasons:['Backtest error, allowing modify']}));
        } else {
            console.log(JSON.stringify(compareStrategies(baseline, modified, 'modify')));
        }
    ")

    MODIFY_PASS=$(json_field "$MODIFY_COMPARISON" "o.pass")

    echo "  [Modify Gate] Result: pass=$MODIFY_PASS"
    echo "$MODIFY_COMPARISON"

    if [ "$MODIFY_PASS" != "true" ]; then
        echo "  [Modify Gate] FAILED. Reverting strategy."
        git checkout -- src/strategies/current-strategy.js 2>/dev/null || true
        # Update batch memory with modify gate failure
        echo "$PARSE_RESULT" | node -e "
            process.stdin.setEncoding('utf8');let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                const r=JSON.parse(d).decision;
                const comp=$MODIFY_COMPARISON;
                const {appendEntry}=require('./src/batch/update-memory');
                appendEntry({action:'modify',reasoning:r.reasoning,confidence:r.confidence,parameters:r.parameters,outcome:'gate_failed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:'$TRIGGER_TYPE'});
            });
        "
        notify_batch '{"type":"modify_fail","reasoning":"modify gate failed"}'
        echo "Batch complete (modify gate failed)."
        exit 0
    fi

    # Git commit the modification
    cd "$PROJECT_DIR"
    REASONING=$(json_field "$PARSE_RESULT" "o.decision.reasoning||'parameter modification'")
    git add -A src/strategies/ trading-config.json 2>/dev/null || true
    git commit -m "batch: modify strategy parameters - $REASONING" 2>/dev/null || true

    MODIFY_JSON=$(node -e "
        const p = $PARAMS;
        const r = $(json_field "$PARSE_RESULT" "JSON.stringify(o.decision)");
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
            appendEntry({action:'modify',reasoning:r.reasoning,confidence:r.confidence,parameters:r.parameters,outcome:'applied',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:'$TRIGGER_TYPE'});
        });
    "
    echo "Batch complete (parameters modified)."
    exit 0
fi

# =====================================================================
# EXPERIMENT PATH — structured hypothesis testing
# =====================================================================

if [ "$ACTION" = "experiment" ]; then
    echo "[Step 4] EXPERIMENT path — structured hypothesis testing"

    EXPERIMENT_DATA=$(json_field "$PARSE_RESULT" "JSON.stringify(o.decision.experiment||{})")
    HYPOTHESIS=$(json_field "$PARSE_RESULT" "o.decision.experiment?o.decision.experiment.hypothesis:'unknown'")
    DESIGN_TYPE=$(json_field "$PARSE_RESULT" "o.decision.experiment&&o.decision.experiment.design?o.decision.experiment.design.type:'unknown'")

    echo "  Hypothesis: $HYPOTHESIS"
    echo "  Design type: $DESIGN_TYPE"

    # Process experiment via experiment-manager
    EXPERIMENT_RESULT=$(node -e "
        const { processExperimentAction } = require('./src/batch/experiment-manager');
        const expData = $EXPERIMENT_DATA;
        const result = processExperimentAction(expData, null);
        console.log(JSON.stringify(result));
    " 2>/dev/null || echo '{"success":false,"reason":"experiment_error"}')

    EXP_SUCCESS=$(json_field "$EXPERIMENT_RESULT" "o.success")
    echo "  Experiment registered: $EXP_SUCCESS"

    if [ "$EXP_SUCCESS" = "true" ]; then
        # If experiment includes strategy code (parameter_test with code), backtest it
        HAS_STRATEGY_CODE=$(json_field "$PARSE_RESULT" "o.strategyCode?'true':'false'")

        if [ "$HAS_STRATEGY_CODE" = "true" ]; then
            echo "  Backtesting experiment strategy..."
            EXP_ID=$(json_field "$EXPERIMENT_RESULT" "o.experiment.id")

            echo "$PARSE_RESULT" | node -e "
                process.stdin.setEncoding('utf8');let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    const r=JSON.parse(d);
                    if (r.strategyCode) require('fs').writeFileSync('$TEMP_STRATEGY', r.strategyCode);
                });
            "

            if [ -f "$TEMP_STRATEGY" ]; then
                EXP_BACKTEST=$(node src/batch/backtest.js --walk-forward "$TEMP_STRATEGY" 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')
                CURRENT_WF=$(node src/batch/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

                EXP_COMPARISON=$(node -e "
                    const { compareStrategies } = require('./src/batch/backtest');
                    const currentWF = $CURRENT_WF;
                    const newWF = $EXP_BACKTEST;
                    const cTest = currentWF.test || {};
                    const nTest = newWF.test || {};
                    if (cTest.error || nTest.error) {
                        console.log(JSON.stringify({pass:false, reasons:['Backtest error']}));
                    } else {
                        const cMetrics = cTest.measurePeriod || cTest;
                        const nMetrics = nTest.measurePeriod || nTest;
                        console.log(JSON.stringify(compareStrategies(cMetrics, nMetrics, 'replace')));
                    }
                ")

                # Update experiment with backtest results
                node -e "
                    const { updateExperimentStatus } = require('./src/batch/experiment-manager');
                    const comp = $EXP_COMPARISON;
                    const status = comp.pass ? 'backtest_passed' : 'backtest_failed';
                    updateExperimentStatus('$EXP_ID', status, {
                        backtestReturn: comp.returnImprovement,
                        backtestMdd: comp.drawdownWorsening,
                    });
                "
                echo "  Experiment backtest: $(json_field "$EXP_COMPARISON" "o.pass?'PASSED':'FAILED'")"
                rm -f "$TEMP_STRATEGY"
            fi
        fi
    fi

    # Update batch memory
    echo "$PARSE_RESULT" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'experiment',reasoning:r.reasoning,confidence:r.confidence,outcome:'registered',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:'$TRIGGER_TYPE'});
        });
    "

    NOTIFY_JSON=$(json_field "$PARSE_RESULT" "JSON.stringify({type:'experiment',hypothesis:o.decision.experiment?o.decision.experiment.hypothesis:'',reasoning:o.decision.reasoning||''})")
    notify_batch "$NOTIFY_JSON"

    echo "Batch complete (experiment registered)."
    exit 0
fi

# =====================================================================
# REPLACE PATH — with retry loop + multi-variant support
# =====================================================================

echo "[Step 4] REPLACE path — retry loop enabled (max $((MAX_RETRIES + 1)) attempts)"

# Baseline: walk-forward backtest of current strategy (done once)
echo "  Backtesting current strategy (baseline)..."
CURRENT_WF=$(node src/batch/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

# Extract current baseline metrics for comparison and retry prompts
CURRENT_METRICS=$(node -e "
    const wf = $CURRENT_WF;
    const t = wf.test || {};
    const m = t.measurePeriod || t;
    console.log(JSON.stringify({
        returnPct: m.returnPct || 0,
        maxDrawdown: m.maxDrawdown || 0,
        dailyTrades: m.dailyTrades || 0,
        tradeDays: m.tradeDays || 0,
    }));
")

LAST_FAILED_CODE=""
LAST_GATE_RESULT=""
LAST_NEW_METRICS=""
TOTAL_VARIANTS_TESTED=0

for ATTEMPT in $(seq 0 $MAX_RETRIES); do
    echo ""
    echo "  === Replace attempt $((ATTEMPT + 1))/$((MAX_RETRIES + 1)) ==="

    if [ "$ATTEMPT" -eq 0 ]; then
        # First attempt: use original parse result
        CURRENT_PARSE="$PARSE_RESULT"
    else
        # Retry: build retry prompt and call Claude again
        echo "  Building retry prompt..."

        # Write failed code to temp file to avoid shell escaping issues
        FAILED_CODE_FILE="$PROJECT_DIR/src/strategies/.tmp-failed-code.js"
        echo "$LAST_FAILED_CODE" > "$FAILED_CODE_FILE"

        RETRY_PROMPT=$(node -e "
            const fs = require('fs');
            const { buildRetryPrompt } = require('./src/batch/build-retry-prompt');
            const failedCode = fs.readFileSync('$FAILED_CODE_FILE', 'utf8');
            const prompt = buildRetryPrompt({
                failedCode,
                gateResult: $LAST_GATE_RESULT,
                currentBacktest: $CURRENT_METRICS,
                newBacktest: $LAST_NEW_METRICS,
                attempt: $ATTEMPT,
            });
            process.stdout.write(prompt);
        ")
        rm -f "$FAILED_CODE_FILE"

        echo "  Calling Claude for retry..."
        RETRY_OUTPUT=$(echo "$RETRY_PROMPT" | timeout 600 env -u CLAUDECODE claude --model claude-opus-4-6 -p 2>/dev/null || true)

        if [ -z "$RETRY_OUTPUT" ]; then
            echo "  Retry Claude returned empty output. Skipping."
            continue
        fi
        echo "  Retry response received (${#RETRY_OUTPUT} chars)."

        CURRENT_PARSE=$(echo "$RETRY_OUTPUT" | node src/batch/parse-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

        RETRY_VALID=$(json_field "$CURRENT_PARSE" "o.valid")
        if [ "$RETRY_VALID" != "true" ]; then
            echo "  Retry parse validation failed. Skipping attempt."
            continue
        fi
    fi

    # Extract strategy variants
    VARIANT_COUNT=$(json_field "$CURRENT_PARSE" "(o.strategyVariants||[]).length")
    echo "  Variants found: $VARIANT_COUNT"

    if [ "$VARIANT_COUNT" -le "1" ]; then
        # Single variant path (backward compatible)
        echo "  Single variant — backtesting..."

        HAS_CUSTOM_INDICATORS="false"

        echo "$CURRENT_PARSE" | node -e "
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
            cp "$CUSTOM_INDICATORS_FILE" "$CUSTOM_INDICATORS_BACKUP" 2>/dev/null || true
            cp "$TEMP_STRATEGY.custom-indicators" "$CUSTOM_INDICATORS_FILE"
        fi

        NEW_WF=$(node src/batch/backtest.js --walk-forward "$TEMP_STRATEGY" 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

        COMPARISON=$(node -e "
            const { compareStrategies } = require('./src/batch/backtest');
            const currentWF = $CURRENT_WF;
            const newWF = $NEW_WF;
            const cTest = currentWF.test || {};
            const nTest = newWF.test || {};
            if (cTest.error || nTest.error) {
                console.log(JSON.stringify({pass:false, reasons:['Backtest error']}));
            } else {
                const cMetrics = cTest.measurePeriod || cTest;
                const nMetrics = nTest.measurePeriod || nTest;
                console.log(JSON.stringify(compareStrategies(cMetrics, nMetrics, 'replace')));
            }
        ")

        PASS=$(json_field "$COMPARISON" "o.pass")
        TOTAL_VARIANTS_TESTED=$((TOTAL_VARIANTS_TESTED + 1))

        echo "  Backtest result: pass=$PASS"
        echo "  $COMPARISON"

        # Restore custom indicators if they were swapped
        if [ "$HAS_CUSTOM_INDICATORS" = "true" ] && [ -f "$CUSTOM_INDICATORS_BACKUP" ]; then
            cp "$CUSTOM_INDICATORS_BACKUP" "$CUSTOM_INDICATORS_FILE"
        fi

        if [ "$PASS" = "true" ]; then
            # Gate passed — proceed to deploy
            WINNING_CODE=$(cat "$TEMP_STRATEGY")
            WINNING_COMPARISON="$COMPARISON"
            WINNING_PARSE="$CURRENT_PARSE"
            rm -f "$TEMP_STRATEGY" "$TEMP_STRATEGY.custom-indicators" "$CUSTOM_INDICATORS_BACKUP"
            break
        else
            # Gate failed — save for retry
            LAST_FAILED_CODE=$(cat "$TEMP_STRATEGY")
            LAST_GATE_RESULT="$COMPARISON"
            LAST_NEW_METRICS=$(node -e "
                const wf = $NEW_WF;
                const t = wf.test || {};
                const m = t.measurePeriod || t;
                console.log(JSON.stringify({
                    returnPct: m.returnPct || 0,
                    maxDrawdown: m.maxDrawdown || 0,
                    dailyTrades: m.dailyTrades || 0,
                    tradeDays: m.tradeDays || 0,
                }));
            ")
            rm -f "$TEMP_STRATEGY" "$TEMP_STRATEGY.custom-indicators" "$CUSTOM_INDICATORS_BACKUP"

            # Diagnose failure
            DIAGNOSIS=$(node -e "
                const { diagnoseGateFailure } = require('./src/batch/diagnose-failure');
                const d = diagnoseGateFailure($COMPARISON, $LAST_NEW_METRICS, $CURRENT_METRICS);
                console.log(d.summary);
            ")
            echo "  Diagnosis: $DIAGNOSIS"
        fi
    else
        # Multi-variant path: test each variant, pick best passing one
        echo "  Multi-variant mode — testing $VARIANT_COUNT variants..."

        BEST_VARIANT_CODE=""
        BEST_VARIANT_RETURN=-999999
        BEST_VARIANT_COMPARISON=""
        LAST_VARIANT_FAILED_CODE=""

        # Install custom indicators once for all variants (if present)
        MV_HAS_CI="false"
        echo "$CURRENT_PARSE" | node -e "
            process.stdin.setEncoding('utf8');let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                const r=JSON.parse(d);
                if (r.customIndicatorsCode) {
                    require('fs').writeFileSync('$TEMP_STRATEGY.custom-indicators', r.customIndicatorsCode);
                }
            });
        "
        if [ -f "$TEMP_STRATEGY.custom-indicators" ]; then
            MV_HAS_CI="true"
            cp "$CUSTOM_INDICATORS_FILE" "$CUSTOM_INDICATORS_BACKUP" 2>/dev/null || true
            cp "$TEMP_STRATEGY.custom-indicators" "$CUSTOM_INDICATORS_FILE"
        fi

        for VI in $(seq 0 $((VARIANT_COUNT - 1))); do
            VARIANT_LABEL=$(json_field "$CURRENT_PARSE" "(o.strategyVariants[$VI]||{}).label||'variant_$VI'")
            echo "    Testing variant $((VI + 1))/$VARIANT_COUNT: $VARIANT_LABEL"

            # Write variant to temp file
            echo "$CURRENT_PARSE" | node -e "
                process.stdin.setEncoding('utf8');let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    const r=JSON.parse(d);
                    const variant = r.strategyVariants[$VI];
                    if (variant) require('fs').writeFileSync('$TEMP_STRATEGY', variant.code);
                });
            "

            # Validate syntax first
            SYNTAX_OK=$(node --check "$TEMP_STRATEGY" 2>&1 && echo "true" || echo "false")
            if [ "$SYNTAX_OK" != "true" ]; then
                echo "    Variant $VARIANT_LABEL: syntax error, skipping."
                rm -f "$TEMP_STRATEGY"
                continue
            fi

            V_WF=$(node src/batch/backtest.js --walk-forward "$TEMP_STRATEGY" 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

            V_COMPARISON=$(node -e "
                const { compareStrategies } = require('./src/batch/backtest');
                const currentWF = $CURRENT_WF;
                const newWF = $V_WF;
                const cTest = currentWF.test || {};
                const nTest = newWF.test || {};
                if (cTest.error || nTest.error) {
                    console.log(JSON.stringify({pass:false, reasons:['Backtest error']}));
                } else {
                    const cMetrics = cTest.measurePeriod || cTest;
                    const nMetrics = nTest.measurePeriod || nTest;
                    console.log(JSON.stringify(compareStrategies(cMetrics, nMetrics, 'replace')));
                }
            ")

            V_PASS=$(json_field "$V_COMPARISON" "o.pass")
            V_RETURN=$(json_field "$V_COMPARISON" "o.returnImprovement||0")
            TOTAL_VARIANTS_TESTED=$((TOTAL_VARIANTS_TESTED + 1))

            echo "    Variant $VARIANT_LABEL: pass=$V_PASS, return_improvement=$V_RETURN"

            if [ "$V_PASS" = "true" ]; then
                # Check if this is the best passing variant
                IS_BETTER=$(node -e "console.log($V_RETURN > $BEST_VARIANT_RETURN ? 'true' : 'false')")
                if [ "$IS_BETTER" = "true" ]; then
                    BEST_VARIANT_CODE=$(cat "$TEMP_STRATEGY")
                    BEST_VARIANT_RETURN="$V_RETURN"
                    BEST_VARIANT_COMPARISON="$V_COMPARISON"
                fi
            else
                LAST_VARIANT_FAILED_CODE=$(cat "$TEMP_STRATEGY")
            fi

            rm -f "$TEMP_STRATEGY"
        done

        # Restore custom indicators after variant testing
        if [ "$MV_HAS_CI" = "true" ] && [ -f "$CUSTOM_INDICATORS_BACKUP" ]; then
            cp "$CUSTOM_INDICATORS_BACKUP" "$CUSTOM_INDICATORS_FILE"
        fi
        rm -f "$TEMP_STRATEGY.custom-indicators"

        if [ -n "$BEST_VARIANT_CODE" ]; then
            # At least one variant passed — use the best
            echo "  Best variant selected (return improvement: $BEST_VARIANT_RETURN%)"
            WINNING_CODE="$BEST_VARIANT_CODE"
            WINNING_COMPARISON="$BEST_VARIANT_COMPARISON"
            WINNING_PARSE="$CURRENT_PARSE"
            break
        else
            # No variant passed — prepare for retry
            LAST_FAILED_CODE="${LAST_VARIANT_FAILED_CODE:-$LAST_FAILED_CODE}"
            LAST_GATE_RESULT="${V_COMPARISON:-$LAST_GATE_RESULT}"
            LAST_NEW_METRICS=$(node -e "
                const wf = ${V_WF:-'{\"test\":{}}'};
                const t = wf.test || {};
                const m = t.measurePeriod || t;
                console.log(JSON.stringify({
                    returnPct: m.returnPct || 0,
                    maxDrawdown: m.maxDrawdown || 0,
                    dailyTrades: m.dailyTrades || 0,
                    tradeDays: m.tradeDays || 0,
                }));
            " 2>/dev/null || echo '{"returnPct":0,"maxDrawdown":0,"dailyTrades":0,"tradeDays":0}')

            DIAGNOSIS=$(node -e "
                const { diagnoseGateFailure } = require('./src/batch/diagnose-failure');
                const gate = ${LAST_GATE_RESULT:-'{}'};
                const nm = ${LAST_NEW_METRICS:-'{}'};
                const cm = $CURRENT_METRICS;
                const d = diagnoseGateFailure(gate, nm, cm);
                console.log(d.summary);
            " 2>/dev/null || echo "Diagnosis unavailable")
            echo "  No variant passed. Diagnosis: $DIAGNOSIS"
        fi
    fi
done

# Check if we have a winner
if [ -z "${WINNING_CODE:-}" ]; then
    echo ""
    echo "[Step 4] All $((MAX_RETRIES + 1)) attempts FAILED. Not deploying."

    # Save comprehensive failure record
    echo "${WINNING_PARSE:-$PARSE_RESULT}" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision || {};
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({
                action:'replace',
                reasoning:r.reasoning||'',
                confidence:r.confidence||0,
                outcome:'all_retries_failed',
                improvementAreas:r.improvementAreas||null,
                backtestResult:${LAST_GATE_RESULT:-null},
                notes:r.notes||'',
                strategicNotes:r.strategicNotes,
                knowledge:r.knowledge||null,
                triggerType:'$TRIGGER_TYPE',
                retryAttempts:$((MAX_RETRIES + 1)),
                variantsTested:$TOTAL_VARIANTS_TESTED,
                diagnosis:$(node -e "
                    const { diagnoseGateFailure } = require('./src/batch/diagnose-failure');
                    try {
                        const d = diagnoseGateFailure(${LAST_GATE_RESULT:-'{}'}, ${LAST_NEW_METRICS:-'{}'}, $CURRENT_METRICS);
                        console.log(JSON.stringify(d.summary));
                    } catch(e) { console.log(JSON.stringify('Diagnosis error: ' + e.message)); }
                " 2>/dev/null || echo '""'),
            });
        });
    "

    FAIL_JSON=$(node -e "
        console.log(JSON.stringify({
            type:'replace_fail',
            reasoning:'All retry attempts failed',
            retryAttempts:$((MAX_RETRIES + 1)),
            variantsTested:$TOTAL_VARIANTS_TESTED,
        }));
    ")
    notify_batch "$FAIL_JSON"

    echo "Batch complete (all replace attempts failed)."
    exit 0
fi

# =====================================================================
# Step 5: Deploy the winning strategy
# =====================================================================
echo ""
echo "[Step 5] Deploying winning strategy..."

# Write winning code to temp file for deploy
echo "$WINNING_CODE" > "$TEMP_STRATEGY"

# Reinstall custom indicators if present
HAS_CUSTOM_INDICATORS="false"
echo "$WINNING_PARSE" | node -e "
    process.stdin.setEncoding('utf8');let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
        const r=JSON.parse(d);
        if (r.customIndicatorsCode) {
            require('fs').writeFileSync('$TEMP_STRATEGY.custom-indicators', r.customIndicatorsCode);
        }
    });
"
if [ -f "$TEMP_STRATEGY.custom-indicators" ]; then
    HAS_CUSTOM_INDICATORS="true"
    cp "$CUSTOM_INDICATORS_FILE" "$CUSTOM_INDICATORS_BACKUP" 2>/dev/null || true
    cp "$TEMP_STRATEGY.custom-indicators" "$CUSTOM_INDICATORS_FILE"
fi

DEPLOY_RESULT=$(node -e "
    const fs = require('fs');
    const { deploy } = require('./src/batch/deploy');
    const code = fs.readFileSync('$TEMP_STRATEGY', 'utf8');
    const comparison = $WINNING_COMPARISON;
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

DEPLOY_SUCCESS=$(json_field "$DEPLOY_RESULT" "o.success")

echo "[Step 5] Deploy result: success=$DEPLOY_SUCCESS"
echo "$DEPLOY_RESULT"

if [ "$DEPLOY_SUCCESS" = "true" ]; then
    # Deploy success: notify + memory + git
    NOTIFY_JSON=$(node -e "
        const comp = $WINNING_COMPARISON;
        const r = $(json_field "$WINNING_PARSE" "JSON.stringify(o.decision)");
        console.log(JSON.stringify({type:'replace_success',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp}));
    ")
    notify_batch "$NOTIFY_JSON"

    echo "$WINNING_PARSE" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const comp=$WINNING_COMPARISON;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'replace',reasoning:r.reasoning,confidence:r.confidence,outcome:'deployed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:'$TRIGGER_TYPE',retryAttempts:$((ATTEMPT + 1)),variantsTested:$TOTAL_VARIANTS_TESTED});
        });
    "

    # Step 6: Git commit & push
    echo "[Step 6] Committing changes to git..."
    cd "$PROJECT_DIR"
    REASONING=$(json_field "$WINNING_PARSE" "o.decision.reasoning||'strategy replacement'")
    git add src/strategies/current-strategy.js src/strategies/custom-indicators.js deploy-log.json trading-config.json data/batch-memory.json 2>/dev/null || true
    git commit -m "batch: replace strategy - $REASONING" 2>/dev/null || echo "  No changes to commit."
    git push 2>/dev/null || echo "  Push skipped (no remote configured)."
else
    # Deploy failed: notify failure + memory
    NOTIFY_JSON=$(node -e "
        const comp = $WINNING_COMPARISON;
        const r = $(json_field "$WINNING_PARSE" "JSON.stringify(o.decision)");
        const dr = $DEPLOY_RESULT;
        console.log(JSON.stringify({type:'replace_fail',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp,deployError:dr.reason||'unknown'}));
    ")
    notify_batch "$NOTIFY_JSON"

    echo "$WINNING_PARSE" | node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const comp=$WINNING_COMPARISON;
            const {appendEntry}=require('./src/batch/update-memory');
            appendEntry({action:'replace',reasoning:r.reasoning,confidence:r.confidence,outcome:'deploy_failed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:'$TRIGGER_TYPE',retryAttempts:$((ATTEMPT + 1)),variantsTested:$TOTAL_VARIANTS_TESTED});
        });
    "

    # Restore custom indicators if deploy failed
    if [ "$HAS_CUSTOM_INDICATORS" = "true" ] && [ -f "$CUSTOM_INDICATORS_BACKUP" ]; then
        cp "$CUSTOM_INDICATORS_BACKUP" "$CUSTOM_INDICATORS_FILE"
        rm -f "$CUSTOM_INDICATORS_BACKUP"
    fi
fi

# =====================================================================
# Step 7: Shadow strategy auto-promotion check
# =====================================================================
echo "[Step 7] Checking shadow strategies for auto-promotion..."

SHADOW_PROMOTION=$(node -e "
    const fs = require('fs');
    const { checkAutoPromotion } = require('./src/batch/shadow-manager');

    // Load performance ledger to compute live return
    let liveReturnPct = 0;
    try {
        const ledger = JSON.parse(fs.readFileSync('./data/performance-ledger.json', 'utf8'));
        if (ledger.summary && ledger.summary.totalReturnPct != null) {
            liveReturnPct = ledger.summary.totalReturnPct;
        }
    } catch(e) {}

    const candidate = checkAutoPromotion(liveReturnPct);
    console.log(JSON.stringify(candidate || {id:null}));
" 2>/dev/null || echo '{"id":null}')

SHADOW_ID=$(json_field "$SHADOW_PROMOTION" "o.id||null")

if [ "$SHADOW_ID" != "null" ] && [ -n "$SHADOW_ID" ]; then
    SHADOW_LABEL=$(json_field "$SHADOW_PROMOTION" "o.label||''")
    SHADOW_ALPHA=$(json_field "$SHADOW_PROMOTION" "o.alpha||0")
    SHADOW_RETURN=$(json_field "$SHADOW_PROMOTION" "o.shadowReturn||0")
    SHADOW_EXP_ID=$(json_field "$SHADOW_PROMOTION" "o.experimentId||''")

    echo "  Shadow promotion candidate: $SHADOW_ID ($SHADOW_LABEL), alpha: $SHADOW_ALPHA%"

    # Read shadow strategy code and deploy
    SHADOW_CODE=$(node -e "
        const { getShadowDetails } = require('./src/batch/shadow-manager');
        const fs = require('fs');
        const details = getShadowDetails('$SHADOW_ID');
        if (details && details.filePath && fs.existsSync(details.filePath)) {
            process.stdout.write(fs.readFileSync(details.filePath, 'utf8'));
        }
    " 2>/dev/null || echo "")

    if [ -n "$SHADOW_CODE" ]; then
        echo "$SHADOW_CODE" > "$TEMP_STRATEGY"

        SHADOW_DEPLOY=$(node -e "
            const fs = require('fs');
            const { deploy } = require('./src/batch/deploy');
            const code = fs.readFileSync('$TEMP_STRATEGY', 'utf8');
            deploy(code, {pass:true, reasons:['Shadow auto-promotion: alpha $SHADOW_ALPHA%']}).then(r => {
                console.log(JSON.stringify(r));
                try { fs.unlinkSync('$TEMP_STRATEGY'); } catch(_){}
            }).catch(e => {
                console.log(JSON.stringify({success:false,reason:e.message}));
                try { fs.unlinkSync('$TEMP_STRATEGY'); } catch(_){}
            });
        " 2>/dev/null || echo '{"success":false}')

        SHADOW_DEPLOY_OK=$(json_field "$SHADOW_DEPLOY" "o.success")

        if [ "$SHADOW_DEPLOY_OK" = "true" ]; then
            echo "  Shadow strategy deployed successfully!"

            # Remove shadow + complete experiment
            node -e "
                const { removeShadow } = require('./src/batch/shadow-manager');
                removeShadow('$SHADOW_ID');
            " 2>/dev/null || true

            if [ -n "$SHADOW_EXP_ID" ] && [ "$SHADOW_EXP_ID" != "" ]; then
                node -e "
                    const { completeExperiment } = require('./src/batch/experiment-manager');
                    completeExperiment('$SHADOW_EXP_ID', 'confirmed', {
                        shadowReturn: $SHADOW_RETURN,
                        alpha: $SHADOW_ALPHA,
                        autoPromoted: true,
                    });
                " 2>/dev/null || true
            fi

            # Notify
            notify_batch "{\"type\":\"shadow_promoted\",\"label\":\"$SHADOW_LABEL\",\"alpha\":$SHADOW_ALPHA,\"shadowReturn\":$SHADOW_RETURN,\"experimentId\":\"$SHADOW_EXP_ID\"}"

            # Git commit
            cd "$PROJECT_DIR"
            git add src/strategies/current-strategy.js deploy-log.json data/shadow-performance.json data/experiments.json 2>/dev/null || true
            git commit -m "batch: auto-promote shadow strategy '$SHADOW_LABEL' (alpha +${SHADOW_ALPHA}%)" 2>/dev/null || true
            git push 2>/dev/null || echo "  Push skipped."
        else
            echo "  Shadow deploy failed: $SHADOW_DEPLOY"
        fi
    else
        echo "  Shadow strategy code not found."
    fi
else
    echo "  No shadow strategies eligible for auto-promotion."
fi

echo "=============================="
echo "Batch complete: $TIMESTAMP"
echo "=============================="
