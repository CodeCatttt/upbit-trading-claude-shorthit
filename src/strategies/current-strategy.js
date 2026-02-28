/**
 * multi-asset-momentum-rv.js
 * Multi-asset relative value + momentum strategy.
 * Compares all watched markets, switches to the strongest candidate.
 * Uses Kalman-filtered price ratios and momentum signals.
 */

'use strict';

const { calcEMASeries, calcRSI, calcATR, calcKalmanFilter } = require('../indicators');

const DEFAULT_CONFIG = {
    lookback: 192,             // Candles for momentum calculation
    momentumWeight: 0.7,      // Weight for momentum score
    rvWeight: 0.3,            // Weight for relative value score
    switchThreshold: 0.06,    // Minimum score advantage to trigger switch
    cooldownCandles: 96,      // Minimum 24 hours (96 x 15min) between trades
    emaPeriod: 40,            // EMA period for trend
    rsiPeriod: 14,            // RSI period
};

function createStrategyState() {
    return { assetHeld: 'KRW-BTC', candlesSinceLastTrade: 9999 };
}

function calcMomentumScore(candles, config) {
    if (!candles || candles.length < config.lookback) return null;

    const slice = candles.slice(-config.lookback);
    const firstClose = slice[0].close;
    const lastClose = slice[slice.length - 1].close;
    const returnPct = (lastClose - firstClose) / firstClose;

    const rsi = calcRSI(candles, config.rsiPeriod);
    const rsiNorm = rsi !== null ? (rsi - 50) / 50 : 0; // -1 to +1

    const emaSeries = calcEMASeries(candles, config.emaPeriod);
    const emaLatest = emaSeries[emaSeries.length - 1];
    const trendStrength = emaLatest ? (lastClose - emaLatest) / emaLatest : 0;

    return {
        returnPct,
        rsiNorm,
        trendStrength,
        combined: returnPct * 0.4 + rsiNorm * 0.3 + trendStrength * 0.3,
    };
}

function calcRelativeValueScore(candles, allCandles, config) {
    if (!candles || candles.length < config.lookback) return null;

    const prices = candles.slice(-config.lookback).map(c => c.close);
    const filtered = calcKalmanFilter(prices, 0.00005, 0.01);
    const current = filtered[filtered.length - 1];
    const mean = filtered.reduce((a, b) => a + b, 0) / filtered.length;
    const deviation = (current - mean) / mean;

    // Negative deviation = undervalued = good buy opportunity
    return -deviation;
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

    // Score each market (using 15m candles)
    const scores = {};
    for (const market of markets) {
        const candles = candleData[market][15];
        if (!candles || candles.length < config.lookback) continue;

        const momentum = calcMomentumScore(candles, config);
        const rv = calcRelativeValueScore(candles, null, config);

        if (momentum === null || rv === null) continue;

        scores[market] = {
            momentum: momentum.combined,
            rv,
            total: momentum.combined * config.momentumWeight + rv * config.rvWeight,
            details: { returnPct: momentum.returnPct, rsi: momentum.rsiNorm, trend: momentum.trendStrength, rv },
        };
    }

    const scoredMarkets = Object.keys(scores);
    if (scoredMarkets.length === 0) {
        return { action: 'NONE', details: { reason: 'no_scoreable_markets' } };
    }

    // Find best market
    const best = scoredMarkets.reduce((a, b) => scores[a].total > scores[b].total ? a : b);
    const currentScore = scores[state.assetHeld] || { total: -Infinity };
    const bestScore = scores[best];
    const advantage = bestScore.total - (currentScore.total || 0);

    // Build details for logging
    const allScores = {};
    for (const m of scoredMarkets) {
        allScores[m] = +scores[m].total.toFixed(4);
    }

    if (best !== state.assetHeld && advantage > config.switchThreshold && !inCooldown) {
        state.assetHeld = best;
        state.candlesSinceLastTrade = 0;
        return {
            action: 'SWITCH',
            details: {
                targetMarket: best,
                reason: 'higher_score',
                advantage: +advantage.toFixed(4),
                scores: allScores,
                bestDetails: bestScore.details,
            },
        };
    }

    return {
        action: 'HOLD',
        details: {
            asset: state.assetHeld,
            scores: allScores,
            bestMarket: best,
            advantage: +advantage.toFixed(4),
            inCooldown,
        },
    };
}

module.exports = { DEFAULT_CONFIG, createStrategyState, onNewCandle };
