/**
 * risk-manager.js
 * Real-time risk management for day trading.
 * - ATR-based dynamic stop-loss (adapts to each coin's volatility)
 * - Trailing take-profit (locks in gains on strong moves)
 * - Daily loss limit
 * - Dynamic throttling (pause when losing)
 * - Trade frequency tracking
 */

'use strict';

const { createLogger } = require('../utils/logger');

const log = createLogger('RISK');

class RiskManager {
    /**
     * @param {object} config
     * @param {number} config.maxDailyLossPct - Max daily loss before halt (default 3%)
     * @param {number} config.maxDailyTrades - Max trades per day (default 1000)
     * @param {number} config.slAtrMultiplier - Stop-loss = ATR * this (default 1.5)
     * @param {number} config.tpAtrMultiplier - Trailing TP activates at ATR * this (default 2.0)
     * @param {number} config.trailingPct - Trailing distance from peak (default 0.2%)
     * @param {number} config.fallbackStopLossPct - Fallback SL when no ATR (default 0.3%)
     * @param {number} config.fallbackTakeProfitPct - Fallback TP when no ATR (default 0.5%)
     * @param {number} config.pauseDurationMs - Pause duration when losing (default 5min)
     * @param {number} config.pauseThresholdPct - Loss in window to trigger pause (default 0.5%)
     * @param {number} config.pauseWindowMs - Rolling window for pause (default 30min)
     */
    constructor(config = {}) {
        this.config = {
            maxDailyLossPct: config.maxDailyLossPct || 3,
            maxDailyTrades: config.maxDailyTrades || 1000,
            slAtrMultiplier: config.slAtrMultiplier || 1.5,
            tpAtrMultiplier: config.tpAtrMultiplier || 2.0,
            trailingPct: config.trailingPct || 0.2,
            fallbackStopLossPct: config.fallbackStopLossPct || 0.3,
            fallbackTakeProfitPct: config.fallbackTakeProfitPct || 0.5,
            pauseDurationMs: config.pauseDurationMs || 300000,
            pauseThresholdPct: config.pauseThresholdPct || 0.5,
            pauseWindowMs: config.pauseWindowMs || 1800000,
        };

        // Daily tracking
        this.dailyStartBalance = 0;
        this.dailyPnL = 0;
        this.dailyTradeCount = 0;
        this.dailyDate = this._todayStr();

        // Trade history for rolling window
        this.recentTrades = [];

        // Pause state
        this.pausedUntil = 0;

        // Active position tracking
        this.position = null;
        // { market, entryPrice, entryTime, amount, atr,
        //   stopLossPrice, tpActivationPrice, peakPrice, trailingActive }
    }

    _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    _checkDayReset() {
        const today = this._todayStr();
        if (today !== this.dailyDate) {
            log.info(`New trading day: ${today}. Previous: trades=${this.dailyTradeCount}, PnL=${this.dailyPnL.toFixed(0)} KRW`);
            this.dailyDate = today;
            this.dailyPnL = 0;
            this.dailyTradeCount = 0;
            this.recentTrades = [];
            this.pausedUntil = 0;
        }
    }

    setDailyStartBalance(balance) {
        this.dailyStartBalance = balance;
    }

    canTrade() {
        this._checkDayReset();
        const now = Date.now();

        if (now < this.pausedUntil) {
            const remaining = Math.ceil((this.pausedUntil - now) / 1000);
            return { allowed: false, reason: `paused (${remaining}s remaining)` };
        }

        if (this.dailyTradeCount >= this.config.maxDailyTrades) {
            return { allowed: false, reason: `daily trade limit reached (${this.dailyTradeCount}/${this.config.maxDailyTrades})` };
        }

        if (this.dailyStartBalance > 0) {
            const dailyLossPct = (-this.dailyPnL / this.dailyStartBalance) * 100;
            if (dailyLossPct >= this.config.maxDailyLossPct) {
                return { allowed: false, reason: `daily loss limit reached (${dailyLossPct.toFixed(2)}% >= ${this.config.maxDailyLossPct}%)` };
            }
        }

        return { allowed: true, reason: 'ok' };
    }

    /**
     * Record entry into a position with ATR-based dynamic levels.
     * @param {string} market
     * @param {number} entryPrice
     * @param {number} amount
     * @param {number|null} atr - ATR value from 1m candles. If null, uses fallback fixed %.
     */
    enterPosition(market, entryPrice, amount, atr = null) {
        let stopLossPrice, tpActivationPrice, stopLossPct, tpActivationPct;

        if (atr && atr > 0) {
            // ATR-based dynamic levels
            stopLossPrice = entryPrice - (atr * this.config.slAtrMultiplier);
            tpActivationPrice = entryPrice + (atr * this.config.tpAtrMultiplier);
            stopLossPct = ((entryPrice - stopLossPrice) / entryPrice) * 100;
            tpActivationPct = ((tpActivationPrice - entryPrice) / entryPrice) * 100;

            // Cap stop-loss to prevent oversized losses on volatile coins
            const maxSlPct = this.config.maxStopLossPct || 1.0;
            if (stopLossPct > maxSlPct) {
                stopLossPrice = entryPrice * (1 - maxSlPct / 100);
                stopLossPct = maxSlPct;
            }
        } else {
            // Fallback fixed percentages
            stopLossPrice = entryPrice * (1 - this.config.fallbackStopLossPct / 100);
            tpActivationPrice = entryPrice * (1 + this.config.fallbackTakeProfitPct / 100);
            stopLossPct = this.config.fallbackStopLossPct;
            tpActivationPct = this.config.fallbackTakeProfitPct;
        }

        this.position = {
            market,
            entryPrice,
            entryTime: Date.now(),
            amount,
            atr,
            stopLossPrice,
            tpActivationPrice,
            peakPrice: entryPrice,
            trailingActive: false,
            stopLossPct,
            tpActivationPct,
        };

        log.info(`Position opened: ${market} @ ${entryPrice}, SL: ${stopLossPrice.toFixed(1)} (-${stopLossPct.toFixed(2)}%), TP activation: ${tpActivationPrice.toFixed(1)} (+${tpActivationPct.toFixed(2)}%), ATR: ${atr ? atr.toFixed(1) : 'N/A'}`);
    }

    /**
     * Check if current position should be exited.
     * Logic:
     *   1. Stop-loss: price <= stopLossPrice → exit
     *   2. Trailing TP: price >= tpActivationPrice → activate trailing
     *      Once trailing active: track peakPrice, exit when price drops trailingPct% from peak
     *
     * @param {number} currentPrice
     * @returns {{ shouldExit: boolean, reason: string, pnlPct: number }}
     */
    checkPositionExit(currentPrice) {
        if (!this.position) {
            return { shouldExit: false, reason: 'no_position', pnlPct: 0 };
        }

        const pnlPct = ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100;

        // 1. Stop-loss
        if (currentPrice <= this.position.stopLossPrice) {
            return { shouldExit: true, reason: 'stop_loss', pnlPct };
        }

        // 2. Trailing take-profit
        if (currentPrice >= this.position.tpActivationPrice) {
            this.position.trailingActive = true;
        }

        if (this.position.trailingActive) {
            // Update peak
            if (currentPrice > this.position.peakPrice) {
                this.position.peakPrice = currentPrice;
            }

            // Check trailing exit: price dropped trailingPct% from peak
            const dropFromPeak = ((this.position.peakPrice - currentPrice) / this.position.peakPrice) * 100;
            if (dropFromPeak >= this.config.trailingPct) {
                return {
                    shouldExit: true,
                    reason: 'trailing_take_profit',
                    pnlPct,
                    peakPrice: this.position.peakPrice,
                    dropFromPeak,
                };
            }
        }

        return {
            shouldExit: false,
            reason: this.position.trailingActive ? 'trailing' : 'holding',
            pnlPct,
            peakPrice: this.position.peakPrice,
            trailingActive: this.position.trailingActive,
        };
    }

    recordTrade(pnlPct, pnlKrw) {
        this._checkDayReset();

        const now = Date.now();
        this.dailyTradeCount++;
        this.dailyPnL += pnlKrw;

        this.recentTrades.push({ timestamp: now, pnlPct });

        const windowStart = now - this.config.pauseWindowMs;
        this.recentTrades = this.recentTrades.filter(t => t.timestamp >= windowStart);

        const windowLoss = this.recentTrades
            .filter(t => t.pnlPct < 0)
            .reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);

        if (windowLoss >= this.config.pauseThresholdPct) {
            this.pausedUntil = now + this.config.pauseDurationMs;
            log.warn(`Trading paused until ${new Date(this.pausedUntil).toISOString()} — window loss ${windowLoss.toFixed(2)}% >= ${this.config.pauseThresholdPct}%`);
        }

        this.position = null;

        log.info(`Trade #${this.dailyTradeCount}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% (${pnlKrw >= 0 ? '+' : ''}${pnlKrw.toFixed(0)} KRW). Daily PnL: ${this.dailyPnL.toFixed(0)} KRW`);
    }

    getStatus() {
        this._checkDayReset();
        const now = Date.now();
        const windowStart = now - this.config.pauseWindowMs;
        const recentLoss = this.recentTrades
            .filter(t => t.timestamp >= windowStart && t.pnlPct < 0)
            .reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);

        const wins = this.recentTrades.filter(t => t.pnlPct > 0).length;
        const losses = this.recentTrades.filter(t => t.pnlPct < 0).length;

        return {
            dailyTradeCount: this.dailyTradeCount,
            dailyPnL: this.dailyPnL,
            dailyPnLPct: this.dailyStartBalance > 0 ? (this.dailyPnL / this.dailyStartBalance) * 100 : 0,
            isPaused: now < this.pausedUntil,
            pauseRemainingMs: Math.max(0, this.pausedUntil - now),
            recentWindowLossPct: recentLoss,
            recentWins: wins,
            recentLosses: losses,
            winRate: (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0,
            hasPosition: !!this.position,
            position: this.position,
        };
    }
}

module.exports = { RiskManager };
