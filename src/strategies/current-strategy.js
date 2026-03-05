/**
 * adaptive-regime-mt.js
 * Multi-timeframe adaptive strategy with CASH management.
 *
 * Key features:
 * - 15m candles: fast risk signals (crash detection, trailing stop)
 * - 4h candles: trend scoring, regime detection, switch decisions
 * - Adaptive cooldown: short in trending, long in choppy markets
 * - CASH conversion: trailing stop + 24h crash detection
 * - Smart re-entry: RSI + trend confirmation before buying back
 * - Enhanced scoring: momentum + trend + volume + Bollinger position
 */

'use strict';

const { calcEMASeries, calcRSI, calcBollingerBands, calcATR } = require('../core/indicators');

const DEFAULT_CONFIG = {
    // 4h trend scoring
    trendLookback: 72,              // 72 × 4h = 12 days momentum window
    emaFast: 9,                     // Fast EMA on 4h (~36h)
    emaSlow: 26,                    // Slow EMA on 4h (~4.3 days)
    rsiPeriod: 14,                  // RSI on 4h
    choppinessPeriod: 20,           // 20 × 4h = ~3.3 days regime detection
    choppinessThreshold: 0.45,      // Above = choppy, block switching
    switchThreshold: 0.15,           // Minimum score advantage to switch

    // Adaptive cooldown (15m candles)
    cooldownTrending: 144,          // 3 days in trending regime
    cooldownChoppy: 288,            // 5 days in choppy regime
    opportunityOverrideMultiplier: 1.3, // Override cooldown if advantage exceeds threshold * this

    // Risk management — CASH conversion
    trailingStopPct: 0.05,          // 5% drop from peak → CASH
    crashWindowCandles: 96,         // 24h of 15m candles
    crashThreshold: 0.03,           // 3% drop in 24h → CASH
    riskGracePeriod: 24,            // 24h grace period after entry (no trailing stop / crash)

    // Re-entry from CASH
    reentryRsiMin: 38,              // RSI must be above this
    reentryMinScore: 0.03,           // Minimum positive score
    reentryTrendConfirm: false,     // Do NOT require EMA golden cross (lagging indicator bottleneck removed)
    reentryCooldown: 72,           // 18h minimum stay in CASH

    // Scoring weights
    momentumWeight: 0.45,           // Risk-adjusted momentum (Sharpe)
    trendWeight: 0.25,              // EMA cross alignment
    volumeWeight: 0.15,             // Volume trend confirmation
    bollingerWeight: 0.15,          // Bollinger band position

    executionMode: 'market',
    smartEntry: {
        candleInterval: 5,
        maxWaitMinutes: 15,
        pollIntervalMs: 15000,
        entryMethod: 'rsi_dip',
        rsiThreshold: 40,
        pullbackPct: 0.3,
    },
};

function createStrategyState() {
    return {
        assetHeld: 'KRW-BTC',
        candlesSinceLastTrade: 9999,
        peakPriceSinceEntry: null,
    };
}

/**
 * Choppiness Index (0-1). Higher = choppier/ranging market.
 */
function calcChoppiness(candles, period) {
    if (candles.length < period + 1) return null;
    const slice = candles.slice(-(period + 1));

    let trSum = 0;
    for (let i = 1; i < slice.length; i++) {
        trSum += Math.max(
            slice[i].high - slice[i].low,
            Math.abs(slice[i].high - slice[i - 1].close),
            Math.abs(slice[i].low - slice[i - 1].close)
        );
    }

    const hh = Math.max(...slice.map(c => c.high));
    const ll = Math.min(...slice.map(c => c.low));
    const range = hh - ll;
    if (range === 0) return 1;

    return Math.min(1, Math.max(0, Math.log10(trSum / range) / Math.log10(period)));
}

/**
 * Enhanced market scoring using 4h candles.
 * Combines momentum, trend, volume, and Bollinger position.
 */
function scoreMarket(candles4h, config) {
    if (!candles4h || candles4h.length < config.trendLookback) return null;

    const choppiness = calcChoppiness(candles4h, config.choppinessPeriod);
    if (choppiness === null) return null;

    // 1. Risk-adjusted momentum (Sharpe-like)
    const slice = candles4h.slice(-config.trendLookback);
    const totalReturn = (slice[slice.length - 1].close - slice[0].close) / slice[0].close;
    const returns = [];
    for (let i = 1; i < slice.length; i++) {
        returns.push((slice[i].close - slice[i - 1].close) / slice[i - 1].close);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const vol = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    const sharpe = vol > 0 ? totalReturn / vol : 0;

    // 2. EMA trend alignment
    const fastEma = calcEMASeries(candles4h, config.emaFast);
    const slowEma = calcEMASeries(candles4h, config.emaSlow);
    const fLast = fastEma[fastEma.length - 1];
    const sLast = slowEma[slowEma.length - 1];
    const price = candles4h[candles4h.length - 1].close;
    const trendCross = (fLast !== null && sLast !== null) ? (fLast - sLast) / price : 0;

    // 3. Volume trend — recent vs older volume ratio
    const volSlice = candles4h.slice(-20);
    let volumeSignal = 0;
    if (volSlice.length >= 15) {
        const recentVol = volSlice.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
        const olderVol = volSlice.slice(0, 10).reduce((a, c) => a + c.volume, 0) / 10;
        if (olderVol > 0) {
            volumeSignal = Math.max(-1, Math.min(1, recentVol / olderVol - 1));
        }
    }

    // 4. Bollinger band position — room to move up
    const bb = calcBollingerBands(candles4h, 20, 2);
    let bollingerSignal = 0;
    if (bb) {
        const range = bb.upper - bb.lower;
        if (range > 0) {
            const percentB = (price - bb.lower) / range;
            bollingerSignal = 0.5 - percentB; // Positive when below middle (room to go up)
        }
    }

    const rsi = calcRSI(candles4h, config.rsiPeriod);

    // Combined score
    const score =
        sharpe * config.momentumWeight +
        trendCross * 100 * config.trendWeight +
        volumeSignal * config.volumeWeight +
        bollingerSignal * config.bollingerWeight;

    return {
        score,
        choppiness,
        isChoppy: choppiness > config.choppinessThreshold,
        totalReturn,
        sharpe,
        trendCross,
        volumeSignal: +volumeSignal.toFixed(4),
        bollingerSignal: +bollingerSignal.toFixed(4),
        rsi,
    };
}

/**
 * Adaptive cooldown based on average regime across markets.
 */
function getAdaptiveCooldown(scores, config) {
    const choppyValues = Object.values(scores)
        .map(s => s.choppiness)
        .filter(c => c !== null);
    if (choppyValues.length === 0) return config.cooldownChoppy;

    const avgChoppiness = choppyValues.reduce((a, b) => a + b, 0) / choppyValues.length;
    // Interpolate: 0.3 → trending cooldown, 0.6 → choppy cooldown
    const t = Math.min(1, Math.max(0, (avgChoppiness - 0.3) / 0.3));
    return Math.round(config.cooldownTrending + t * (config.cooldownChoppy - config.cooldownTrending));
}

/**
 * Fast risk check on 15m candles — 24h crash detection.
 */
function checkCrashSignal(candles15m, config) {
    if (!candles15m || candles15m.length < config.crashWindowCandles) return null;

    const window = candles15m.slice(-config.crashWindowCandles);
    const highInWindow = Math.max(...window.map(c => c.high));
    const currentPrice = window[window.length - 1].close;
    const drawdown = (currentPrice - highInWindow) / highInWindow;

    if (drawdown < -config.crashThreshold) {
        return { triggered: true, drawdown };
    }
    return null;
}

/**
 * Trailing stop check — exit to CASH if price drops too far from peak.
 */
function checkTrailingStop(state, currentPrice, config) {
    if (!state.peakPriceSinceEntry) return null;

    const drawdown = (currentPrice - state.peakPriceSinceEntry) / state.peakPriceSinceEntry;
    if (drawdown < -config.trailingStopPct) {
        return { triggered: true, drawdown };
    }
    return null;
}

/**
 * Re-entry logic when in CASH — check if conditions are right to buy back.
 */
function checkReentry(state, candleData, markets, config) {
    const scores = {};
    for (const market of markets) {
        const candles4h = candleData[market] && candleData[market][240];
        const result = scoreMarket(candles4h, config);
        if (result) scores[market] = result;
    }

    const scoredMarkets = Object.keys(scores);
    if (scoredMarkets.length === 0) {
        return { action: 'NONE', details: { reason: 'no_scoreable_markets' } };
    }

    const best = scoredMarkets.reduce((a, b) => scores[a].score > scores[b].score ? a : b);
    const bestScore = scores[best];

    const summary = {};
    for (const m of scoredMarkets) {
        summary[m] = {
            score: +scores[m].score.toFixed(4),
            ret: +(scores[m].totalReturn * 100).toFixed(2),
            choppy: scores[m].isChoppy,
        };
    }

    // Must wait reentryCooldown candles in CASH before buying back
    const cashCooldownMet = state.candlesSinceLastTrade >= (config.reentryCooldown || 288);

    // Re-entry conditions
    const canReenter =
        cashCooldownMet &&
        !bestScore.isChoppy &&
        bestScore.rsi !== null && bestScore.rsi > config.reentryRsiMin &&
        bestScore.score > config.reentryMinScore &&
        (!config.reentryTrendConfirm || bestScore.trendCross > 0);

    if (canReenter) {
        state.assetHeld = best;
        state.candlesSinceLastTrade = 0;
        state.peakPriceSinceEntry = null;
        return {
            action: 'SWITCH',
            details: {
                targetMarket: best,
                reason: 'reentry_from_cash',
                score: +bestScore.score.toFixed(4),
                rsi: +bestScore.rsi.toFixed(1),
                scores: summary,
            },
        };
    }

    return {
        action: 'HOLD',
        details: {
            asset: 'CASH',
            reason: 'reentry_conditions_not_met',
            bestMarket: best,
            bestScore: +bestScore.score.toFixed(4),
            rsi: bestScore.rsi !== null ? +bestScore.rsi.toFixed(1) : null,
            choppy: bestScore.isChoppy,
            trendCross: +bestScore.trendCross.toFixed(4),
            scores: summary,
        },
    };
}

function onNewCandle(state, candleData, config = DEFAULT_CONFIG) {
    if (state.candlesSinceLastTrade === undefined) state.candlesSinceLastTrade = 9999;
    state.candlesSinceLastTrade++;

    const markets = Object.keys(candleData);
    if (markets.length < 2) {
        return { action: 'NONE', details: { reason: 'insufficient_markets' } };
    }

    // === CASH STATE: check re-entry ===
    if (state.assetHeld === 'CASH') {
        return checkReentry(state, candleData, markets, config);
    }

    const currentAsset = state.assetHeld;
    const candles15 = candleData[currentAsset] && candleData[currentAsset][15];
    const currentPrice = candles15 && candles15.length > 0
        ? candles15[candles15.length - 1].close
        : null;

    // Update peak tracking
    if (currentPrice !== null) {
        if (!state.peakPriceSinceEntry || currentPrice > state.peakPriceSinceEntry) {
            state.peakPriceSinceEntry = currentPrice;
        }
    }

    // === RISK CHECKS (skip during grace period after entry) ===
    const gracePeriod = config.riskGracePeriod || 96;
    const pastGracePeriod = state.candlesSinceLastTrade > gracePeriod;

    if (pastGracePeriod) {
        // RISK CHECK 1: 24h crash detection (15m)
        const crash = checkCrashSignal(candles15, config);
        if (crash && crash.triggered) {
            state.assetHeld = 'CASH';
            state.candlesSinceLastTrade = 0;
            state.peakPriceSinceEntry = null;
            return {
                action: 'SWITCH',
                details: {
                    targetMarket: 'CASH',
                    reason: 'crash_detected',
                    drawdown: +(crash.drawdown * 100).toFixed(2),
                },
            };
        }

        // RISK CHECK 2: trailing stop
        if (currentPrice !== null) {
            const trailing = checkTrailingStop(state, currentPrice, config);
            if (trailing && trailing.triggered) {
                state.assetHeld = 'CASH';
                state.candlesSinceLastTrade = 0;
                state.peakPriceSinceEntry = null;
                return {
                    action: 'SWITCH',
                    details: {
                        targetMarket: 'CASH',
                        reason: 'trailing_stop',
                        drawdown: +(trailing.drawdown * 100).toFixed(2),
                        peak: state.peakPriceSinceEntry,
                    },
                };
            }
        }
    }

    // === TREND SCORING + SWITCH (4h) ===
    const scores = {};
    for (const market of markets) {
        const candles4h = candleData[market] && candleData[market][240];
        const result = scoreMarket(candles4h, config);
        if (result) scores[market] = result;
    }

    const scoredMarkets = Object.keys(scores);
    if (scoredMarkets.length === 0) {
        return { action: 'NONE', details: { reason: 'no_scoreable_markets' } };
    }

    // Adaptive cooldown
    const adaptiveCooldown = getAdaptiveCooldown(scores, config);
    const inCooldown = state.candlesSinceLastTrade < adaptiveCooldown;

    const best = scoredMarkets.reduce((a, b) => scores[a].score > scores[b].score ? a : b);
    const currentScore = scores[currentAsset];
    const bestScore = scores[best];
    const advantage = bestScore.score - (currentScore ? currentScore.score : -Infinity);

    const summary = {};
    for (const m of scoredMarkets) {
        summary[m] = {
            score: +scores[m].score.toFixed(4),
            ret: +(scores[m].totalReturn * 100).toFixed(2),
            choppy: scores[m].isChoppy,
            vol: scores[m].volumeSignal,
        };
    }

    // Switch: clear advantage + target is trending + not in cooldown (or opportunity override)
    const opportunityOverride = inCooldown &&
        advantage > config.switchThreshold * (config.opportunityOverrideMultiplier || 1.5);
    const shouldSwitch =
        (!inCooldown || opportunityOverride) &&
        best !== currentAsset &&
        advantage > config.switchThreshold &&
        !bestScore.isChoppy;

    if (shouldSwitch) {
        state.assetHeld = best;
        state.candlesSinceLastTrade = 0;
        state.peakPriceSinceEntry = null;
        return {
            action: 'SWITCH',
            details: {
                targetMarket: best,
                reason: opportunityOverride ? 'opportunity_override' : 'trend_advantage',
                advantage: +advantage.toFixed(4),
                adaptiveCooldown,
                opportunityOverride,
                scores: summary,
            },
        };
    }

    return {
        action: 'HOLD',
        details: {
            asset: currentAsset,
            scores: summary,
            bestMarket: best,
            advantage: +advantage.toFixed(4),
            inCooldown,
            adaptiveCooldown,
            opportunityOverride,
            peakPrice: state.peakPriceSinceEntry,
            currentPrice,
        },
    };
}

module.exports = { DEFAULT_CONFIG, createStrategyState, onNewCandle };
