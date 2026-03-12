/**
 * batch-scheduler.js
 * 3-tier adaptive batch scheduling — strategy, infra_fix, research.
 * Evaluates trigger conditions every 15 minutes, routes to appropriate pipeline.
 *
 * Tiers:
 *   strategy   — market response, parameter adjustment (run-batch.sh)
 *   infra_fix  — bug detection and fixing (run-infra-fix.sh)
 *   research   — fundamental strategy research (run-research.sh)
 *
 * Run via PM2: pm2 start src/batch/pipeline/batch-scheduler.js --name batch-scheduler
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const api = require('../../core/upbit-api');
const { createLogger } = require('../../utils/logger');

const log = createLogger('SCHEDULER');

const PROJECT_DIR = path.join(__dirname, '../../..');
const CONFIG_FILE = path.join(PROJECT_DIR, 'trading-config.json');
const EXECUTION_LOG_FILE = path.join(PROJECT_DIR, 'data/execution-log.json');
const EXPERIMENTS_FILE = path.join(PROJECT_DIR, 'data/experiments.json');
const SCHEDULER_STATE_FILE = path.join(PROJECT_DIR, 'data/scheduler-state.json');
const PERFORMANCE_FILE = path.join(PROJECT_DIR, 'data/performance-ledger.json');

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PRICE_CHANGE_THRESHOLD = 5; // 5%
const MDD_THRESHOLD = 8; // 8%
const STAGNATION_DAYS = 7;

// Per-tier minimum intervals
const MIN_INTERVALS = {
    strategy: 6 * 60 * 60 * 1000,           // 6 hours (normal)
    strategy_urgent: 3 * 60 * 60 * 1000,     // 3 hours (urgent: DRAWDOWN, REGIME)
    infra_fix: 24 * 60 * 60 * 1000,          // 24 hours (regular maintenance)
    infra_fix_crash: 6 * 60 * 60 * 1000,     // 6 hours (PM2 crash — more urgent)
    infra_fix_weekly: 7 * 24 * 60 * 60 * 1000, // 7 days (weekly maintenance)
    research: 7 * 24 * 60 * 60 * 1000,       // 7 days
};

// Per-tier timeout
const TIER_TIMEOUT_MS = {
    strategy: 60 * 60 * 1000,    // 1 hour
    infra_fix: 30 * 60 * 1000,   // 30 minutes
    research: 90 * 60 * 1000,    // 1.5 hours
};

// Scripts per tier
const TIER_SCRIPTS = {
    strategy: 'src/batch/pipeline/run-batch.sh',
    infra_fix: 'src/batch/pipeline/run-infra-fix.sh',
    research: 'src/batch/pipeline/run-research.sh',
};

// Environment variable names per tier (for passing trigger type)
const TIER_ENV_KEYS = {
    strategy: 'BATCH_TRIGGER',
    infra_fix: 'INFRA_TRIGGER',
    research: 'RESEARCH_TRIGGER',
};

// Cross-tier conflict rules: which tiers CANNOT run simultaneously
// strategy + research both modify strategy files → conflict
const CONFLICTS = {
    strategy: ['research'],
    research: ['strategy'],
    infra_fix: [],  // infra_fix can run alongside anything
};

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

// --- Scheduler state management (per-tier) ---

const DEFAULT_STATE = {
    strategy: { lastBatchTime: null, lastDailyReviewDate: null },
    infra_fix: { lastRunTime: null, lastPm2Restarts: {} },
    research: { lastRunTime: null },
};

function loadSchedulerState() {
    const raw = loadJSON(SCHEDULER_STATE_FILE, null);

    // Migration from old flat format
    if (raw && raw.lastBatchTime !== undefined && !raw.strategy) {
        log.info('Migrating scheduler-state.json from flat to per-tier format');
        const migrated = {
            strategy: {
                lastBatchTime: raw.lastBatchTime,
                lastDailyReviewDate: raw.lastDailyReviewDate || null,
            },
            infra_fix: { lastRunTime: null, lastPm2Restarts: {} },
            research: { lastRunTime: null },
        };
        saveSchedulerState(migrated);
        return migrated;
    }

    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));

    // Ensure all tier keys exist
    if (!raw.strategy) raw.strategy = { lastBatchTime: null, lastDailyReviewDate: null };
    if (!raw.infra_fix) raw.infra_fix = { lastRunTime: null, lastPm2Restarts: {} };
    if (!raw.research) raw.research = { lastRunTime: null };
    return raw;
}

function saveSchedulerState(state) {
    saveJSON(SCHEDULER_STATE_FILE, state);
}

// --- Tier interval checks ---

function getTierLastTime(state, tier) {
    if (tier === 'strategy') return state.strategy.lastBatchTime;
    if (tier === 'infra_fix') return state.infra_fix.lastRunTime;
    if (tier === 'research') return state.research.lastRunTime;
    return null;
}

function checkTierInterval(state, tier, urgent = false) {
    const lastTime = getTierLastTime(state, tier);
    if (!lastTime) return true;
    const elapsed = Date.now() - new Date(lastTime).getTime();
    const key = urgent ? `${tier}_urgent` : tier;
    const minInterval = MIN_INTERVALS[key] || MIN_INTERVALS[tier];
    return elapsed >= minInterval;
}

function checkTierIntervalCustom(state, tier, intervalMs) {
    const lastTime = getTierLastTime(state, tier);
    if (!lastTime) return true;
    const elapsed = Date.now() - new Date(lastTime).getTime();
    return elapsed >= intervalMs;
}

// --- Strategy tier triggers ---

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

function checkDailyClose(state) {
    const today = new Date().toISOString().slice(0, 10);
    if (state.strategy.lastDailyReviewDate === today) return false;
    const hour = new Date().getUTCHours();
    return hour < 2;
}

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
        if (exp.status === 'proposed' && daysSinceStart >= 3) {
            log.info(`Experiment ${exp.id} stuck in proposed for ${daysSinceStart.toFixed(1)}d — triggering review`);
            return true;
        }
    }
    return false;
}

// --- Infra_fix tier triggers ---

function checkPM2Crash(state) {
    try {
        const raw = execSync('pm2 jlist', { encoding: 'utf8', timeout: 10000 });
        const processes = JSON.parse(raw);
        const prevRestarts = state.infra_fix.lastPm2Restarts || {};

        for (const proc of processes) {
            const name = proc.name || 'unknown';
            const restarts = proc.pm2_env?.restart_time || 0;
            const prev = prevRestarts[name] || 0;

            if (restarts - prev >= 3) {
                log.info(`PM2 crash detected: ${name} restarted ${restarts - prev} times since last check`);
                // Update stored restart counts
                state.infra_fix.lastPm2Restarts[name] = restarts;
                saveSchedulerState(state);
                return true;
            }
        }

        // Update restart counts even when no crash detected
        for (const proc of processes) {
            const name = proc.name || 'unknown';
            state.infra_fix.lastPm2Restarts[name] = proc.pm2_env?.restart_time || 0;
        }
        saveSchedulerState(state);
    } catch (e) {
        log.warn('PM2 crash check failed:', e.message);
    }
    return false;
}

// --- Research tier triggers ---

function checkPersistentUnderperformance() {
    const ledger = loadJSON(PERFORMANCE_FILE, { entries: [] });
    if (ledger.entries.length < 14) return false;

    const recent14 = ledger.entries.slice(-14);
    const avgAlpha = recent14.reduce((sum, e) => sum + (e.alpha || 0), 0) / recent14.length;

    if (avgAlpha < -3) {
        log.info(`Persistent underperformance: avg alpha ${avgAlpha.toFixed(2)}% over 14 days`);
        return true;
    }
    return false;
}


// --- Main trigger evaluation ---

/**
 * Evaluate all trigger conditions across all tiers.
 * Returns { tier, trigger } or null.
 * Priority order: PM2_CRASH > DRAWDOWN > REGIME > EXPERIMENT > WEEKLY_MAINTENANCE > UNDERPERFORMANCE > STAGNATION > DAILY > WEEKLY_RESEARCH
 */
async function evaluateTriggers() {
    const state = loadSchedulerState();

    // 1. PM2_CRASH → infra_fix (6h interval — more urgent than regular maintenance)
    if (checkTierIntervalCustom(state, 'infra_fix', MIN_INTERVALS.infra_fix_crash)) {
        if (checkPM2Crash(state)) return { tier: 'infra_fix', trigger: 'PM2_CRASH' };
    }

    // 2-3. Urgent strategy triggers (3h interval)
    if (checkTierInterval(state, 'strategy', true)) {
        if (checkDrawdown()) return { tier: 'strategy', trigger: 'DRAWDOWN_ALERT' };
        if (await checkRegimeChange()) return { tier: 'strategy', trigger: 'REGIME_CHANGE' };
    }

    // 4. EXPERIMENT_REVIEW → strategy (6h interval)
    if (checkTierInterval(state, 'strategy')) {
        if (checkExperimentReview()) return { tier: 'strategy', trigger: 'EXPERIMENT_REVIEW' };
    }

    // 5. WEEKLY_MAINTENANCE → infra_fix (7d interval)
    if (checkTierIntervalCustom(state, 'infra_fix', MIN_INTERVALS.infra_fix_weekly)) {
        return { tier: 'infra_fix', trigger: 'WEEKLY_MAINTENANCE' };
    }

    // 6. PERSISTENT_UNDERPERFORMANCE → research (7d interval)
    if (checkTierInterval(state, 'research')) {
        if (checkPersistentUnderperformance()) return { tier: 'research', trigger: 'PERSISTENT_UNDERPERFORMANCE' };
    }

    // 7. STAGNATION → strategy (6h interval)
    if (checkTierInterval(state, 'strategy')) {
        if (checkStagnation()) return { tier: 'strategy', trigger: 'STAGNATION' };
    }

    // 8. DAILY_REVIEW → strategy (6h interval)
    if (checkTierInterval(state, 'strategy')) {
        if (checkDailyClose(state)) return { tier: 'strategy', trigger: 'DAILY_REVIEW' };
    }

    // 9. WEEKLY_RESEARCH → research (7d interval)
    if (checkTierInterval(state, 'research')) {
        return { tier: 'research', trigger: 'WEEKLY_RESEARCH' };
    }

    return null;
}

// --- Per-tier running state ---

const runningTiers = {};  // { tier: { running: bool, startTime: number } }

function isTierRunning(tier) {
    const t = runningTiers[tier];
    if (!t || !t.running) return false;

    // Safety: reset stuck flag if past timeout
    const timeout = TIER_TIMEOUT_MS[tier] || 60 * 60 * 1000;
    if (t.startTime && (Date.now() - t.startTime > timeout)) {
        log.warn(`${tier} flag stuck for ${Math.round((Date.now() - t.startTime) / 60000)}min, resetting.`);
        runningTiers[tier] = { running: false, startTime: null };
        return false;
    }

    return true;
}

function hasConflict(tier) {
    const conflicting = CONFLICTS[tier] || [];
    for (const ct of conflicting) {
        if (isTierRunning(ct)) {
            log.info(`Cannot start ${tier}: conflicts with running ${ct}`);
            return true;
        }
    }
    return false;
}

/**
 * Execute a tier's pipeline script with the given trigger type
 */
function executeTier(tier, triggerType) {
    if (isTierRunning(tier)) {
        log.info(`${tier} already running, skipping trigger: ${triggerType}`);
        return;
    }

    if (hasConflict(tier)) {
        return;
    }

    runningTiers[tier] = { running: true, startTime: Date.now() };
    log.info(`Executing ${tier} with trigger: ${triggerType}`);

    // Set daily review date early for strategy tier
    if (tier === 'strategy' && triggerType === 'DAILY_REVIEW') {
        const state = loadSchedulerState();
        state.strategy.lastDailyReviewDate = new Date().toISOString().slice(0, 10);
        saveSchedulerState(state);
    }

    const script = path.join(PROJECT_DIR, TIER_SCRIPTS[tier]);
    const envKey = TIER_ENV_KEYS[tier];

    const child = spawn('bash', [script], {
        cwd: PROJECT_DIR,
        env: { ...process.env, [envKey]: triggerType },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) log.info(`[${tier}] ${line}`);
    });

    child.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) log.warn(`[${tier}:err] ${line}`);
    });

    child.on('close', (code) => {
        runningTiers[tier] = { running: false, startTime: null };
        log.info(`${tier} completed with exit code: ${code}`);

        // Update tier's last run time
        const state = loadSchedulerState();
        if (tier === 'strategy') {
            state.strategy.lastBatchTime = new Date().toISOString();
        } else if (tier === 'infra_fix') {
            state.infra_fix.lastRunTime = new Date().toISOString();
        } else if (tier === 'research') {
            state.research.lastRunTime = new Date().toISOString();
        }
        saveSchedulerState(state);
    });

    child.on('error', (err) => {
        runningTiers[tier] = { running: false, startTime: null };
        log.error(`${tier} spawn error: ${err.message}`);
    });
}

/**
 * Main scheduler loop — runs every 15 minutes
 */
async function checkAndRun() {
    try {
        const result = await evaluateTriggers();
        if (result) {
            executeTier(result.tier, result.trigger);
        } else {
            log.info('No trigger conditions met. Skipping.');
        }
    } catch (e) {
        log.error('Scheduler error:', e.message);
    }
}

// Run immediately on start, then every 15 minutes
log.info('Batch scheduler started (3-tier). Checking every 15 minutes.');
checkAndRun();
setInterval(checkAndRun, CHECK_INTERVAL_MS);
