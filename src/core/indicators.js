/**
 * indicators.js
 * Unified technical indicator library for all strategies.
 */

'use strict';

function calcPriceRatio(baseCandles, quoteCandles) {
    if (baseCandles.length !== quoteCandles.length) return [];
    return baseCandles.map((b, i) => b.close / quoteCandles[i].close);
}

/**
 * Estimate Ornstein-Uhlenbeck parameters via AR(1) regression.
 * Returns { mu, theta, sigma } or null if not mean-reverting.
 */
function estimateOU(series) {
    if (series.length < 3) return null;

    const n = series.length - 1;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;

    for (let i = 0; i < n; i++) {
        const x = series[i];
        const y = series[i + 1];
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumXY += x * y;
    }

    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;

    const b = (n * sumXY - sumX * sumY) / denom;
    const a = (sumY - b * sumX) / n;

    let sumResSq = 0;
    for (let i = 0; i < n; i++) {
        const res = series[i + 1] - (a + b * series[i]);
        sumResSq += res * res;
    }
    const varRes = sumResSq / n;

    if (b <= 0 || b >= 1) return null;

    const theta = -Math.log(b);
    const mu = a / (1 - b);
    const sigma = Math.sqrt(varRes * 2 * theta / (1 - Math.pow(b, 2)));

    return { mu, theta, sigma };
}

function calculateDynamicThreshold(theta, sigma, baseThreshold, minThreshold, maxThreshold) {
    const scalingFactor = sigma / theta;
    const raw = baseThreshold * scalingFactor;
    return Math.min(maxThreshold, Math.max(minThreshold, raw));
}

function calcEMA(candles, period) {
    if (candles.length < period) return null;
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) {
        ema = candles[i].close * k + ema * (1 - k);
    }
    return ema;
}

function calcEMASeries(candles, period) {
    if (candles.length < period) return [];
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
    const result = new Array(period - 1).fill(null);
    result.push(ema);
    for (let i = period; i < candles.length; i++) {
        ema = candles[i].close * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}

function calcRSI(candles, period = 14) {
    if (candles.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = candles[i].close - candles[i - 1].close;
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < candles.length; i++) {
        const diff = candles[i].close - candles[i - 1].close;
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

function calcBollingerBands(candles, period = 20, stdDevMultiplier = 2) {
    if (candles.length < period) return null;
    const slice = candles.slice(-period);
    const closes = slice.map(c => c.close);
    const middle = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
        upper: middle + stdDev * stdDevMultiplier,
        middle,
        lower: middle - stdDev * stdDevMultiplier,
        stdDev,
    };
}

function calcATR(candles, period = 14) {
    if (candles.length < period + 1) return null;
    let atr = 0;
    for (let i = 1; i <= period; i++) {
        const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        );
        atr += tr;
    }
    atr /= period;
    for (let i = period + 1; i < candles.length; i++) {
        const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        );
        atr = (atr * (period - 1) + tr) / period;
    }
    return atr;
}

function calcZScore(series, lookback) {
    if (series.length < lookback) return null;
    const slice = series.slice(-lookback);
    const mean = slice.reduce((a, b) => a + b, 0) / lookback;
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / lookback;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    return (series[series.length - 1] - mean) / stdDev;
}

function calcKalmanFilter(prices, Q = 0.0001, R = 0.01) {
    if (prices.length === 0) return [];
    let x = prices[0];
    let P = 1.0;
    const estimates = [];
    for (const z of prices) {
        // Predict
        P = P + Q;
        // Update
        const K = P / (P + R);
        x = x + K * (z - x);
        P = (1 - K) * P;
        estimates.push(x);
    }
    return estimates;
}

module.exports = {
    calcPriceRatio,
    estimateOU,
    calculateDynamicThreshold,
    calcEMA,
    calcEMASeries,
    calcRSI,
    calcBollingerBands,
    calcATR,
    calcZScore,
    calcKalmanFilter,
};
