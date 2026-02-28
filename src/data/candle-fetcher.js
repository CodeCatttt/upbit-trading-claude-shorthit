/**
 * candle-fetcher.js
 * Fetches historical candle data from Upbit with pagination.
 * Targets: KRW-BTC, KRW-ETH x 15m, 240m — 2000 candles each.
 */

'use strict';

const api = require('../upbit-api');
const store = require('./candle-store');
const { createLogger } = require('../utils/logger');

const log = createLogger('CANDLE-FETCHER');

const TARGETS = [
    { market: 'KRW-BTC', unit: 15 },
    { market: 'KRW-ETH', unit: 15 },
    { market: 'KRW-BTC', unit: 240 },
    { market: 'KRW-ETH', unit: 240 },
];

const MAX_CANDLES = 2000;
const PAGE_SIZE = 200; // Upbit max per request
const RATE_LIMIT_MS = 200; // Be gentle with the API

async function fetchAll(market, unit) {
    const existing = store.getCandles(market, unit);
    const needed = MAX_CANDLES;

    log.info(`Fetching ${market} ${unit}m candles (existing: ${existing.length})`);

    if (existing.length >= MAX_CANDLES - PAGE_SIZE) {
        // Incremental update: just fetch latest
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
    log.info('Starting candle data collection...');
    for (const { market, unit } of TARGETS) {
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
