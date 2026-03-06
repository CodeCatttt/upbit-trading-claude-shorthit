/**
 * batch-scheduler.js
 * Adaptive batch scheduling — replaces fixed hourly cron.
 * Evaluates trigger conditions every 15 minutes, runs batch when conditions met.
 *
 * Trigger conditions (any one triggers a batch):
 *   - 24h price change > 5% for any watched asset (REGIME_CHANGE)
 *   - Portfolio MDD > 8% from peak (DRAWDOWN_ALERT)
 *   - 6+ hours since last batch (minimum guarantee → DAILY_REVIEW)
 *   - New daily candle close / UTC 0:00 (DAILY_REVIEW)
 *   - 7+ days since last trade (STAGNATION)
 *   - Active experiment ready for review (EXPERIMENT_REVIEW)
 *
 * Run via PM2: pm2 start src/batch/batch-scheduler.js --name batch-scheduler
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const api = require('../core/upbit-api');
const { createLogger } = require('../utils/logger');

const log = createLogger('SCHEDULER');

const PROJECT_DIR = path.join(__dirname, '../..');
const CONFIG_FILE = path.join(PROJECT_DIR, 'trading-config.json');
const STATE_FILE = path.join(PROJECT_DIR, 'bot-state.json');
const EXECUTION_LOG_FILE = path.join(PROJECT_DIR, 'data/execution-log.json');
const EXPERIMENTS_FILE = path.join(PROJECT_DIR, 'data/experiments.json');
const SCHEDULER_STATE_FILE = path.join(PROJECT_DIR, 'data/scheduler-state.json');
const PERFORMANCE_FILE = path.join(PROJECT_DIR, 'data/performance-ledger.json');

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MIN_BATCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours minimum between batches
const PRICE_CHANGE_THRESHOLD = 5; // 5%
const MDD_THRESHOLD = 8; // 8%
const STAGNATION_DAYS = 7;

function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return fallback;
}

function saveJSON(fp, data) {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, fp);
}

function loadSchedulerState() {
    return loadJSON(SCHEDULER_STATE_FILE, {
        lastBatchTime: null,
        lastDailyReviewDate: null,
    });
}

function saveSchedulerState(state) {
    saveJSON(SCHEDULER_STATE_FILE, state);
}

/**
 * Check if any watched asset has > 5% price change in 24h
 */
async function checkRegimeChange() {
    const config = loadJSON(CONFIG_FILE, { markets: ['KRW-BTC'] });
    for (const market of config.markets) {
        try {
            const candles = await api.getCandles(market, 60, 24);
            if (candles.length >= 24) {
                const price = candles[candles.length - 1].close;
                const oldPrice = candles[0].close;
                const change = Math.abs((price - oldPrice) / oldPrice * 100);
                if (change > PRICE_CHANGE_THRESHOLD) {
                    log.info(`Regime change detected: ${market} ${change.toFixed(1)}% change`);
                    return true;
                }
            }
        } catch (e) {
            log.warn(`Failed to check ${market}:`, e.message);
        }
    }
    return false;
}

/**
 * Check if portfolio MDD exceeds threshold
 */
function checkDrawdown() {
    const ledger = loadJSON(PERFORMANCE_FILE, { entries: [] });
    if (ledger.entries.length === 0) return false;

    const latest = ledger.entries[ledger.entries.length - 1];
    if (latest.mdd > MDD_THRESHOLD) {
        log.info(`Drawdown alert: MDD ${latest.mdd}% > ${MDD_THRESHOLD}%`);
        return true;
    }
    return false;
}

/**
 * Check if enough time has passed since last batch (6h minimum)
 */
function checkMinInterval(schedulerState) {
    if (!schedulerState.lastBatchTime) return true;
    const elapsed = Date.now() - new Date(schedulerState.lastBatchTime).getTime();
    return elapsed >= MIN_BATCH_INTERVAL_MS;
}

/**
 * Check if daily candle has closed (new UTC day since last daily review)
 */
function checkDailyClose(schedulerState) {
    const today = new Date().toISOString().slice(0, 10);
    if (schedulerState.lastDailyReviewDate === today) return false;

    // Only trigger around UTC 0:00 (KST 09:00) — within first 2 hours
    const hour = new Date().getUTCHours();
    return hour < 2;
}

/**
 * Check if no trades for 7+ days (stagnation)
 */
function checkStagnation() {
    const execLog = loadJSON(EXECUTION_LOG_FILE, []);
    if (execLog.length === 0) return true;

    const lastTrade = execLog[execLog.length - 1];
    if (!lastTrade.timestamp) return false;

    const daysSinceTrade = (Date.now() - new Date(lastTrade.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceTrade >= STAGNATION_DAYS) {
        log.info(`Stagnation detected: ${daysSinceTrade.toFixed(1)} days since last trade`);
        return true;
    }
    return false;
}

/**
 * Check if any active experiment needs review.
 * Triggers on: live_testing past duration, or proposed stuck > 3 days (needs cleanup).
 */
function checkExperimentReview() {
    const experiments = loadJSON(EXPERIMENTS_FILE, { active: [] });
    for (const exp of experiments.active) {
        if (!exp.startedAt) continue;
        const daysSinceStart = (Date.now() - new Date(exp.startedAt).getTime()) / (1000 * 60 * 60 * 24);
        const durationDays = parseInt(exp.design?.duration) || 7;

        if (exp.status === 'live_testing' && daysSinceStart >= durationDays) {
            log.info(`Experiment ${exp.id} ready for review (${daysSinceStart.toFixed(1)}d / ${durationDays}d)`);
            return true;
        }
        // Trigger cleanup for experiments stuck in proposed status
        if (exp.status === 'proposed' && daysSinceStart >= 3) {
            log.info(`Experiment ${exp.id} stuck in proposed for ${daysSinceStart.toFixed(1)}d — triggering review`);
            return true;
        }
    }
    return false;
}

/**
 * Evaluate all trigger conditions and determine if batch should run.
 * Returns trigger type string or null.
 */
async function evaluateTriggers() {
    const schedulerState = loadSchedulerState();

    // Must respect minimum interval
    if (!checkMinInterval(schedulerState)) {
        return null;
    }

    // Priority-ordered checks
    if (checkDrawdown()) return 'DRAWDOWN_ALERT';

    if (await checkRegimeChange()) return 'REGIME_CHANGE';

    if (checkExperimentReview()) return 'EXPERIMENT_REVIEW';

    if (checkStagnation()) return 'STAGNATION';

    if (checkDailyClose(schedulerState)) return 'DAILY_REVIEW';

    return null;
}

/**
 * Execute the batch pipeline with the given trigger type
 */
function executeBatch(triggerType) {
    log.info(`Executing batch with trigger: ${triggerType}`);

    const schedulerState = loadSchedulerState();
    schedulerState.lastBatchTime = new Date().toISOString();
    if (triggerType === 'DAILY_REVIEW') {
        schedulerState.lastDailyReviewDate = new Date().toISOString().slice(0, 10);
    }
    saveSchedulerState(schedulerState);

    const batchScript = path.join(PROJECT_DIR, 'src/batch/run-batch.sh');

    const child = spawn('bash', [batchScript], {
        cwd: PROJECT_DIR,
        env: { ...process.env, BATCH_TRIGGER: triggerType },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) log.info(`[batch] ${line}`);
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) log.warn(`[batch:err] ${line}`);
    });

    child.on('close', (code) => {
        log.info(`Batch completed with exit code: ${code}`);
    });

    child.on('error', (err) => {
        log.error(`Batch spawn error: ${err.message}`);
    });
}

/**
 * Main scheduler loop — runs every 15 minutes
 */
async function checkAndRun() {
    try {
        const trigger = await evaluateTriggers();
        if (trigger) {
            executeBatch(trigger);
        } else {
            log.info('No trigger conditions met. Skipping batch.');
        }
    } catch (e) {
        log.error('Scheduler error:', e.message);
    }
}

// Run immediately on start, then every 15 minutes
log.info('Batch scheduler started. Checking every 15 minutes.');
checkAndRun();
setInterval(checkAndRun, CHECK_INTERVAL_MS);
