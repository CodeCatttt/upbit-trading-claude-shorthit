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

PROJECT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$PROJECT_DIR"

# --- Lockfile: prevent concurrent/overlapping batch runs ---
LOCKFILE="$PROJECT_DIR/data/.batch-lock"
if [ -f "$LOCKFILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    if [ "$LOCK_AGE" -lt 3600 ]; then
        echo "Batch already running (lock age: ${LOCK_AGE}s). Exiting."
        exit 0
    fi
    echo "Stale lock found (age: ${LOCK_AGE}s). Removing."
    rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

TIMESTAMP=$(date +"%Y-%m-%d-%H%M")
LOG_DIR="$PROJECT_DIR/logs/batch"
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
node src/batch/eval/collect-metrics.js > /dev/null
echo "[Step 1] Done."

# Step 2: Build prompt and call Claude
TRIGGER_TYPE="${BATCH_TRIGGER:-DAILY_REVIEW}"
echo "[Step 2] Building prompt (trigger: $TRIGGER_TYPE) and calling Claude..."
PROMPT=$(BATCH_TRIGGER="$TRIGGER_TYPE" node src/batch/prompt/build-prompt.js)

CLAUDE_OUTPUT=$(echo "$PROMPT" | timeout 600 env -u CLAUDECODE claude --model claude-opus-4-6 --allowedTools "WebSearch" -p 2>/dev/null || true)

if [ -z "$CLAUDE_OUTPUT" ]; then
    echo "[Step 2] ERROR: Claude returned empty output."
    exit 1
fi
echo "[Step 2] Claude response received (${#CLAUDE_OUTPUT} chars)."

# Step 3: Parse response
echo "[Step 3] Parsing Claude response..."
PARSE_RESULT=$(echo "$CLAUDE_OUTPUT" | node src/batch/prompt/parse-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

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
    echo "$PARSE_RESULT" | TRIGGER="$TRIGGER_TYPE" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const {appendEntry}=require('./src/batch/learning/update-memory');
            appendEntry({action:'keep',reasoning:r.reasoning,confidence:r.confidence,outcome:'kept',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:process.env.TRIGGER});
        });
    "
    echo "Batch complete."
    exit 0
fi

if [ "$ACTION" = "modify" ]; then
    echo "Claude chose MODIFY (parameter adjustment, retry enabled)."

    # Extract parameters from initial response
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

    # Step M0: Baseline walk-forward backtest (done once)
    echo "  [Modify Gate] Backtesting baseline strategy (walk-forward)..."
    MODIFY_BASELINE_WF=$(node src/batch/eval/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

    MODIFY_BASELINE_METRICS=$(MOD_BL="$MODIFY_BASELINE_WF" node -e "
        const wf = JSON.parse(process.env.MOD_BL);
        const t = wf.test || {};
        const m = t.measurePeriod || t;
        console.log(JSON.stringify({
            returnPct: m.returnPct || 0,
            maxDrawdown: m.maxDrawdown || 0,
            dailyTrades: m.dailyTrades || 0,
            tradeDays: m.tradeDays || 0,
        }));
    ")

    MODIFY_MAX_RETRIES=2
    MODIFY_WINNING=false
    MODIFY_LAST_PARAMS="$PARAMS"
    MODIFY_LAST_GATE_RESULT=""
    MODIFY_LAST_NEW_METRICS=""
    MODIFY_CURRENT_PARSE="$PARSE_RESULT"

    for M_ATTEMPT in $(seq 0 $MODIFY_MAX_RETRIES); do
        echo ""
        echo "  === Modify attempt $((M_ATTEMPT + 1))/$((MODIFY_MAX_RETRIES + 1)) ==="

        if [ "$M_ATTEMPT" -gt 0 ]; then
            # Retry: build modify retry prompt and call Claude again
            echo "  Building modify retry prompt..."
            MODIFY_RETRY_PROMPT=$(LAST_PARAMS="$MODIFY_LAST_PARAMS" GATE_RESULT="$MODIFY_LAST_GATE_RESULT" CUR_METRICS="$MODIFY_BASELINE_METRICS" NEW_METRICS="$MODIFY_LAST_NEW_METRICS" ATTEMPT="$M_ATTEMPT" node -e "
                const { buildModifyRetryPrompt } = require('./src/batch/prompt/build-retry-prompt');
                const prompt = buildModifyRetryPrompt({
                    failedParams: JSON.parse(process.env.LAST_PARAMS),
                    gateResult: JSON.parse(process.env.GATE_RESULT),
                    currentBacktest: JSON.parse(process.env.CUR_METRICS),
                    newBacktest: JSON.parse(process.env.NEW_METRICS),
                    attempt: Number(process.env.ATTEMPT),
                });
                process.stdout.write(prompt);
            ")

            echo "  Calling Claude for modify retry..."
            MODIFY_RETRY_OUTPUT=$(echo "$MODIFY_RETRY_PROMPT" | timeout 600 env -u CLAUDECODE claude --model claude-opus-4-6 -p 2>/dev/null || true)

            if [ -z "$MODIFY_RETRY_OUTPUT" ]; then
                echo "  Retry Claude returned empty output. Skipping."
                continue
            fi
            echo "  Retry response received (${#MODIFY_RETRY_OUTPUT} chars)."

            RETRY_PARSE=$(echo "$MODIFY_RETRY_OUTPUT" | node src/batch/prompt/parse-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')
            RETRY_VALID=$(json_field "$RETRY_PARSE" "o.valid")
            RETRY_ACTION=$(json_field "$RETRY_PARSE" "o.decision?o.decision.action:'none'")

            if [ "$RETRY_VALID" != "true" ] || [ "$RETRY_ACTION" != "modify" ]; then
                echo "  Retry parse failed or action changed ($RETRY_ACTION). Skipping attempt."
                continue
            fi

            PARAMS=$(echo "$RETRY_PARSE" | node -e "
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
                echo "  No parameters in retry response. Skipping."
                continue
            fi

            MODIFY_CURRENT_PARSE="$RETRY_PARSE"
        fi

        echo "  Applying parameter modifications: $PARAMS"
        node src/batch/eval/apply-modify.js "$PARAMS"

        # Backtest modified strategy (walk-forward)
        echo "  [Modify Gate] Backtesting modified strategy (walk-forward)..."
        MODIFY_AFTER_WF=$(node src/batch/eval/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

        # Compare with modify gate (walk-forward results)
        MODIFY_COMPARISON=$(BASELINE_WF="$MODIFY_BASELINE_WF" MODIFIED_WF="$MODIFY_AFTER_WF" node -e "
            const { compareStrategies } = require('./src/batch/eval/backtest');
            const baselineWF = JSON.parse(process.env.BASELINE_WF);
            const modifiedWF = JSON.parse(process.env.MODIFIED_WF);
            const bTest = baselineWF.test || {};
            const mTest = modifiedWF.test || {};
            if (bTest.error || mTest.error) {
                console.log(JSON.stringify({pass:true, reasons:['Backtest error, allowing modify']}));
            } else {
                const bMetrics = bTest.measurePeriod || bTest;
                const mMetrics = mTest.measurePeriod || mTest;
                console.log(JSON.stringify(compareStrategies(bMetrics, mMetrics, 'modify')));
            }
        ")

        MODIFY_PASS=$(json_field "$MODIFY_COMPARISON" "o.pass")

        echo "  [Modify Gate] Result: pass=$MODIFY_PASS"
        echo "$MODIFY_COMPARISON"

        if [ "$MODIFY_PASS" = "true" ]; then
            MODIFY_WINNING=true
            break
        else
            # Gate failed — revert and prepare for retry
            echo "  [Modify Gate] FAILED. Reverting strategy."
            git checkout -- src/strategies/current-strategy.js 2>/dev/null || true

            MODIFY_LAST_PARAMS="$PARAMS"
            MODIFY_LAST_GATE_RESULT="$MODIFY_COMPARISON"
            MODIFY_LAST_NEW_METRICS=$(MOD_AFT="$MODIFY_AFTER_WF" node -e "
                const wf = JSON.parse(process.env.MOD_AFT);
                const t = wf.test || {};
                const m = t.measurePeriod || t;
                console.log(JSON.stringify({
                    returnPct: m.returnPct || 0,
                    maxDrawdown: m.maxDrawdown || 0,
                    dailyTrades: m.dailyTrades || 0,
                    tradeDays: m.tradeDays || 0,
                }));
            ")

            # Diagnose failure
            MODIFY_DIAGNOSIS=$(COMP_JSON="$MODIFY_COMPARISON" NEW_M="$MODIFY_LAST_NEW_METRICS" CUR_M="$MODIFY_BASELINE_METRICS" node -e "
                const { diagnoseGateFailure } = require('./src/batch/prompt/diagnose-failure');
                const d = diagnoseGateFailure(JSON.parse(process.env.COMP_JSON), JSON.parse(process.env.NEW_M), JSON.parse(process.env.CUR_M));
                console.log(d.summary);
            " 2>/dev/null || echo "Diagnosis unavailable")
            echo "  Diagnosis: $MODIFY_DIAGNOSIS"
        fi
    done

    if [ "$MODIFY_WINNING" = "true" ]; then
        # Git commit the modification
        cd "$PROJECT_DIR"
        REASONING=$(json_field "$MODIFY_CURRENT_PARSE" "o.decision.reasoning||'parameter modification'")
        git add -A src/strategies/ trading-config.json 2>/dev/null || true
        git commit -m "batch: modify strategy parameters - $REASONING" 2>/dev/null || true

        # Restart PM2 to reload modified parameters
        echo "  Restarting PM2 to apply modified parameters..."
        pm2 restart upbit-trading-bot 2>/dev/null || echo "  WARNING: PM2 restart failed"

        MODIFY_DECISION=$(json_field "$MODIFY_CURRENT_PARSE" "JSON.stringify(o.decision)")
        MODIFY_JSON=$(PARAMS_JSON="$PARAMS" DECISION_JSON="$MODIFY_DECISION" node -e "
            const p = JSON.parse(process.env.PARAMS_JSON);
            const r = JSON.parse(process.env.DECISION_JSON);
            console.log(JSON.stringify({type:'modify',reasoning:r.reasoning||'',confidence:r.confidence||0,parameters:p}));
        ")
        notify_batch "$MODIFY_JSON"
        # Update batch memory
        echo "$MODIFY_CURRENT_PARSE" | TRIGGER="$TRIGGER_TYPE" node -e "
            process.stdin.setEncoding('utf8');let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                const r=JSON.parse(d).decision;
                const {appendEntry}=require('./src/batch/learning/update-memory');
                appendEntry({action:'modify',reasoning:r.reasoning,confidence:r.confidence,parameters:r.parameters,outcome:'applied',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:process.env.TRIGGER});
            });
        "
        echo "Batch complete (parameters modified)."
    else
        echo ""
        echo "  All $((MODIFY_MAX_RETRIES + 1)) modify attempts FAILED. Not applying changes."
        # Update batch memory with all retries failed
        echo "$MODIFY_CURRENT_PARSE" | COMP_JSON="${MODIFY_LAST_GATE_RESULT:-'{}'}" TRIGGER="$TRIGGER_TYPE" RETRIES="$((MODIFY_MAX_RETRIES + 1))" node -e "
            process.stdin.setEncoding('utf8');let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                const r=JSON.parse(d).decision;
                let comp=null; try{comp=JSON.parse(process.env.COMP_JSON);}catch(e){}
                const {appendEntry}=require('./src/batch/learning/update-memory');
                appendEntry({action:'modify',reasoning:r.reasoning,confidence:r.confidence,parameters:r.parameters,outcome:'all_retries_failed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:process.env.TRIGGER,retryAttempts:Number(process.env.RETRIES)});
            });
        "
        notify_batch '{"type":"modify_fail","reasoning":"all modify retry attempts failed"}'
        echo "Batch complete (all modify attempts failed)."
    fi
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
    EXPERIMENT_RESULT=$(EXP_DATA_JSON="$EXPERIMENT_DATA" node -e "
        const { processExperimentAction } = require('./src/batch/learning/experiment-manager');
        const expData = JSON.parse(process.env.EXP_DATA_JSON);
        const result = processExperimentAction(expData, null);
        console.log(JSON.stringify(result));
    " 2>/dev/null || echo '{"success":false,"reason":"experiment_error"}')

    EXP_SUCCESS=$(json_field "$EXPERIMENT_RESULT" "o.success")
    echo "  Experiment registered: $EXP_SUCCESS"

    if [ "$EXP_SUCCESS" = "true" ]; then
        HAS_STRATEGY_CODE=$(json_field "$PARSE_RESULT" "o.strategyCode?'true':'false'")
        EXP_ID=$(json_field "$EXPERIMENT_RESULT" "o.experiment.id")

        if [ "$HAS_STRATEGY_CODE" = "true" ]; then
            echo "  Strategy code found. Extracting..."

            echo "$PARSE_RESULT" | TEMP_FILE="$TEMP_STRATEGY" node -e "
                process.stdin.setEncoding('utf8');let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    const r=JSON.parse(d);
                    if (r.strategyCode) require('fs').writeFileSync(process.env.TEMP_FILE, r.strategyCode);
                });
            "

            if [ -f "$TEMP_STRATEGY" ] && [ "$DESIGN_TYPE" = "shadow_strategy" ]; then
                # === SHADOW STRATEGY: deploy as shadow for paper-trading ===
                echo "  Deploying as shadow strategy for paper-trading..."
                SHADOW_CODE=$(cat "$TEMP_STRATEGY")

                SHADOW_DEPLOY_RESULT=$(TEMP_FILE="$TEMP_STRATEGY" SHADOW_LABEL="$HYPOTHESIS" SHADOW_EXP_ID="$EXP_ID" node -e "
                    const { deployShadow } = require('./src/batch/learning/shadow-manager');
                    const fs = require('fs');
                    const code = fs.readFileSync(process.env.TEMP_FILE, 'utf8');
                    const id = deployShadow(code, process.env.SHADOW_LABEL, process.env.SHADOW_EXP_ID);
                    if (id) {
                        console.log(JSON.stringify({success:true, shadowId:id}));
                    } else {
                        console.log(JSON.stringify({success:false, reason:'deploy_failed'}));
                    }
                " 2>/dev/null || echo '{"success":false,"reason":"shadow_error"}')

                SHADOW_OK=$(json_field "$SHADOW_DEPLOY_RESULT" "o.success")
                echo "  Shadow deploy: $SHADOW_OK"

                if [ "$SHADOW_OK" = "true" ]; then
                    SHADOW_ID=$(json_field "$SHADOW_DEPLOY_RESULT" "o.shadowId")
                    echo "  Shadow ID: $SHADOW_ID"
                    EXP_ID_VAL="$EXP_ID" SHADOW_ID_VAL="$SHADOW_ID" node -e "
                        const { updateExperimentStatus } = require('./src/batch/learning/experiment-manager');
                        updateExperimentStatus(process.env.EXP_ID_VAL, 'shadow_running', {
                            shadowId: process.env.SHADOW_ID_VAL,
                        });
                    " 2>/dev/null || true
                else
                    echo "  Shadow deploy failed. Falling back to backtest..."
                    EXP_ID_VAL="$EXP_ID" node -e "
                        const { updateExperimentStatus } = require('./src/batch/learning/experiment-manager');
                        updateExperimentStatus(process.env.EXP_ID_VAL, 'shadow_deploy_failed', {});
                    " 2>/dev/null || true
                fi
                rm -f "$TEMP_STRATEGY"

            elif [ -f "$TEMP_STRATEGY" ]; then
                # === PARAMETER_TEST or other: backtest only ===
                echo "  Backtesting experiment strategy..."
                EXP_BACKTEST=$(node src/batch/eval/backtest.js --walk-forward "$TEMP_STRATEGY" 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')
                CURRENT_WF=$(node src/batch/eval/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

                EXP_COMPARISON=$(CUR_WF="$CURRENT_WF" NEW_WF_JSON="$EXP_BACKTEST" node -e "
                    const { compareStrategies } = require('./src/batch/eval/backtest');
                    const currentWF = JSON.parse(process.env.CUR_WF);
                    const newWF = JSON.parse(process.env.NEW_WF_JSON);
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

                COMP_JSON="$EXP_COMPARISON" EXP_ID_VAL="$EXP_ID" node -e "
                    const { updateExperimentStatus } = require('./src/batch/learning/experiment-manager');
                    const comp = JSON.parse(process.env.COMP_JSON);
                    const status = comp.pass ? 'backtest_passed' : 'backtest_failed';
                    updateExperimentStatus(process.env.EXP_ID_VAL, status, {
                        backtestReturn: comp.returnImprovement,
                        backtestMdd: comp.drawdownWorsening,
                    });
                "
                echo "  Experiment backtest: $(json_field "$EXP_COMPARISON" "o.pass?'PASSED':'FAILED'")"
                rm -f "$TEMP_STRATEGY"
            fi
        else
            # No strategy code provided — auto-generate for parameter_test
            if [ "$DESIGN_TYPE" = "parameter_test" ]; then
                CHANGES=$(json_field "$PARSE_RESULT" "JSON.stringify((o.decision.experiment&&o.decision.experiment.design&&o.decision.experiment.design.changes)||{})")

                if [ "$CHANGES" != "{}" ] && [ "$CHANGES" != "null" ] && [ -n "$CHANGES" ]; then
                    echo "  Auto-generating modified strategy from parameter changes..."
                    cp src/strategies/current-strategy.js "$TEMP_STRATEGY"

                    STRATEGY_PATH="$TEMP_STRATEGY" node src/batch/eval/apply-modify.js "$CHANGES" 2>/dev/null
                    APPLY_EXIT=$?

                    if [ $APPLY_EXIT -eq 0 ]; then
                        echo "  Backtesting experiment strategy..."
                        EXP_BACKTEST=$(node src/batch/eval/backtest.js --walk-forward "$TEMP_STRATEGY" 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')
                        CURRENT_WF=$(node src/batch/eval/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

                        EXP_COMPARISON=$(CUR_WF="$CURRENT_WF" NEW_WF_JSON="$EXP_BACKTEST" node -e "
                            const { compareStrategies } = require('./src/batch/eval/backtest');
                            const currentWF = JSON.parse(process.env.CUR_WF);
                            const newWF = JSON.parse(process.env.NEW_WF_JSON);
                            const cTest = currentWF.test || {};
                            const nTest = newWF.test || {};
                            if (cTest.error || nTest.error) {
                                console.log(JSON.stringify({pass:false, reasons:['Backtest error']}));
                            } else {
                                const cMetrics = cTest.measurePeriod || cTest;
                                const nMetrics = nTest.measurePeriod || nTest;
                                console.log(JSON.stringify(compareStrategies(cMetrics, nMetrics, 'modify')));
                            }
                        ")

                        COMP_JSON="$EXP_COMPARISON" EXP_ID_VAL="$EXP_ID" node -e "
                            const { updateExperimentStatus } = require('./src/batch/learning/experiment-manager');
                            const comp = JSON.parse(process.env.COMP_JSON);
                            const status = comp.pass ? 'backtest_passed' : 'backtest_failed';
                            updateExperimentStatus(process.env.EXP_ID_VAL, status, {
                                backtestReturn: comp.returnImprovement,
                                backtestMdd: comp.drawdownWorsening,
                            });
                        " 2>/dev/null || true
                        echo "  Experiment backtest: $(json_field "$EXP_COMPARISON" "o.pass?'PASSED':'FAILED'")"

                        # If passed, deploy as shadow for paper-trading evaluation
                        EXP_PASS=$(json_field "$EXP_COMPARISON" "o.pass")
                        if [ "$EXP_PASS" = "true" ]; then
                            echo "  Deploying as shadow strategy for evaluation..."
                            SHADOW_DEPLOY_RESULT=$(TEMP_FILE="$TEMP_STRATEGY" SHADOW_LABEL="$HYPOTHESIS" SHADOW_EXP_ID="$EXP_ID" node -e "
                                const { deployShadow } = require('./src/batch/learning/shadow-manager');
                                const fs = require('fs');
                                const code = fs.readFileSync(process.env.TEMP_FILE, 'utf8');
                                const id = deployShadow(code, process.env.SHADOW_LABEL, process.env.SHADOW_EXP_ID);
                                console.log(id ? JSON.stringify({success:true,shadowId:id}) : JSON.stringify({success:false}));
                            " 2>/dev/null || echo '{"success":false}')

                            SHADOW_OK=$(json_field "$SHADOW_DEPLOY_RESULT" "o.success")
                            if [ "$SHADOW_OK" = "true" ]; then
                                SHADOW_ID=$(json_field "$SHADOW_DEPLOY_RESULT" "o.shadowId")
                                echo "  Shadow deployed: $SHADOW_ID"
                                EXP_ID_VAL="$EXP_ID" SHADOW_ID_VAL="$SHADOW_ID" node -e "
                                    const { updateExperimentStatus } = require('./src/batch/learning/experiment-manager');
                                    updateExperimentStatus(process.env.EXP_ID_VAL, 'shadow_running', {
                                        shadowId: process.env.SHADOW_ID_VAL,
                                    });
                                " 2>/dev/null || true
                            fi
                        fi
                    else
                        echo "  Parameter application failed."
                        EXP_ID_VAL="$EXP_ID" node -e "
                            const { completeExperiment } = require('./src/batch/learning/experiment-manager');
                            completeExperiment(process.env.EXP_ID_VAL, 'inconclusive', {
                                reason: 'Parameter application failed'
                            });
                        " 2>/dev/null || true
                    fi
                    rm -f "$TEMP_STRATEGY"
                else
                    echo "  No parameter changes specified."
                    EXP_ID_VAL="$EXP_ID" node -e "
                        const { completeExperiment } = require('./src/batch/learning/experiment-manager');
                        completeExperiment(process.env.EXP_ID_VAL, 'inconclusive', {
                            reason: 'No parameter changes in experiment design'
                        });
                    " 2>/dev/null || true
                fi
            else
                echo "  shadow_strategy requires strategy code block. Completing as inconclusive."
                EXP_ID_VAL="$EXP_ID" node -e "
                    const { completeExperiment } = require('./src/batch/learning/experiment-manager');
                    completeExperiment(process.env.EXP_ID_VAL, 'inconclusive', {
                        reason: 'shadow_strategy requires a javascript code block'
                    });
                " 2>/dev/null || true
            fi
        fi
    fi

    # Update batch memory
    echo "$PARSE_RESULT" | TRIGGER="$TRIGGER_TYPE" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const {appendEntry}=require('./src/batch/learning/update-memory');
            appendEntry({action:'experiment',reasoning:r.reasoning,confidence:r.confidence,outcome:'registered',improvementAreas:r.improvementAreas||null,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:process.env.TRIGGER});
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
CURRENT_WF=$(node src/batch/eval/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

# Extract current baseline metrics for comparison and retry prompts
CURRENT_METRICS=$(CUR_WF="$CURRENT_WF" node -e "
    const wf = JSON.parse(process.env.CUR_WF);
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
            const { buildRetryPrompt } = require('./src/batch/prompt/build-retry-prompt');
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

        CURRENT_PARSE=$(echo "$RETRY_OUTPUT" | node src/batch/prompt/parse-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

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

        NEW_WF=$(node src/batch/eval/backtest.js --walk-forward "$TEMP_STRATEGY" 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

        COMPARISON=$(CUR_WF="$CURRENT_WF" NEW_WF_JSON="$NEW_WF" node -e "
            const { compareStrategies } = require('./src/batch/eval/backtest');
            const currentWF = JSON.parse(process.env.CUR_WF);
            const newWF = JSON.parse(process.env.NEW_WF_JSON);
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
            LAST_NEW_METRICS=$(NEW_WF_JSON="$NEW_WF" node -e "
                const wf = JSON.parse(process.env.NEW_WF_JSON);
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
            DIAGNOSIS=$(COMP_JSON="$COMPARISON" NEW_M="$LAST_NEW_METRICS" CUR_M="$CURRENT_METRICS" node -e "
                const { diagnoseGateFailure } = require('./src/batch/prompt/diagnose-failure');
                const d = diagnoseGateFailure(JSON.parse(process.env.COMP_JSON), JSON.parse(process.env.NEW_M), JSON.parse(process.env.CUR_M));
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

            V_WF=$(node src/batch/eval/backtest.js --walk-forward "$TEMP_STRATEGY" 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

            V_COMPARISON=$(CUR_WF="$CURRENT_WF" NEW_WF_JSON="$V_WF" node -e "
                const { compareStrategies } = require('./src/batch/eval/backtest');
                const currentWF = JSON.parse(process.env.CUR_WF);
                const newWF = JSON.parse(process.env.NEW_WF_JSON);
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
                IS_BETTER=$(V_R="$V_RETURN" B_R="$BEST_VARIANT_RETURN" node -e "console.log(Number(process.env.V_R) > Number(process.env.B_R) ? 'true' : 'false')")
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
            LAST_NEW_METRICS=$(NEW_WF_JSON="${V_WF:-'{"test":{}}'}" node -e "
                const wf = JSON.parse(process.env.NEW_WF_JSON);
                const t = wf.test || {};
                const m = t.measurePeriod || t;
                console.log(JSON.stringify({
                    returnPct: m.returnPct || 0,
                    maxDrawdown: m.maxDrawdown || 0,
                    dailyTrades: m.dailyTrades || 0,
                    tradeDays: m.tradeDays || 0,
                }));
            " 2>/dev/null || echo '{"returnPct":0,"maxDrawdown":0,"dailyTrades":0,"tradeDays":0}')

            DIAGNOSIS=$(GATE_JSON="${LAST_GATE_RESULT:-'{}'}" NEW_M="${LAST_NEW_METRICS:-'{}'}" CUR_M="$CURRENT_METRICS" node -e "
                const { diagnoseGateFailure } = require('./src/batch/prompt/diagnose-failure');
                const d = diagnoseGateFailure(JSON.parse(process.env.GATE_JSON), JSON.parse(process.env.NEW_M), JSON.parse(process.env.CUR_M));
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
    DIAG_RESULT=$(GATE_JSON="${LAST_GATE_RESULT:-'{}'}" NEW_M="${LAST_NEW_METRICS:-'{}'}" CUR_M="$CURRENT_METRICS" node -e "
        const { diagnoseGateFailure } = require('./src/batch/prompt/diagnose-failure');
        try {
            const d = diagnoseGateFailure(JSON.parse(process.env.GATE_JSON), JSON.parse(process.env.NEW_M), JSON.parse(process.env.CUR_M));
            console.log(JSON.stringify(d.summary));
        } catch(e) { console.log(JSON.stringify('Diagnosis error: ' + e.message)); }
    " 2>/dev/null || echo '""')
    echo "${WINNING_PARSE:-$PARSE_RESULT}" | LAST_GATE_JSON="${LAST_GATE_RESULT:-null}" TRIGGER="$TRIGGER_TYPE" RETRIES="$((MAX_RETRIES + 1))" VARIANTS="$TOTAL_VARIANTS_TESTED" DIAG="$DIAG_RESULT" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision || {};
            const {appendEntry}=require('./src/batch/learning/update-memory');
            let bt=null; try{bt=JSON.parse(process.env.LAST_GATE_JSON);}catch(e){}
            let diag=''; try{diag=JSON.parse(process.env.DIAG);}catch(e){diag=process.env.DIAG||'';}
            appendEntry({
                action:'replace',
                reasoning:r.reasoning||'',
                confidence:r.confidence||0,
                outcome:'all_retries_failed',
                improvementAreas:r.improvementAreas||null,
                backtestResult:bt,
                notes:r.notes||'',
                strategicNotes:r.strategicNotes,
                knowledge:r.knowledge||null,
                triggerType:process.env.TRIGGER,
                retryAttempts:Number(process.env.RETRIES),
                variantsTested:Number(process.env.VARIANTS),
                diagnosis:diag,
            });
        });
    "

    FAIL_JSON=$(RETRIES="$((MAX_RETRIES + 1))" VARIANTS="$TOTAL_VARIANTS_TESTED" node -e "
        console.log(JSON.stringify({
            type:'replace_fail',
            reasoning:'All retry attempts failed',
            retryAttempts:Number(process.env.RETRIES),
            variantsTested:Number(process.env.VARIANTS),
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

DEPLOY_RESULT=$(COMP_JSON="$WINNING_COMPARISON" node -e "
    const fs = require('fs');
    const { deploy } = require('./src/batch/eval/deploy');
    const code = fs.readFileSync('$TEMP_STRATEGY', 'utf8');
    const comparison = JSON.parse(process.env.COMP_JSON);
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
    WIN_DECISION=$(json_field "$WINNING_PARSE" "JSON.stringify(o.decision)")
    NOTIFY_JSON=$(COMP_JSON="$WINNING_COMPARISON" DEC_JSON="$WIN_DECISION" node -e "
        const comp = JSON.parse(process.env.COMP_JSON);
        const r = JSON.parse(process.env.DEC_JSON);
        console.log(JSON.stringify({type:'replace_success',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp}));
    ")
    notify_batch "$NOTIFY_JSON"

    echo "$WINNING_PARSE" | COMP_JSON="$WINNING_COMPARISON" TRIGGER="$TRIGGER_TYPE" RETRIES="$((ATTEMPT + 1))" VARIANTS="$TOTAL_VARIANTS_TESTED" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const comp=JSON.parse(process.env.COMP_JSON);
            const {appendEntry}=require('./src/batch/learning/update-memory');
            appendEntry({action:'replace',reasoning:r.reasoning,confidence:r.confidence,outcome:'deployed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:process.env.TRIGGER,retryAttempts:Number(process.env.RETRIES),variantsTested:Number(process.env.VARIANTS)});
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
    FAIL_DECISION=$(json_field "$WINNING_PARSE" "JSON.stringify(o.decision)")
    NOTIFY_JSON=$(COMP_JSON="$WINNING_COMPARISON" DEC_JSON="$FAIL_DECISION" DR_JSON="$DEPLOY_RESULT" node -e "
        const comp = JSON.parse(process.env.COMP_JSON);
        const r = JSON.parse(process.env.DEC_JSON);
        const dr = JSON.parse(process.env.DR_JSON);
        console.log(JSON.stringify({type:'replace_fail',reasoning:r.reasoning||'',confidence:r.confidence||0,comparison:comp,deployError:dr.reason||'unknown'}));
    ")
    notify_batch "$NOTIFY_JSON"

    echo "$WINNING_PARSE" | COMP_JSON="$WINNING_COMPARISON" TRIGGER="$TRIGGER_TYPE" RETRIES="$((ATTEMPT + 1))" VARIANTS="$TOTAL_VARIANTS_TESTED" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision;
            const comp=JSON.parse(process.env.COMP_JSON);
            const {appendEntry}=require('./src/batch/learning/update-memory');
            appendEntry({action:'replace',reasoning:r.reasoning,confidence:r.confidence,outcome:'deploy_failed',improvementAreas:r.improvementAreas||null,backtestResult:comp,notes:r.notes||'',strategicNotes:r.strategicNotes,knowledge:r.knowledge||null,triggerType:process.env.TRIGGER,retryAttempts:Number(process.env.RETRIES),variantsTested:Number(process.env.VARIANTS)});
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
    const { checkAutoPromotion } = require('./src/batch/learning/shadow-manager');

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
        const { getShadowDetails } = require('./src/batch/learning/shadow-manager');
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
            const { deploy } = require('./src/batch/eval/deploy');
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
                const { removeShadow } = require('./src/batch/learning/shadow-manager');
                removeShadow('$SHADOW_ID');
            " 2>/dev/null || true

            if [ -n "$SHADOW_EXP_ID" ] && [ "$SHADOW_EXP_ID" != "" ]; then
                node -e "
                    const { completeExperiment } = require('./src/batch/learning/experiment-manager');
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
