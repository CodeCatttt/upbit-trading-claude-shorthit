/**
 * risk-manager.js
 * Real-time risk management for day trading.
 * - Per-trade stop-loss / take-profit
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
     * @param {number} config.maxDailyLossPct - Max daily loss before halt (e.g., 3 = 3%)
     * @param {number} config.maxDailyTrades - Max trades per day (e.g., 1000)
     * @param {number} config.stopLossPct - Per-trade stop loss (e.g., 0.3 = 0.3%)
     * @param {number} config.takeProfitPct - Per-trade take profit (e.g., 0.5 = 0.5%)
     * @param {number} config.pauseDurationMs - How long to pause when losing (e.g., 300000 = 5min)
     * @param {number} config.pauseThresholdPct - Cumulative loss in window to trigger pause (e.g., 0.5%)
     * @param {number} config.pauseWindowMs - Rolling window for pause check (e.g., 1800000 = 30min)
     */
    constructor(config = {}) {
        this.config = {
            maxDailyLossPct: config.maxDailyLossPct || 3,
            maxDailyTrades: config.maxDailyTrades || 1000,
            stopLossPct: config.stopLossPct || 0.3,
            takeProfitPct: config.takeProfitPct || 0.5,
            pauseDurationMs: config.pauseDurationMs || 300000,
            pauseThresholdPct: config.pauseThresholdPct || 0.5,
            pauseWindowMs: config.pauseWindowMs || 1800000,
        };

        // Daily tracking
        this.dailyStartBalance = 0;
        this.dailyPnL = 0;           // Cumulative P&L today (KRW)
        this.dailyTradeCount = 0;
        this.dailyDate = this._todayStr();

        // Trade history for rolling window
        this.recentTrades = [];  // [{ timestamp, pnlPct }]

        // Pause state
        this.pausedUntil = 0;

        // Active position tracking
        this.position = null;  // { market, entryPrice, entryTime, amount }
    }

    _todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /**
     * Reset daily counters if new day.
     */
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

    /**
     * Set the starting balance for the day.
     */
    setDailyStartBalance(balance) {
        this.dailyStartBalance = balance;
    }

    /**
     * Check if trading is allowed right now.
     * @returns {{ allowed: boolean, reason: string }}
     */
    canTrade() {
        this._checkDayReset();

        const now = Date.now();

        // Check pause
        if (now < this.pausedUntil) {
            const remaining = Math.ceil((this.pausedUntil - now) / 1000);
            return { allowed: false, reason: `paused (${remaining}s remaining)` };
        }

        // Check daily trade limit
        if (this.dailyTradeCount >= this.config.maxDailyTrades) {
            return { allowed: false, reason: `daily trade limit reached (${this.dailyTradeCount}/${this.config.maxDailyTrades})` };
        }

        // Check daily loss limit
        if (this.dailyStartBalance > 0) {
            const dailyLossPct = (-this.dailyPnL / this.dailyStartBalance) * 100;
            if (dailyLossPct >= this.config.maxDailyLossPct) {
                return { allowed: false, reason: `daily loss limit reached (${dailyLossPct.toFixed(2)}% >= ${this.config.maxDailyLossPct}%)` };
            }
        }

        return { allowed: true, reason: 'ok' };
    }

    /**
     * Record entry into a position.
     */
    enterPosition(market, entryPrice, amount) {
        this.position = {
            market,
            entryPrice,
            entryTime: Date.now(),
            amount,
        };
    }

    /**
     * Check if current position should be exited (stop-loss or take-profit).
     * @param {number} currentPrice
     * @returns {{ shouldExit: boolean, reason: string, pnlPct: number }}
     */
    checkPositionExit(currentPrice) {
        if (!this.position) {
            return { shouldExit: false, reason: 'no_position', pnlPct: 0 };
        }

        const pnlPct = ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100;

        if (pnlPct <= -this.config.stopLossPct) {
            return { shouldExit: true, reason: 'stop_loss', pnlPct };
        }

        if (pnlPct >= this.config.takeProfitPct) {
            return { shouldExit: true, reason: 'take_profit', pnlPct };
        }

        return { shouldExit: false, reason: 'holding', pnlPct };
    }

    /**
     * Record a completed trade.
     * @param {number} pnlPct - Profit/loss percentage
     * @param {number} pnlKrw - Profit/loss in KRW
     */
    recordTrade(pnlPct, pnlKrw) {
        this._checkDayReset();

        const now = Date.now();
        this.dailyTradeCount++;
        this.dailyPnL += pnlKrw;

        this.recentTrades.push({ timestamp: now, pnlPct });

        // Clean old trades from rolling window
        const windowStart = now - this.config.pauseWindowMs;
        this.recentTrades = this.recentTrades.filter(t => t.timestamp >= windowStart);

        // Check rolling window loss for pause
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

    /**
     * Get current status summary.
     */
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
