/**
 * market-selector.js
 * Dynamically selects top KRW markets by 24h trading volume.
 * Runs on bot startup + periodically to keep trading-config.json fresh.
 */

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('MARKET-SEL');

const UPBIT_API = 'https://api.upbit.com';
const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');
const API_TIMEOUT = 10000;

// Coins to always exclude (stablecoins, wrapped, low-cap junk)
const EXCLUDE_COINS = new Set([
    'KRW-USDT', 'KRW-USDC',
]);

// Minimum price filter — coins below this are unsuitable for scalping
// (tick size relative to price is too large, causing artificial volatility)
const MIN_COIN_PRICE_KRW = 100;

/**
 * Fetch all KRW markets and select top N by 24h trading volume.
 * @param {number} topN - Number of markets to select (default 12)
 * @param {number} minVolume24h - Minimum 24h volume in KRW (default 10B)
 * @returns {string[]} Selected market codes
 */
async function selectTopMarkets(topN = 12, minVolume24h = 10_000_000_000) {
    // 1. Get all KRW markets
    const marketsRes = await axios.get(`${UPBIT_API}/v1/market/all?is_details=true`, {
        timeout: API_TIMEOUT,
    });

    const krwMarkets = marketsRes.data
        .filter(m => m.market.startsWith('KRW-'))
        .filter(m => !EXCLUDE_COINS.has(m.market))
        .filter(m => m.market_warning !== 'CAUTION') // Skip caution-flagged coins
        .map(m => m.market);

    if (krwMarkets.length === 0) {
        log.warn('No KRW markets found');
        return [];
    }

    // 2. Get ticker data for all KRW markets (batch request)
    const tickerRes = await axios.get(
        `${UPBIT_API}/v1/ticker?markets=${krwMarkets.join(',')}`,
        { timeout: API_TIMEOUT }
    );

    // 3. Sort by 24h trading volume (KRW) and filter
    const ranked = tickerRes.data
        .filter(t => t.acc_trade_price_24h >= minVolume24h)
        .filter(t => t.trade_price >= MIN_COIN_PRICE_KRW) // Exclude cheap coins
        .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
        .slice(0, topN);

    const selected = ranked.map(t => t.market);

    log.info(`Selected ${selected.length} markets from ${krwMarkets.length} KRW markets:`);
    for (const t of ranked) {
        const volB = (t.acc_trade_price_24h / 1_000_000_000).toFixed(1);
        const change = (t.signed_change_rate * 100).toFixed(2);
        log.info(`  ${t.market.padEnd(10)} vol: ${volB}B KRW, 24h: ${change}%`);
    }

    return selected;
}

/**
 * Update trading-config.json with new markets.
 * Preserves the currently held asset in the list.
 */
function updateConfig(newMarkets) {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        config = {};
    }

    const oldMarkets = config.markets || [];

    // Safety: preserve currently held asset
    const statePath = path.join(__dirname, '../../bot-state.json');
    try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state.assetHeld && state.assetHeld !== 'CASH' && !newMarkets.includes(state.assetHeld)) {
            log.warn(`Preserving held asset ${state.assetHeld} in market list`);
            newMarkets = [state.assetHeld, ...newMarkets];
        }
    } catch {}

    config.markets = newMarkets;
    config.updatedAt = new Date().toISOString();
    config.updatedBy = 'market-selector';

    const tmpFile = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
    fs.renameSync(tmpFile, CONFIG_FILE);

    // Log changes
    const added = newMarkets.filter(m => !oldMarkets.includes(m));
    const removed = oldMarkets.filter(m => !newMarkets.includes(m));
    if (added.length > 0) log.info(`Added: ${added.join(', ')}`);
    if (removed.length > 0) log.info(`Removed: ${removed.join(', ')}`);

    return { markets: newMarkets, added, removed };
}

/**
 * Run market selection and update config.
 */
async function refreshMarkets(topN = 12) {
    try {
        const markets = await selectTopMarkets(topN);
        if (markets.length === 0) {
            log.warn('No markets selected, keeping current config');
            return null;
        }
        return updateConfig(markets);
    } catch (e) {
        log.error('Market selection failed:', e.message);
        return null;
    }
}

module.exports = { selectTopMarkets, updateConfig, refreshMarkets };

// CLI entry point
if (require.main === module) {
    refreshMarkets().then(result => {
        if (result) {
            console.log(JSON.stringify(result, null, 2));
        }
    });
}
