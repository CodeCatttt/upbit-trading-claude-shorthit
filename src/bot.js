/**
 * bot.js
 * Main trading bot - runs 24/7 via PM2.
 * Dynamically loads current-strategy.js, executes on 15-minute cron schedule.
 * Supports multi-asset trading via trading-config.json.
 */

'use strict';

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const api = require('./upbit-api');
const { executeSmartEntry } = require('./execution/smart-entry');
const { createLogger } = require('./utils/logger');

const log = createLogger('BOT');

const MIN_ORDER_KRW = 5500;
const TRADE_RATIO = 0.995;

const STATE_FILE = path.join(__dirname, '../bot-state.json');
const HEARTBEAT_FILE = path.join(__dirname, '../data/bot-heartbeat.json');
const EXECUTION_LOG_FILE = path.join(__dirname, '../data/execution-log.json');
const STRATEGY_PATH = path.resolve(__dirname, './strategies/current-strategy.js');
const CONFIG_FILE = path.join(__dirname, '../trading-config.json');

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        log.warn('Failed to load trading-config.json, using defaults');
        return {
            markets: ['KRW-BTC', 'KRW-ETH'],
            defaultAsset: 'KRW-BTC',
            candleIntervals: [15, 240],
        };
    }
}

function loadStrategy() {
    // Clear cache to pick up hot-swapped strategy files
    delete require.cache[require.resolve('./strategies/current-strategy')];
    const resolved = require.resolve('./strategies/current-strategy');
    delete require.cache[resolved];
    return require('./strategies/current-strategy');
}

let strategy = loadStrategy();
let state = strategy.createStrategyState();

if (fs.existsSync(STATE_FILE)) {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (parsed.assetHeld) state = parsed;
    } catch (e) {
        log.error('Failed to parse state file, starting fresh.');
    }
}

function saveState() {
    // Atomic write: write to temp file then rename to prevent corruption
    const tmpFile = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, STATE_FILE);
}

function writeHeartbeat(lastAction) {
    const config = loadTradingConfig();
    const heartbeat = {
        timestamp: new Date().toISOString(),
        state: state.assetHeld,
        lastAction,
        markets: config.markets,
    };
    try {
        const dir = path.dirname(HEARTBEAT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));
    } catch (e) {
        log.error('Failed to write heartbeat', e.message);
    }
}

function getCurrencyFromMarket(market) {
    return market.replace('KRW-', '');
}

function appendExecutionLog(entry) {
    try {
        const dir = path.dirname(EXECUTION_LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let logs = [];
        if (fs.existsSync(EXECUTION_LOG_FILE)) {
            logs = JSON.parse(fs.readFileSync(EXECUTION_LOG_FILE, 'utf8'));
        }
        logs.push({ timestamp: new Date().toISOString(), ...entry });
        if (logs.length > 100) logs = logs.slice(-100);
        fs.writeFileSync(EXECUTION_LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) {
        log.error('Failed to write execution log', e.message);
    }
}

async function fetchCandleData(markets, intervals) {
    const candleData = {};
    for (const market of markets) {
        candleData[market] = {};
        for (const unit of intervals) {
            try {
                const candles = await api.getCandles(market, unit, 100);
                candleData[market][unit] = candles;
            } catch (e) {
                log.warn(`Failed to fetch candles for ${market} ${unit}m: ${e.message}`);
                candleData[market][unit] = [];
            }
        }
    }
    return candleData;
}

async function runStrategyBoundary() {
    try {
        // Reload strategy and config each cycle to pick up deploys
        strategy = loadStrategy();
        const config = loadTradingConfig();
        const markets = config.markets;

        // Ensure current asset is always in the watched markets list
        let effectiveMarkets = markets;
        if (state.assetHeld !== 'CASH' && !markets.includes(state.assetHeld)) {
            log.warn(`Current asset ${state.assetHeld} not in markets list, adding temporarily.`);
            effectiveMarkets = [state.assetHeld, ...markets];
        }

        const intervals = config.candleIntervals || [15, 240];
        log.info(`Strategy check - Held: ${state.assetHeld}, Markets: ${effectiveMarkets.join(', ')}, Intervals: ${intervals.join(', ')}`);

        const candleData = await fetchCandleData(effectiveMarkets, intervals);

        // Verify we have sufficient data for at least some markets (check 15m candles)
        const marketsWithData = Object.entries(candleData)
            .filter(([, intervals]) => intervals[15] && intervals[15].length >= 21);
        if (marketsWithData.length < 2) {
            log.warn('Insufficient candle data for markets.');
            writeHeartbeat('NONE');
            return;
        }

        // Re-entry from CASH
        if (state.assetHeld === 'CASH') {
            log.info('Attempting re-entry from CASH.');
            const defaultAsset = config.defaultAsset || markets[0];
            const tempState = { ...state, assetHeld: defaultAsset };
            const signal = strategy.onNewCandle(tempState, candleData);

            const krw = await api.getBalance('KRW');
            const amt = Math.floor(krw * TRADE_RATIO);

            if (amt > MIN_ORDER_KRW) {
                let targetMarket = defaultAsset;
                if (signal.action === 'SWITCH' && signal.details && signal.details.targetMarket) {
                    targetMarket = signal.details.targetMarket;
                }
                log.info(`Re-entry: Buying ${getCurrencyFromMarket(targetMarket)}.`);
                await api.buyMarketOrder(targetMarket, amt);
                state.assetHeld = targetMarket;
                saveState();
            } else {
                log.warn('Insufficient KRW for re-entry.');
            }
            writeHeartbeat('REENTRY');
            return;
        }

        // Save current asset BEFORE strategy mutates state.assetHeld
        const assetBeforeSignal = state.assetHeld;
        const result = strategy.onNewCandle(state, candleData);
        // Restore pre-signal asset — bot controls state transitions, not strategy
        state.assetHeld = assetBeforeSignal;
        saveState();

        log.info(`Action: [${result.action}]`, result.details);

        if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
            const targetMarket = result.details.targetMarket;
            const targetCurrency = getCurrencyFromMarket(targetMarket);
            const currentCurrency = getCurrencyFromMarket(state.assetHeld);
            const previousAsset = state.assetHeld;
            const executionMode = (strategy.DEFAULT_CONFIG && strategy.DEFAULT_CONFIG.executionMode) || 'market';

            try {
                // Sell current asset (always immediate)
                if (state.assetHeld !== 'CASH') {
                    const balance = await api.getBalance(currentCurrency);
                    if (balance > 0) {
                        log.info(`Selling ${balance} ${currentCurrency} to buy ${targetCurrency}...`);
                        await api.sellMarketOrder(state.assetHeld, balance);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }

                const krwBalance = await api.getBalance('KRW');

                if (executionMode === 'smart' && strategy.DEFAULT_CONFIG.smartEntry) {
                    // Smart execution: monitor and enter at optimal price
                    log.info(`Smart entry mode for ${targetMarket}`);
                    const smartResult = await executeSmartEntry(
                        targetMarket, krwBalance, strategy.DEFAULT_CONFIG.smartEntry, TRADE_RATIO, MIN_ORDER_KRW
                    );

                    appendExecutionLog({
                        from: previousAsset,
                        to: targetMarket,
                        mode: 'smart',
                        ...smartResult,
                    });

                    if (smartResult.executed) {
                        state.assetHeld = targetMarket;
                        saveState();
                        log.info(`SWITCH complete (smart, ${smartResult.method}): ${previousAsset} → ${targetMarket}, improvement: ${smartResult.improvement}%`);
                    } else {
                        log.error(`Smart entry failed for ${targetMarket}. Entering CASH state.`);
                        state.assetHeld = 'CASH';
                        saveState();
                    }
                } else {
                    // Market execution: immediate buy
                    const buyAmount = Math.floor(krwBalance * TRADE_RATIO);
                    if (buyAmount > MIN_ORDER_KRW) {
                        await api.buyMarketOrder(targetMarket, buyAmount);
                        state.assetHeld = targetMarket;
                        saveState();
                        log.info(`SWITCH complete (market): ${previousAsset} → ${targetMarket}`);
                        appendExecutionLog({
                            from: previousAsset,
                            to: targetMarket,
                            mode: 'market',
                            executed: true,
                            method: 'market',
                            improvement: 0,
                            waitedMs: 0,
                        });
                    } else {
                        log.error(`Buy failed: insufficient KRW (${buyAmount}). Entering CASH state.`);
                        state.assetHeld = 'CASH';
                        saveState();
                    }
                }
            } catch (switchErr) {
                log.error(`SWITCH execution error: ${switchErr.message}`);
                const krwBal = await api.getBalance('KRW').catch(() => 0);
                if (krwBal > MIN_ORDER_KRW) {
                    state.assetHeld = 'CASH';
                }
                saveState();
            }
        }

        writeHeartbeat(result.action);
    } catch (e) {
        log.error('runStrategyBoundary Error:', e.message);
        writeHeartbeat('ERROR');
    }
}

// Schedule: second 10 of minutes 0,15,30,45
cron.schedule('10 0,15,30,45 * * * *', runStrategyBoundary);

const config = loadTradingConfig();
log.info('Upbit Multi-Asset Trading Bot Started!');
log.info(`Markets: ${config.markets.join(', ')}`);
log.info(`Initial State: Holding ${state.assetHeld}`);

// Run immediately on start
runStrategyBoundary();
