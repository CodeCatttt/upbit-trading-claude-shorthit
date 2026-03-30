/**
 * scalping-strategy.js
 * High-frequency scalping strategy for day trading.
 *
 * Uses 1m/5m candles with multiple confirmation signals:
 * - EMA 5/13 crossover on 1m for entries
 * - RSI(6) for overbought/oversold detection
 * - Bollinger Band squeeze & breakout
 * - VWAP reversion
 * - Volume spike detection
 * - Orderbook bid/ask imbalance
 *
 * Returns BUY/SELL/HOLD signals on every tick.
 */

'use strict';

const {
    calcEMA, calcEMASeries, calcRSI, calcBollingerBands,
    calcATR, calcVWAP, calcMACD, calcStochastic, calcADX,
} = require('../core/indicators');

const DEFAULT_CONFIG = {
    // EMA crossover (1m)
    emaFast: 5,
    emaSlow: 13,

    // RSI (1m)
    rsiPeriod: 6,
    rsiOversold: 30,
    rsiOverbought: 70,

    // Bollinger Bands (1m)
    bbPeriod: 20,
    bbStdDev: 2,

    // Volume spike detection
    volumeLookback: 20,
    volumeSpikeMultiplier: 2.0,

    // VWAP
    vwapEnabled: true,

    // MACD (1m)
    macdFast: 6,
    macdSlow: 13,
    macdSignal: 5,

    // 5m trend filter (only trade in direction of 5m trend)
    trendFilterEnabled: true,
    trendEmaPeriod: 20,

    // Orderbook imbalance
    orderbookWeight: 0.15,
    orderbookBullishThreshold: 1.5, // bid/ask ratio > 1.5 = bullish
    orderbookBearishThreshold: 0.67, // bid/ask ratio < 0.67 = bearish

    // Signal scoring weights (total = 1.0)
    emaCrossWeight: 0.20,
    rsiWeight: 0.15,
    bbWeight: 0.12,
    vwapWeight: 0.12,
    macdWeight: 0.13,
    volumeWeight: 0.13,

    // Entry threshold (sum of weighted signals must exceed this)
    entryThreshold: 0.15,

    // Minimum candles before first trade
    minCandles1m: 30,
    minCandles5m: 25,
};

/**
 * Analyze 1m candles and return buy/sell/hold signal.
 *
 * @param {object[]} candles1m - Array of 1m candles
 * @param {object[]} candles5m - Array of 5m candles
 * @param {object} config - Strategy config
 * @param {object|null} orderbook - { bidPrice, askPrice, bidSize, askSize, totalBidSize, totalAskSize }
 * @returns {{ action: 'BUY'|'SELL'|'HOLD', score: number, signals: object }}
 */
function analyze(candles1m, candles5m, config = DEFAULT_CONFIG, orderbook = null) {
    if (!candles1m || candles1m.length < config.minCandles1m) {
        return { action: 'HOLD', score: 0, signals: { reason: 'insufficient_1m_candles' } };
    }
    if (!candles5m || candles5m.length < config.minCandles5m) {
        return { action: 'HOLD', score: 0, signals: { reason: 'insufficient_5m_candles' } };
    }

    const signals = {};
    let buyScore = 0;
    let sellScore = 0;

    const currentPrice = candles1m[candles1m.length - 1].close;

    // === 1. EMA Crossover (1m) ===
    const emaFastSeries = calcEMASeries(candles1m, config.emaFast);
    const emaSlowSeries = calcEMASeries(candles1m, config.emaSlow);
    const emaFast = emaFastSeries[emaFastSeries.length - 1];
    const emaSlow = emaSlowSeries[emaSlowSeries.length - 1];
    const emaFastPrev = emaFastSeries[emaFastSeries.length - 2];
    const emaSlowPrev = emaSlowSeries[emaSlowSeries.length - 2];

    if (emaFast !== null && emaSlow !== null && emaFastPrev !== null && emaSlowPrev !== null) {
        const crossUp = emaFastPrev <= emaSlowPrev && emaFast > emaSlow;
        const crossDown = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;
        const emaSpread = (emaFast - emaSlow) / emaSlow;

        if (crossUp) {
            buyScore += config.emaCrossWeight;
            signals.emaCross = 'bullish_cross';
        } else if (crossDown) {
            sellScore += config.emaCrossWeight;
            signals.emaCross = 'bearish_cross';
        } else if (emaSpread > 0.0005) {
            buyScore += config.emaCrossWeight * 0.5;
            signals.emaCross = 'bullish_trend';
        } else if (emaSpread < -0.0005) {
            sellScore += config.emaCrossWeight * 0.5;
            signals.emaCross = 'bearish_trend';
        } else {
            signals.emaCross = 'neutral';
        }
        signals.emaSpread = +emaSpread.toFixed(6);
    }

    // === 2. RSI (1m) ===
    const rsi = calcRSI(candles1m, config.rsiPeriod);
    if (rsi !== null) {
        signals.rsi = +rsi.toFixed(1);
        if (rsi < config.rsiOversold) {
            buyScore += config.rsiWeight;
            signals.rsiSignal = 'oversold';
        } else if (rsi > config.rsiOverbought) {
            sellScore += config.rsiWeight;
            signals.rsiSignal = 'overbought';
        } else if (rsi < 45) {
            buyScore += config.rsiWeight * 0.3;
            signals.rsiSignal = 'leaning_oversold';
        } else if (rsi > 55) {
            sellScore += config.rsiWeight * 0.3;
            signals.rsiSignal = 'leaning_overbought';
        } else {
            signals.rsiSignal = 'neutral';
        }
    }

    // === 3. Bollinger Bands (1m) ===
    const bb = calcBollingerBands(candles1m, config.bbPeriod, config.bbStdDev);
    if (bb) {
        const percentB = (currentPrice - bb.lower) / (bb.upper - bb.lower);
        signals.bbPercentB = +percentB.toFixed(3);
        signals.bbWidth = +((bb.upper - bb.lower) / bb.middle * 100).toFixed(3);

        if (percentB <= 0.05) {
            buyScore += config.bbWeight;
            signals.bbSignal = 'lower_touch';
        } else if (percentB >= 0.95) {
            sellScore += config.bbWeight;
            signals.bbSignal = 'upper_touch';
        } else if (percentB <= 0.2) {
            buyScore += config.bbWeight * 0.5;
            signals.bbSignal = 'lower_zone';
        } else if (percentB >= 0.8) {
            sellScore += config.bbWeight * 0.5;
            signals.bbSignal = 'upper_zone';
        } else {
            signals.bbSignal = 'neutral';
        }
    }

    // === 4. VWAP (1m) ===
    if (config.vwapEnabled) {
        const vwap = calcVWAP(candles1m.slice(-60)); // Last 60 1m candles = 1 hour
        if (vwap !== null) {
            const vwapDev = (currentPrice - vwap) / vwap;
            signals.vwapDev = +(vwapDev * 100).toFixed(3);

            if (vwapDev < -0.002) {
                buyScore += config.vwapWeight; // Below VWAP = potential buy
                signals.vwapSignal = 'below_vwap';
            } else if (vwapDev > 0.002) {
                sellScore += config.vwapWeight; // Above VWAP = potential sell
                signals.vwapSignal = 'above_vwap';
            } else {
                signals.vwapSignal = 'at_vwap';
            }
        }
    }

    // === 5. MACD (1m) ===
    const macd = calcMACD(candles1m, config.macdFast, config.macdSlow, config.macdSignal);
    if (macd) {
        signals.macdHistogram = +macd.histogram.toFixed(2);
        if (macd.histogram > 0 && macd.macdLine > 0) {
            buyScore += config.macdWeight;
            signals.macdSignal = 'bullish';
        } else if (macd.histogram < 0 && macd.macdLine < 0) {
            sellScore += config.macdWeight;
            signals.macdSignal = 'bearish';
        } else if (macd.histogram > 0) {
            buyScore += config.macdWeight * 0.4;
            signals.macdSignal = 'weak_bullish';
        } else if (macd.histogram < 0) {
            sellScore += config.macdWeight * 0.4;
            signals.macdSignal = 'weak_bearish';
        } else {
            signals.macdSignal = 'neutral';
        }
    }

    // === 6. Volume Spike ===
    if (candles1m.length >= config.volumeLookback + 1) {
        const recentVol = candles1m[candles1m.length - 1].volume;
        const avgVol = candles1m.slice(-(config.volumeLookback + 1), -1)
            .reduce((sum, c) => sum + c.volume, 0) / config.volumeLookback;

        if (avgVol > 0) {
            const volRatio = recentVol / avgVol;
            signals.volumeRatio = +volRatio.toFixed(2);
            if (volRatio >= config.volumeSpikeMultiplier) {
                // Volume spike amplifies the dominant signal
                const dominant = buyScore > sellScore ? 'buy' : 'sell';
                if (dominant === 'buy') buyScore += config.volumeWeight;
                else sellScore += config.volumeWeight;
                signals.volumeSignal = `spike_${dominant}`;
            } else {
                signals.volumeSignal = 'normal';
            }
        }
    }

    // === 7. Orderbook Imbalance ===
    if (orderbook && orderbook.totalBidSize > 0 && orderbook.totalAskSize > 0) {
        const obRatio = orderbook.totalBidSize / orderbook.totalAskSize;
        signals.orderbookRatio = +obRatio.toFixed(2);

        if (obRatio >= (config.orderbookBullishThreshold || 1.5)) {
            buyScore += config.orderbookWeight;
            signals.orderbookSignal = 'bullish_imbalance';
        } else if (obRatio <= (config.orderbookBearishThreshold || 0.67)) {
            sellScore += config.orderbookWeight;
            signals.orderbookSignal = 'bearish_imbalance';
        } else if (obRatio > 1.15) {
            buyScore += config.orderbookWeight * 0.4;
            signals.orderbookSignal = 'slight_bullish';
        } else if (obRatio < 0.87) {
            sellScore += config.orderbookWeight * 0.4;
            signals.orderbookSignal = 'slight_bearish';
        } else {
            signals.orderbookSignal = 'balanced';
        }
    }

    // === 8. 5m Trend Filter ===
    if (config.trendFilterEnabled && candles5m.length >= config.trendEmaPeriod) {
        const trend5mEma = calcEMA(candles5m, config.trendEmaPeriod);
        const price5m = candles5m[candles5m.length - 1].close;
        if (trend5mEma !== null) {
            const trendDir = price5m > trend5mEma ? 'up' : 'down';
            signals.trend5m = trendDir;

            // Penalize counter-trend trades
            if (trendDir === 'down' && buyScore > sellScore) {
                buyScore *= 0.75;
                signals.trendFilter = 'buy_penalized';
            } else if (trendDir === 'up' && sellScore > buyScore) {
                sellScore *= 0.75;
                signals.trendFilter = 'sell_penalized';
            } else {
                signals.trendFilter = 'aligned';
            }
        }
    }

    // === Decision ===
    const netScore = buyScore - sellScore;
    signals.buyScore = +buyScore.toFixed(3);
    signals.sellScore = +sellScore.toFixed(3);
    signals.netScore = +netScore.toFixed(3);

    let action = 'HOLD';
    if (netScore >= config.entryThreshold) {
        action = 'BUY';
    } else if (netScore <= -config.entryThreshold) {
        action = 'SELL';
    }

    return { action, score: +netScore.toFixed(3), signals };
}

module.exports = { DEFAULT_CONFIG, analyze };
