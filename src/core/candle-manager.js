/**
 * candle-manager.js
 * Real-time candle aggregation from WebSocket trade data.
 * Maintains rolling 1m and 5m candle buffers for each market.
 */

'use strict';

const { createLogger } = require('../utils/logger');

const log = createLogger('CANDLE-MGR');

class CandleManager {
    /**
     * @param {string[]} markets - Market codes to track
     * @param {object} opts
     * @param {number} opts.buffer1m - Number of 1m candles to keep (default 200)
     * @param {number} opts.buffer5m - Number of 5m candles to keep (default 200)
     */
    constructor(markets, opts = {}) {
        this.markets = markets;
        this.buffer1m = opts.buffer1m || 200;
        this.buffer5m = opts.buffer5m || 200;

        // candles[market][interval] = [{ open, high, low, close, volume, timestamp }]
        this.candles = {};
        // Current building candle per market per interval
        this.building = {};

        for (const market of markets) {
            this.candles[market] = { 1: [], 5: [] };
            this.building[market] = { 1: null, 5: null };
        }
    }

    /**
     * Get the candle bucket start time for a given timestamp and interval.
     */
    _getBucketStart(timestampMs, intervalMinutes) {
        const date = new Date(timestampMs);
        const minutes = date.getMinutes();
        const bucketMinutes = Math.floor(minutes / intervalMinutes) * intervalMinutes;
        date.setMinutes(bucketMinutes, 0, 0);
        return date.getTime();
    }

    /**
     * Format timestamp for candle storage (KST).
     */
    _formatTimestamp(timestampMs) {
        const d = new Date(timestampMs + 9 * 60 * 60 * 1000); // UTC+9
        return d.toISOString().replace('Z', '+09:00').slice(0, 19);
    }

    /**
     * Process a trade tick and update candles.
     * @param {string} market
     * @param {number} price
     * @param {number} volume
     * @param {number} timestamp - Unix timestamp in ms
     * @returns {{ closed1m: object|null, closed5m: object|null }} Closed candles if any
     */
    processTrade(market, price, volume, timestamp) {
        if (!this.candles[market]) return { closed1m: null, closed5m: null };

        const result = { closed1m: null, closed5m: null };

        for (const interval of [1, 5]) {
            const bucketStart = this._getBucketStart(timestamp, interval);
            const building = this.building[market][interval];

            if (!building || building._bucketStart !== bucketStart) {
                // New candle bucket — close previous if exists
                if (building) {
                    const closed = {
                        open: building.open,
                        high: building.high,
                        low: building.low,
                        close: building.close,
                        volume: building.volume,
                        timestamp: building.timestamp,
                    };
                    this.candles[market][interval].push(closed);

                    const maxBuffer = interval === 1 ? this.buffer1m : this.buffer5m;
                    if (this.candles[market][interval].length > maxBuffer) {
                        this.candles[market][interval] = this.candles[market][interval].slice(-maxBuffer);
                    }

                    if (interval === 1) result.closed1m = closed;
                    else result.closed5m = closed;
                }

                // Start new candle
                this.building[market][interval] = {
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume: volume,
                    timestamp: this._formatTimestamp(bucketStart),
                    _bucketStart: bucketStart,
                };
            } else {
                // Update current building candle
                building.high = Math.max(building.high, price);
                building.low = Math.min(building.low, price);
                building.close = price;
                building.volume += volume;
            }
        }

        return result;
    }

    /**
     * Get completed candles for a market and interval.
     * Optionally includes the current building candle.
     */
    getCandles(market, interval, includeBuilding = true) {
        if (!this.candles[market] || !this.candles[market][interval]) return [];

        const completed = this.candles[market][interval];
        if (!includeBuilding) return [...completed];

        const building = this.building[market][interval];
        if (building) {
            return [...completed, {
                open: building.open,
                high: building.high,
                low: building.low,
                close: building.close,
                volume: building.volume,
                timestamp: building.timestamp,
            }];
        }
        return [...completed];
    }

    /**
     * Seed candles from API data (for initial startup).
     */
    seedCandles(market, interval, candles) {
        if (!this.candles[market]) {
            this.candles[market] = { 1: [], 5: [] };
            this.building[market] = { 1: null, 5: null };
        }
        this.candles[market][interval] = candles.slice();
        log.info(`Seeded ${candles.length} ${interval}m candles for ${market}`);
    }

    /**
     * Get the latest price from building candle.
     */
    getLatestPrice(market) {
        const building = this.building[market] && this.building[market][1];
        if (building) return building.close;
        const candles1m = this.candles[market] && this.candles[market][1];
        if (candles1m && candles1m.length > 0) return candles1m[candles1m.length - 1].close;
        return null;
    }
}

module.exports = { CandleManager };
