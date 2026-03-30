/**
 * scalping-backtest.js
 * Backtest engine for scalping strategy using 1m/5m candles.
 * Simulates the day-trading bot's behavior with realistic fee/slippage model.
 */

'use strict';

const { createLogger } = require('../../utils/logger');

const log = createLogger('SCALP-BT');
const FEE_RATE = 0.0005;       // 0.05% per side
const SLIPPAGE_RATE = 0.0005;  // 0.05% slippage (tighter for scalping)

/**
 * Run scalping backtest on 1m candle data.
 *
 * @param {object} strategyModule - { analyze, DEFAULT_CONFIG }
 * @param {object} candleData - { 'KRW-BTC': { 1: [...], 5: [...] } }
 * @param {object} opts
 * @param {number} opts.stopLossPct - Stop loss percentage (default 0.3)
 * @param {number} opts.takeProfitPct - Take profit percentage (default 0.5)
 * @param {number} opts.maxDailyTrades - Max trades per day (default 1000)
 * @param {number} opts.maxDailyLossPct - Max daily loss (default 3)
 * @param {string} opts.market - Which market to test (default: first in candleData)
 */
function runScalpingBacktest(strategyModule, candleData, opts = {}) {
    const config = strategyModule.DEFAULT_CONFIG || {};
    const markets = Object.keys(candleData);
    if (markets.length === 0) return { error: 'No candle data provided' };

    const market = opts.market || markets[0];
    const candles1m = candleData[market] && candleData[market][1];
    const candles5m = candleData[market] && candleData[market][5];

    if (!candles1m || candles1m.length < 60) {
        return { error: `Insufficient 1m candles for ${market}: ${candles1m ? candles1m.length : 0}` };
    }

    const stopLossPct = opts.stopLossPct || 0.3;
    const takeProfitPct = opts.takeProfitPct || 0.5;
    const maxDailyTrades = opts.maxDailyTrades || 1000;
    const maxDailyLossPct = opts.maxDailyLossPct || 3;

    const startBalance = 1000000; // 1M KRW
    let cash = startBalance;
    let holdings = 0;
    let inPosition = false;
    let entryPrice = 0;

    // Tracking
    const trades = [];
    const equityCurve = [];
    let peak = startBalance;
    let maxDrawdown = 0;

    // Daily tracking
    let dailyDate = '';
    let dailyTradeCount = 0;
    let dailyPnL = 0;
    let dailyStartValue = startBalance;
    let dailyHalted = false;
    const dailyStats = [];

    const minCandles = Math.max(config.minCandles1m || 30, 30);

    // Build 5m candle index by timestamp for alignment
    const candle5mByTime = {};
    if (candles5m) {
        for (const c of candles5m) {
            candle5mByTime[c.timestamp] = c;
        }
    }

    for (let i = minCandles; i < candles1m.length; i++) {
        const candle = candles1m[i];
        const currentPrice = candle.close;

        // Daily reset check
        const candleDate = candle.timestamp.slice(0, 10);
        if (candleDate !== dailyDate) {
            if (dailyDate) {
                dailyStats.push({
                    date: dailyDate,
                    trades: dailyTradeCount,
                    pnlKrw: +dailyPnL.toFixed(0),
                    pnlPct: +(dailyPnL / dailyStartValue * 100).toFixed(3),
                });
            }
            dailyDate = candleDate;
            dailyTradeCount = 0;
            dailyPnL = 0;
            dailyHalted = false;
            dailyStartValue = inPosition ? holdings * currentPrice : cash;
        }

        // Position management: check stop-loss / take-profit
        if (inPosition) {
            const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

            let exitReason = null;
            if (pnlPct <= -stopLossPct) exitReason = 'stop_loss';
            else if (pnlPct >= takeProfitPct) exitReason = 'take_profit';

            if (exitReason) {
                const sellPrice = currentPrice * (1 - SLIPPAGE_RATE);
                const proceeds = holdings * sellPrice * (1 - FEE_RATE);
                const tradePnl = proceeds - (holdings * entryPrice);

                trades.push({
                    idx: i,
                    timestamp: candle.timestamp,
                    action: 'SELL',
                    reason: exitReason,
                    entryPrice,
                    exitPrice: sellPrice,
                    pnlPct: +pnlPct.toFixed(4),
                    pnlKrw: +tradePnl.toFixed(0),
                });

                cash = proceeds;
                holdings = 0;
                inPosition = false;
                entryPrice = 0;
                dailyTradeCount++;
                dailyPnL += tradePnl;

                // Update equity
                const value = cash;
                equityCurve.push(value);
                if (value > peak) peak = value;
                const dd = (peak - value) / peak;
                if (dd > maxDrawdown) maxDrawdown = dd;

                // Check daily loss limit
                if (dailyStartValue > 0 && (-dailyPnL / dailyStartValue * 100) >= maxDailyLossPct) {
                    dailyHalted = true;
                }

                continue;
            }
        }

        // Check if can trade
        if (dailyHalted || dailyTradeCount >= maxDailyTrades) {
            const value = inPosition ? holdings * currentPrice : cash;
            equityCurve.push(value);
            if (value > peak) peak = value;
            const dd = (peak - value) / peak;
            if (dd > maxDrawdown) maxDrawdown = dd;
            continue;
        }

        // Run strategy analysis
        const slice1m = candles1m.slice(Math.max(0, i - 199), i + 1);

        // Find aligned 5m candles up to this point
        let slice5m = [];
        if (candles5m) {
            const currentTs = new Date(candle.timestamp).getTime();
            slice5m = candles5m.filter(c => new Date(c.timestamp).getTime() <= currentTs);
            if (slice5m.length > 200) slice5m = slice5m.slice(-200);
        }

        const signal = strategyModule.analyze(slice1m, slice5m, config);

        // Act on signal
        if (!inPosition && signal.action === 'BUY') {
            const buyPrice = currentPrice * (1 + SLIPPAGE_RATE);
            holdings = (cash * (1 - FEE_RATE)) / buyPrice;
            entryPrice = buyPrice;
            cash = 0;
            inPosition = true;

            trades.push({
                idx: i,
                timestamp: candle.timestamp,
                action: 'BUY',
                reason: 'strategy',
                price: buyPrice,
                score: signal.score,
            });
        } else if (inPosition && signal.action === 'SELL') {
            const sellPrice = currentPrice * (1 - SLIPPAGE_RATE);
            const proceeds = holdings * sellPrice * (1 - FEE_RATE);
            const pnlPct = ((sellPrice - entryPrice) / entryPrice) * 100;
            const tradePnl = proceeds - (holdings * entryPrice);

            trades.push({
                idx: i,
                timestamp: candle.timestamp,
                action: 'SELL',
                reason: 'strategy',
                entryPrice,
                exitPrice: sellPrice,
                pnlPct: +pnlPct.toFixed(4),
                pnlKrw: +tradePnl.toFixed(0),
            });

            cash = proceeds;
            holdings = 0;
            inPosition = false;
            entryPrice = 0;
            dailyTradeCount++;
            dailyPnL += tradePnl;

            if (dailyStartValue > 0 && (-dailyPnL / dailyStartValue * 100) >= maxDailyLossPct) {
                dailyHalted = true;
            }
        }

        // Update equity curve
        const value = inPosition ? holdings * currentPrice : cash;
        equityCurve.push(value);
        if (value > peak) peak = value;
        const dd = (peak - value) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Final daily stats
    if (dailyDate) {
        dailyStats.push({
            date: dailyDate,
            trades: dailyTradeCount,
            pnlKrw: +dailyPnL.toFixed(0),
            pnlPct: +(dailyPnL / dailyStartValue * 100).toFixed(3),
        });
    }

    // Calculate results
    const finalValue = inPosition
        ? holdings * candles1m[candles1m.length - 1].close
        : cash;
    const returnPct = ((finalValue - startBalance) / startBalance) * 100;

    const totalDays = dailyStats.length || 1;
    const avgDailyTrades = trades.filter(t => t.action === 'SELL').length / totalDays;

    const sellTrades = trades.filter(t => t.action === 'SELL');
    const wins = sellTrades.filter(t => t.pnlPct > 0);
    const losses = sellTrades.filter(t => t.pnlPct <= 0);
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
    const winRate = sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0;

    const totalFees = sellTrades.length * 2 * FEE_RATE * 100; // approximate total fee %

    // Benchmark: buy and hold
    const benchmarkReturn = ((candles1m[candles1m.length - 1].close - candles1m[minCandles].close) / candles1m[minCandles].close) * 100;

    return {
        market,
        returnPct: +returnPct.toFixed(4),
        maxDrawdown: +(maxDrawdown * 100).toFixed(4),
        finalValue: Math.floor(finalValue),
        totalTrades: sellTrades.length,
        avgDailyTrades: +avgDailyTrades.toFixed(1),
        winRate: +winRate.toFixed(1),
        avgWinPct: +avgWin.toFixed(4),
        avgLossPct: +avgLoss.toFixed(4),
        totalFeePct: +totalFees.toFixed(2),
        benchmarkReturn: +benchmarkReturn.toFixed(4),
        alpha: +(returnPct - benchmarkReturn).toFixed(4),
        totalDays,
        dailyStats: dailyStats.slice(-30),
        recentTrades: sellTrades.slice(-20),
        config: {
            stopLossPct,
            takeProfitPct,
            maxDailyTrades,
            maxDailyLossPct,
            feeRate: FEE_RATE,
            slippageRate: SLIPPAGE_RATE,
        },
    };
}

module.exports = { runScalpingBacktest };
