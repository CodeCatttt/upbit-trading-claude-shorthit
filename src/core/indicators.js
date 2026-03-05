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

/**
 * MACD (Moving Average Convergence Divergence).
 * Returns { macdLine, signalLine, histogram } (latest values).
 */
function calcMACD(candles, fast = 12, slow = 26, signal = 9) {
    if (candles.length < slow + signal) return null;

    const closes = candles.map(c => c.close);

    // Calculate EMA series from close prices
    function emaSeries(data, period) {
        const k = 2 / (period + 1);
        let ema = 0;
        for (let i = 0; i < period; i++) ema += data[i];
        ema /= period;
        const result = new Array(period - 1).fill(null);
        result.push(ema);
        for (let i = period; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
            result.push(ema);
        }
        return result;
    }

    const fastEma = emaSeries(closes, fast);
    const slowEma = emaSeries(closes, slow);

    // MACD line = fast EMA - slow EMA (starting from index slow-1)
    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        if (fastEma[i] != null && slowEma[i] != null) {
            macdLine.push(fastEma[i] - slowEma[i]);
        }
    }

    if (macdLine.length < signal) return null;

    // Signal line = EMA of MACD line
    const signalEma = emaSeries(macdLine, signal);

    const lastIdx = macdLine.length - 1;
    const sigIdx = signalEma.length - 1;

    if (signalEma[sigIdx] == null) return null;

    const macd = macdLine[lastIdx];
    const sig = signalEma[sigIdx];

    return {
        macdLine: macd,
        signalLine: sig,
        histogram: macd - sig,
    };
}

/**
 * Stochastic Oscillator (%K, %D).
 * Returns { k, d } (latest values).
 */
function calcStochastic(candles, kPeriod = 14, dPeriod = 3) {
    if (candles.length < kPeriod + dPeriod - 1) return null;

    // Calculate %K series
    const kValues = [];
    for (let i = kPeriod - 1; i < candles.length; i++) {
        const slice = candles.slice(i - kPeriod + 1, i + 1);
        const highest = Math.max(...slice.map(c => c.high));
        const lowest = Math.min(...slice.map(c => c.low));
        const range = highest - lowest;
        kValues.push(range === 0 ? 50 : ((candles[i].close - lowest) / range) * 100);
    }

    if (kValues.length < dPeriod) return null;

    // %D = SMA of %K
    let dSum = 0;
    for (let i = kValues.length - dPeriod; i < kValues.length; i++) {
        dSum += kValues[i];
    }

    return {
        k: kValues[kValues.length - 1],
        d: dSum / dPeriod,
    };
}

/**
 * ADX (Average Directional Index) with +DI and -DI.
 * Returns { adx, plusDI, minusDI } (latest values).
 */
function calcADX(candles, period = 14) {
    if (candles.length < period * 2 + 1) return null;

    const trList = [];
    const plusDM = [];
    const minusDM = [];

    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const prevHigh = candles[i - 1].high;
        const prevLow = candles[i - 1].low;

        trList.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

        const upMove = high - prevHigh;
        const downMove = prevLow - low;

        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    // Smoothed averages (Wilder's smoothing)
    let smoothTR = 0, smoothPlusDM = 0, smoothMinusDM = 0;
    for (let i = 0; i < period; i++) {
        smoothTR += trList[i];
        smoothPlusDM += plusDM[i];
        smoothMinusDM += minusDM[i];
    }

    const dxValues = [];

    for (let i = period; i < trList.length; i++) {
        smoothTR = smoothTR - smoothTR / period + trList[i];
        smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
        smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

        const pDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
        const mDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;
        const diSum = pDI + mDI;
        const dx = diSum === 0 ? 0 : (Math.abs(pDI - mDI) / diSum) * 100;

        dxValues.push({ dx, pDI, mDI });
    }

    if (dxValues.length < period) return null;

    // ADX = smoothed average of DX
    let adx = 0;
    for (let i = 0; i < period; i++) {
        adx += dxValues[i].dx;
    }
    adx /= period;

    for (let i = period; i < dxValues.length; i++) {
        adx = (adx * (period - 1) + dxValues[i].dx) / period;
    }

    const last = dxValues[dxValues.length - 1];

    return {
        adx,
        plusDI: last.pDI,
        minusDI: last.mDI,
    };
}

/**
 * On-Balance Volume (OBV).
 * Returns the current OBV value.
 */
function calcOBV(candles) {
    if (candles.length < 2) return null;

    let obv = 0;
    for (let i = 1; i < candles.length; i++) {
        if (candles[i].close > candles[i - 1].close) {
            obv += candles[i].volume;
        } else if (candles[i].close < candles[i - 1].close) {
            obv -= candles[i].volume;
        }
    }
    return obv;
}

/**
 * Volume-Weighted Average Price (VWAP).
 * Returns the current VWAP value.
 */
function calcVWAP(candles) {
    if (candles.length === 0) return null;

    let cumulativeTPV = 0; // typical price * volume
    let cumulativeVolume = 0;

    for (const c of candles) {
        const typicalPrice = (c.high + c.low + c.close) / 3;
        cumulativeTPV += typicalPrice * c.volume;
        cumulativeVolume += c.volume;
    }

    return cumulativeVolume === 0 ? null : cumulativeTPV / cumulativeVolume;
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
    calcMACD,
    calcStochastic,
    calcADX,
    calcOBV,
    calcVWAP,
};
