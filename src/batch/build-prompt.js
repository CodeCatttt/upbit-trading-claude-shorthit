/**
 * build-prompt.js
 * Assembles the Claude analysis prompt from collected metrics.
 * Trigger-based focused prompts instead of monolithic 25-section dump.
 *
 * Trigger modes:
 *   REGIME_CHANGE  — market regime shift detected → strategy modification focus
 *   DRAWDOWN_ALERT — MDD exceeded threshold → risk management focus
 *   STAGNATION     — no trades for 7+ days → opportunity exploration focus
 *   DAILY_REVIEW   — daily candle close → general review
 *   EXPERIMENT_REVIEW — active experiment evaluation
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('BUILD-PROMPT');

const METRICS_DIR = path.join(__dirname, '../../data/metrics');
const CUSTOM_INDICATORS_FILE = path.join(__dirname, '../strategies/custom-indicators.js');
const CONFIG_FILE = path.join(__dirname, '../../trading-config.json');
const MEMORY_FILE = path.join(__dirname, '../../data/batch-memory.json');
const PERFORMANCE_FILE = path.join(__dirname, '../../data/performance-ledger.json');
const EXPERIMENTS_FILE = path.join(__dirname, '../../data/experiments.json');

// --- Data loaders ---

function getLatestMetrics() {
    if (!fs.existsSync(METRICS_DIR)) return null;
    const files = fs.readdirSync(METRICS_DIR).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    return JSON.parse(fs.readFileSync(path.join(METRICS_DIR, files[files.length - 1]), 'utf8'));
}

function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return fallback;
}

function loadTradingConfig() {
    return loadJSON(CONFIG_FILE, { markets: ['KRW-BTC', 'KRW-ETH'] });
}

function loadMemory() {
    return loadJSON(MEMORY_FILE, { entries: [], knowledge: { confirmed: [], hypotheses: [], rejected: [] } });
}

function loadPerformance() {
    return loadJSON(PERFORMANCE_FILE, { entries: [], summary: null });
}

function loadExperiments() {
    return loadJSON(EXPERIMENTS_FILE, { active: [], completed: [] });
}

function loadCustomIndicators() {
    try {
        if (fs.existsSync(CUSTOM_INDICATORS_FILE)) {
            return fs.readFileSync(CUSTOM_INDICATORS_FILE, 'utf8');
        }
    } catch {}
    return null;
}

// --- Section builders ---

function buildPortfolioSection(metrics) {
    const marketLines = Object.entries(metrics.market || {})
        .map(([market, data]) => {
            const priceStr = data.price ? data.price.toLocaleString() : 'N/A';
            const changeStr = data.change24h !== null ? `${data.change24h > 0 ? '+' : ''}${data.change24h}%` : 'N/A';
            return `- ${market}: ${priceStr} KRW (24h: ${changeStr})`;
        })
        .join('\n');

    return `## Current Portfolio
- Total Value: ${metrics.portfolio.totalValueKrw.toLocaleString()} KRW
- Holdings: ${JSON.stringify(metrics.portfolio.holdings, null, 2)}
- Bot State: ${JSON.stringify(metrics.bot.state)}

## Market Data
${marketLines}`;
}

function buildPerformanceSection(metrics, performance) {
    const lines = [];
    const enhanced = metrics.enhanced || {};

    // Real P&L from performance tracker
    if (performance.summary) {
        const s = performance.summary;
        lines.push('## 실제 수익률 (Performance Tracker)');
        lines.push(`- 총 수익률: ${s.totalReturnPct != null ? s.totalReturnPct + '%' : 'N/A'}`);
        lines.push(`- BTC Buy&Hold: ${s.btcReturnPct != null ? s.btcReturnPct + '%' : 'N/A'}`);
        lines.push(`- 알파: ${s.alphaPct != null ? (s.alphaPct > 0 ? '+' : '') + s.alphaPct + '%' : 'N/A'}`);
        lines.push(`- 최대 MDD: ${s.maxMdd != null ? s.maxMdd + '%' : 'N/A'}`);
        lines.push(`- 총 거래: ${s.totalTrades || 0}회, 승률: ${s.winRate != null ? (s.winRate * 100).toFixed(1) + '%' : 'N/A'}`);
    }

    // Recent 7d/30d entries
    if (performance.entries && performance.entries.length > 0) {
        const recent = performance.entries.slice(-7);
        lines.push('');
        lines.push('### 최근 7일 일별 성과');
        for (const e of recent) {
            lines.push(`- ${e.date}: ${e.portfolioValueKrw.toLocaleString()} KRW, alpha ${e.alpha > 0 ? '+' : ''}${e.alpha}%, MDD ${e.mdd}%`);
        }
    }

    // Enhanced metrics (Sharpe, rolling)
    lines.push('');
    lines.push('### 기술 지표');
    lines.push(`- Sharpe Ratio: ${enhanced.sharpeRatio != null ? enhanced.sharpeRatio : 'N/A'}`);
    lines.push(`- Rolling 7d: ${enhanced.rollingReturns?.rolling7d != null ? enhanced.rollingReturns.rolling7d + '%' : 'N/A'}`);
    lines.push(`- Rolling 30d: ${enhanced.rollingReturns?.rolling30d != null ? enhanced.rollingReturns.rolling30d + '%' : 'N/A'}`);

    return lines.join('\n');
}

function buildKnowledgeSection(memory) {
    const knowledge = memory.knowledge || { confirmed: [], hypotheses: [], rejected: [] };
    const lines = ['## 학습 기록 (Knowledge Base)'];

    if (knowledge.confirmed.length > 0) {
        lines.push('\n### 검증된 사실');
        for (const k of knowledge.confirmed.slice(-5)) {
            lines.push(`- ${k.insight} (근거: ${k.evidence}, ${k.addedAt})`);
        }
    }

    if (knowledge.hypotheses.length > 0) {
        lines.push('\n### 검증 중인 가설');
        for (const h of knowledge.hypotheses) {
            lines.push(`- [${h.status}] ${h.hypothesis}${h.experimentId ? ' (실험: ' + h.experimentId + ')' : ''}`);
        }
    }

    if (knowledge.rejected.length > 0) {
        lines.push('\n### 반증된 가설');
        for (const r of knowledge.rejected.slice(-5)) {
            lines.push(`- ${r.hypothesis} → 반증: ${r.reason} (${r.rejectedAt})`);
        }
    }

    if (lines.length === 1) lines.push('아직 학습 기록 없음.');
    return lines.join('\n');
}

function buildRecentBatchHistory(memory) {
    const recentEntries = memory.entries.slice(-5);
    if (recentEntries.length === 0) return '## 최근 배치 결정\n기록 없음.';

    const lines = ['## 최근 배치 결정 (최신 5건)'];
    for (const e of recentEntries) {
        let line = `- [${e.timestamp}] ${e.action} (confidence: ${e.confidence}) → ${e.outcome}`;
        if (e.notes) line += ` | ${e.notes.slice(0, 100)}...`;
        lines.push(line);
    }

    // Keep streak detection
    let keepStreak = 0;
    for (let i = memory.entries.length - 1; i >= 0; i--) {
        if (memory.entries[i].action === 'keep') keepStreak++;
        else break;
    }

    if (keepStreak >= 10) {
        lines.push('');
        lines.push(`**⚠ KEEP ${keepStreak}회 연속 중** — 전략이 정체되어 있을 수 있습니다.`);
        lines.push('modify, replace, 또는 experiment 액션을 적극 검토하세요.');
        lines.push('현재 전략의 수익률이 BTC buy-and-hold 대비 우수한지 확인하고, 개선 여지가 있다면 변경을 시도하세요.');
    }

    return lines.join('\n');
}

function buildExperimentSection(experiments) {
    const lines = ['## 실험 현황'];
    if (experiments.active.length === 0 && experiments.completed.length === 0) {
        lines.push('진행 중인 실험 없음. 새로운 가설이 있다면 "experiment" 액션으로 제안하세요.');
        lines.push('**shadow_strategy 타입 권장**: 새 전략을 4일간 페이퍼 트레이딩 → alpha >= 2% 시 자동 승격.');
        return lines.join('\n');
    }

    if (experiments.active.length > 0) {
        lines.push('\n### 진행 중');
        for (const exp of experiments.active) {
            lines.push(`- **${exp.id}**: ${exp.hypothesis}`);
            lines.push(`  상태: ${exp.status}, 시작: ${exp.startedAt}`);
            if (exp.results) lines.push(`  결과: ${JSON.stringify(exp.results)}`);
        }
    }

    const recentCompleted = experiments.completed.slice(-3);
    if (recentCompleted.length > 0) {
        lines.push('\n### 최근 완료');
        for (const exp of recentCompleted) {
            lines.push(`- **${exp.id}**: ${exp.hypothesis} → ${exp.outcome || 'N/A'}`);
        }
    }

    return lines.join('\n');
}

function buildStrategySection(metrics) {
    return `## Current Strategy Source Code
\`\`\`javascript
${metrics.strategy.source}
\`\`\``;
}

function buildMarketRegimeSection(metrics) {
    const mr = metrics.marketRegime;
    if (!mr) return '## Market Regime\nNo data available.';
    return `## Market Regime
- Direction: ${mr.direction}
- Avg 24h Change: ${mr.avgChange24h}%
- Asset Count: ${mr.assetCount}
- Dispersion: ${mr.dispersion}% (lower = higher correlation)`;
}

function buildAdditionalMetrics(metrics) {
    const lines = [];

    // Orderbook spread
    if (metrics.orderbookSpread) {
        lines.push('## 호가 스프레드');
        for (const [market, spread] of Object.entries(metrics.orderbookSpread)) {
            lines.push(`- ${market}: ${spread.spreadPct}% (매수 ${spread.bidPrice?.toLocaleString()}, 매도 ${spread.askPrice?.toLocaleString()})`);
        }
    }

    // Trade intensity
    if (metrics.tradeIntensity) {
        lines.push('\n## 체결 강도');
        for (const [market, intensity] of Object.entries(metrics.tradeIntensity)) {
            lines.push(`- ${market}: ${intensity.ratio} (매수 ${intensity.buyVolume}, 매도 ${intensity.sellVolume})`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : '';
}

// --- Trigger-specific focus sections ---

function buildFocusSection(triggerType) {
    const focusMap = {
        REGIME_CHANGE: `## 이번 배치의 초점: 시장 레짐 변화 대응
시장 레짐 변화가 감지되었습니다. 다음에 집중하세요:
1. 현재 레짐(추세/횡보/급변)에 적합한 전략인가?
2. 파라미터 수정으로 적응 가능한가, 전략 교체가 필요한가?
3. 포지션 변경이 필요한가? (현금 전환 포함)`,

        DRAWDOWN_ALERT: `## 이번 배치의 초점: 리스크 관리 (Drawdown Alert)
포트폴리오 MDD가 경고 수준입니다. 다음에 집중하세요:
1. 현재 손실의 원인 (시장 하락 vs 전략 문제)
2. 현금 전환 필요 여부 (trailing stop, crash detection)
3. 리스크 파라미터 강화 필요 여부`,

        STAGNATION: `## 이번 배치의 초점: 기회 탐색 (장기 미거래)
7일 이상 거래가 없었습니다. 다음에 집중하세요:
1. 현재 보유 자산이 여전히 최적인가?
2. 놓치고 있는 시장 기회가 있는가?
3. 쿨다운/임계값이 과도하게 보수적이지 않은가?
4. 새로운 실험 가설을 제안해보세요.`,

        DAILY_REVIEW: `## 이번 배치의 초점: 일일 정기 점검
일일 캔들 마감에 따른 정기 점검입니다. 성과 데이터를 기반으로 판단하세요.
- 수익률이 BTC buy-and-hold 대비 저조하면 modify 또는 replace를 적극 검토하세요.
- 검증하고 싶은 가설이 있다면 "experiment" 액션을 활용하세요.
- 변경 여부는 실제 성과와 시장 상황에 근거하여 결정하세요.`,

        EXPERIMENT_REVIEW: `## 이번 배치의 초점: 실험 결과 평가
진행 중인 실험이 있습니다. 결과를 평가하고 학습 사항을 정리하세요.
성공한 실험은 라이브 전략에 반영을, 실패한 실험은 가설 반증 기록을 남기세요.`,
    };

    return focusMap[triggerType] || focusMap.DAILY_REVIEW;
}

// --- Constraints and response format (shared across all modes) ---

function buildConstraintsSection() {
    return `## Constraints
- Strategy must export: \`DEFAULT_CONFIG\`, \`createStrategyState()\`, \`onNewCandle(state, candleData, config?)\`
- \`candleData\`: \`{ 'KRW-BTC': { 15: [...], 240: [...] }, ... }\`
- Returns: \`{ action: 'HOLD'|'SWITCH'|'NONE', details: { ... } }\`
- SWITCH to CASH: \`{ action: 'SWITCH', details: { targetMarket: 'CASH', reason: '...' } }\`
- \`createStrategyState()\` must return \`{ assetHeld: 'KRW-BTC' }\`
- DEFAULT_CONFIG must include \`executionMode\` and \`smartEntry\` fields
- Available: \`require('../core/indicators')\`, \`require('./custom-indicators')\`, \`require('../utils/adf-test')\`
- No external npm packages beyond what exists
- Daily trade frequency: >= 0.15 and <= 10 trades/day (0-trade 전략은 게이트 탈락)
- Backtest: 0.1% slippage (0.05% smart) + 0.05% fee per side
- Walk-forward: replace uses 70/30 split, TEST period for gate evaluation
- Gates: replace(return diff >= -1%, MDD <= 3% worse, trades 0.15~10/day), modify(return diff >= -2%, MDD <= 5% worse, trades 0.1~10/day)`;
}

function buildExperimentRecommendation(memory, experiments) {
    const lines = [];

    // Check if there are actionable hypotheses without experiments
    const kb = memory.knowledge || { hypotheses: [] };
    const activeExpCount = experiments.active ? experiments.active.length : 0;
    const maxActive = 3;
    const pendingHypotheses = kb.hypotheses.filter(h => h.status === 'proposed' && !h.experimentId);

    if (pendingHypotheses.length > 0 && activeExpCount < maxActive) {
        lines.push('## 실험 권장');
        lines.push(`검증 대기 중인 가설이 ${pendingHypotheses.length}개 있고, 활성 실험 슬롯이 ${maxActive - activeExpCount}개 남아있습니다.`);
        lines.push('"experiment" 액션으로 가설을 체계적으로 검증하는 것을 권장합니다.');
        lines.push('**shadow_strategy 타입을 적극 활용하세요** — 4일간 페이퍼 트레이딩 후 alpha >= 2% 시 자동 승격됩니다.');
        for (const h of pendingHypotheses.slice(0, 3)) {
            lines.push(`- 가설: ${h.hypothesis.slice(0, 100)}`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : '';
}

function buildResponseFormat() {
    return `## Response Format
**모든 응답은 한국어로 작성하세요.**

간결한 분석 후 JSON 결정을 출력하세요:

\`\`\`json
{
  "action": "keep" | "modify" | "replace" | "experiment",
  "reasoning": "한국어로 간단한 사유",
  "confidence": 0.0~1.0,
  "parameters": {},
  "markets": ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
  "improvementAreas": ["strategy", "execution", "risk", "assets", "regime"],
  "notes": "다음 배치를 위한 메모",
  "knowledge": {
    "confirmed": [{"insight": "...", "evidence": "..."}],
    "hypotheses": [{"hypothesis": "...", "status": "proposed"}],
    "rejected": [{"hypothesis": "...", "reason": "..."}]
  },
  "experiment": {
    "hypothesis": "...",
    "design": {"type": "parameter_test|shadow_strategy", "changes": {}, "duration": "7d", "successCriteria": "..."},
    "successCriteria": "..."
  }
}
\`\`\`

- \`experiment\` 액션: 새 가설 테스트 제안 (백테스트 후 승인)
  - \`shadow_strategy\` 타입: 4일 페이퍼 트레이딩 후 alpha >= 2% 시 자동 승격 (전략 코드 포함 필수)
  - \`parameter_test\` 타입: 파라미터 변경 백테스트
- \`knowledge\`: 이번 분석에서 발견한 인사이트를 구조화하여 기록 (기존 strategicNotes 대체)
- replace 시 \`\`\`javascript 블록으로 전략 코드 출력 (최대 3 변형, 첫줄에 \`// VARIANT: 라벨\`)
- replace 시 커스텀 인디케이터는 \`\`\`custom-indicators 블록

## Multi-Variant Mode
replace 시 최대 3개 변형 가능. 각 \`\`\`javascript 블록 첫줄에 \`// VARIANT: 라벨\`.
모든 변형 독립 백테스트 → 게이트 통과 최고 성과 배포. 실패 시 최대 2회 재시도.`;
}

// --- Main build function ---

function buildPrompt(triggerType) {
    // Default to DAILY_REVIEW if not specified
    triggerType = triggerType || process.env.BATCH_TRIGGER || 'DAILY_REVIEW';

    const metrics = getLatestMetrics();
    if (!metrics) {
        log.error('No metrics file found.');
        process.exit(1);
    }

    const tradingConfig = loadTradingConfig();
    const memory = loadMemory();
    const performance = loadPerformance();
    const experiments = loadExperiments();
    const customIndicatorsSource = loadCustomIndicators();

    const sections = [];

    // Header with trigger context
    sections.push(`You are a quantitative trading strategy analyst for a multi-asset trading bot on Upbit.
The bot holds exactly one asset at a time (100% allocation) and can switch between watched markets.

**배치 트리거**: ${triggerType}`);

    // Always include: portfolio + market data + focus
    sections.push(buildFocusSection(triggerType));
    sections.push(buildPortfolioSection(metrics));

    // Always include: real performance (core improvement)
    sections.push(buildPerformanceSection(metrics, performance));

    // Always include: knowledge base (replaces strategicNotes)
    sections.push(buildKnowledgeSection(memory));

    // Always include: recent batch history (slim — 5 entries)
    sections.push(buildRecentBatchHistory(memory));

    // Conditional sections based on trigger type
    if (triggerType === 'REGIME_CHANGE' || triggerType === 'DRAWDOWN_ALERT') {
        sections.push(buildMarketRegimeSection(metrics));
        sections.push(buildStrategySection(metrics));
    }

    if (triggerType === 'STAGNATION' || triggerType === 'DAILY_REVIEW') {
        sections.push(buildMarketRegimeSection(metrics));
        sections.push(buildStrategySection(metrics));

        // Market management
        sections.push(`## Market Management
현재 관심 종목: ${tradingConfig.markets.join(', ')}
종목 변경이 필요하면 "markets" 필드에 새 리스트를 포함하세요.

Upbit KRW 마켓 참고:
KRW-BTC, KRW-ETH, KRW-XRP, KRW-SOL, KRW-DOGE, KRW-ADA, KRW-AVAX, KRW-DOT,
KRW-LINK, KRW-MATIC, KRW-ATOM, KRW-TRX, KRW-ETC, KRW-NEAR, KRW-APT,
KRW-ARB, KRW-OP, KRW-SUI, KRW-SEI, KRW-STX, KRW-HBAR`);
    }

    if (triggerType === 'EXPERIMENT_REVIEW') {
        sections.push(buildExperimentSection(experiments));
        sections.push(buildStrategySection(metrics));
    }

    // Additional metrics (orderbook, trade intensity) — if available
    const additionalMetrics = buildAdditionalMetrics(metrics);
    if (additionalMetrics) sections.push(additionalMetrics);

    // Custom indicators — only when strategy code is shown
    if (triggerType !== 'DRAWDOWN_ALERT') {
        if (customIndicatorsSource) {
            sections.push(`## Custom Indicators
\`\`\`javascript
${customIndicatorsSource}
\`\`\``);
        }
    }

    // Experiment status — always show if there are active experiments
    if (experiments.active.length > 0 && triggerType !== 'EXPERIMENT_REVIEW') {
        sections.push(buildExperimentSection(experiments));
    }

    // Experiment recommendation (if applicable)
    const experimentRec = buildExperimentRecommendation(memory, experiments);
    if (experimentRec) sections.push(experimentRec);

    // Constraints + response format (always)
    sections.push(buildConstraintsSection());
    sections.push(buildResponseFormat());

    return sections.join('\n\n');
}

if (require.main === module) {
    const prompt = buildPrompt();
    process.stdout.write(prompt);
}

module.exports = { buildPrompt };
