/**
 * Tests for scalping backtest engine.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runScalpingBacktest } = require('../src/batch/eval/scalping-backtest');

// Simple always-buy then always-sell strategy for testing
const alwaysBuyStrategy = {
    DEFAULT_CONFIG: { minCandles1m: 30, minCandles5m: 25 },
    analyze(candles1m, candles5m) {
        return { action: 'BUY', score: 1.0, signals: {} };
    },
};

const alwaysSellStrategy = {
    DEFAULT_CONFIG: { minCandles1m: 30, minCandles5m: 25 },
    analyze(candles1m, candles5m) {
        return { action: 'SELL', score: -1.0, signals: {} };
    },
};

const holdStrategy = {
    DEFAULT_CONFIG: { minCandles1m: 30, minCandles5m: 25 },
    analyze() {
        return { action: 'HOLD', score: 0, signals: {} };
    },
};

// Alternating buy/sell every candle
let flipState = false;
const flipStrategy = {
    DEFAULT_CONFIG: { minCandles1m: 30, minCandles5m: 25 },
    analyze() {
        flipState = !flipState;
        return { action: flipState ? 'BUY' : 'SELL', score: flipState ? 0.5 : -0.5, signals: {} };
    },
};

function generateTestCandles(count, startPrice = 100000) {
    const candles = [];
    let price = startPrice;
    const baseDate = new Date('2026-03-01T00:00:00');

    for (let i = 0; i < count; i++) {
        // Small random walk
        price *= (1 + (Math.sin(i * 0.1) * 0.001));
        const date = new Date(baseDate.getTime() + i * 60000);
        const dateStr = date.toISOString().slice(0, 19);

        candles.push({
            open: price * 0.9999,
            high: price * 1.001,
            low: price * 0.999,
            close: price,
            volume: 1,
            timestamp: dateStr,
        });
    }
    return candles;
}

function generateTest5mCandles(count, startPrice = 100000) {
    const candles = [];
    let price = startPrice;
    const baseDate = new Date('2026-03-01T00:00:00');

    for (let i = 0; i < count; i++) {
        price *= (1 + (Math.sin(i * 0.5) * 0.001));
        const date = new Date(baseDate.getTime() + i * 5 * 60000);
        const dateStr = date.toISOString().slice(0, 19);

        candles.push({
            open: price * 0.9999,
            high: price * 1.002,
            low: price * 0.998,
            close: price,
            volume: 5,
            timestamp: dateStr,
        });
    }
    return candles;
}

describe('Scalping Backtest Engine', () => {
    const candleData = {
        'KRW-BTC': {
            1: generateTestCandles(2000),
            5: generateTest5mCandles(400),
        },
    };

    describe('basic execution', () => {
        it('should return error with insufficient data', () => {
            const result = runScalpingBacktest(holdStrategy, {
                'KRW-BTC': { 1: generateTestCandles(20), 5: [] },
            });
            assert.ok(result.error);
        });

        it('should complete backtest with hold strategy (no trades)', () => {
            const result = runScalpingBacktest(holdStrategy, candleData);

            assert.ok(!result.error, `Unexpected error: ${result.error}`);
            assert.equal(result.totalTrades, 0);
            assert.equal(result.market, 'KRW-BTC');
            assert.ok(result.finalValue > 0);
        });

        it('should complete backtest with trading strategy', () => {
            flipState = false; // reset
            const result = runScalpingBacktest(flipStrategy, candleData);

            assert.ok(!result.error, `Unexpected error: ${result.error}`);
            assert.ok(result.totalTrades > 0, 'Should have executed trades');
            assert.ok(result.market === 'KRW-BTC');
        });
    });

    describe('fee accounting', () => {
        it('should track total fees', () => {
            flipState = false;
            const result = runScalpingBacktest(flipStrategy, candleData);

            assert.ok(result.totalFeePct > 0, 'Fee tracking should report fees');
        });

        it('should lose money when trading flat market with fees', () => {
            flipState = false;
            const flatCandles = generateTestCandles(2000); // near-flat price
            const result = runScalpingBacktest(flipStrategy, {
                'KRW-BTC': { 1: flatCandles, 5: generateTest5mCandles(400) },
            });

            if (result.totalTrades > 10) {
                // With many trades on flat market, fees should dominate
                assert.ok(result.returnPct < 1,
                    `Expected negative or near-zero return on flat market with fees, got ${result.returnPct}%`);
            }
        });
    });

    describe('risk controls', () => {
        it('should respect maxDailyTrades limit', () => {
            flipState = false;
            const result = runScalpingBacktest(flipStrategy, candleData, {
                maxDailyTrades: 5,
            });

            // Check that no day exceeds 5 trades
            if (result.dailyStats) {
                for (const day of result.dailyStats) {
                    assert.ok(day.trades <= 5,
                        `Day ${day.date} had ${day.trades} trades, max is 5`);
                }
            }
        });

        it('should include daily stats in output', () => {
            flipState = false;
            const result = runScalpingBacktest(flipStrategy, candleData);

            assert.ok(Array.isArray(result.dailyStats));
            assert.ok(result.dailyStats.length > 0);

            const day = result.dailyStats[0];
            assert.ok('date' in day);
            assert.ok('trades' in day);
            assert.ok('pnlKrw' in day);
            assert.ok('pnlPct' in day);
        });
    });

    describe('result metrics', () => {
        it('should calculate win rate correctly', () => {
            flipState = false;
            const result = runScalpingBacktest(flipStrategy, candleData);

            assert.ok(result.winRate >= 0 && result.winRate <= 100);
            assert.ok(typeof result.avgWinPct === 'number');
            assert.ok(typeof result.avgLossPct === 'number');
        });

        it('should calculate max drawdown', () => {
            flipState = false;
            const result = runScalpingBacktest(flipStrategy, candleData);

            assert.ok(result.maxDrawdown >= 0);
        });

        it('should calculate benchmark return and alpha', () => {
            flipState = false;
            const result = runScalpingBacktest(flipStrategy, candleData);

            assert.ok(typeof result.benchmarkReturn === 'number');
            assert.ok(typeof result.alpha === 'number');
            assert.equal(+(result.returnPct - result.benchmarkReturn).toFixed(4), result.alpha);
        });

        it('should include config in output', () => {
            const result = runScalpingBacktest(holdStrategy, candleData, {
                stopLossPct: 0.5,
                takeProfitPct: 1.0,
            });

            assert.equal(result.config.stopLossPct, 0.5);
            assert.equal(result.config.takeProfitPct, 1.0);
        });
    });
});
