/**
 * diagnose-failure.js
 * Analyzes gate failure reasons to provide actionable feedback for retry prompts.
 *
 * Usage:
 *   const { diagnoseGateFailure } = require('./diagnose-failure');
 *   const diagnosis = diagnoseGateFailure(gateResult, newBacktest, currentBacktest);
 */

'use strict';

const GATE_THRESHOLDS = {
    replace: { minReturn: -1, maxMddWorsening: 3, maxDailyTrades: 10, minDailyTrades: 0.15 },
    modify:  { minReturn: -2, maxMddWorsening: 5, maxDailyTrades: 10, minDailyTrades: 0.1 },
};

function diagnoseGateFailure(gateResult, newBacktest, currentBacktest) {
    const issues = [];
    const suggestions = [];
    const gate = GATE_THRESHOLDS[gateResult.gateType || 'replace'];

    // 1. Return deficiency analysis
    if (gateResult.returnImprovement < gate.minReturn) {
        const gap = gate.minReturn - gateResult.returnImprovement;
        const nearMiss = gap < 1;
        issues.push({
            type: 'return',
            severity: nearMiss ? 'minor' : 'major',
            message: `수익률 차이 ${gateResult.returnImprovement.toFixed(2)}% (기준: >= ${gate.minReturn}%, 부족: ${gap.toFixed(2)}%)`,
        });

        if (nearMiss) {
            suggestions.push('수익률이 기준에 근접합니다. 소폭 파라미터 조정으로 통과 가능성이 있습니다.');
        } else {
            suggestions.push('수익률 격차가 큽니다. 시그널 로직 자체를 재검토하세요.');
        }
    }

    // 2. MDD worsening analysis
    if (gateResult.drawdownWorsening > gate.maxMddWorsening) {
        const excess = gateResult.drawdownWorsening - gate.maxMddWorsening;
        issues.push({
            type: 'mdd',
            severity: excess < 2 ? 'minor' : 'major',
            message: `MDD 악화 ${gateResult.drawdownWorsening.toFixed(2)}% (기준: <= ${gate.maxMddWorsening}%, 초과: ${excess.toFixed(2)}%)`,
        });
        suggestions.push('MDD 악화가 심합니다. 트레일링 스탑 강화 또는 CASH 전환 조건을 추가/강화하세요.');
    }

    // 3. Trade frequency analysis
    if (gateResult.dailyTrades > gate.maxDailyTrades) {
        const excess = gateResult.dailyTrades - gate.maxDailyTrades;
        issues.push({
            type: 'trade_frequency',
            severity: excess <= 2 ? 'minor' : 'major',
            message: `일일 거래 ${gateResult.dailyTrades.toFixed(1)}회 (기준: <= ${gate.maxDailyTrades}회)`,
        });

        // Estimate slippage drag from overtrading
        const slippagePerTrade = 0.15; // 0.1% slippage + 0.05% fee per side
        const excessTradesTotal = excess * (newBacktest.tradeDays || 30);
        const slippageDrag = excessTradesTotal * slippagePerTrade * 2; // round-trip
        suggestions.push(
            `과다 거래로 인한 슬리피지/수수료 드래그 추정: ~${slippageDrag.toFixed(1)}%. 쿨다운 기간을 늘리거나 스위칭 문턱을 높이세요.`
        );
    }

    // 4. Insufficient trading activity
    if (gate.minDailyTrades && gateResult.dailyTrades < gate.minDailyTrades) {
        issues.push({
            type: 'trade_insufficient',
            severity: 'major',
            message: `일일 거래 ${gateResult.dailyTrades.toFixed(2)}회 — 최소 기준 ${gate.minDailyTrades}회 미달 (비활성 전략)`,
        });
        suggestions.push(
            '전략이 거래를 거의 하지 않습니다. 쿨다운을 줄이거나 스위칭 문턱을 낮추세요. 비활성 전략은 시장가 대비 알파를 생성할 수 없습니다.'
        );
    }

    // 5. Combined analysis
    const failedCount = issues.length;
    const majorCount = issues.filter(i => i.severity === 'major').length;

    let summary;
    if (failedCount === 0) {
        summary = '게이트 통과 — 진단 불필요.';
    } else if (failedCount === 1 && majorCount === 0) {
        summary = `단일 항목 근소 실패 (${issues[0].type}). 타겟 수정으로 통과 가능성 높음.`;
    } else if (majorCount === 0) {
        summary = `${failedCount}개 항목 근소 실패. 전반적 미세 조정으로 통과 가능.`;
    } else if (majorCount === failedCount) {
        summary = `${failedCount}개 항목 모두 대폭 실패. 전략 접근 방식 자체를 재고하되, 전면 재설계보다는 핵심 문제 하나에 집중하세요.`;
    } else {
        summary = `${failedCount}개 항목 실패 중 ${majorCount}개 심각. 심각한 항목부터 우선 해결하세요.`;
    }

    return {
        issues,
        suggestions,
        summary,
        gateType: gateResult.gateType || 'replace',
        thresholds: gate,
    };
}

// Self-test when run directly
if (require.main === module) {
    // Mock gate failure result
    const mockGateResult = {
        pass: false,
        gateType: 'replace',
        returnImprovement: -2.5,
        drawdownWorsening: 4.2,
        dailyTrades: 8.3,
        reasons: ['FAILED'],
    };
    const mockNewBacktest = { tradeDays: 30, returnPct: -1.5, maxDrawdown: 12 };
    const mockCurrentBacktest = { returnPct: 1.0, maxDrawdown: 7.8 };

    const diagnosis = diagnoseGateFailure(mockGateResult, mockNewBacktest, mockCurrentBacktest);
    console.log(JSON.stringify(diagnosis, null, 2));
    console.log('\n--- Self-test passed ---');
}

module.exports = { diagnoseGateFailure };
