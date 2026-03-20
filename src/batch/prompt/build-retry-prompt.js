/**
 * build-retry-prompt.js
 * Builds a focused retry prompt (~10K chars) for failed replace attempts.
 * Includes failure context, gate benchmarks, and targeted fix instructions.
 *
 * Usage:
 *   const { buildRetryPrompt } = require('./build-retry-prompt');
 *   const prompt = buildRetryPrompt({ failedCode, gateResult, currentBacktest, newBacktest, attempt, diagnosis });
 */

'use strict';

const { diagnoseGateFailure } = require('./diagnose-failure');

function buildRetryPrompt({ failedCode, gateResult, currentBacktest, newBacktest, attempt, diagnosis }) {
    // Auto-diagnose if not provided
    if (!diagnosis && gateResult && newBacktest && currentBacktest) {
        diagnosis = diagnoseGateFailure(gateResult, newBacktest, currentBacktest);
    }

    const issuesList = (diagnosis?.issues || [])
        .map(i => `  - [${i.severity.toUpperCase()}] ${i.message}`)
        .join('\n');

    const suggestionsList = (diagnosis?.suggestions || [])
        .map((s, i) => `  ${i + 1}. ${s}`)
        .join('\n');

    const thresholds = diagnosis?.thresholds || { minReturn: -1, maxMddWorsening: 3, maxDailyTrades: 10, minDailyTrades: 0.15 };

    const prompt = `## 재시도 요청 (시도 ${attempt + 1}/3)

이전 replace 시도가 백테스트 게이트에서 실패했습니다.
아래 진단 결과를 참고하여 전략을 수정하세요.

### 실패 진단
${diagnosis?.summary || '진단 정보 없음'}

#### 실패 항목
${issuesList || '  (없음)'}

#### 개선 제안
${suggestionsList || '  (없음)'}

### 게이트 통과 기준 (${diagnosis?.gateType || 'replace'})
- 수익률 차이: >= ${thresholds.minReturn}% (현재 전략 대비)
- MDD 악화: <= ${thresholds.maxMddWorsening}%
- 일일 거래: >= ${thresholds.minDailyTrades || 0.15}회 and <= ${thresholds.maxDailyTrades}회
- **주의**: 거래 0회 전략은 minDailyTrades 게이트에서 자동 탈락합니다.

### 현재 전략 벤치마크
- 수익률: ${currentBacktest?.returnPct?.toFixed(2) ?? 'N/A'}%
- MDD: ${currentBacktest?.maxDrawdown?.toFixed(2) ?? 'N/A'}%
- 일일 거래: ${currentBacktest?.dailyTrades?.toFixed(1) ?? 'N/A'}회

### 이전 시도 결과
- 수익률: ${newBacktest?.returnPct?.toFixed(2) ?? 'N/A'}%
- MDD: ${newBacktest?.maxDrawdown?.toFixed(2) ?? 'N/A'}%
- 일일 거래: ${newBacktest?.dailyTrades?.toFixed(1) ?? 'N/A'}회

### 이전 시도 코드 (실패한 전략)
\`\`\`javascript
${failedCode || '// 코드 없음'}
\`\`\`

### 지시사항
1. **전면 재설계하지 마세요.** 위 코드를 기반으로 실패 항목만 타겟 수정하세요.
2. 수익률이 부족하면: 시그널 민감도 조정, 불필요한 필터 제거를 고려
3. MDD가 심하면: 트레일링 스탑 강화, CASH 전환 조건 추가/강화
4. 거래 빈도가 높으면: 쿨다운 증가, 스위칭 문턱 상향
5. 최대 3개 변형을 제출할 수 있습니다. 각 \`\`\`javascript 블록 첫줄에 \`// VARIANT: 라벨\` 작성.

### 응답 포맷
수정된 전략 코드를 \`\`\`javascript 블록으로, 결정 JSON을 \`\`\`json 블록으로 출력하세요.
JSON의 action은 반드시 "replace"로 설정하세요.
`;

    return prompt;
}

function buildModifyRetryPrompt({ failedParams, gateResult, currentBacktest, newBacktest, attempt, diagnosis }) {
    // Auto-diagnose if not provided
    if (!diagnosis && gateResult && newBacktest && currentBacktest) {
        diagnosis = diagnoseGateFailure(gateResult, newBacktest, currentBacktest);
    }

    const issuesList = (diagnosis?.issues || [])
        .map(i => `  - [${i.severity.toUpperCase()}] ${i.message}`)
        .join('\n');

    const suggestionsList = (diagnosis?.suggestions || [])
        .map((s, i) => `  ${i + 1}. ${s}`)
        .join('\n');

    const thresholds = diagnosis?.thresholds || { minReturn: -1, maxMddWorsening: 3, maxDailyTrades: 10, minDailyTrades: 0.1 };

    const prompt = `## 파라미터 수정 재시도 요청 (시도 ${attempt + 1}/3)

이전 modify 시도가 백테스트 게이트에서 실패했습니다.
아래 진단 결과를 참고하여 다른 파라미터 조합을 제안하세요.

### 실패한 파라미터
\`\`\`json
${JSON.stringify(failedParams, null, 2)}
\`\`\`

### 실패 진단
${diagnosis?.summary || '진단 정보 없음'}

#### 실패 항목
${issuesList || '  (없음)'}

#### 개선 제안
${suggestionsList || '  (없음)'}

### 게이트 통과 기준 (modify)
- 수익률 차이: >= ${thresholds.minReturn}% (현재 전략 대비)
- MDD 악화: <= ${thresholds.maxMddWorsening}%
- 일일 거래: >= ${thresholds.minDailyTrades || 0.1}회 and <= ${thresholds.maxDailyTrades}회

### 현재 전략 벤치마크 (walk-forward TEST 구간)
- 수익률: ${currentBacktest?.returnPct?.toFixed(2) ?? 'N/A'}%
- MDD: ${currentBacktest?.maxDrawdown?.toFixed(2) ?? 'N/A'}%
- 일일 거래: ${currentBacktest?.dailyTrades?.toFixed(1) ?? 'N/A'}회

### 이전 시도 결과
- 수익률: ${newBacktest?.returnPct?.toFixed(2) ?? 'N/A'}%
- MDD: ${newBacktest?.maxDrawdown?.toFixed(2) ?? 'N/A'}%
- 일일 거래: ${newBacktest?.dailyTrades?.toFixed(1) ?? 'N/A'}회

### 지시사항
1. 이전에 실패한 파라미터와는 **다른 값**을 사용하세요.
2. 게이트 기준을 충족하는 보수적인 조정을 우선하세요.
3. 수익률이 악화되었다면: 변경 폭을 줄이거나, 다른 파라미터를 조정하세요.
4. MDD가 악화되었다면: 리스크 파라미터를 더 보수적으로 설정하세요.
5. 거래 빈도가 너무 높다면: 쿨다운/문턱 값을 높이세요.

### 응답 포맷
결정 JSON을 \`\`\`json 블록으로 출력하세요.
action은 반드시 "modify"로, parameters에 새로운 파라미터 조합을 포함하세요.
`;

    return prompt;
}

// Self-test
if (require.main === module) {
    const prompt = buildRetryPrompt({
        failedCode: '// mock strategy code\nmodule.exports = {};',
        gateResult: {
            pass: false,
            gateType: 'replace',
            returnImprovement: -2.5,
            drawdownWorsening: 4.2,
            dailyTrades: 8.3,
        },
        currentBacktest: { returnPct: 3.0, maxDrawdown: 8.0, dailyTrades: 2.1 },
        newBacktest: { returnPct: 0.5, maxDrawdown: 12.2, dailyTrades: 8.3, tradeDays: 30 },
        attempt: 0,
        diagnosis: null,
    });
    console.log(prompt);
    console.log(`\n--- Prompt length: ${prompt.length} chars ---`);
    console.log('--- Self-test passed ---');
}

module.exports = { buildRetryPrompt, buildModifyRetryPrompt };
