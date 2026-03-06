/**
 * backtest.js
 * Multi-asset backtest engine with slippage model.
 * Simulates strategy over historical candle data.
 * Calculates return, max drawdown, trade frequency, per-market benchmarks.
 *
 * Key improvements:
 * - Next-candle open for trade execution (no same-candle close bias)
 * - Correct fee accounting (0.05% per side, not double on SWITCH)
 * - Walk-forward: fresh state at split point for true OOS evaluation
 *
 * Usage:
 *   node backtest.js [strategyPath]
 *   If no path given, backtests current-strategy.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../../data/candle-store');
const { createLogger } = require('../../utils/logger');

const log = createLogger('BACKTEST');
const FEE_RATE = 0.0005;    // 0.05% per trade side (Upbit)
const SLIPPAGE_RATE = 0.001; // 0.1% slippage (market order assumption)
const RESULTS_DIR = path.join(__dirname, '../../../data/backtest-results');
const CONFIG_FILE = path.join(__dirname, '../../../trading-config.json');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return { markets: ['KRW-BTC', 'KRW-ETH'], candleIntervals: [15, 240] };
    }
}

function runBacktest(strategy, candleData, label = 'unnamed', measureFromIdx = null) {
    // If strategy uses smart execution, model reduced slippage (50%)
    const executionMode = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.executionMode) || 'market';
    const effectiveSlippage = executionMode === 'smart' ? SLIPPAGE_RATE * 0.5 : SLIPPAGE_RATE;

    const markets = Object.keys(candleData);
    if (markets.length < 2) {
        return { error: 'Need at least 2 markets for backtest' };
    }

    // Find shortest 15m candle length across markets
    const minLength = Math.min(...markets.map(m => {
        const c15 = candleData[m][15] || candleData[m];
        return Array.isArray(c15) ? c15.length : 0;
    }));
    if (minLength < 100) {
        return { error: 'Insufficient candle data for backtest' };
    }

    // Determine if data is nested (multi-timeframe) or flat (legacy)
    const isNested = !Array.isArray(candleData[markets[0]]);

    const state = strategy.createStrategyState();
    const startAsset = state.assetHeld;

    // Helper to get 15m candles (CASH guard: no candle data for CASH)
    const get15m = (market) => {
        if (market === 'CASH') return [];
        return isNested ? (candleData[market][15] || []) : (candleData[market] || []);
    };
    const get240m = (market) => {
        if (market === 'CASH') return [];
        return isNested ? (candleData[market][240] || []) : [];
    };

    // Record start prices for benchmarks
    const startPrices = {};
    for (const market of markets) {
        startPrices[market] = get15m(market)[0].close;
    }

    // Start with 1,000,000 KRW worth of default asset
    let portfolio = 1000000;
    let holdings = portfolio / startPrices[startAsset];
    let currentAsset = startAsset;
    let trades = [];
    let equityCurve = [];
    let peak = portfolio;
    let maxDrawdown = 0;

    // Walk-forward: track measure period metrics separately
    const effectiveMeasureIdx = measureFromIdx !== null ? measureFromIdx : null;
    let measurePeak = null;
    let measureMaxDrawdown = 0;
    let measureStartValue = null;
    let measureTrades = [];

    const lookback = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.lookback) || 60;
    const startIdx = Math.max(lookback, 60);

    // Pre-compute 240m timestamps (avoid repeated Date parsing in loop)
    const timestamps240 = {};
    for (const market of markets) {
        timestamps240[market] = get240m(market).map(c => new Date(c.timestamp).getTime());
    }

    // Pre-build slicedData with candles up to startIdx (O(n) total, not per step)
    const slicedData = {};
    const idx240 = {};
    const startTs = new Date(get15m(markets[0])[startIdx].timestamp).getTime();

    for (const market of markets) {
        const candles15 = get15m(market);
        slicedData[market] = {
            15: candles15.slice(0, startIdx + 1),
            240: [],
        };

        // Find initial 240m boundary using pre-computed timestamps
        const ts240 = timestamps240[market];
        let j = 0;
        while (j < ts240.length && ts240[j] <= startTs) {
            slicedData[market][240].push(get240m(market)[j]);
            j++;
        }
        idx240[market] = j;
    }

    // Track pending trades to execute on NEXT candle's open
    let pendingTrade = null;

    for (let i = startIdx; i < minLength; i++) {
        // For i > startIdx, incrementally grow arrays (O(1) per step)
        if (i > startIdx) {
            const currentTs = new Date(get15m(markets[0])[i].timestamp).getTime();
            for (const market of markets) {
                // Push new 15m candle
                slicedData[market][15].push(get15m(market)[i]);

                // Advance 240m pointer
                const candles240 = get240m(market);
                const ts240 = timestamps240[market];
                while (idx240[market] < ts240.length && ts240[idx240[market]] <= currentTs) {
                    slicedData[market][240].push(candles240[idx240[market]]);
                    idx240[market]++;
                }
            }
        }

        // Execute pending trade at this candle's open price (next-candle execution)
        if (pendingTrade !== null) {
            const pt = pendingTrade;
            pendingTrade = null;

            if (pt.type === 'SELL_TO_CASH' && currentAsset !== 'CASH') {
                const sellPrice = get15m(pt.from)[i].open || get15m(pt.from)[i].close;
                portfolio = holdings * sellPrice * (1 - effectiveSlippage) * (1 - FEE_RATE);
                trades.push({
                    idx: i, timestamp: get15m(pt.from)[i].timestamp,
                    action: 'SELL_TO_CASH', from: pt.from, to: 'CASH',
                    sellPrice, buyPrice: null,
                });
                currentAsset = 'CASH';
                holdings = 0;
            } else if (pt.type === 'BUY_FROM_CASH' && currentAsset === 'CASH' && candleData[pt.to]) {
                const buyPrice = get15m(pt.to)[i].open || get15m(pt.to)[i].close;
                const effectiveBuyPrice = buyPrice * (1 + effectiveSlippage);
                holdings = (portfolio * (1 - FEE_RATE)) / effectiveBuyPrice;
                trades.push({
                    idx: i, timestamp: get15m(markets[0])[i].timestamp,
                    action: 'BUY_FROM_CASH', from: 'CASH', to: pt.to,
                    sellPrice: null, buyPrice,
                });
                currentAsset = pt.to;
                portfolio = 0;
            } else if (pt.type === 'SWITCH' && currentAsset !== 'CASH' && candleData[pt.to]) {
                const sellPrice = get15m(pt.from)[i].open || get15m(pt.from)[i].close;
                const buyPrice = get15m(pt.to)[i].open || get15m(pt.to)[i].close;
                // Correct fee: 0.05% on sell side + 0.05% on buy side (not double)
                const krwAfterSell = holdings * sellPrice * (1 - effectiveSlippage) * (1 - FEE_RATE);
                const effectiveBuyPrice = buyPrice * (1 + effectiveSlippage);
                holdings = (krwAfterSell * (1 - FEE_RATE)) / effectiveBuyPrice;
                trades.push({
                    idx: i, timestamp: get15m(pt.from)[i].timestamp,
                    action: 'SWITCH', from: pt.from, to: pt.to,
                    sellPrice, buyPrice,
                });
                currentAsset = pt.to;
            }
        }

        const result = strategy.onNewCandle(state, slicedData);

        if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
            const target = result.details.targetMarket;
            if (target !== currentAsset) {
                // Queue trade for next candle's open (realistic execution)
                if (target === 'CASH' && currentAsset !== 'CASH') {
                    pendingTrade = { type: 'SELL_TO_CASH', from: currentAsset };
                } else if (currentAsset === 'CASH' && target !== 'CASH' && candleData[target]) {
                    pendingTrade = { type: 'BUY_FROM_CASH', to: target };
                } else if (currentAsset !== 'CASH' && target !== 'CASH' && candleData[target]) {
                    pendingTrade = { type: 'SWITCH', from: currentAsset, to: target };
                }
            }
        }

        // Equity: CASH uses portfolio (KRW), otherwise holdings * price
        const value = currentAsset === 'CASH'
            ? portfolio
            : holdings * get15m(currentAsset)[i].close;
        equityCurve.push(value);

        if (value > peak) peak = value;
        const dd = (peak - value) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;

        // Walk-forward: track measure period
        if (effectiveMeasureIdx !== null && i >= effectiveMeasureIdx) {
            if (measureStartValue === null) {
                measureStartValue = value;
                measurePeak = value;
            }
            if (value > measurePeak) measurePeak = value;
            const mdd = (measurePeak - value) / measurePeak;
            if (mdd > measureMaxDrawdown) measureMaxDrawdown = mdd;
            // Collect trades in measure period
            const lastTrade = trades[trades.length - 1];
            if (lastTrade && lastTrade.idx === i && !measureTrades.includes(lastTrade)) {
                measureTrades.push(lastTrade);
            }
        }
    }

    const finalIdx = minLength - 1;
    const finalValue = currentAsset === 'CASH'
        ? portfolio
        : holdings * get15m(currentAsset)[finalIdx].close;
    const returnPct = ((finalValue - 1000000) / 1000000) * 100;

    // Per-market benchmarks: buy and hold
    const benchmarks = {};
    for (const market of markets) {
        const startP = startPrices[market];
        const endP = get15m(market)[finalIdx].close;
        benchmarks[market] = +((endP - startP) / startP * 100).toFixed(4);
    }

    // Estimate daily trades (assuming 15m candles, 96 per day)
    const totalPeriods = minLength - startIdx;
    const days = totalPeriods / 96;
    const dailyTrades = days > 0 ? trades.length / days : 0;

    const result = {
        label,
        returnPct: parseFloat(returnPct.toFixed(4)),
        maxDrawdown: parseFloat((maxDrawdown * 100).toFixed(4)),
        totalTrades: trades.length,
        dailyTrades: parseFloat(dailyTrades.toFixed(2)),
        benchmarks,
        finalValue: Math.floor(finalValue),
        periodCandles: totalPeriods,
        executionMode,
        slippageRate: effectiveSlippage,
        feeRate: FEE_RATE,
        trades: trades.slice(-20),
    };

    // Walk-forward: include measure period metrics
    if (effectiveMeasureIdx !== null && measureStartValue !== null) {
        const measureFinalValue = currentAsset === 'CASH'
            ? portfolio
            : holdings * get15m(currentAsset)[finalIdx].close;
        const measureReturnPct = ((measureFinalValue - measureStartValue) / measureStartValue) * 100;
        const measurePeriods = minLength - effectiveMeasureIdx;
        const measureDays = measurePeriods / 96;
        const measureDailyTrades = measureDays > 0 ? measureTrades.length / measureDays : 0;

        result.measurePeriod = {
            returnPct: parseFloat(measureReturnPct.toFixed(4)),
            maxDrawdown: parseFloat((measureMaxDrawdown * 100).toFixed(4)),
            totalTrades: measureTrades.length,
            dailyTrades: parseFloat(measureDailyTrades.toFixed(2)),
            periodCandles: measurePeriods,
        };
    }

    return result;
}

// Tiered gate thresholds — tightened to prevent regression
const GATE_THRESHOLDS = {
    replace: { minReturn: 0, maxMddWorsening: 2, maxDailyTrades: 10, minDailyTrades: 0.15 },
    modify:  { minReturn: -1, maxMddWorsening: 3, maxDailyTrades: 10, minDailyTrades: 0.1 },
};

function compareStrategies(currentResult, newResult, gateType = 'replace') {
    const gate = GATE_THRESHOLDS[gateType] || GATE_THRESHOLDS.replace;

    // Use measure period (OOS) metrics if available, otherwise full backtest
    const newMetrics = newResult.measurePeriod || newResult;
    const currentMetrics = currentResult.measurePeriod || currentResult;

    const returnImprovement = newMetrics.returnPct - currentMetrics.returnPct;
    const drawdownWorsening = newMetrics.maxDrawdown - currentMetrics.maxDrawdown;
    const dailyTrades = newMetrics.dailyTrades;

    const pass =
        returnImprovement >= gate.minReturn &&
        drawdownWorsening <= gate.maxMddWorsening &&
        dailyTrades <= gate.maxDailyTrades &&
        dailyTrades >= (gate.minDailyTrades || 0);

    return {
        pass,
        gateType,
        returnImprovement: parseFloat(returnImprovement.toFixed(4)),
        drawdownWorsening: parseFloat(drawdownWorsening.toFixed(4)),
        dailyTrades,
        reasons: [
            pass ? 'PASSED' : 'FAILED',
            `Return improvement: ${returnImprovement.toFixed(2)}% (need >= ${gate.minReturn}%)`,
            `Drawdown worsening: ${drawdownWorsening.toFixed(2)}% (need <= ${gate.maxMddWorsening}%)`,
            `Daily trades: ${dailyTrades} (need >= ${gate.minDailyTrades || 0} and <= ${gate.maxDailyTrades})`,
        ],
    };
}

function runWalkForwardBacktest(strategy, candleData, label = 'unnamed') {
    const markets = Object.keys(candleData);
    const isNested = markets.length > 0 && !Array.isArray(candleData[markets[0]]);
    const get15m = (market) => isNested ? (candleData[market][15] || []) : (candleData[market] || []);

    const minLength = Math.min(...markets.map(m => {
        const c15 = get15m(m);
        return Array.isArray(c15) ? c15.length : 0;
    }));

    // Minimum 200 candles for walk-forward, otherwise fallback to single pass
    if (minLength < 200) {
        const single = runBacktest(strategy, candleData, label);
        return { train: single, test: single, splitUsed: false, splitIndex: 0 };
    }

    const splitIndex = Math.floor(minLength * 0.7);

    // Train: run on first 70% of data (trim candleData)
    const trainData = {};
    for (const market of markets) {
        if (isNested) {
            trainData[market] = {};
            for (const interval of Object.keys(candleData[market])) {
                const candles = candleData[market][interval];
                if (interval === '15') {
                    trainData[market][interval] = candles.slice(0, splitIndex);
                } else {
                    // For 240m, include candles up to the split timestamp
                    const splitTs = new Date(get15m(market)[splitIndex - 1].timestamp).getTime();
                    trainData[market][interval] = candles.filter(c => new Date(c.timestamp).getTime() <= splitTs);
                }
            }
        } else {
            trainData[market] = candleData[market].slice(0, splitIndex);
        }
    }
    const train = runBacktest(strategy, trainData, label + '-train');

    // Test: run on ONLY the test portion with FRESH state
    // This prevents strategy state leaking from train to test
    const testData = {};
    const lookback = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.lookback) || 60;
    const warmupStart = Math.max(0, splitIndex - lookback);

    for (const market of markets) {
        if (isNested) {
            testData[market] = {};
            for (const interval of Object.keys(candleData[market])) {
                const candles = candleData[market][interval];
                if (interval === '15') {
                    // Include lookback warmup candles before split point
                    testData[market][interval] = candles.slice(warmupStart);
                } else {
                    // For 240m, include candles from warmup period onward
                    const warmupTs = new Date(get15m(market)[warmupStart].timestamp).getTime();
                    testData[market][interval] = candles.filter(c => new Date(c.timestamp).getTime() >= warmupTs);
                }
            }
        } else {
            testData[market] = candleData[market].slice(warmupStart);
        }
    }
    // Run fresh backtest on test data — new strategy state, no train contamination
    const test = runBacktest(strategy, testData, label + '-test');

    return { train, test, splitUsed: true, splitIndex };
}

function saveResult(result, comparison = null) {
    ensureDir(RESULTS_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `backtest-${ts}.json`;
    const fp = path.join(RESULTS_DIR, filename);
    fs.writeFileSync(fp, JSON.stringify({ result, comparison }, null, 2));
    log.info(`Backtest result saved: ${filename}`);
    return fp;
}

// CLI entry point
if (require.main === module) {
    const args = process.argv.slice(2);
    const walkForward = args.includes('--walk-forward');
    const strategyPath = args.find(a => !a.startsWith('--')) || path.join(__dirname, '../../strategies/current-strategy.js');
    const resolvedPath = path.resolve(strategyPath);

    process.stderr.write(`[BACKTEST] Strategy: ${resolvedPath}${walkForward ? ' (walk-forward)' : ''}\n`);

    const strategy = require(resolvedPath);
    const config = loadTradingConfig();

    // Build candleData with nested timeframe structure
    const intervals = config.candleIntervals || [15, 240];
    const candleData = {};
    for (const market of config.markets) {
        const candles15 = store.getCandles(market, 15);
        if (candles15.length > 0) {
            candleData[market] = { 15: candles15 };
            for (const unit of intervals) {
                if (unit !== 15) {
                    candleData[market][unit] = store.getCandles(market, unit);
                }
            }
        }
    }

    const marketsLoaded = Object.keys(candleData);
    if (marketsLoaded.length < 2) {
        process.stderr.write(`[BACKTEST] Not enough candle data. Found: ${marketsLoaded.join(', ')}. Run candle-fetcher.js first.\n`);
        process.exit(1);
    }

    process.stderr.write(`[BACKTEST] Markets: ${marketsLoaded.join(', ')}, Intervals: ${intervals.join(', ')}\n`);

    if (walkForward) {
        const wf = runWalkForwardBacktest(strategy, candleData, path.basename(resolvedPath));
        console.log(JSON.stringify(wf));
        saveResult(wf);
    } else {
        const result = runBacktest(strategy, candleData, path.basename(resolvedPath));
        console.log(JSON.stringify(result));
        saveResult(result);
    }
}

module.exports = { runBacktest, runWalkForwardBacktest, compareStrategies, saveResult, GATE_THRESHOLDS };
