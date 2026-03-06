/**
 * adaptive-regime-mt.js
 * Multi-timeframe adaptive strategy with CASH management.
 *
 * Key features:
 * - 15m candles: fast risk signals (crash detection, trailing stop)
 * - 4h candles: trend scoring, regime detection, switch decisions
 * - Adaptive cooldown: short in trending, long in choppy markets
 * - CASH conversion: trailing stop + 24h crash detection
 * - Smart re-entry: RSI + ADX trend strength + Stochastic confirmation
 * - Enhanced scoring: momentum(35%) + trend(35%) + volume(15%) + Bollinger(15%)
 */

'use strict';

const { calcEMASeries, calcRSI, calcBollingerBands, calcATR, calcADX, calcStochastic, calcMACD } = require('../core/indicators');

const DEFAULT_CONFIG = {
    // 4h trend scoring
    trendLookback: 72,              // 72 x 4h = 12 days momentum window
    emaFast: 9,                     // Fast EMA on 4h (~36h)
    emaSlow: 26,                    // Slow EMA on 4h (~4.3 days)
    rsiPeriod: 14,                  // RSI on 4h
    choppinessPeriod: 20,           // 20 x 4h = ~3.3 days regime detection
    choppinessThreshold: 0.45,      // Above = choppy, block switching
    switchThreshold: 0.15,          // Minimum score advantage to switch
    adxPeriod: 14,                  // ADX period for trend strength
    adxMinTrend: 20,                // Minimum ADX for "trending" confirmation

    // Adaptive cooldown (15m candles)
    cooldownTrending: 144,          // 3 days in trending regime
    cooldownChoppy: 288,            // 5 days in choppy regime
    opportunityOverrideMultiplier: 1.3,

    // Risk management — CASH conversion
    trailingStopPct: 0.07,          // 7% drop from peak -> CASH (was 5%, too tight)
    crashWindowCandles: 96,         // 24h of 15m candles
    crashThreshold: 0.04,           // 4% drop in 24h -> CASH (was 3%, too sensitive)
    riskGracePeriod: 48,            // 12h grace period after entry (was 24h)

    // Re-entry from CASH
    reentryRsiMin: 50,              // RSI must be above 50 (uptrend confirmed, was 38)
    reentryMinScore: 0.05,          // Minimum positive score (was 0.03)
    reentryTrendConfirm: false,     // Do NOT require EMA golden cross
    reentryCooldown: 72,            // 18h minimum stay in CASH
    reentryIntensityMin: 0.5,       // Block re-entry when trade intensity < this
    reentryStochMax: 85,            // Block re-entry when Stochastic > this (overbought)

    // Scoring weights — increased trend weight, reduced momentum
    momentumWeight: 0.35,           // Risk-adjusted momentum (Sharpe)
    trendWeight: 0.35,              // EMA cross + ADX strength
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
 * Combines momentum, trend (with ADX), volume, and Bollinger position.
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

    // 2. EMA trend alignment + ADX trend strength
    const fastEma = calcEMASeries(candles4h, config.emaFast);
    const slowEma = calcEMASeries(candles4h, config.emaSlow);
    const fLast = fastEma[fastEma.length - 1];
    const sLast = slowEma[slowEma.length - 1];
    const price = candles4h[candles4h.length - 1].close;
    const trendCross = (fLast !== null && sLast !== null) ? (fLast - sLast) / price : 0;

    // ADX: scale trend signal by trend strength
    const adxResult = calcADX(candles4h, config.adxPeriod || 14);
    const adxValue = adxResult ? adxResult.adx : 0;
    // Normalize ADX: 0-100 -> 0-1, then use to amplify/dampen trend signal
    const adxFactor = Math.min(1, adxValue / 50); // ADX 50+ = full strength
    const trendSignal = trendCross * 100 * adxFactor;

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

    // 4. Bollinger band position — CORRECTED: lower band = oversold = bullish
    const bb = calcBollingerBands(candles4h, 20, 2);
    let bollingerSignal = 0;
    if (bb) {
        const range = bb.upper - bb.lower;
        if (range > 0) {
            const percentB = (price - bb.lower) / range;
            // Near lower band (percentB < 0.3) = oversold = bullish signal
            // Near upper band (percentB > 0.7) = overbought = bearish signal
            // Middle (0.5) = neutral
            bollingerSignal = percentB < 0.5
                ? (0.5 - percentB) * 2    // Below middle: positive (mean reversion up)
                : -(percentB - 0.5) * 0.5; // Above middle: slight negative (extended)
        }
    }

    const rsi = calcRSI(candles4h, config.rsiPeriod);

    // Stochastic for re-entry gating
    const stoch = calcStochastic(candles4h, 14, 3);

    // Combined score
    const score =
        sharpe * config.momentumWeight +
        trendSignal * config.trendWeight +
        volumeSignal * config.volumeWeight +
        bollingerSignal * config.bollingerWeight;

    return {
        score,
        choppiness,
        isChoppy: choppiness > config.choppinessThreshold,
        totalReturn,
        sharpe,
        trendCross,
        trendSignal: +trendSignal.toFixed(4),
        adx: adxValue,
        volumeSignal: +volumeSignal.toFixed(4),
        bollingerSignal: +bollingerSignal.toFixed(4),
        rsi,
        stochK: stoch ? stoch.k : null,
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
    // Interpolate: 0.3 -> trending cooldown, 0.6 -> choppy cooldown
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
 * Enhanced with ADX trend strength and Stochastic overbought filter.
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

    // Get trade intensity for the best candidate
    const bestIntensity = candleData[best] && candleData[best]._tradeIntensity;

    const summary = {};
    for (const m of scoredMarkets) {
        summary[m] = {
            score: +scores[m].score.toFixed(4),
            ret: +(scores[m].totalReturn * 100).toFixed(2),
            choppy: scores[m].isChoppy,
            adx: scores[m].adx ? +scores[m].adx.toFixed(1) : null,
            stochK: scores[m].stochK ? +scores[m].stochK.toFixed(1) : null,
            intensity: candleData[m] && candleData[m]._tradeIntensity,
        };
    }

    const cashCooldownMet = state.candlesSinceLastTrade >= (config.reentryCooldown || 288);
    const intensityOk = bestIntensity == null || bestIntensity >= (config.reentryIntensityMin || 0.5);
    // Block re-entry when Stochastic is overbought (avoid buying the top of a bounce)
    const stochOk = bestScore.stochK == null || bestScore.stochK < (config.reentryStochMax || 85);
    // ADX must show some trend (not range-bound)
    const adxOk = bestScore.adx == null || bestScore.adx >= (config.adxMinTrend || 20);

    const canReenter =
        cashCooldownMet &&
        intensityOk &&
        stochOk &&
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
                adx: bestScore.adx ? +bestScore.adx.toFixed(1) : null,
                stochK: bestScore.stochK ? +bestScore.stochK.toFixed(1) : null,
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
            adx: bestScore.adx ? +bestScore.adx.toFixed(1) : null,
            stochK: bestScore.stochK ? +bestScore.stochK.toFixed(1) : null,
            choppy: bestScore.isChoppy,
            trendCross: +bestScore.trendCross.toFixed(4),
            intensity: bestIntensity,
            intensityOk,
            stochOk,
            adxOk,
            cooldownMet: cashCooldownMet,
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
    const gracePeriod = config.riskGracePeriod || 48;
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
                const peakBeforeReset = state.peakPriceSinceEntry;
                state.assetHeld = 'CASH';
                state.candlesSinceLastTrade = 0;
                state.peakPriceSinceEntry = null;
                return {
                    action: 'SWITCH',
                    details: {
                        targetMarket: 'CASH',
                        reason: 'trailing_stop',
                        drawdown: +(trailing.drawdown * 100).toFixed(2),
                        peak: peakBeforeReset,
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
            adx: scores[m].adx ? +scores[m].adx.toFixed(1) : null,
            vol: scores[m].volumeSignal,
        };
    }

    // Switch: clear advantage + target is trending + not in cooldown (or opportunity override)
    // Also require ADX > minimum to confirm real trend (not noise)
    const opportunityOverride = inCooldown &&
        advantage > config.switchThreshold * (config.opportunityOverrideMultiplier || 1.5);
    const shouldSwitch =
        (!inCooldown || opportunityOverride) &&
        best !== currentAsset &&
        advantage > config.switchThreshold &&
        !bestScore.isChoppy &&
        (bestScore.adx == null || bestScore.adx >= (config.adxMinTrend || 20));

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
                adx: bestScore.adx ? +bestScore.adx.toFixed(1) : null,
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
