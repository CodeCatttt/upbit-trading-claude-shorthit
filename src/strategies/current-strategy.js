/**
 * regime-trend-4h.js
 * 4h-timeframe trend-following with choppiness regime filter.
 * Only switches when clear trending regime detected on 4h candles.
 * Minimizes trade frequency to avoid transaction cost drag.
 */

'use strict';

const { calcEMASeries, calcRSI } = require('../indicators');

const DEFAULT_CONFIG = {
    trendLookback: 48,         // 48 × 4h = 8 days for momentum
    emaFast: 9,                // Fast EMA on 4h (~36h)
    emaSlow: 26,               // Slow EMA on 4h (~4.3 days)
    rsiPeriod: 14,             // RSI on 4h
    choppinessPeriod: 20,      // 20 × 4h = ~3.3 days for regime detection
    choppinessThreshold: 0.55, // Above = choppy/ranging, block switching
    switchThreshold: 0.15,     // Minimum score advantage to trigger switch
    cooldownCandles: 288,      // 288 × 15min = 3 days between trades
};

function createStrategyState() {
    return { assetHeld: 'KRW-BTC', candlesSinceLastTrade: 9999 };
}

/**
 * Choppiness Index (0-1). Higher = choppier/ranging market.
 * Based on sum(TR) / price range over the period.
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
 * Score a market using 4h candles.
 * Combines risk-adjusted momentum (Sharpe-like) with EMA trend alignment.
 */
function scoreMarket(candles4h, config) {
    if (!candles4h || candles4h.length < config.trendLookback) return null;

    const choppiness = calcChoppiness(candles4h, config.choppinessPeriod);
    if (choppiness === null) return null;

    // Risk-adjusted momentum over lookback
    const slice = candles4h.slice(-config.trendLookback);
    const totalReturn = (slice[slice.length - 1].close - slice[0].close) / slice[0].close;

    const returns = [];
    for (let i = 1; i < slice.length; i++) {
        returns.push((slice[i].close - slice[i - 1].close) / slice[i - 1].close);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const vol = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    const sharpe = vol > 0 ? totalReturn / vol : 0;

    // EMA crossover trend strength
    const fastEma = calcEMASeries(candles4h, config.emaFast);
    const slowEma = calcEMASeries(candles4h, config.emaSlow);
    const fLast = fastEma[fastEma.length - 1];
    const sLast = slowEma[slowEma.length - 1];
    const price = candles4h[candles4h.length - 1].close;
    const trendCross = (fLast !== null && sLast !== null) ? (fLast - sLast) / price : 0;

    const rsi = calcRSI(candles4h, config.rsiPeriod);

    // Combined: 60% risk-adjusted momentum + 40% trend alignment
    const score = sharpe * 0.6 + trendCross * 100 * 0.4;

    return {
        score,
        choppiness,
        isChoppy: choppiness > config.choppinessThreshold,
        totalReturn,
        sharpe,
        trendCross,
        rsi,
    };
}

function onNewCandle(state, candleData, config = DEFAULT_CONFIG) {
    if (state.candlesSinceLastTrade === undefined) {
        state.candlesSinceLastTrade = 9999;
    }
    state.candlesSinceLastTrade++;

    const markets = Object.keys(candleData);
    if (markets.length < 2) {
        return { action: 'NONE', details: { reason: 'insufficient_markets' } };
    }

    const inCooldown = state.candlesSinceLastTrade < config.cooldownCandles;

    // Score all markets on 4h candles
    const scores = {};
    for (const market of markets) {
        const result = scoreMarket(candleData[market][240], config);
        if (result) scores[market] = result;
    }

    const scoredMarkets = Object.keys(scores);
    if (scoredMarkets.length === 0) {
        return { action: 'NONE', details: { reason: 'no_scoreable_markets' } };
    }

    const best = scoredMarkets.reduce((a, b) => scores[a].score > scores[b].score ? a : b);
    const currentScore = scores[state.assetHeld];
    const bestScore = scores[best];
    const advantage = bestScore.score - (currentScore ? currentScore.score : -Infinity);

    const summary = {};
    for (const m of scoredMarkets) {
        summary[m] = {
            score: +scores[m].score.toFixed(4),
            ret: +(scores[m].totalReturn * 100).toFixed(2),
            choppy: scores[m].isChoppy,
        };
    }

    // Switch only when: not in cooldown, clear advantage, target is trending
    const shouldSwitch =
        !inCooldown &&
        best !== state.assetHeld &&
        advantage > config.switchThreshold &&
        !bestScore.isChoppy;

    if (shouldSwitch) {
        state.assetHeld = best;
        state.candlesSinceLastTrade = 0;
        return {
            action: 'SWITCH',
            details: {
                targetMarket: best,
                reason: 'trend_advantage',
                advantage: +advantage.toFixed(4),
                scores: summary,
            },
        };
    }

    return {
        action: 'HOLD',
        details: {
            asset: state.assetHeld,
            scores: summary,
            bestMarket: best,
            advantage: +advantage.toFixed(4),
            inCooldown,
        },
    };
}

module.exports = { DEFAULT_CONFIG, createStrategyState, onNewCandle };