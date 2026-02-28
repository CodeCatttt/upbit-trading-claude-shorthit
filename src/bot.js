/**
 * bot.js
 * Main trading bot - runs 24/7 via PM2.
 * Dynamically loads current-strategy.js, executes on 15-minute cron schedule.
 */

'use strict';

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const api = require('./upbit-api');
const { createLogger } = require('./utils/logger');

const log = createLogger('BOT');

const BTC_MARKET = 'KRW-BTC';
const ETH_MARKET = 'KRW-ETH';
const MIN_ORDER_KRW = 5500;
const TRADE_RATIO = 0.995;

const STATE_FILE = path.join(__dirname, '../bot-state.json');
const HEARTBEAT_FILE = path.join(__dirname, '../data/bot-heartbeat.json');
const STRATEGY_PATH = path.resolve(__dirname, './strategies/current-strategy.js');

function loadStrategy() {
    // Clear cache to pick up hot-swapped strategy files
    delete require.cache[require.resolve('./strategies/current-strategy')];
    // Also clear the underlying strategy module cache if it's a re-export
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
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function writeHeartbeat(lastAction) {
    const heartbeat = {
        timestamp: new Date().toISOString(),
        state: state.assetHeld,
        lastAction,
    };
    try {
        const dir = path.dirname(HEARTBEAT_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(heartbeat, null, 2));
    } catch (e) {
        log.error('Failed to write heartbeat', e.message);
    }
}

async function runStrategyBoundary() {
    try {
        // Reload strategy each cycle to pick up deploys
        strategy = loadStrategy();

        log.info(`Strategy check - Held: ${state.assetHeld}`);

        const btcCandles = await api.getCandles(BTC_MARKET, 15, 100);
        const ethCandles = await api.getCandles(ETH_MARKET, 15, 100);

        if (btcCandles.length < 21 || ethCandles.length < 21) {
            log.warn('Insufficient candle data to proceed.');
            writeHeartbeat('NONE');
            return;
        }

        // Re-entry from CASH
        if (state.assetHeld === 'CASH') {
            log.info('Attempting re-entry from CASH.');
            const tempState = { ...state, assetHeld: 'IN_BTC' };
            const signal = strategy.onNewCandle(tempState, btcCandles, ethCandles);

            const krw = await api.getBalance('KRW');
            const amt = Math.floor(krw * TRADE_RATIO);

            if (amt > MIN_ORDER_KRW) {
                if (signal.action === 'SWITCH_TO_ETH') {
                    log.info('Re-entry: Buying ETH.');
                    await api.buyMarketOrder(ETH_MARKET, amt);
                    state.assetHeld = 'IN_ETH';
                } else {
                    log.info('Re-entry: Buying BTC.');
                    await api.buyMarketOrder(BTC_MARKET, amt);
                    state.assetHeld = 'IN_BTC';
                }
                saveState();
            } else {
                log.warn('Insufficient KRW for re-entry.');
            }
            writeHeartbeat('REENTRY');
            return;
        }

        const result = strategy.onNewCandle(state, btcCandles, ethCandles);
        saveState();

        log.info(`Action: [${result.action}]`, result.details);

        if (result.action === 'SWITCH_TO_ETH') {
            const btcBalance = await api.getBalance('BTC');
            if (btcBalance > 0) {
                log.info(`Selling ${btcBalance} BTC to buy ETH...`);
                await api.sellMarketOrder(BTC_MARKET, btcBalance);
                await new Promise(r => setTimeout(r, 3000));
            }
            const krwBalance = await api.getBalance('KRW');
            const buyAmount = Math.floor(krwBalance * TRADE_RATIO);
            if (buyAmount > MIN_ORDER_KRW) {
                await api.buyMarketOrder(ETH_MARKET, buyAmount);
            }
        } else if (result.action === 'SWITCH_TO_BTC') {
            const ethBalance = await api.getBalance('ETH');
            if (ethBalance > 0) {
                log.info(`Selling ${ethBalance} ETH to buy BTC...`);
                await api.sellMarketOrder(ETH_MARKET, ethBalance);
                await new Promise(r => setTimeout(r, 3000));
            }
            const krwBalance = await api.getBalance('KRW');
            const buyAmount = Math.floor(krwBalance * TRADE_RATIO);
            if (buyAmount > MIN_ORDER_KRW) {
                await api.buyMarketOrder(BTC_MARKET, buyAmount);
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

log.info('Upbit Relative Value Bot Started!');
log.info(`Pairs: ${BTC_MARKET} / ${ETH_MARKET}`);
log.info(`Initial State: Holding ${state.assetHeld}`);

// Run immediately on start
runStrategyBoundary();
