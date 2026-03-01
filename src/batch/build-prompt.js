/**
 * build-prompt.js
 * Assembles the Claude analysis prompt from collected metrics.
 * Multi-asset support with market management, enhanced metrics display.
 * Reads the latest metrics file and current strategy, outputs prompt to stdout.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('BUILD-PROMPT');

const METRICS_DIR = path.join(__dirname, '../../data/metrics');
const DEPLOY_LOG = path.join(__dirname, '../../deploy-log.json');
const INDICATORS_FILE = path.join(__dirname, '../indicators.js');
const CUSTOM_INDICATORS_FILE = path.join(__dirname, '../strategies/custom-indicators.js');
const BACKTEST_DIR = path.join(__dirname, '../../data/backtest-results');
const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');
const MEMORY_FILE = path.join(__dirname, '../../data/batch-memory.json');

function getLatestMetrics() {
    if (!fs.existsSync(METRICS_DIR)) return null;
    const files = fs.readdirSync(METRICS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort();
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(METRICS_DIR, files[files.length - 1]), 'utf8'));
}

function loadTradingConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return { markets: ['KRW-BTC', 'KRW-ETH'] };
    }
}

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        }
    } catch {}
    return { entries: [], strategicNotes: '' };
}

function loadCustomIndicators() {
    try {
        if (fs.existsSync(CUSTOM_INDICATORS_FILE)) {
            return fs.readFileSync(CUSTOM_INDICATORS_FILE, 'utf8');
        }
    } catch {}
    return null;
}

function getBenchmarkComparison() {
    const BACKTEST_DIR_LOCAL = path.join(__dirname, '../../data/backtest-results');
    if (!fs.existsSync(BACKTEST_DIR_LOCAL)) return null;
    const files = fs.readdirSync(BACKTEST_DIR_LOCAL).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return null;

    try {
        const latest = JSON.parse(fs.readFileSync(path.join(BACKTEST_DIR_LOCAL, files[files.length - 1]), 'utf8'));
        const result = latest.result || latest.test || latest;
        if (!result || !result.benchmarks || result.returnPct === undefined) return null;

        const btcBenchmark = result.benchmarks['KRW-BTC'];
        if (btcBenchmark === undefined) return null;

        const diff = result.returnPct - btcBenchmark;
        return { strategyReturn: result.returnPct, btcReturn: btcBenchmark, diff };
    } catch { return null; }
}

function getInnovationNudge(memory) {
    const lines = [];
    const entries = memory.entries || [];
    if (entries.length === 0) return '';

    // Check KEEP ratio in last 10 entries
    const recent = entries.slice(-10);
    const keepCount = recent.filter(e => e.action === 'keep').length;
    const keepRatio = keepCount / recent.length;

    if (keepRatio >= 0.6) {
        lines.push(`- 최근 ${recent.length}회 배치 중 ${keepCount}회(${(keepRatio * 100).toFixed(0)}%)가 KEEP입니다. 현재 전략이 정체되어 있을 수 있으니 과감한 변경을 고려하세요.`);
    }

    // Check backtest failure streak
    const failCount = recent.filter(e => e.outcome === 'backtest_failed' || e.outcome === 'gate_failed').length;
    if (failCount >= 2) {
        lines.push(`- 최근 백테스트/게이트 실패 ${failCount}회. 완화된 게이트 기준: replace(수익률 차이 >= -1%, MDD 악화 <= 3%), modify(수익률 차이 >= -2%, MDD 악화 <= 5%). 기존보다 통과 가능성이 높습니다.`);
    }

    return lines.length > 0 ? lines.join('\n') : '';
}

function buildPrompt() {
    const metrics = getLatestMetrics();
    if (!metrics) {
        log.error('No metrics file found.');
        process.exit(1);
    }

    const deployLog = fs.existsSync(DEPLOY_LOG)
        ? JSON.parse(fs.readFileSync(DEPLOY_LOG, 'utf8'))
        : [];

    const indicatorsSource = fs.readFileSync(INDICATORS_FILE, 'utf8');
    const tradingConfig = loadTradingConfig();
    const memory = loadMemory();
    const customIndicatorsSource = loadCustomIndicators();

    // Extract available indicator function names
    const indicatorExports = indicatorsSource.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    const availableIndicators = indicatorExports
        ? indicatorExports[1].split(',').map(s => s.trim()).filter(Boolean)
        : [];

    // Build market data section
    const marketSection = Object.entries(metrics.market || {})
        .map(([market, data]) => {
            const priceStr = data.price ? data.price.toLocaleString() : 'N/A';
            const changeStr = data.change24h !== null ? `${data.change24h > 0 ? '+' : ''}${data.change24h}%` : 'N/A';
            return `- ${market}: ${priceStr} KRW (24h: ${changeStr})`;
        })
        .join('\n');

    // Build enhanced metrics section
    const enhanced = metrics.enhanced || {};
    const enhancedSection = [
        `- Sharpe Ratio: ${enhanced.sharpeRatio !== null ? enhanced.sharpeRatio : 'N/A (insufficient data)'}`,
        `- Win Rate: ${enhanced.winRate ? `${(enhanced.winRate.winRate * 100).toFixed(1)}% (${enhanced.winRate.wins}/${enhanced.winRate.total})` : 'N/A'}`,
        `- Rolling Returns 7d: ${enhanced.rollingReturns?.rolling7d != null ? `${enhanced.rollingReturns.rolling7d}%` : 'N/A'}`,
        `- Rolling Returns 30d: ${enhanced.rollingReturns?.rolling30d != null ? `${enhanced.rollingReturns.rolling30d}%` : 'N/A'}`,
        `- Trade Stats: ${enhanced.tradeStats ? `${enhanced.tradeStats.totalDeploys} deploys, avg hold ${enhanced.tradeStats.avgHoldHours || 'N/A'}h` : 'N/A'}`,
    ].join('\n');

    const prompt = `You are a quantitative trading strategy analyst for a multi-asset trading bot on Upbit (Korean exchange).
The bot holds exactly one asset at a time (100% allocation) and can switch between any watched market.

## Current Portfolio
- Total Value: ${metrics.portfolio.totalValueKrw.toLocaleString()} KRW
- Holdings: ${JSON.stringify(metrics.portfolio.holdings, null, 2)}

## Market Data (Watched Assets)
${marketSection}

## Enhanced Performance Metrics
${enhancedSection}

## Bot Status
- Current State: ${JSON.stringify(metrics.bot.state)}
- Healthy: ${metrics.bot.healthy}
- Heartbeat Age: ${metrics.bot.heartbeatAgeSec}s

## Recent Trades
${JSON.stringify(metrics.recentOrders, null, 2)}

## Current Strategy Source Code
\`\`\`javascript
${metrics.strategy.source}
\`\`\`

## Available Indicators (from indicators.js)
${availableIndicators.join(', ')}

Full indicator module source for reference:
\`\`\`javascript
${indicatorsSource}
\`\`\`

## Recent Deploy History (last 5)
${JSON.stringify(deployLog.slice(-5), null, 2)}

## Batch Decision History
${(() => {
    const recentEntries = memory.entries.slice(-10);
    if (recentEntries.length === 0) return 'No previous batch decisions recorded yet.';
    return recentEntries.map(e =>
        `- [${e.timestamp}] ${e.action} (confidence: ${e.confidence}) → ${e.outcome}${e.notes ? ' | Notes: ' + e.notes : ''}`
    ).join('\n');
})()}
${memory.strategicNotes ? `\n### Strategic Notes (accumulated insights)\n${memory.strategicNotes}` : ''}

## Custom Indicators
${customIndicatorsSource ? '```javascript\n' + customIndicatorsSource + '\n```' : 'No custom indicators defined yet. You can define them using a ```custom-indicators code block.'}

## Recent Backtest Results (last 3)
${(() => {
    if (!fs.existsSync(BACKTEST_DIR)) return 'No backtest results yet.';
    const files = fs.readdirSync(BACKTEST_DIR).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return 'No backtest results yet.';
    return files.slice(-3).map(f => {
        try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(BACKTEST_DIR, f), 'utf8')), null, 2); }
        catch { return ''; }
    }).filter(Boolean).join('\n---\n');
})()}

## Execution Quality
${(() => {
    const eq = metrics.executionQuality;
    if (!eq) return 'No execution data available yet.';
    const lines = [`- Total Executions: ${eq.totalExecutions}`, `- Smart Entries: ${eq.smartEntries}`];
    if (eq.smartEntries > 0) {
        lines.push(`- Smart Success Rate: ${(eq.smartSuccessRate * 100).toFixed(1)}%`);
        lines.push(`- Timeout Rate: ${(eq.timeoutRate * 100).toFixed(1)}%`);
        lines.push(`- Avg Price Improvement: ${eq.avgPriceImprovement}%`);
    }
    return lines.join('\n');
})()}

## Market Regime
${(() => {
    const mr = metrics.marketRegime;
    if (!mr) return 'No market regime data available.';
    return '- Direction: ' + mr.direction + '\n' +
        '- Avg 24h Change: ' + mr.avgChange24h + '%\n' +
        '- Asset Count: ' + mr.assetCount + '\n' +
        '- Dispersion: ' + mr.dispersion + '% (lower = higher correlation)';
})()}

## Strategy vs Benchmark
${(() => {
    const bench = getBenchmarkComparison();
    if (!bench) return '벤치마크 데이터 없음 (백테스트 결과 필요).';
    const lines = [
        `- 전략 수익률: ${bench.strategyReturn.toFixed(2)}%`,
        `- BTC Buy&Hold: ${bench.btcReturn.toFixed(2)}%`,
        `- 차이: ${bench.diff > 0 ? '+' : ''}${bench.diff.toFixed(2)}%`,
    ];
    if (bench.diff <= -10) {
        lines.push('');
        lines.push('**경고: BTC 대비 10%+ 언더퍼폼. 전략 전면 교체를 적극 고려하세요.**');
    } else if (bench.diff <= -5) {
        lines.push('');
        lines.push('**주의: BTC 대비 5%+ 언더퍼폼. 파라미터 수정 또는 전략 교체를 검토하세요.**');
    }
    return lines.join('\n');
})()}

## Gate Failure History (Recent)
${(() => {
    const failures = (memory.entries || [])
        .filter(e => e.outcome === 'backtest_failed' || e.outcome === 'gate_failed' || e.outcome === 'all_retries_failed')
        .slice(-5);
    if (failures.length === 0) return '최근 게이트 실패 이력 없음.';
    return failures.map(e => {
        const parts = [`- [${e.timestamp}] ${e.action} → ${e.outcome}`];
        if (e.backtestResult) {
            const r = e.backtestResult;
            parts.push(`  수익률 차이: ${r.returnImprovement != null ? r.returnImprovement + '%' : 'N/A'}, MDD 악화: ${r.drawdownWorsening != null ? r.drawdownWorsening + '%' : 'N/A'}, 일일거래: ${r.dailyTrades != null ? r.dailyTrades : 'N/A'}`);
        }
        if (e.diagnosis) parts.push(`  진단: ${e.diagnosis}`);
        if (e.retryAttempts) parts.push(`  시도: ${e.retryAttempts}회, 변형: ${e.variantsTested || 0}개`);
        return parts.join('\n');
    }).join('\n');
})()}

## Multi-Variant Mode
replace 시 최대 3개 변형을 제출할 수 있습니다.
각 \`\`\`javascript 블록 첫줄에 \`// VARIANT: 라벨\` 작성.
모든 변형을 독립 백테스트하여 게이트 통과하는 최고 성과 변형을 배포합니다.
실패 시 자동으로 최대 2회 재시도합니다 (재시도 프롬프트에 실패 진단 포함).

## Innovation Signals
${(() => {
    const nudge = getInnovationNudge(memory);
    return nudge || '현재 특별한 혁신 시그널 없음.';
})()}

## Market Management
현재 관심 종목: ${tradingConfig.markets.join(', ')}
필요하다면 종목을 추가하거나 제거할 수 있습니다.
응답 JSON의 "markets" 필드에 새 종목 리스트를 포함하세요.

Upbit에서 거래 가능한 주요 KRW 마켓 참고:
KRW-BTC, KRW-ETH, KRW-XRP, KRW-SOL, KRW-DOGE, KRW-ADA, KRW-AVAX, KRW-DOT,
KRW-LINK, KRW-MATIC, KRW-ATOM, KRW-TRX, KRW-ETC, KRW-NEAR, KRW-APT,
KRW-ARB, KRW-OP, KRW-SUI, KRW-SEI, KRW-STX, KRW-HBAR

## Your Task — 5영역 종합 분석

아래 5개 영역을 종합적으로 분석한 후, 가장 임팩트 있는 개선점을 선택하세요.

### 1. 전략 로직
시그널 정확도, 타임프레임 활용, 레짐 필터 효과를 점검하세요.

### 2. 실행 최적화
- \`executionMode\`: 현재 \`'market'\` 또는 \`'smart'\`. 스마트 실행이 가격 개선을 보이면 유지/강화, 아니면 market으로 복귀.
- \`smartEntry.*\`: entryMethod, rsiThreshold, pullbackPct, maxWaitMinutes 등 조정 가능.

### 3. 리스크 관리
쿨다운 기간, MDD 한도, 방어 메커니즘(시장 급락 시 현금 전환 등)을 점검하세요.

### 4. 종목 선택
포트폴리오 분산, 자산 간 상관관계, 신규 종목 기회를 평가하세요.

### 5. 시장 환경
현재 레짐(추세/횡보/급변), 거시 전망, 적절한 포지셔닝을 판단하세요.

Choose ONE action:
1. **KEEP** — 현재 전략 유지 (변경 불필요)
2. **MODIFY** — 파라미터 조정 (전략 코드 유지)
3. **REPLACE** — 전략 전면 교체

## Adjustable Parameters (via modify)
다음 키들을 \`parameters\` 필드에 포함하여 수정할 수 있습니다:

**실행 파라미터:**
- \`executionMode\`: \`'market'\` | \`'smart'\`
- \`smartEntry.entryMethod\`: \`'rsi_dip'\` | \`'pullback'\` | \`'bollinger_touch'\`
- \`smartEntry.rsiThreshold\`, \`smartEntry.pullbackPct\`, \`smartEntry.maxWaitMinutes\`, \`smartEntry.pollIntervalMs\`

**리스크 관리 파라미터:**
- \`trailingStopPct\`: 트레일링 스탑 % (기본 0.12 = 12%)
- \`crashThreshold\`: 24h 크래시 감지 % (기본 0.08 = 8%)
- \`crashWindowCandles\`: 크래시 감지 윈도우 (기본 96 = 24h)

**쿨다운 파라미터:**
- \`cooldownTrending\`: 추세장 쿨다운 캔들 수 (기본 288 = 3일)
- \`cooldownChoppy\`: 횡보장 쿨다운 캔들 수 (기본 1344 = 14일)
- \`choppinessThreshold\`: 횡보 판단 임계값 (기본 0.45)

**재진입 파라미터:**
- \`reentryRsiMin\`: CASH 탈출 최소 RSI (기본 45)
- \`reentryMinScore\`: 재진입 최소 스코어 (기본 0.1)
- \`reentryTrendConfirm\`: EMA 골든크로스 필요 여부 (기본 true)

**스코어링 가중치:**
- \`momentumWeight\`: 모멘텀 가중치 (기본 0.45)
- \`trendWeight\`: 추세 가중치 (기본 0.25)
- \`volumeWeight\`: 거래량 가중치 (기본 0.15)
- \`bollingerWeight\`: 볼린저 가중치 (기본 0.15)
- \`switchThreshold\`, \`trendLookback\`, \`emaFast\`, \`emaSlow\`, \`rsiPeriod\`

## Strategy Pattern Library
전략 교체(replace) 시 참고할 수 있는 검증된 패턴입니다.

### CASH 전환 패턴 (트레일링 스탑)
\`\`\`javascript
// state.peakPriceSinceEntry를 매 캔들마다 갱신
// 고점 대비 trailingStopPct 이상 하락 시 CASH 전환
if (currentPrice < state.peakPriceSinceEntry * (1 - config.trailingStopPct)) {
    return { action: 'SWITCH', details: { targetMarket: 'CASH', reason: 'trailing_stop' } };
}
\`\`\`

### 크래시 감지 패턴 (15m)
\`\`\`javascript
// 최근 24h(96캔들) 내 최고가 대비 8%+ 하락 시 즉시 CASH
const window = candles15m.slice(-96);
const high = Math.max(...window.map(c => c.high));
if ((currentPrice - high) / high < -0.08) {
    return { action: 'SWITCH', details: { targetMarket: 'CASH', reason: 'crash_detected' } };
}
\`\`\`

### 스마트 재진입 패턴
\`\`\`javascript
// CASH 상태에서 재진입 조건: RSI > 45 + 추세 확인 + 레짐 비횡보
if (state.assetHeld === 'CASH') {
    const best = findBestMarket(scores);
    if (!best.isChoppy && best.rsi > 45 && best.trendCross > 0 && best.score > 0.1) {
        return { action: 'SWITCH', details: { targetMarket: best.market, reason: 'reentry_from_cash' } };
    }
    return { action: 'HOLD', details: { asset: 'CASH', reason: 'reentry_conditions_not_met' } };
}
\`\`\`

### 적응형 쿨다운 패턴
\`\`\`javascript
// 시장 평균 choppiness로 쿨다운 보간
const avgChoppiness = Object.values(scores).reduce((a,s) => a + s.choppiness, 0) / n;
const t = Math.min(1, Math.max(0, (avgChoppiness - 0.3) / 0.3));
const cooldown = cooldownTrending + t * (cooldownChoppy - cooldownTrending);
\`\`\`

## Constraints
- The strategy must export: \`DEFAULT_CONFIG\`, \`createStrategyState()\`, \`onNewCandle(state, candleData, config?)\`
- \`candleData\` is a nested object: \`{ 'KRW-BTC': { 15: [...], 240: [...] }, 'KRW-ETH': { 15: [...], 240: [...] }, ... }\`
- Access: \`candleData['KRW-BTC'][15]\` for 15m candles, \`candleData['KRW-BTC'][240]\` for 4h candles
- Each candle array contains: \`{open, high, low, close, volume, timestamp}\`
- \`onNewCandle\` must return one of:
  - \`{ action: 'HOLD', details: { ... } }\`
  - \`{ action: 'NONE', details: { reason: '...' } }\`
  - \`{ action: 'SWITCH', details: { targetMarket: 'KRW-SOL', reason: '...', ... } }\`
  - \`{ action: 'SWITCH', details: { targetMarket: 'CASH', reason: '리스크 관리' } }\` — 현금 전환 (하락장 방어)
- \`createStrategyState()\` must return \`{ assetHeld: 'KRW-BTC' }\`
- \`state.assetHeld\` uses market codes: \`'KRW-BTC'\`, \`'KRW-ETH'\`, \`'CASH'\`, etc.
- CASH 전환: targetMarket을 \`'CASH'\`로 설정하면 매도 후 현금 보유. 다음 사이클에서 자동 재진입.
- DEFAULT_CONFIG must include \`executionMode\` and \`smartEntry\` fields
- You may use any function from indicators.js via \`require('../indicators')\`
- You may use \`require('./custom-indicators')\` for custom indicator functions
- You may use \`require('../utils/adf-test')\` for the ADF test
- Do NOT use any external npm packages beyond what the project already has
- The strategy runs on 15-minute candles (240m candles available for higher-timeframe context)
- Daily trade frequency should stay under 6 trades/day
- Backtest includes 0.1% slippage (0.05% if smart mode) + 0.05% fee per side
- **Walk-forward 백테스트**: replace 시 70/30 분할, TEST 구간 기준으로 게이트 평가
- **완화된 게이트 (티어드)**:
  - replace: 수익률 차이 >= -1%, MDD 악화 <= 3%, 일일거래 <= 6
  - modify: 수익률 차이 >= -2%, MDD 악화 <= 5%, 일일거래 <= 6
- 리스크 관리를 위해 CASH 전환을 적극 활용하세요 (하락장 방어)

## Response Format
**모든 응답은 한국어로 작성하세요.**

먼저 5개 영역에 대한 분석과 판단 근거를 평문으로 작성하세요.

그 다음, 결정을 JSON 블록으로 출력하세요:

\`\`\`json
{
  "action": "keep" | "modify" | "replace",
  "reasoning": "한국어로 간단한 사유 설명",
  "confidence": 0.0 to 1.0,
  "parameters": {},
  "markets": ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
  "improvementAreas": ["execution", "risk"],
  "notes": "다음 배치를 위한 메모 (선택사항)",
  "strategicNotes": "누적 전략 인사이트 갱신 (선택사항)"
}
\`\`\`

- \`parameters\`: "modify" 액션일 때만 필수
- \`markets\`: 종목 리스트를 변경하고 싶을 때만 포함 (선택사항)
- \`improvementAreas\`: 이번 분석에서 중점 개선한 영역 (선택사항, e.g. ["strategy", "execution", "risk", "assets", "regime"])
- \`notes\`: 이번 결정에 대한 메모. 다음 배치에 참고됨 (선택사항)
- \`strategicNotes\`: 전략적 인사이트 누적. 기존 내용을 대체함 (선택사항)

If action is "replace", also output the complete new strategy file:

\`\`\`javascript
// Complete strategy file here
\`\`\`

If action is "replace" and you want to define custom indicator functions, output them in a separate block:

\`\`\`custom-indicators
function myIndicator(candles, period) { ... }
module.exports = { myIndicator };
\`\`\`
`;

    return prompt;
}

if (require.main === module) {
    const prompt = buildPrompt();
    process.stdout.write(prompt);
}

module.exports = { buildPrompt };
