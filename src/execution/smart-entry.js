/**
 * smart-entry.js
 * Smart execution module for SWITCH signals.
 * Sells immediately, then monitors short-term candles for optimal buy entry.
 * Falls back to market order after maxWaitMinutes.
 */

'use strict';

const api = require('../core/upbit-api');
const { calcRSI, calcBollingerBands } = require('../core/indicators');
const { createLogger } = require('../utils/logger');

const log = createLogger('SMART-ENTRY');

/**
 * Check if entry condition is met based on the configured method.
 * Uses real 1-minute candles from API for indicator-based methods.
 */
async function checkEntryCondition(method, priceHistory, signalPrice, config, targetMarket) {
    if (priceHistory.length < 2) return false;

    const currentPrice = priceHistory[priceHistory.length - 1].price;

    if (method === 'pullback') {
        const dropPct = ((signalPrice - currentPrice) / signalPrice) * 100;
        return dropPct >= config.pullbackPct;
    }

    if (method === 'rsi_dip') {
        // Fetch 30 candles for accurate RSI-14 (Wilder smoothing needs ~2x period)
        const candles = await api.getCandles(targetMarket, 1, 30);
        if (!candles || candles.length < 15) return false;
        const rsi = calcRSI(candles, 14);
        if (rsi === null) return false;
        return rsi <= config.rsiThreshold;
    }

    if (method === 'bollinger_touch') {
        // Fetch real 1-minute candles for Bollinger Bands
        const candles = await api.getCandles(targetMarket, 1, 21);
        if (!candles || candles.length < 21) return false;
        const bb = calcBollingerBands(candles, 20, 2);
        if (!bb) return false;
        return currentPrice <= bb.lower;
    }

    return false;
}

/**
 * Execute smart entry for a target market.
 * Polls price at intervals, buys when entry condition is met or timeout occurs.
 *
 * @param {string} targetMarket - Market to buy (e.g. 'KRW-BTC')
 * @param {number} krwBalance - Available KRW for buying
 * @param {object} config - smartEntry config from DEFAULT_CONFIG
 * @param {number} tradeRatio - Fraction of balance to use (e.g. 0.995)
 * @param {number} minOrderKrw - Minimum order amount
 * @returns {object} { executed, method, priceAtSignal, executionPrice, improvement, waitedMs }
 */
async function executeSmartEntry(targetMarket, krwBalance, config, tradeRatio = 0.995, minOrderKrw = 5500) {
    const startTime = Date.now();
    const maxWaitMs = config.maxWaitMinutes * 60 * 1000;
    const method = config.entryMethod || 'rsi_dip';

    // Get initial price at signal time
    const signalPrice = await api.getCurrentPrice(targetMarket);
    if (!signalPrice) {
        log.error(`Failed to get signal price for ${targetMarket}`);
        return { executed: false, method, priceAtSignal: 0, executionPrice: 0, improvement: 0, waitedMs: 0 };
    }

    log.info(`Smart entry started: ${targetMarket}, method=${method}, signalPrice=${signalPrice}`);

    const priceHistory = [{ price: signalPrice, ts: startTime }];

    // Poll loop
    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, config.pollIntervalMs || 15000));

        const currentPrice = await api.getCurrentPrice(targetMarket);
        if (!currentPrice) continue;

        priceHistory.push({ price: currentPrice, ts: Date.now() });

        const conditionMet = await checkEntryCondition(method, priceHistory, signalPrice, config, targetMarket);

        if (conditionMet) {
            log.info(`Entry condition met: ${method}, price=${currentPrice} (signal=${signalPrice})`);
            const buyAmount = Math.floor(krwBalance * tradeRatio);
            if (buyAmount < minOrderKrw) {
                log.error(`Insufficient KRW for smart entry: ${buyAmount}`);
                return { executed: false, method, priceAtSignal: signalPrice, executionPrice: 0, improvement: 0, waitedMs: Date.now() - startTime };
            }

            const buyResult = await api.buyMarketOrder(targetMarket, buyAmount);
            if (!buyResult) {
                log.error(`Smart entry buy failed for ${targetMarket}`);
                return { executed: false, method, priceAtSignal: signalPrice, executionPrice: currentPrice, improvement: 0, waitedMs: Date.now() - startTime };
            }
            const improvement = ((signalPrice - currentPrice) / signalPrice) * 100;
            return {
                executed: true,
                method,
                priceAtSignal: signalPrice,
                executionPrice: currentPrice,
                improvement: +improvement.toFixed(4),
                waitedMs: Date.now() - startTime,
            };
        }
    }

    // Timeout: fallback to market order
    log.info(`Smart entry timeout after ${maxWaitMs}ms, executing market order`);
    const finalPrice = await api.getCurrentPrice(targetMarket);
    const buyAmount = Math.floor(krwBalance * tradeRatio);

    if (buyAmount < minOrderKrw) {
        log.error(`Insufficient KRW for fallback order: ${buyAmount}`);
        return { executed: false, method: 'timeout', priceAtSignal: signalPrice, executionPrice: 0, improvement: 0, waitedMs: Date.now() - startTime };
    }

    const buyResult = await api.buyMarketOrder(targetMarket, buyAmount);
    if (!buyResult) {
        log.error(`Fallback buy failed for ${targetMarket}`);
        return { executed: false, method: 'timeout', priceAtSignal: signalPrice, executionPrice: finalPrice || 0, improvement: 0, waitedMs: Date.now() - startTime };
    }
    const improvement = finalPrice ? ((signalPrice - finalPrice) / signalPrice) * 100 : 0;

    return {
        executed: true,
        method: 'timeout',
        priceAtSignal: signalPrice,
        executionPrice: finalPrice || signalPrice,
        improvement: +improvement.toFixed(4),
        waitedMs: Date.now() - startTime,
    };
}

module.exports = { executeSmartEntry };
