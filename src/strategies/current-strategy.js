/**
 * strategy-ou-kalman-v2.js
 * BTC/ETH Relative Value Strategy using Kalman-filtered OU Process
 * with trade cooldown to prevent whipsaw in choppy markets.
 */

'use strict';

const { calcPriceRatio, estimateOU, calcKalmanFilter } = require('../indicators');
const { runAdfTest } = require('../utils/adf-test');

const DEFAULT_CONFIG = {
    lookback: 384,            // 48 hours of 15-min candles for stable OU estimates
    entryZScore: 2.5,         // Z-score threshold to trigger a switch
    cooldownCandles: 48,      // Minimum 8 hours between trades
    kalmanQ: 0.00005,          // Kalman process noise
    kalmanR: 0.01,            // Kalman measurement noise
};

function createStrategyState() {
    return { assetHeld: 'IN_BTC' };
}

function onNewCandle(state, btcCandles, ethCandles, config = DEFAULT_CONFIG) {
    if (state.candlesSinceLastTrade === undefined) {
        state.candlesSinceLastTrade = 9999;
    }
    state.candlesSinceLastTrade++;

    if (btcCandles.length < config.lookback || ethCandles.length < config.lookback) {
        return { action: 'NONE', details: { reason: 'insufficient_data' } };
    }

    const btcSlice = btcCandles.slice(-config.lookback);
    const ethSlice = ethCandles.slice(-config.lookback);
    const ratioSeries = calcPriceRatio(btcSlice, ethSlice);

    const adfResult = runAdfTest(ratioSeries, 0, 0.05);
    if (!adfResult.isStationary && adfResult.adfStatistic > -2.86) {
        return {
            action: 'HOLD',
            details: { asset: state.assetHeld, reason: 'adf_non_stationary', adfStatistic: adfResult.adfStatistic },
        };
    }

    const smoothedRatio = calcKalmanFilter(ratioSeries, config.kalmanQ, config.kalmanR);

    const ouParams = estimateOU(smoothedRatio);
    if (!ouParams) {
        return { action: 'HOLD', details: { asset: state.assetHeld, reason: 'ou_not_mean_reverting' } };
    }

    const { mu, theta, sigma } = ouParams;
    const currentRatio = smoothedRatio[smoothedRatio.length - 1];
    const eqStdDev = sigma / Math.sqrt(2 * theta);

    if (eqStdDev === 0 || isNaN(eqStdDev)) {
        return { action: 'HOLD', details: { asset: state.assetHeld, reason: 'invalid_eq_stddev' } };
    }

    const currentZScore = (currentRatio - mu) / eqStdDev;
    const inCooldown = state.candlesSinceLastTrade < config.cooldownCandles;

    if (state.assetHeld === 'IN_BTC' && currentZScore > config.entryZScore && !inCooldown) {
        state.assetHeld = 'IN_ETH';
        state.candlesSinceLastTrade = 0;
        return {
            action: 'SWITCH_TO_ETH',
            details: {
                reason: 'btc_overvalued_ou',
                zscore: +currentZScore.toFixed(4),
                mu: +mu.toFixed(4),
                theta: +theta.toFixed(4),
                threshold: config.entryZScore,
            },
        };
    }

    if (state.assetHeld === 'IN_ETH' && currentZScore < -config.entryZScore && !inCooldown) {
        state.assetHeld = 'IN_BTC';
        state.candlesSinceLastTrade = 0;
        return {
            action: 'SWITCH_TO_BTC',
            details: {
                reason: 'eth_overvalued_ou',
                zscore: +currentZScore.toFixed(4),
                mu: +mu.toFixed(4),
                theta: +theta.toFixed(4),
                threshold: config.entryZScore,
            },
        };
    }

    return {
        action: 'HOLD',
        details: {
            asset: state.assetHeld,
            zscore: +currentZScore.toFixed(4),
            theta: +theta.toFixed(4),
            mu: +mu.toFixed(4),
            inCooldown,
        },
    };
}

module.exports = { DEFAULT_CONFIG, createStrategyState, onNewCandle };