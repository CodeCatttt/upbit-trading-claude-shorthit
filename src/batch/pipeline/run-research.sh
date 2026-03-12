#!/usr/bin/env bash
#
# run-research.sh — Research pipeline orchestrator (3-tier autonomous batch system)
# Steps: fetch candles → collect metrics → Claude research analysis (with WebSearch) →
#         parse response → backtest/experiment/findings → update memory → notify
# Features: longer timeout (15min), web search enabled, research-log tracking
#

set -euo pipefail

# Ensure node/claude are available in cron environment
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

PROJECT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$PROJECT_DIR"

# --- Lockfile: prevent concurrent/overlapping research runs ---
LOCKFILE="$PROJECT_DIR/data/.research-lock"
if [ -f "$LOCKFILE" ]; then
    LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
    if [ "$LOCK_AGE" -lt 7200 ]; then
        echo "Research already running (lock age: ${LOCK_AGE}s). Exiting."
        exit 0
    fi
    echo "Stale lock found (age: ${LOCK_AGE}s). Removing."
    rm -f "$LOCKFILE"
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

TIMESTAMP=$(date +"%Y-%m-%d-%H%M")
LOG_DIR="$PROJECT_DIR/logs/research"
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
TEMP_STRATEGY="$PROJECT_DIR/src/strategies/.tmp-new-strategy.js"
CUSTOM_INDICATORS_FILE="$PROJECT_DIR/src/strategies/custom-indicators.js"
CUSTOM_INDICATORS_BACKUP="$PROJECT_DIR/src/strategies/.backup-custom-indicators.js"
RESEARCH_LOG="$PROJECT_DIR/data/research-log.json"
TRIGGER_TYPE="${RESEARCH_TRIGGER:-WEEKLY_RESEARCH}"

echo "=============================="
echo "Research run: $TIMESTAMP"
echo "Trigger: $TRIGGER_TYPE"
echo "=============================="

# Step 1: Fetch latest candle data
echo "[Step 1] Fetching candle data..."
node src/data/candle-fetcher.js
echo "[Step 1] Done."

# Step 2: Collect metrics
echo "[Step 2] Collecting metrics..."
node src/batch/eval/collect-metrics.js > /dev/null
echo "[Step 2] Done."

# Step 3: Build research prompt and call Claude (with WebSearch)
echo "[Step 3] Building research prompt and calling Claude..."
PROMPT=$(RESEARCH_TRIGGER="$TRIGGER_TYPE" node src/batch/prompt/build-research-prompt.js)

CLAUDE_OUTPUT=$(echo "$PROMPT" | timeout 900 env -u CLAUDECODE claude --model claude-opus-4-6 --allowedTools "WebSearch" -p 2>/dev/null || true)

if [ -z "$CLAUDE_OUTPUT" ]; then
    echo "[Step 3] ERROR: Claude returned empty output."
    notify_batch '{"type":"research_findings","reasoning":"Research failed: Claude returned empty output"}'
    exit 1
fi
echo "[Step 3] Claude response received (${#CLAUDE_OUTPUT} chars)."

# Step 4: Parse response
echo "[Step 4] Parsing Claude research response..."
PARSE_RESULT=$(echo "$CLAUDE_OUTPUT" | node src/batch/prompt/parse-research-response.js 2>/dev/null || echo '{"valid":false,"errors":["parse failed"]}')

VALID=$(json_field "$PARSE_RESULT" "o.valid")
ACTION=$(json_field "$PARSE_RESULT" "o.decision?o.decision.action:'none'")

echo "[Step 4] Valid: $VALID, Action: $ACTION"

if [ "$VALID" != "true" ]; then
    echo "[Step 4] Validation failed. Saving raw findings and aborting."
    json_field "$PARSE_RESULT" "o.errors"
    notify_batch '{"type":"research_findings","reasoning":"Research parse failed"}'
    exit 1
fi

# Extract common fields
REASONING=$(json_field "$PARSE_RESULT" "o.decision.reasoning||'research analysis'")
CONFIDENCE=$(json_field "$PARSE_RESULT" "o.decision.confidence||0")
FINDINGS=$(json_field "$PARSE_RESULT" "o.decision.findings||o.decision.reasoning||''")

# =====================================================================
# ACTION: replace_strategy — backtest + gate check + deploy
# =====================================================================

if [ "$ACTION" = "replace_strategy" ]; then
    echo "[Step 5] REPLACE_STRATEGY path — backtesting new strategy"

    # Baseline: walk-forward backtest of current strategy
    echo "  Backtesting current strategy (baseline)..."
    CURRENT_WF=$(node src/batch/eval/backtest.js --walk-forward src/strategies/current-strategy.js 2>/dev/null || echo '{"test":{"error":"backtest failed"}}')

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

    # Check for multi-variant support
    VARIANT_COUNT=$(json_field "$PARSE_RESULT" "(o.strategyVariants||[]).length")
    echo "  Variants found: ${VARIANT_COUNT:-0}"

    WINNING_CODE=""
    WINNING_COMPARISON=""
    TOTAL_VARIANTS_TESTED=0

    if [ "${VARIANT_COUNT:-0}" -gt "1" ]; then
        # Multi-variant path: test each variant, pick best passing one
        echo "  Multi-variant mode — testing $VARIANT_COUNT variants..."

        BEST_VARIANT_CODE=""
        BEST_VARIANT_RETURN=-999999
        BEST_VARIANT_COMPARISON=""

        # Install custom indicators once for all variants (if present)
        MV_HAS_CI="false"
        echo "$PARSE_RESULT" | node -e "
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
            VARIANT_LABEL=$(json_field "$PARSE_RESULT" "(o.strategyVariants[$VI]||{}).label||'variant_$VI'")
            echo "    Testing variant $((VI + 1))/$VARIANT_COUNT: $VARIANT_LABEL"

            # Write variant to temp file
            echo "$PARSE_RESULT" | node -e "
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
                IS_BETTER=$(V_R="$V_RETURN" B_R="$BEST_VARIANT_RETURN" node -e "console.log(Number(process.env.V_R) > Number(process.env.B_R) ? 'true' : 'false')")
                if [ "$IS_BETTER" = "true" ]; then
                    BEST_VARIANT_CODE=$(cat "$TEMP_STRATEGY")
                    BEST_VARIANT_RETURN="$V_RETURN"
                    BEST_VARIANT_COMPARISON="$V_COMPARISON"
                fi
            fi

            rm -f "$TEMP_STRATEGY"
        done

        # Restore custom indicators after variant testing
        if [ "$MV_HAS_CI" = "true" ] && [ -f "$CUSTOM_INDICATORS_BACKUP" ]; then
            cp "$CUSTOM_INDICATORS_BACKUP" "$CUSTOM_INDICATORS_FILE"
        fi
        rm -f "$TEMP_STRATEGY.custom-indicators"

        if [ -n "$BEST_VARIANT_CODE" ]; then
            echo "  Best variant selected (return improvement: $BEST_VARIANT_RETURN%)"
            WINNING_CODE="$BEST_VARIANT_CODE"
            WINNING_COMPARISON="$BEST_VARIANT_COMPARISON"
        fi
    else
        # Single variant path
        echo "  Single variant — extracting and backtesting..."

        HAS_CUSTOM_INDICATORS="false"

        echo "$PARSE_RESULT" | node -e "
            process.stdin.setEncoding('utf8');
            let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                const r=JSON.parse(d);
                if (r.strategyCode) require('fs').writeFileSync('$TEMP_STRATEGY', r.strategyCode);
                if (r.customIndicatorsCode) {
                    require('fs').writeFileSync('$TEMP_STRATEGY.custom-indicators', r.customIndicatorsCode);
                }
            });
        "

        if [ ! -f "$TEMP_STRATEGY" ]; then
            echo "  ERROR: No strategy code found in response."
            ACTION="no_action"
        else
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
                WINNING_CODE=$(cat "$TEMP_STRATEGY")
                WINNING_COMPARISON="$COMPARISON"
            fi

            rm -f "$TEMP_STRATEGY" "$TEMP_STRATEGY.custom-indicators"
        fi
    fi

    # Deploy if a winning strategy was found
    if [ -n "${WINNING_CODE:-}" ]; then
        echo "[Step 6] Deploying winning research strategy..."

        # Write winning code to temp file for deploy
        echo "$WINNING_CODE" > "$TEMP_STRATEGY"

        # Reinstall custom indicators if present
        HAS_CUSTOM_INDICATORS="false"
        echo "$PARSE_RESULT" | node -e "
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

        echo "[Step 6] Deploy result: success=$DEPLOY_SUCCESS"
        echo "$DEPLOY_RESULT"

        if [ "$DEPLOY_SUCCESS" = "true" ]; then
            OUTCOME="deployed"

            # Git commit
            cd "$PROJECT_DIR"
            git add src/strategies/current-strategy.js src/strategies/custom-indicators.js deploy-log.json trading-config.json data/batch-memory.json 2>/dev/null || true
            git commit -m "research: replace strategy - $REASONING" 2>/dev/null || echo "  No changes to commit."
            git push 2>/dev/null || echo "  Push skipped (no remote configured)."

            # Notify success
            NOTIFY_JSON=$(COMP_JSON="$WINNING_COMPARISON" REASON="$REASONING" CONF="$CONFIDENCE" node -e "
                const comp = JSON.parse(process.env.COMP_JSON);
                console.log(JSON.stringify({type:'research_replace',reasoning:process.env.REASON,confidence:Number(process.env.CONF),comparison:comp}));
            ")
            notify_batch "$NOTIFY_JSON"
        else
            OUTCOME="deploy_failed"

            # Restore custom indicators if deploy failed
            if [ "$HAS_CUSTOM_INDICATORS" = "true" ] && [ -f "$CUSTOM_INDICATORS_BACKUP" ]; then
                cp "$CUSTOM_INDICATORS_BACKUP" "$CUSTOM_INDICATORS_FILE"
                rm -f "$CUSTOM_INDICATORS_BACKUP"
            fi

            notify_batch "{\"type\":\"research_replace\",\"reasoning\":\"Deploy failed: $REASONING\",\"deployError\":\"$(json_field "$DEPLOY_RESULT" "o.reason||'unknown'")\"}"
        fi
    else
        OUTCOME="gate_failed"
        echo "  Backtest gate failed. Strategy not deployed."
        notify_batch "{\"type\":\"research_findings\",\"reasoning\":\"Research strategy failed backtest gate: $REASONING\"}"
    fi

    # Update batch memory
    echo "$PARSE_RESULT" | TRIGGER="$TRIGGER_TYPE" OUTCOME_VAL="$OUTCOME" VARIANTS="$TOTAL_VARIANTS_TESTED" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision||{};
            const {appendEntry}=require('./src/batch/learning/update-memory');
            appendEntry({
                action:'replace',
                reasoning:r.reasoning||'',
                confidence:r.confidence||0,
                outcome:process.env.OUTCOME_VAL,
                improvementAreas:r.improvementAreas||null,
                notes:r.notes||'',
                knowledge:r.knowledge||null,
                triggerType:process.env.TRIGGER,
                variantsTested:Number(process.env.VARIANTS),
                source:'research',
            });
        });
    "
fi

# =====================================================================
# ACTION: propose_experiment — register experiment + optional shadow deploy
# =====================================================================

if [ "$ACTION" = "propose_experiment" ]; then
    echo "[Step 5] PROPOSE_EXPERIMENT path — structured hypothesis testing"

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

        if [ "$HAS_STRATEGY_CODE" = "true" ] && [ "$DESIGN_TYPE" = "shadow_strategy" ]; then
            # Shadow strategy: deploy as shadow for paper-trading
            echo "  Strategy code found. Deploying as shadow strategy..."

            echo "$PARSE_RESULT" | TEMP_FILE="$TEMP_STRATEGY" node -e "
                process.stdin.setEncoding('utf8');let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    const r=JSON.parse(d);
                    if (r.strategyCode) require('fs').writeFileSync(process.env.TEMP_FILE, r.strategyCode);
                });
            "

            if [ -f "$TEMP_STRATEGY" ]; then
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
                    echo "  Shadow deploy failed."
                    EXP_ID_VAL="$EXP_ID" node -e "
                        const { updateExperimentStatus } = require('./src/batch/learning/experiment-manager');
                        updateExperimentStatus(process.env.EXP_ID_VAL, 'shadow_deploy_failed', {});
                    " 2>/dev/null || true
                fi
                rm -f "$TEMP_STRATEGY"
            fi

        elif [ "$DESIGN_TYPE" = "parameter_test" ]; then
            # Parameter test: auto-generate modified strategy + backtest + shadow deploy
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

        elif [ "$HAS_STRATEGY_CODE" = "true" ]; then
            # shadow_strategy with code but handled above; other types: backtest only
            echo "  Backtesting experiment strategy..."

            echo "$PARSE_RESULT" | TEMP_FILE="$TEMP_STRATEGY" node -e "
                process.stdin.setEncoding('utf8');let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    const r=JSON.parse(d);
                    if (r.strategyCode) require('fs').writeFileSync(process.env.TEMP_FILE, r.strategyCode);
                });
            "

            if [ -f "$TEMP_STRATEGY" ]; then
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
                " 2>/dev/null || true
                echo "  Experiment backtest: $(json_field "$EXP_COMPARISON" "o.pass?'PASSED':'FAILED'")"
                rm -f "$TEMP_STRATEGY"
            fi
        else
            echo "  No strategy code — experiment registered for tracking only."
        fi
    fi

    # Update batch memory
    echo "$PARSE_RESULT" | TRIGGER="$TRIGGER_TYPE" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision||{};
            const {appendEntry}=require('./src/batch/learning/update-memory');
            appendEntry({
                action:'experiment',
                reasoning:r.reasoning||'',
                confidence:r.confidence||0,
                outcome:'registered',
                improvementAreas:r.improvementAreas||null,
                notes:r.notes||'',
                knowledge:r.knowledge||null,
                triggerType:process.env.TRIGGER,
                source:'research',
            });
        });
    "

    NOTIFY_JSON=$(json_field "$PARSE_RESULT" "JSON.stringify({type:'research_experiment',hypothesis:o.decision.experiment?o.decision.experiment.hypothesis:'',reasoning:o.decision.reasoning||''})")
    notify_batch "$NOTIFY_JSON"

    echo "  Experiment path complete."
fi

# =====================================================================
# ACTION: no_action — save findings/knowledge only
# =====================================================================

if [ "$ACTION" = "no_action" ]; then
    echo "[Step 5] NO_ACTION path — saving research findings"

    # Update batch memory with findings and knowledge
    echo "$PARSE_RESULT" | TRIGGER="$TRIGGER_TYPE" node -e "
        process.stdin.setEncoding('utf8');let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            const r=JSON.parse(d).decision||{};
            const {appendEntry}=require('./src/batch/learning/update-memory');
            appendEntry({
                action:'keep',
                reasoning:r.reasoning||'',
                confidence:r.confidence||0,
                outcome:'research_findings',
                improvementAreas:r.improvementAreas||null,
                notes:r.notes||r.findings||'',
                knowledge:r.knowledge||null,
                triggerType:process.env.TRIGGER,
                source:'research',
            });
        });
    "

    NOTIFY_JSON=$(REASON="$REASONING" FIND="$FINDINGS" node -e "
        console.log(JSON.stringify({
            type:'research_findings',
            reasoning:process.env.REASON,
            findings:process.env.FIND,
        }));
    ")
    notify_batch "$NOTIFY_JSON"

    echo "  Research findings saved."
fi

# =====================================================================
# Step 8: Update research-log.json
# =====================================================================
echo "[Step 8] Updating research-log.json..."

DECISION_JSON=$(json_field "$PARSE_RESULT" "JSON.stringify(o.decision||{})")

ACTION_VAL="$ACTION" TRIGGER_VAL="$TRIGGER_TYPE" TIMESTAMP_VAL="$TIMESTAMP" DECISION_DATA="$DECISION_JSON" FINDINGS_VAL="$FINDINGS" node -e "
    const fs = require('fs');
    const LOG_FILE = '$RESEARCH_LOG';
    const MAX_ENTRIES = 30;

    let log = [];
    try {
        if (fs.existsSync(LOG_FILE)) {
            log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
            if (!Array.isArray(log)) log = [];
        }
    } catch(e) { log = []; }

    let decision = {};
    try { decision = JSON.parse(process.env.DECISION_DATA); } catch(e) {}

    log.push({
        timestamp: new Date().toISOString(),
        batchTimestamp: process.env.TIMESTAMP_VAL,
        trigger: process.env.TRIGGER_VAL,
        action: process.env.ACTION_VAL,
        reasoning: decision.reasoning || '',
        confidence: decision.confidence || 0,
        findings: process.env.FINDINGS_VAL || '',
        knowledge: decision.knowledge || null,
    });

    // Trim to max entries
    if (log.length > MAX_ENTRIES) {
        log = log.slice(log.length - MAX_ENTRIES);
    }

    // Atomic write
    const tmpFile = LOG_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(log, null, 2));
    fs.renameSync(tmpFile, LOG_FILE);
    console.log('  Research log updated (' + log.length + ' entries).');
"

echo "=============================="
echo "Research complete: $TIMESTAMP"
echo "=============================="
