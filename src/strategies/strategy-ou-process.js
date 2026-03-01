/**
 * strategy-ou-process.js
 * BTC/ETH Relative Value Strategy using Ornstein-Uhlenbeck Process.
 */

'use strict';

const { calcPriceRatio, estimateOU, calculateDynamicThreshold } = require('../core/indicators');
const { runAdfTest } = require('../utils/adf-test');

const DEFAULT_CONFIG = {
    lookback: 60,
    entryThreshold: 1.5,
    minThreshold: 1.0,
    maxThreshold: 2.5,
};

function createStrategyState() {
    return { assetHeld: 'IN_BTC' };
}

function onNewCandle(state, btcCandles, ethCandles, config = DEFAULT_CONFIG) {
    if (btcCandles.length < config.lookback || ethCandles.length < config.lookback) {
        return { action: 'NONE', details: { reason: 'insufficient_data' } };
    }

    const btcSlice = btcCandles.slice(-config.lookback);
    const ethSlice = ethCandles.slice(-config.lookback);
    const ratioSeries = calcPriceRatio(btcSlice, ethSlice);
    const ouParams = estimateOU(ratioSeries);

    if (!ouParams) {
        return { action: 'HOLD', details: { asset: state.assetHeld, reason: 'ou_not_mean_reverting' } };
    }

    const adfResult = runAdfTest(ratioSeries, 0, 0.05);
    if (!adfResult.isStationary && adfResult.adfStatistic > -2.86) {
        return { action: 'HOLD', details: { asset: state.assetHeld, reason: 'adf_non_stationary', adfStatistic: adfResult.adfStatistic } };
    }

    const { mu, theta, sigma } = ouParams;
    const currentRatio = ratioSeries[ratioSeries.length - 1];
    const eqStdDev = sigma / Math.sqrt(2 * theta);

    if (eqStdDev === 0 || isNaN(eqStdDev)) {
        return { action: 'HOLD', details: { asset: state.assetHeld, reason: 'invalid_eq_stddev' } };
    }

    const currentZScore = (currentRatio - mu) / eqStdDev;
    const dynamicThreshold = calculateDynamicThreshold(
        theta, sigma, config.entryThreshold, config.minThreshold, config.maxThreshold
    );

    if (state.assetHeld === 'IN_BTC' && currentZScore > dynamicThreshold) {
        state.assetHeld = 'IN_ETH';
        return {
            action: 'SWITCH_TO_ETH',
            details: { reason: 'btc_overvalued_ou', zscore: currentZScore, mu, theta, dynamicThreshold },
        };
    }

    if (state.assetHeld === 'IN_ETH' && currentZScore < -dynamicThreshold) {
        state.assetHeld = 'IN_BTC';
        return {
            action: 'SWITCH_TO_BTC',
            details: { reason: 'eth_overvalued_ou', zscore: currentZScore, mu, theta, dynamicThreshold },
        };
    }

    return {
        action: 'HOLD',
        details: { asset: state.assetHeld, zscore: currentZScore, theta: theta.toFixed(4), dynamicThreshold },
    };
}

module.exports = { DEFAULT_CONFIG, createStrategyState, onNewCandle };
