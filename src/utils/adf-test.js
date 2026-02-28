/**
 * adf-test.js
 * Lightweight Augmented Dickey-Fuller test for stationarity.
 */

'use strict';

function runAdfTest(series, maxLags = 1, significanceLevel = 0.05) {
    if (series.length < maxLags + 3) {
        return { isStationary: false, p_value: 1.0, adfStatistic: 0, error: 'Not enough data' };
    }

    const n = series.length;
    const dy = [];
    const y_prev = [];

    for (let i = 1; i < n; i++) {
        dy.push(series[i] - series[i - 1]);
        y_prev.push(series[i - 1]);
    }

    const Y = [];
    const X_y_prev = [];

    for (let i = maxLags; i < dy.length; i++) {
        Y.push(dy[i]);
        X_y_prev.push(y_prev[i]);
    }

    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
    const n_reg = Y.length;

    for (let i = 0; i < n_reg; i++) {
        const x = X_y_prev[i];
        const y = Y[i];
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumXY += x * y;
    }

    const denominator = n_reg * sumXX - sumX * sumX;
    if (denominator === 0) {
        return { isStationary: false, p_value: 1.0, adfStatistic: 0, error: 'Zero variance' };
    }

    const gamma = (n_reg * sumXY - sumX * sumY) / denominator;
    const alpha = (sumY - gamma * sumX) / n_reg;

    let sumResSq = 0;
    for (let i = 0; i < n_reg; i++) {
        const y_pred = alpha + gamma * X_y_prev[i];
        const res = Y[i] - y_pred;
        sumResSq += res * res;
    }

    const s2 = sumResSq / (n_reg - 2);
    const meanX = sumX / n_reg;
    let sumSqDevX = 0;
    for (let i = 0; i < n_reg; i++) {
        sumSqDevX += Math.pow(X_y_prev[i] - meanX, 2);
    }

    const se_gamma = Math.sqrt(s2 / sumSqDevX);
    const adfStatistic = gamma / se_gamma;

    const criticalValues = { '1%': -3.50, '5%': -2.89, '10%': -2.58 };

    let isStationary = false;
    let p_value = 1.0;

    if (adfStatistic < criticalValues['1%']) {
        p_value = 0.01;
        isStationary = true;
    } else if (adfStatistic < criticalValues['5%']) {
        p_value = 0.05;
        isStationary = true;
    } else if (adfStatistic < criticalValues['10%']) {
        p_value = 0.10;
        isStationary = significanceLevel >= 0.10;
    } else {
        p_value = 0.50;
        isStationary = false;
    }

    return { isStationary, p_value, adfStatistic, criticalValues, gamma };
}

module.exports = { runAdfTest };
