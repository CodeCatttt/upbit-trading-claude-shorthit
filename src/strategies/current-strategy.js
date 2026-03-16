// VARIANT: soft-choppiness
/**
 * adaptive-regime-mt.js — Soft Choppiness Gate
 *
 * Core structural fix: Replace hard isChoppy gate in shouldSwitch with
 * continuous choppiness penalty on switch threshold. In choppy markets,
 * a proportionally larger score advantage is required to switch, but
 * sufficiently strong opportunities can still pass through.
 *
 * Changes from previous version:
 * - shouldSwitch: !bestScore.isChoppy removed, replaced with dynamic threshold
 * - switchThreshold 0.04 (lowered, compensated by choppiness penalty)
 * - adxMinTrend 5 (relaxed for low-volatility environments)
 * - New params: choppinessBase 0.45, choppinessPenalty 1.5
 */

'use strict';

const { calcEMASeries, calcRSI, calcBollingerBands, calcATR, calcADX, calcStochastic, calcMACD } = require('../core/indicators');

const DEFAULT_CONFIG = {
    // 4h trend scoring
    trendLookback: 72,
    emaFast: 9,
    emaSlow: 26,
    rsiPeriod: 14,
    choppinessPeriod: 20,
    choppinessThreshold: 0.62,
    switchThreshold: 0.01,
    adxPeriod: 14,
    adxMinTrend: 3,

    // Soft choppiness for switching
    choppinessBase: 0.7,
    choppinessPenalty: 0.3,

    // Adaptive cooldown (15m candles)
    cooldownTrending: 12,
    cooldownChoppy: 96,
    opportunityOverrideMultiplier: 1.15,

    // Risk management — CASH conversion
    trailingStopPct: 0.045,
    crashWindowCandles: 96,
    crashThreshold: 0.04,
    riskGracePeriod: 48,

    // Re-entry from CASH (aggressive graduated)
    reentryRsiMin: 35,
    reentryMinScore: 0.005,
    reentryTrendConfirm: false,
    reentryCooldown: 24,
    reentryPhase2Candles: 24,
    maxCashCandles: 72,
    reentryIntensityMin: 0.3,
    reentryStochMax: 92,

    // Scoring weights
    momentumWeight: 0.35,
    trendWeight: 0.35,
    volumeWeight: 0.15,
    bollingerWeight: 0.15,

    executionMode: 'market',
    smartEntry: {
        candleInterval: 5,
        maxWaitMinutes: 15,
        pollIntervalMs: 15000,
        entryMethod: 'rsi_dip',
        rsiThreshold: 40,
        pullbackPct: 0.3,
    },
};

function createStrategyState() {
    return {
        assetHeld: 'KRW-BTC',
        candlesSinceLastTrade: 9999,
        peakPriceSinceEntry: null,
    };
}

function calcChoppiness(candles, period) {
    if (candles.length < period + 1) return null;
    const slice = candles.slice(-(period + 1));

    let trSum = 0;
    for (let i = 1; i < slice.length; i++) {
        trSum += Math.max(
            slice[i].high - slice[i].low,
            Math.abs(slice[i].high - slice[i - 1].close),
            Math.abs(slice[i].low - slice[i - 1].close)
        );
    }

    const hh = Math.max(...slice.map(c => c.high));
    const ll = Math.min(...slice.map(c => c.low));
    const range = hh - ll;
    if (range === 0) return 1;

    return Math.min(1, Math.max(0, Math.log10(trSum / range) / Math.log10(period)));
}

function scoreMarket(candles4h, config) {
    if (!candles4h || candles4h.length < config.trendLookback) return null;

    if (candles4h.length > 200) candles4h = candles4h.slice(-200);

    const choppiness = calcChoppiness(candles4h, config.choppinessPeriod);
    if (choppiness === null) return null;

    const slice = candles4h.slice(-config.trendLookback);
    const totalReturn = (slice[slice.length - 1].close - slice[0].close) / slice[0].close;
    const returns = [];
    for (let i = 1; i < slice.length; i++) {
        returns.push((slice[i].close - slice[i - 1].close) / slice[i - 1].close);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const vol = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
    const sharpe = vol > 0 ? totalReturn / vol : 0;

    const fastEma = calcEMASeries(candles4h, config.emaFast);
    const slowEma = calcEMASeries(candles4h, config.emaSlow);
    const fLast = fastEma[fastEma.length - 1];
    const sLast = slowEma[slowEma.length - 1];
    const price = candles4h[candles4h.length - 1].close;
    const trendCross = (fLast !== null && sLast !== null) ? (fLast - sLast) / price : 0;

    const adxResult = calcADX(candles4h, config.adxPeriod || 14);
    const adxValue = adxResult ? adxResult.adx : 0;
    const adxFactor = Math.min(1, adxValue / 50);
    const trendSignal = trendCross * 100 * adxFactor;

    const volSlice = candles4h.slice(-20);
    let volumeSignal = 0;
    if (volSlice.length >= 15) {
        const recentVol = volSlice.slice(-5).reduce((a, c) => a + c.volume, 0) / 5;
        const olderVol = volSlice.slice(0, 10).reduce((a, c) => a + c.volume, 0) / 10;
        if (olderVol > 0) {
            volumeSignal = Math.max(-1, Math.min(1, recentVol / olderVol - 1));
        }
    }

    const bb = calcBollingerBands(candles4h, 20, 2);
    let bollingerSignal = 0;
    if (bb) {
        const range = bb.upper - bb.lower;
        if (range > 0) {
            const percentB = (price - bb.lower) / range;
            bollingerSignal = percentB < 0.5
                ? (0.5 - percentB) * 2
                : -(percentB - 0.5) * 0.5;
        }
    }

    const rsi = calcRSI(candles4h, config.rsiPeriod);
    const stoch = calcStochastic(candles4h, 14, 3);

    const score =
        sharpe * config.momentumWeight +
        trendSignal * config.trendWeight +
        volumeSignal * config.volumeWeight +
        bollingerSignal * config.bollingerWeight;

    return {
        score,
        choppiness,
        isChoppy: choppiness > config.choppinessThreshold,
        totalReturn,
        sharpe,
        trendCross,
        trendSignal: +trendSignal.toFixed(4),
        adx: adxValue,
        volumeSignal: +volumeSignal.toFixed(4),
        bollingerSignal: +bollingerSignal.toFixed(4),
        rsi,
        stochK: stoch ? stoch.k : null,
    };
}

function getAdaptiveCooldown(scores, config) {
    const choppyValues = Object.values(scores)
        .map(s => s.choppiness)
        .filter(c => c !== null);
    if (choppyValues.length === 0) return config.cooldownChoppy;

    const avgChoppiness = choppyValues.reduce((a, b) => a + b, 0) / choppyValues.length;
    const t = Math.min(1, Math.max(0, (avgChoppiness - 0.3) / 0.3));
    return Math.round(config.cooldownTrending + t * (config.cooldownChoppy - config.cooldownTrending));
}

function checkCrashSignal(candles15m, config) {
    if (!candles15m || candles15m.length < config.crashWindowCandles) return null;

    const window = candles15m.slice(-config.crashWindowCandles);
    const highInWindow = Math.max(...window.map(c => c.high));
    const currentPrice = window[window.length - 1].close;
    const drawdown = (currentPrice - highInWindow) / highInWindow;

    if (drawdown < -config.crashThreshold) {
        return { triggered: true, drawdown };
    }
    return null;
}

function checkTrailingStop(state, currentPrice, config) {
    if (!state.peakPriceSinceEntry) return null;

    const drawdown = (currentPrice - state.peakPriceSinceEntry) / state.peakPriceSinceEntry;
    if (drawdown < -config.trailingStopPct) {
        return { triggered: true, drawdown };
    }
    return null;
}

function checkReentry(state, candleData, markets, config) {
    const candles4hKey = markets.map(m => {
        const c = candleData[m] && candleData[m][240];
        if (!c || c.length === 0) return '0';
        return `${c.length}:${c[c.length - 1].timestamp}`;
    }).join(',') + `|${config.trendLookback},${config.emaFast},${config.emaSlow},${config.rsiPeriod},${config.choppinessPeriod},${config.choppinessThreshold},${config.adxPeriod},${config.momentumWeight},${config.trendWeight},${config.volumeWeight},${config.bollingerWeight}`;
    let scores;
    if (state._cachedScoresKey === candles4hKey && state._cachedScores) {
        scores = state._cachedScores;
    } else {
        scores = {};
        for (const market of markets) {
            const candles4h = candleData[market] && candleData[market][240];
            const result = scoreMarket(candles4h, config);
            if (result) scores[market] = result;
        }
        state._cachedScoresKey = candles4hKey;
        state._cachedScores = scores;
    }

    const scoredMarkets = Object.keys(scores);
    if (scoredMarkets.length === 0) {
        return { action: 'NONE', details: { reason: 'no_scoreable_markets' } };
    }

    const cashAge = state.candlesSinceLastTrade;
    const phase1 = config.reentryCooldown || 48;
    const phase2 = config.reentryPhase2Candles || 72;
    const phase3 = config.maxCashCandles || 144;

    let reentryPhase = 0;
    if (cashAge >= phase3) reentryPhase = 3;
    else if (cashAge >= phase2) reentryPhase = 2;
    else if (cashAge >= phase1) reentryPhase = 1;

    let rsiMin, scoreMin, ignoreChoppy, adxMin, intensityMin;
    switch (reentryPhase) {
        case 3:
            rsiMin = 20;
            scoreMin = -1.0;
            ignoreChoppy = true;
            adxMin = 0;
            intensityMin = 0.1;
            break;
        case 2:
            rsiMin = 30;
            scoreMin = -0.05;
            ignoreChoppy = true;
            adxMin = 5;
            intensityMin = 0.15;
            break;
        case 1:
            rsiMin = config.reentryRsiMin;
            scoreMin = config.reentryMinScore;
            ignoreChoppy = false;
            adxMin = config.adxMinTrend || 20;
            intensityMin = config.reentryIntensityMin || 0.3;
            break;
        default:
            break;
    }

    const summary = {};
    for (const m of scoredMarkets) {
        summary[m] = {
            score: +scores[m].score.toFixed(4),
            ret: +(scores[m].totalReturn * 100).toFixed(2),
            choppy: scores[m].isChoppy,
            adx: scores[m].adx ? +scores[m].adx.toFixed(1) : null,
            stochK: scores[m].stochK ? +scores[m].stochK.toFixed(1) : null,
            intensity: candleData[m] && candleData[m]._tradeIntensity,
        };
    }

    if (reentryPhase === 0) {
        return {
            action: 'HOLD',
            details: {
                asset: 'CASH',
                reason: 'cooldown',
                cashAge,
                cooldownRemaining: phase1 - cashAge,
                reentryPhase,
                scores: summary,
            },
        };
    }

    const eligibleMarkets = scoredMarkets.filter(m => {
        const intensity = candleData[m] && candleData[m]._tradeIntensity;
        return intensity == null || intensity >= intensityMin;
    });

    if (eligibleMarkets.length === 0) {
        return {
            action: 'HOLD',
            details: {
                asset: 'CASH',
                reason: 'all_markets_low_intensity',
                threshold: intensityMin,
                reentryPhase,
                scores: summary,
            },
        };
    }

    const best = eligibleMarkets.reduce((a, b) => scores[a].score > scores[b].score ? a : b);
    const bestScore = scores[best];

    const stochOk = bestScore.stochK == null || bestScore.stochK < (config.reentryStochMax || 85);
    const choppyOk = ignoreChoppy || !bestScore.isChoppy;
    const adxOk = bestScore.adx == null || bestScore.adx >= adxMin;

    const canReenter =
        stochOk &&
        choppyOk &&
        adxOk &&
        bestScore.rsi !== null && bestScore.rsi > rsiMin &&
        bestScore.score > scoreMin &&
        (!config.reentryTrendConfirm || bestScore.trendCross > 0);

    if (canReenter) {
        state.assetHeld = best;
        state.candlesSinceLastTrade = 0;
        state.peakPriceSinceEntry = null;
        return {
            action: 'SWITCH',
            details: {
                targetMarket: best,
                reason: reentryPhase === 3 ? 'forced_reentry' :
                        reentryPhase === 2 ? 'relaxed_reentry' : 'reentry_from_cash',
                reentryPhase,
                score: +bestScore.score.toFixed(4),
                rsi: +bestScore.rsi.toFixed(1),
                adx: bestScore.adx ? +bestScore.adx.toFixed(1) : null,
                stochK: bestScore.stochK ? +bestScore.stochK.toFixed(1) : null,
                scores: summary,
            },
        };
    }

    return {
        action: 'HOLD',
        details: {
            asset: 'CASH',
            reason: 'reentry_conditions_not_met',
            reentryPhase,
            bestMarket: best,
            bestScore: +bestScore.score.toFixed(4),
            rsi: bestScore.rsi !== null ? +bestScore.rsi.toFixed(1) : null,
            adx: bestScore.adx ? +bestScore.adx.toFixed(1) : null,
            stochK: bestScore.stochK ? +bestScore.stochK.toFixed(1) : null,
            choppy: bestScore.isChoppy,
            choppyOk,
            trendCross: +bestScore.trendCross.toFixed(4),
            intensity: candleData[best] && candleData[best]._tradeIntensity,
            stochOk,
            adxOk,
            cashAge,
            thresholds: { rsiMin, scoreMin, ignoreChoppy, adxMin },
            scores: summary,
        },
    };
}

function onNewCandle(state, candleData, config = DEFAULT_CONFIG) {
    if (state.candlesSinceLastTrade === undefined) state.candlesSinceLastTrade = 9999;
    const currentCandlesSince = state.candlesSinceLastTrade;
    state.candlesSinceLastTrade = currentCandlesSince + 1;

    const markets = Object.keys(candleData);
    if (markets.length < 2) {
        return { action: 'NONE', details: { reason: 'insufficient_markets' } };
    }

    // === CASH STATE: check re-entry ===
    if (state.assetHeld === 'CASH') {
        return checkReentry(state, candleData, markets, config);
    }

    const currentAsset = state.assetHeld;
    const candles15 = candleData[currentAsset] && candleData[currentAsset][15];
    const currentPrice = candles15 && candles15.length > 0
        ? candles15[candles15.length - 1].close
        : null;

    if (currentPrice !== null) {
        if (!state.peakPriceSinceEntry || currentPrice > state.peakPriceSinceEntry) {
            state.peakPriceSinceEntry = currentPrice;
        }
    }

    // === RISK CHECKS (skip during grace period) ===
    const gracePeriod = config.riskGracePeriod || 48;
    const pastGracePeriod = state.candlesSinceLastTrade > gracePeriod;

    if (pastGracePeriod) {
        const crash = checkCrashSignal(candles15, config);
        if (crash && crash.triggered) {
            state.assetHeld = 'CASH';
            state.candlesSinceLastTrade = 0;
            state.peakPriceSinceEntry = null;
            return {
                action: 'SWITCH',
                details: {
                    targetMarket: 'CASH',
                    reason: 'crash_detected',
                    drawdown: +(crash.drawdown * 100).toFixed(2),
                },
            };
        }

        if (currentPrice !== null) {
            const trailing = checkTrailingStop(state, currentPrice, config);
            if (trailing && trailing.triggered) {
                const peakBeforeReset = state.peakPriceSinceEntry;
                state.assetHeld = 'CASH';
                state.candlesSinceLastTrade = 0;
                state.peakPriceSinceEntry = null;
                return {
                    action: 'SWITCH',
                    details: {
                        targetMarket: 'CASH',
                        reason: 'trailing_stop',
                        drawdown: +(trailing.drawdown * 100).toFixed(2),
                        peak: peakBeforeReset,
                    },
                };
            }
        }
    }

    // === TREND SCORING + SWITCH (4h) ===
    const candles4hKey = markets.map(m => {
        const c = candleData[m] && candleData[m][240];
        if (!c || c.length === 0) return '0';
        return `${c.length}:${c[c.length - 1].timestamp}`;
    }).join(',') + `|${config.trendLookback},${config.emaFast},${config.emaSlow},${config.rsiPeriod},${config.choppinessPeriod},${config.choppinessThreshold},${config.adxPeriod},${config.momentumWeight},${config.trendWeight},${config.volumeWeight},${config.bollingerWeight}`;
    let scores;
    if (state._cachedScoresKey === candles4hKey && state._cachedScores) {
        scores = state._cachedScores;
    } else {
        scores = {};
        for (const market of markets) {
            const candles4h = candleData[market] && candleData[market][240];
            const result = scoreMarket(candles4h, config);
            if (result) scores[market] = result;
        }
        state._cachedScoresKey = candles4hKey;
        state._cachedScores = scores;
    }

    const scoredMarkets = Object.keys(scores);
    if (scoredMarkets.length === 0) {
        return { action: 'NONE', details: { reason: 'no_scoreable_markets' } };
    }

    const adaptiveCooldown = getAdaptiveCooldown(scores, config);
    const inCooldown = state.candlesSinceLastTrade < adaptiveCooldown;

    const best = scoredMarkets.reduce((a, b) => scores[a].score > scores[b].score ? a : b);
    const currentScore = scores[currentAsset];
    const bestScore = scores[best];
    const advantage = bestScore.score - (currentScore ? currentScore.score : -Infinity);

    const summary = {};
    for (const m of scoredMarkets) {
        summary[m] = {
            score: +scores[m].score.toFixed(4),
            ret: +(scores[m].totalReturn * 100).toFixed(2),
            choppy: scores[m].isChoppy,
            choppiness: +scores[m].choppiness.toFixed(3),
            adx: scores[m].adx ? +scores[m].adx.toFixed(1) : null,
            vol: scores[m].volumeSignal,
        };
    }

    // === SOFT CHOPPINESS: continuous penalty on switch threshold ===
    const choppinessBase = config.choppinessBase || 0.45;
    const choppinessPenaltyFactor = config.choppinessPenalty || 1.5;
    const bestChoppiness = bestScore.choppiness || 0;
    const choppinessMult = bestChoppiness > choppinessBase
        ? 1 + (bestChoppiness - choppinessBase) * choppinessPenaltyFactor
        : 1;
    const effectiveThreshold = config.switchThreshold * choppinessMult;

    const opportunityOverride = inCooldown &&
        advantage > effectiveThreshold * (config.opportunityOverrideMultiplier || 1.5);
    const shouldSwitch =
        (!inCooldown || opportunityOverride) &&
        best !== currentAsset &&
        advantage > effectiveThreshold &&
        (bestScore.adx == null || bestScore.adx >= (config.adxMinTrend || 20));

    if (shouldSwitch) {
        state.assetHeld = best;
        state.candlesSinceLastTrade = 0;
        state.peakPriceSinceEntry = null;
        return {
            action: 'SWITCH',
            details: {
                targetMarket: best,
                reason: opportunityOverride ? 'opportunity_override' : 'trend_advantage',
                advantage: +advantage.toFixed(4),
                effectiveThreshold: +effectiveThreshold.toFixed(4),
                choppinessMult: +choppinessMult.toFixed(3),
                adx: bestScore.adx ? +bestScore.adx.toFixed(1) : null,
                adaptiveCooldown,
                opportunityOverride,
                scores: summary,
            },
        };
    }

    return {
        action: 'HOLD',
        details: {
            asset: currentAsset,
            scores: summary,
            bestMarket: best,
            advantage: +advantage.toFixed(4),
            effectiveThreshold: +effectiveThreshold.toFixed(4),
            choppinessMult: +choppinessMult.toFixed(3),
            inCooldown,
            adaptiveCooldown,
            opportunityOverride,
            peakPrice: state.peakPriceSinceEntry,
            currentPrice,
        },
    };
}

module.exports = { DEFAULT_CONFIG, createStrategyState, onNewCandle };
