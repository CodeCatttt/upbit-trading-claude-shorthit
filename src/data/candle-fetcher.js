/**
 * candle-fetcher.js
 * Fetches historical candle data from Upbit with pagination.
 * Reads markets and intervals from trading-config.json for dynamic multi-asset support.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const api = require('../core/upbit-api');
const store = require('./candle-store');
const { createLogger } = require('../utils/logger');

const log = createLogger('CANDLE-FETCHER');

const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');

const MAX_CANDLES = 10000;
const PAGE_SIZE = 200; // Upbit max per request
const RATE_LIMIT_MS = 200; // Be gentle with the API

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        log.warn('Failed to load trading-config.json, using defaults');
        return {
            markets: ['KRW-BTC', 'KRW-ETH'],
            candleIntervals: [15, 240],
        };
    }
}

function buildTargets(config) {
    const targets = [];
    for (const market of config.markets) {
        for (const unit of config.candleIntervals) {
            targets.push({ market, unit });
        }
    }
    return targets;
}

async function fetchAll(market, unit) {
    const existing = store.getCandles(market, unit);
    const needed = MAX_CANDLES;

    log.info(`Fetching ${market} ${unit}m candles (existing: ${existing.length})`);

    if (existing.length >= PAGE_SIZE) {
        // Incremental update: already have data, just fetch latest page and merge
        const latest = await api.getCandles(market, unit, PAGE_SIZE);
        if (latest.length > 0) {
            const merged = store.appendCandles(market, unit, latest, MAX_CANDLES);
            log.info(`Incremental update: ${market} ${unit}m now has ${merged.length} candles`);
        }
        return;
    }

    // Full fetch with pagination
    let allCandles = [...existing];
    let to = null;
    let fetched = 0;

    while (fetched < needed) {
        const batch = await api.getCandlesPaginated(market, unit, PAGE_SIZE, to);
        if (batch.length === 0) break;

        allCandles = store.merge(allCandles, batch);
        fetched += batch.length;

        // Set 'to' parameter to oldest candle's timestamp for next page
        const oldest = batch[0];
        if (!oldest || !oldest.timestamp) break;
        to = oldest.timestamp.replace(' ', 'T');

        log.info(`  ${market} ${unit}m: fetched ${fetched}/${needed} (total: ${allCandles.length})`);

        if (batch.length < PAGE_SIZE) break; // No more data
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    const trimmed = allCandles.slice(-MAX_CANDLES);
    store.save(market, unit, trimmed);
    log.info(`Done: ${market} ${unit}m saved ${trimmed.length} candles`);
}

async function main() {
    const config = loadTradingConfig();
    const targets = buildTargets(config);

    log.info(`Starting candle data collection for ${config.markets.length} markets x ${config.candleIntervals.length} intervals = ${targets.length} targets`);

    for (const { market, unit } of targets) {
        await fetchAll(market, unit);
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }
    log.info('Candle collection complete.');
}

if (require.main === module) {
    main().catch(e => {
        log.error('Fatal error:', e.message);
        process.exit(1);
    });
}

module.exports = { fetchAll, main };
