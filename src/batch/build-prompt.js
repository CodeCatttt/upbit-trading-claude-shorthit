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

## Adjustable Execution Parameters (via modify)
다음 키들을 \`parameters\` 필드에 포함하여 수정할 수 있습니다:
- \`executionMode\`: \`'market'\` | \`'smart'\` — 실행 모드 전환
- \`smartEntry.entryMethod\`: \`'rsi_dip'\` | \`'pullback'\` | \`'bollinger_touch'\`
- \`smartEntry.rsiThreshold\`: RSI 진입 임계값 (기본 40)
- \`smartEntry.pullbackPct\`: 풀백 진입 % (기본 0.3)
- \`smartEntry.maxWaitMinutes\`: 최대 대기시간 (기본 15)
- \`smartEntry.pollIntervalMs\`: 폴링 간격 ms (기본 15000)
- 기존 전략 파라미터(cooldownCandles, switchThreshold 등)도 동일하게 수정 가능

## Constraints
- The strategy must export: \`DEFAULT_CONFIG\`, \`createStrategyState()\`, \`onNewCandle(state, candleData, config?)\`
- \`candleData\` is a nested object: \`{ 'KRW-BTC': { 15: [...], 240: [...] }, 'KRW-ETH': { 15: [...], 240: [...] }, ... }\`
- Access: \`candleData['KRW-BTC'][15]\` for 15m candles, \`candleData['KRW-BTC'][240]\` for 4h candles
- Each candle array contains: \`{open, high, low, close, volume, timestamp}\`
- \`onNewCandle\` must return one of:
  - \`{ action: 'HOLD', details: { ... } }\`
  - \`{ action: 'NONE', details: { reason: '...' } }\`
  - \`{ action: 'SWITCH', details: { targetMarket: 'KRW-SOL', reason: '...', ... } }\`
- \`createStrategyState()\` must return \`{ assetHeld: 'KRW-BTC' }\`
- \`state.assetHeld\` uses market codes: \`'KRW-BTC'\`, \`'KRW-ETH'\`, \`'CASH'\`, etc.
- DEFAULT_CONFIG must include \`executionMode\` and \`smartEntry\` fields
- You may use any function from indicators.js via \`require('../indicators')\`
- You may use \`require('./custom-indicators')\` for custom indicator functions
- You may use \`require('../utils/adf-test')\` for the ADF test
- Do NOT use any external npm packages beyond what the project already has
- The strategy runs on 15-minute candles (240m candles available for higher-timeframe context)
- Daily trade frequency should stay under 6 trades/day
- Backtest includes 0.1% slippage (0.05% if smart mode) + 0.05% fee per side

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
