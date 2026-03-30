/**
 * Tests for RiskManager — ATR-based dynamic SL/TP + trailing take-profit.
 */

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { RiskManager } = require('../src/core/risk-manager');

describe('RiskManager', () => {
    let rm;

    beforeEach(() => {
        rm = new RiskManager({
            maxDailyLossPct: 3,
            maxDailyTrades: 100,
            slAtrMultiplier: 1.5,
            tpAtrMultiplier: 2.0,
            trailingPct: 0.2,
            fallbackStopLossPct: 0.3,
            fallbackTakeProfitPct: 0.5,
            pauseDurationMs: 5000,
            pauseThresholdPct: 1.0,
            pauseWindowMs: 60000,
        });
        rm.setDailyStartBalance(1000000);
    });

    describe('canTrade', () => {
        it('should allow trading when no limits reached', () => {
            assert.equal(rm.canTrade().allowed, true);
        });

        it('should block when daily trade limit reached', () => {
            rm.dailyTradeCount = 100;
            assert.equal(rm.canTrade().allowed, false);
        });

        it('should block when daily loss limit reached', () => {
            rm.dailyPnL = -30000; // -3%
            assert.equal(rm.canTrade().allowed, false);
        });

        it('should block during pause', () => {
            rm.pausedUntil = Date.now() + 10000;
            assert.equal(rm.canTrade().allowed, false);
        });
    });

    describe('enterPosition with ATR', () => {
        it('should set ATR-based stop-loss and TP activation', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200); // ATR=200

            assert.ok(rm.position);
            // SL = 100000 - (200 * 1.5) = 99700
            assert.equal(rm.position.stopLossPrice, 99700);
            // TP activation = 100000 + (200 * 2.0) = 100400
            assert.equal(rm.position.tpActivationPrice, 100400);
            assert.equal(rm.position.trailingActive, false);
            assert.equal(rm.position.atr, 200);
        });

        it('should use fallback when ATR is null', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, null);

            // Fallback SL = 100000 * (1 - 0.003) = 99700
            assert.ok(Math.abs(rm.position.stopLossPrice - 99700) < 1);
            // Fallback TP = 100000 * (1 + 0.005) = 100500
            assert.ok(Math.abs(rm.position.tpActivationPrice - 100500) < 1);
        });
    });

    describe('checkPositionExit - stop-loss', () => {
        it('should trigger stop-loss with ATR-based level', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);
            // SL = 99700
            const result = rm.checkPositionExit(99690);
            assert.equal(result.shouldExit, true);
            assert.equal(result.reason, 'stop_loss');
        });

        it('should not trigger stop-loss above level', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);
            const result = rm.checkPositionExit(99710);
            assert.equal(result.shouldExit, false);
        });
    });

    describe('checkPositionExit - trailing take-profit', () => {
        it('should activate trailing when price reaches TP activation', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);
            // TP activation = 100400
            const result = rm.checkPositionExit(100500);
            assert.equal(result.shouldExit, false);
            assert.equal(rm.position.trailingActive, true);
            assert.equal(rm.position.peakPrice, 100500);
        });

        it('should track peak price while trailing', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);

            rm.checkPositionExit(100500); // activate trailing, peak=100500
            rm.checkPositionExit(100800); // new peak=100800

            assert.equal(rm.position.peakPrice, 100800);
            assert.equal(rm.position.trailingActive, true);
        });

        it('should exit when price drops trailingPct from peak', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);

            rm.checkPositionExit(100500); // activate trailing
            rm.checkPositionExit(100800); // peak = 100800

            // Trail = 0.2% of 100800 = 201.6 → exit below 100598.4
            const result = rm.checkPositionExit(100590);
            assert.equal(result.shouldExit, true);
            assert.equal(result.reason, 'trailing_take_profit');
            assert.ok(result.pnlPct > 0.5, 'Should have positive PnL');
        });

        it('should not exit while price is near peak', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);

            rm.checkPositionExit(100500); // activate
            rm.checkPositionExit(100800); // peak

            // Still very close to peak
            const result = rm.checkPositionExit(100750);
            assert.equal(result.shouldExit, false);
            assert.equal(result.reason, 'trailing');
        });

        it('should capture large moves with trailing', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);

            // Price pumps from 100000 → 101000 (1% gain)
            rm.checkPositionExit(100500); // activate trailing
            rm.checkPositionExit(100800);
            rm.checkPositionExit(101000); // peak = 101000

            // Price pulls back 0.2% from peak → exit
            const exitPrice = 101000 * (1 - 0.002); // 100798
            const result = rm.checkPositionExit(exitPrice);
            assert.equal(result.shouldExit, true);
            // P&L should be ~0.8% (much better than fixed 0.5% TP)
            assert.ok(result.pnlPct > 0.7, `Expected >0.7% PnL, got ${result.pnlPct.toFixed(3)}%`);
        });
    });

    describe('recordTrade', () => {
        it('should increment trade count and PnL', () => {
            rm.recordTrade(0.2, 2000);
            assert.equal(rm.dailyTradeCount, 1);
            assert.equal(rm.dailyPnL, 2000);
        });

        it('should trigger pause on rolling window loss', () => {
            rm.recordTrade(-0.4, -4000);
            rm.recordTrade(-0.3, -3000);
            rm.recordTrade(-0.4, -4000);
            assert.ok(rm.pausedUntil > Date.now());
        });

        it('should clear position after recording', () => {
            rm.enterPosition('KRW-BTC', 100000, 1000, 200);
            rm.recordTrade(0.5, 5000);
            assert.equal(rm.position, null);
        });
    });

    describe('getStatus', () => {
        it('should return complete status', () => {
            rm.recordTrade(0.3, 3000);
            rm.recordTrade(-0.1, -1000);
            const status = rm.getStatus();
            assert.equal(status.dailyTradeCount, 2);
            assert.equal(status.dailyPnL, 2000);
            assert.equal(status.winRate, 50);
        });
    });

    describe('daily reset', () => {
        it('should reset on new day', () => {
            rm.dailyTradeCount = 50;
            rm.dailyPnL = 10000;
            rm.dailyDate = '2020-01-01';
            rm.canTrade();
            assert.equal(rm.dailyTradeCount, 0);
            assert.equal(rm.dailyPnL, 0);
        });
    });
});
