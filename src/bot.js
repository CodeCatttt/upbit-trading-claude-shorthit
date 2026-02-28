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
const { createLogger } = require('./utils/logger');

const log = createLogger('BOT');

const MIN_ORDER_KRW = 5500;
const TRADE_RATIO = 0.995;

const STATE_FILE = path.join(__dirname, '../bot-state.json');
const HEARTBEAT_FILE = path.join(__dirname, '../data/bot-heartbeat.json');
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

async function fetchCandlesByMarket(markets) {
    const candlesByMarket = {};
    for (const market of markets) {
        try {
            const candles = await api.getCandles(market, 15, 100);
            candlesByMarket[market] = candles;
        } catch (e) {
            log.warn(`Failed to fetch candles for ${market}: ${e.message}`);
            candlesByMarket[market] = [];
        }
    }
    return candlesByMarket;
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

        log.info(`Strategy check - Held: ${state.assetHeld}, Markets: ${effectiveMarkets.join(', ')}`);

        const candlesByMarket = await fetchCandlesByMarket(effectiveMarkets);

        // Verify we have sufficient data for at least some markets
        const marketsWithData = Object.entries(candlesByMarket)
            .filter(([, candles]) => candles.length >= 21);
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
            const signal = strategy.onNewCandle(tempState, candlesByMarket);

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

        const result = strategy.onNewCandle(state, candlesByMarket);
        saveState();

        log.info(`Action: [${result.action}]`, result.details);

        if (result.action === 'SWITCH' && result.details && result.details.targetMarket) {
            const targetMarket = result.details.targetMarket;
            const targetCurrency = getCurrencyFromMarket(targetMarket);
            const currentCurrency = getCurrencyFromMarket(state.assetHeld);
            const previousAsset = state.assetHeld;

            try {
                // Sell current asset
                if (state.assetHeld !== 'CASH') {
                    const balance = await api.getBalance(currentCurrency);
                    if (balance > 0) {
                        log.info(`Selling ${balance} ${currentCurrency} to buy ${targetCurrency}...`);
                        await api.sellMarketOrder(state.assetHeld, balance);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }

                // Buy target asset — only update state if buy succeeds
                const krwBalance = await api.getBalance('KRW');
                const buyAmount = Math.floor(krwBalance * TRADE_RATIO);
                if (buyAmount > MIN_ORDER_KRW) {
                    await api.buyMarketOrder(targetMarket, buyAmount);
                    state.assetHeld = targetMarket;
                    saveState();
                    log.info(`SWITCH complete: ${previousAsset} → ${targetMarket}`);
                } else {
                    log.error(`Buy failed: insufficient KRW (${buyAmount}). Entering CASH state.`);
                    state.assetHeld = 'CASH';
                    saveState();
                }
            } catch (switchErr) {
                log.error(`SWITCH execution error: ${switchErr.message}`);
                // Check what we actually hold now
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
