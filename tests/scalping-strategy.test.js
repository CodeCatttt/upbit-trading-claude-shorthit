/**
 * Tests for scalping strategy signal generation.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyze, DEFAULT_CONFIG } = require('../src/strategies/scalping-strategy');

// Helper: generate synthetic candle data
function generateCandles(count, startPrice = 100000, trend = 'flat', volatility = 0.001) {
    const candles = [];
    let price = startPrice;

    for (let i = 0; i < count; i++) {
        const trendBias = trend === 'up' ? 0.0003 : trend === 'down' ? -0.0003 : 0;
        const change = (Math.random() - 0.5) * 2 * volatility + trendBias;
        price *= (1 + change);

        const open = price * (1 - Math.random() * volatility);
        const close = price;
        const high = Math.max(open, close) * (1 + Math.random() * volatility);
        const low = Math.min(open, close) * (1 - Math.random() * volatility);

        candles.push({
            open,
            high,
            low,
            close,
            volume: 1 + Math.random() * 10,
            timestamp: `2026-03-29T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
        });
    }
    return candles;
}

// Generate deterministic oversold/overbought candles
function generateOversoldCandles(count, startPrice = 100000) {
    const candles = [];
    let price = startPrice;
    // Steady decline to push RSI low
    for (let i = 0; i < count; i++) {
        price *= 0.998; // Consistent decline
        candles.push({
            open: price * 1.001,
            high: price * 1.002,
            low: price * 0.999,
            close: price,
            volume: 5,
            timestamp: `2026-03-29T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
        });
    }
    return candles;
}

function generateOverboughtCandles(count, startPrice = 100000) {
    const candles = [];
    let price = startPrice;
    for (let i = 0; i < count; i++) {
        price *= 1.002;
        candles.push({
            open: price * 0.999,
            high: price * 1.001,
            low: price * 0.998,
            close: price,
            volume: 5,
            timestamp: `2026-03-29T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
        });
    }
    return candles;
}

describe('Scalping Strategy', () => {
    describe('analyze - basic', () => {
        it('should return HOLD with insufficient 1m candles', () => {
            const result = analyze(generateCandles(10), generateCandles(30));
            assert.equal(result.action, 'HOLD');
            assert.equal(result.signals.reason, 'insufficient_1m_candles');
        });

        it('should return HOLD with insufficient 5m candles', () => {
            const result = analyze(generateCandles(50), generateCandles(10));
            assert.equal(result.action, 'HOLD');
            assert.equal(result.signals.reason, 'insufficient_5m_candles');
        });

        it('should return a valid signal with sufficient data', () => {
            const candles1m = generateCandles(60);
            const candles5m = generateCandles(30);
            const result = analyze(candles1m, candles5m);

            assert.ok(['BUY', 'SELL', 'HOLD'].includes(result.action));
            assert.ok(typeof result.score === 'number');
            assert.ok(typeof result.signals === 'object');
        });

        it('should include all signal components in output', () => {
            const candles1m = generateCandles(100);
            const candles5m = generateCandles(50);
            const result = analyze(candles1m, candles5m);

            // Should have score components
            assert.ok('buyScore' in result.signals);
            assert.ok('sellScore' in result.signals);
            assert.ok('netScore' in result.signals);
        });
    });

    describe('analyze - signal direction', () => {
        it('should lean BUY on heavily oversold candles', () => {
            const candles1m = generateOversoldCandles(60);
            const candles5m = generateOversoldCandles(30);
            const result = analyze(candles1m, candles5m);

            // RSI should be low, BB should be near lower band
            assert.ok(result.signals.rsi < 40, `RSI should be low, got ${result.signals.rsi}`);
            // Buy score should be positive
            assert.ok(result.signals.buyScore > 0, `Buy score should be positive, got ${result.signals.buyScore}`);
        });

        it('should lean SELL on heavily overbought candles', () => {
            const candles1m = generateOverboughtCandles(60);
            const candles5m = generateOverboughtCandles(30);
            const result = analyze(candles1m, candles5m);

            assert.ok(result.signals.rsi > 60, `RSI should be high, got ${result.signals.rsi}`);
            assert.ok(result.signals.sellScore > 0, `Sell score should be positive, got ${result.signals.sellScore}`);
        });
    });

    describe('analyze - config customization', () => {
        it('should respect custom entry threshold', () => {
            const candles1m = generateCandles(60);
            const candles5m = generateCandles(30);

            // Very high threshold = should always HOLD
            const config = { ...DEFAULT_CONFIG, entryThreshold: 10 };
            const result = analyze(candles1m, candles5m, config);
            assert.equal(result.action, 'HOLD');
        });

        it('should respect custom RSI thresholds', () => {
            const candles1m = generateOversoldCandles(60);
            const candles5m = generateCandles(30);

            // Very low RSI threshold = oversold candles may not trigger
            const config = { ...DEFAULT_CONFIG, rsiOversold: 5 };
            const result = analyze(candles1m, candles5m, config);
            // With threshold at 5, most oversold readings (10-25) won't trigger the full RSI signal
            assert.ok(result.signals.rsiSignal !== 'oversold' || result.signals.rsi <= 5);
        });
    });

    describe('analyze - 5m trend filter', () => {
        it('should penalize counter-trend buys when 5m trend is down', () => {
            const candles1m = generateOversoldCandles(60);
            const candles5m = generateOversoldCandles(30); // downtrend

            const withFilter = analyze(candles1m, candles5m, { ...DEFAULT_CONFIG, trendFilterEnabled: true });
            const withoutFilter = analyze(candles1m, candles5m, { ...DEFAULT_CONFIG, trendFilterEnabled: false });

            // With filter, buy score should be penalized (lower)
            if (withFilter.signals.trendFilter === 'buy_penalized') {
                assert.ok(withFilter.signals.buyScore <= withoutFilter.signals.buyScore,
                    'Buy score should be penalized with downtrend filter');
            }
        });
    });
});
