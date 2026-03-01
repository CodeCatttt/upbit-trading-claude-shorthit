/**
 * shadow-manager.js
 * Manages shadow (paper-trading) strategies that run in parallel with the live strategy.
 * Shadow strategies simulate trades without executing them, tracking hypothetical performance.
 *
 * Usage:
 *   const { deployShadow, runShadowCycle, evaluateShadows } = require('./shadow-manager');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('SHADOW');

const SHADOW_DIR = path.join(__dirname, '../../data/shadow-strategies');
const SHADOW_PERF_FILE = path.join(__dirname, '../../data/shadow-performance.json');
const PROMOTE_THRESHOLD_DAYS = 7;

function loadShadowPerformance() {
    try {
        if (fs.existsSync(SHADOW_PERF_FILE)) {
            return JSON.parse(fs.readFileSync(SHADOW_PERF_FILE, 'utf8'));
        }
    } catch {}
    return { shadows: {} };
}

function saveShadowPerformance(data) {
    const dir = path.dirname(SHADOW_PERF_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = SHADOW_PERF_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, SHADOW_PERF_FILE);
}

/**
 * Deploy a new shadow strategy.
 * @param {string} strategyCode - Full strategy source code
 * @param {string} label - Descriptive label
 * @param {string} experimentId - Associated experiment ID (optional)
 */
function deployShadow(strategyCode, label, experimentId) {
    if (!fs.existsSync(SHADOW_DIR)) fs.mkdirSync(SHADOW_DIR, { recursive: true });

    const id = `shadow-${Date.now()}`;
    const filePath = path.join(SHADOW_DIR, `${id}.js`);

    // Validate syntax first
    const tmpCheck = path.join(SHADOW_DIR, '.tmp-check.js');
    try {
        fs.writeFileSync(tmpCheck, strategyCode);
        delete require.cache[require.resolve(tmpCheck)];
        const mod = require(tmpCheck);
        if (!mod.DEFAULT_CONFIG || !mod.createStrategyState || !mod.onNewCandle) {
            throw new Error('Invalid strategy interface');
        }
    } catch (e) {
        try { fs.unlinkSync(tmpCheck); } catch {}
        log.error(`Shadow deploy failed: ${e.message}`);
        return null;
    }
    try { fs.unlinkSync(tmpCheck); } catch {}

    fs.writeFileSync(filePath, strategyCode);

    // Initialize performance tracking
    const perf = loadShadowPerformance();
    perf.shadows[id] = {
        label,
        experimentId: experimentId || null,
        filePath,
        deployedAt: new Date().toISOString(),
        state: null, // Will be initialized on first cycle
        trades: [],
        snapshots: [],
    };
    saveShadowPerformance(perf);

    log.info(`Shadow deployed: ${id} (${label})`);
    return id;
}

/**
 * Run all shadow strategies against current candle data.
 * Called from bot.js on each 15-minute cycle.
 * @param {object} candleData - Same format as live strategy receives
 */
function runShadowCycle(candleData) {
    const perf = loadShadowPerformance();
    const shadowIds = Object.keys(perf.shadows);

    if (shadowIds.length === 0) return;

    for (const id of shadowIds) {
        const shadow = perf.shadows[id];
        try {
            // Load shadow strategy
            const modPath = shadow.filePath;
            if (!fs.existsSync(modPath)) {
                log.warn(`Shadow file missing: ${id}, removing.`);
                delete perf.shadows[id];
                continue;
            }

            delete require.cache[require.resolve(modPath)];
            const strategy = require(modPath);

            // Initialize state on first run
            if (!shadow.state) {
                shadow.state = strategy.createStrategyState();
            }

            // Run strategy
            const result = strategy.onNewCandle(shadow.state, candleData);

            // Simulate trade (paper trading)
            if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
                const from = shadow.state.assetHeld;
                const to = result.details.targetMarket;

                // Get current prices for paper P&L
                const fromMarket = candleData[from];
                const toMarket = candleData[to];
                const fromPrice = fromMarket && fromMarket[15] && fromMarket[15].length > 0
                    ? fromMarket[15][fromMarket[15].length - 1].close : 0;

                shadow.trades.push({
                    timestamp: new Date().toISOString(),
                    from,
                    to,
                    reason: result.details.reason || '',
                    fromPrice,
                });

                shadow.state.assetHeld = to;
            }

            // Snapshot current state
            const currentAsset = shadow.state.assetHeld;
            const assetData = candleData[currentAsset];
            const currentPrice = assetData && assetData[15] && assetData[15].length > 0
                ? assetData[15][assetData[15].length - 1].close : 0;

            // Keep only last 672 snapshots (7 days of 15m candles)
            shadow.snapshots.push({
                timestamp: new Date().toISOString(),
                assetHeld: currentAsset,
                price: currentPrice,
            });
            if (shadow.snapshots.length > 672) {
                shadow.snapshots = shadow.snapshots.slice(-672);
            }

        } catch (e) {
            log.warn(`Shadow ${id} cycle error: ${e.message}`);
        }
    }

    saveShadowPerformance(perf);
}

/**
 * Evaluate shadow strategies for potential promotion.
 * Returns array of { id, label, daysSinceDeployment, tradeCount, readyForReview }
 */
function evaluateShadows() {
    const perf = loadShadowPerformance();
    const results = [];

    for (const [id, shadow] of Object.entries(perf.shadows)) {
        const daysSince = (Date.now() - new Date(shadow.deployedAt).getTime()) / (1000 * 60 * 60 * 24);

        results.push({
            id,
            label: shadow.label,
            experimentId: shadow.experimentId,
            daysSinceDeployment: +daysSince.toFixed(1),
            tradeCount: shadow.trades.length,
            snapshotCount: shadow.snapshots.length,
            readyForReview: daysSince >= PROMOTE_THRESHOLD_DAYS,
        });
    }

    return results;
}

/**
 * Remove a shadow strategy.
 */
function removeShadow(id) {
    const perf = loadShadowPerformance();
    const shadow = perf.shadows[id];
    if (!shadow) return false;

    // Remove strategy file
    try {
        if (fs.existsSync(shadow.filePath)) fs.unlinkSync(shadow.filePath);
    } catch {}

    delete perf.shadows[id];
    saveShadowPerformance(perf);

    log.info(`Shadow removed: ${id}`);
    return true;
}

/**
 * Get shadow strategy details including performance summary.
 */
function getShadowDetails(id) {
    const perf = loadShadowPerformance();
    return perf.shadows[id] || null;
}

// CLI
if (require.main === module) {
    const cmd = process.argv[2];
    if (cmd === 'list') {
        console.log(JSON.stringify(evaluateShadows(), null, 2));
    } else if (cmd === 'remove' && process.argv[3]) {
        removeShadow(process.argv[3]);
    } else {
        console.log('Usage: node shadow-manager.js list|remove <id>');
    }
}

module.exports = {
    deployShadow,
    runShadowCycle,
    evaluateShadows,
    removeShadow,
    getShadowDetails,
};
