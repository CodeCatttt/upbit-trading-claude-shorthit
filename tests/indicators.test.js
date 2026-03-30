/**
 * Tests for technical indicators used by scalping strategy.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    calcEMA, calcEMASeries, calcRSI, calcBollingerBands,
    calcATR, calcVWAP, calcMACD, calcStochastic, calcADX,
} = require('../src/core/indicators');

function makeCandles(closes, volume = 1) {
    return closes.map((close, i) => ({
        open: close * 0.999,
        high: close * 1.005,
        low: close * 0.995,
        close,
        volume,
        timestamp: `2026-03-29T00:${String(i).padStart(2, '0')}:00`,
    }));
}

describe('Indicators', () => {
    describe('calcEMA', () => {
        it('should return null with insufficient data', () => {
            assert.equal(calcEMA(makeCandles([1, 2, 3]), 5), null);
        });

        it('should calculate EMA correctly', () => {
            const candles = makeCandles([10, 11, 12, 13, 14, 15]);
            const ema = calcEMA(candles, 3);
            assert.ok(ema > 13 && ema < 16, `EMA should be in range, got ${ema}`);
        });
    });

    describe('calcEMASeries', () => {
        it('should return array with nulls for warmup period', () => {
            const candles = makeCandles([10, 11, 12, 13, 14]);
            const series = calcEMASeries(candles, 3);
            assert.equal(series.length, 5);
            assert.equal(series[0], null);
            assert.equal(series[1], null);
            assert.ok(series[2] !== null);
        });

        it('should return empty array for insufficient data', () => {
            const result = calcEMASeries(makeCandles([1, 2]), 5);
            assert.deepStrictEqual(result, []);
        });
    });

    describe('calcRSI', () => {
        it('should return null with insufficient data', () => {
            assert.equal(calcRSI(makeCandles([1, 2, 3]), 14), null);
        });

        it('should return ~100 for consistently rising prices', () => {
            const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
            const rsi = calcRSI(makeCandles(prices), 14);
            assert.ok(rsi > 90, `RSI should be near 100 for rising prices, got ${rsi}`);
        });

        it('should return ~0 for consistently falling prices', () => {
            const prices = Array.from({ length: 30 }, (_, i) => 100 - i);
            const rsi = calcRSI(makeCandles(prices), 14);
            assert.ok(rsi < 10, `RSI should be near 0 for falling prices, got ${rsi}`);
        });

        it('should return ~50 for flat prices', () => {
            // Alternating up/down
            const prices = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
            const rsi = calcRSI(makeCandles(prices), 14);
            assert.ok(rsi > 30 && rsi < 70, `RSI should be near 50, got ${rsi}`);
        });
    });

    describe('calcBollingerBands', () => {
        it('should return null with insufficient data', () => {
            assert.equal(calcBollingerBands(makeCandles([1, 2, 3]), 20), null);
        });

        it('should return bands with correct structure', () => {
            const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
            const bb = calcBollingerBands(makeCandles(prices), 20, 2);

            assert.ok(bb);
            assert.ok(bb.upper > bb.middle);
            assert.ok(bb.middle > bb.lower);
            assert.ok(bb.stdDev > 0);
        });
    });

    describe('calcVWAP', () => {
        it('should return null for empty candles', () => {
            assert.equal(calcVWAP([]), null);
        });

        it('should calculate volume-weighted average', () => {
            const candles = [
                { high: 102, low: 98, close: 100, volume: 10 },
                { high: 112, low: 108, close: 110, volume: 20 },
            ];
            const vwap = calcVWAP(candles);
            // TP1 = (102+98+100)/3 = 100, TP2 = (112+108+110)/3 = 110
            // VWAP = (100*10 + 110*20) / 30 = 3200/30 ≈ 106.67
            assert.ok(Math.abs(vwap - 106.67) < 0.1, `VWAP should be ~106.67, got ${vwap}`);
        });
    });

    describe('calcMACD', () => {
        it('should return null with insufficient data', () => {
            assert.equal(calcMACD(makeCandles(Array(20).fill(100))), null);
        });

        it('should return MACD components', () => {
            const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
            const macd = calcMACD(makeCandles(prices), 6, 13, 5);

            assert.ok(macd);
            assert.ok(typeof macd.macdLine === 'number');
            assert.ok(typeof macd.signalLine === 'number');
            assert.ok(typeof macd.histogram === 'number');
        });

        it('should show positive MACD for uptrend', () => {
            const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 2);
            const macd = calcMACD(makeCandles(prices), 6, 13, 5);

            assert.ok(macd.macdLine > 0, `MACD should be positive in uptrend, got ${macd.macdLine}`);
        });
    });

    describe('calcStochastic', () => {
        it('should return null with insufficient data', () => {
            assert.equal(calcStochastic(makeCandles([1, 2, 3]), 14, 3), null);
        });

        it('should return K and D values', () => {
            const prices = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 10);
            const stoch = calcStochastic(makeCandles(prices), 14, 3);

            assert.ok(stoch);
            assert.ok(stoch.k >= 0 && stoch.k <= 100, `K should be 0-100, got ${stoch.k}`);
            assert.ok(stoch.d >= 0 && stoch.d <= 100, `D should be 0-100, got ${stoch.d}`);
        });
    });

    describe('calcATR', () => {
        it('should return null with insufficient data', () => {
            assert.equal(calcATR(makeCandles([1, 2, 3]), 14), null);
        });

        it('should return positive ATR', () => {
            const prices = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 5);
            const atr = calcATR(makeCandles(prices), 14);
            assert.ok(atr > 0, `ATR should be positive, got ${atr}`);
        });
    });

    describe('calcADX', () => {
        it('should return null with insufficient data', () => {
            assert.equal(calcADX(makeCandles([1, 2, 3]), 14), null);
        });

        it('should return ADX with DI components', () => {
            const prices = Array.from({ length: 50 }, (_, i) => 100 + i + Math.sin(i) * 3);
            const adx = calcADX(makeCandles(prices), 14);

            assert.ok(adx);
            assert.ok(typeof adx.adx === 'number');
            assert.ok(typeof adx.plusDI === 'number');
            assert.ok(typeof adx.minusDI === 'number');
            assert.ok(adx.adx >= 0, `ADX should be non-negative, got ${adx.adx}`);
        });
    });
});
