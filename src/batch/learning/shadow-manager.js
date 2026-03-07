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
const { createLogger } = require('../../utils/logger');

const log = createLogger('SHADOW');

const SHADOW_DIR = path.join(__dirname, '../../../data/shadow-strategies');
const SHADOW_PERF_FILE = path.join(__dirname, '../../../data/shadow-performance.json');
const PROMOTE_THRESHOLD_DAYS = 4;

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

            // Save pre-mutation state (strategy mutates state.assetHeld internally)
            const prevAsset = shadow.state.assetHeld;

            // Run strategy
            const result = strategy.onNewCandle(shadow.state, candleData);

            // Simulate trade (paper trading)
            if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
                const from = prevAsset;
                const to = result.details.targetMarket;

                // Get current prices for paper P&L
                const fromMarket = from !== 'CASH' ? candleData[from] : null;
                const fromCandles = fromMarket && fromMarket[15];
                const fromPrice = (fromCandles && fromCandles.length > 0)
                    ? fromCandles[fromCandles.length - 1].close : 0;

                const toMarket = to !== 'CASH' ? candleData[to] : null;
                const toCandles = toMarket && toMarket[15];
                const toPrice = (toCandles && toCandles.length > 0)
                    ? toCandles[toCandles.length - 1].close : 0;

                shadow.trades.push({
                    timestamp: new Date().toISOString(),
                    from,
                    to,
                    reason: result.details.reason || '',
                    fromPrice,
                    toPrice,
                });

                shadow.state.assetHeld = to;
            }

            // Snapshot current state
            const currentAsset = shadow.state.assetHeld;
            let currentPrice;
            if (currentAsset === 'CASH') {
                // CASH — no market exposure, value is flat (price=0 signals CASH to return calc)
                currentPrice = 0;
            } else {
                const assetData = candleData[currentAsset];
                currentPrice = assetData && assetData[15] && assetData[15].length > 0
                    ? assetData[15][assetData[15].length - 1].close : 0;
            }

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

/**
 * Check for auto-promotion candidates among shadow strategies.
 * A shadow is eligible if it has run >= PROMOTE_THRESHOLD_DAYS and its
 * estimated return beats live strategy by >= 2% alpha.
 * @param {number} liveReturnPct - Live strategy return % over the shadow's period
 * @returns {object|null} Best promotion candidate { id, label, experimentId, alpha, shadowReturn }
 */
function checkAutoPromotion(liveReturnPct) {
    const perf = loadShadowPerformance();
    const candidates = [];

    for (const [id, shadow] of Object.entries(perf.shadows)) {
        const daysSince = (Date.now() - new Date(shadow.deployedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < PROMOTE_THRESHOLD_DAYS) continue;

        // Estimate shadow return from snapshots
        const snapshots = shadow.snapshots || [];
        if (snapshots.length < 2) continue;

        const first = snapshots[0];
        const last = snapshots[snapshots.length - 1];

        // Estimate return accounting for trade costs (0.1% slippage + 0.05% fee per side)
        const TRADE_COST = 0.003; // 0.15% per side × 2 sides = 0.3% round-trip
        const tradeCount = (shadow.trades || []).length;

        // Pure CASH with no trades — nothing to measure
        if (first.assetHeld === 'CASH' && last.assetHeld === 'CASH' && tradeCount === 0) continue;
        // Need valid prices for non-CASH positions
        if (first.assetHeld !== 'CASH' && (!first.price || first.price === 0)) continue;
        if (last.assetHeld !== 'CASH' && (!last.price || last.price === 0)) continue;

        let shadowReturn;
        if (first.assetHeld === last.assetHeld && tradeCount === 0) {
            if (first.assetHeld === 'CASH') continue;
            shadowReturn = ((last.price - first.price) / first.price) * 100;
        } else {
            // Multi-asset: approximate from intermediate snapshots
            // CASH periods contribute 0% return (no market exposure)
            let cumReturn = 1;
            let prevPrice = first.price;
            let prevAsset = first.assetHeld;
            for (let i = 1; i < snapshots.length; i++) {
                const s = snapshots[i];
                if (s.assetHeld !== prevAsset) {
                    if (prevAsset !== 'CASH' && prevPrice > 0 && snapshots[i - 1].price > 0) {
                        cumReturn *= snapshots[i - 1].price / prevPrice;
                    }
                    cumReturn *= (1 - TRADE_COST);
                    prevPrice = s.price;
                    prevAsset = s.assetHeld;
                }
            }
            // Final segment
            if (prevAsset !== 'CASH' && prevPrice > 0 && last.price > 0) {
                cumReturn *= last.price / prevPrice;
            }
            shadowReturn = (cumReturn - 1) * 100;
        }

        const alpha = shadowReturn - (liveReturnPct || 0);

        if (alpha >= 2) {
            candidates.push({
                id,
                label: shadow.label,
                experimentId: shadow.experimentId,
                alpha: +alpha.toFixed(2),
                shadowReturn: +shadowReturn.toFixed(2),
                daysSince: +daysSince.toFixed(1),
            });
        }
    }

    if (candidates.length === 0) return null;

    // Return best by alpha
    candidates.sort((a, b) => b.alpha - a.alpha);
    return candidates[0];
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
    checkAutoPromotion,
};
