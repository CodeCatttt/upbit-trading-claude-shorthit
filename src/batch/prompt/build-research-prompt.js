/**
 * build-research-prompt.js
 * Assembles the research-tier prompt for Claude with WebSearch capability.
 * Focuses on fundamental strategy research, novel approaches, and deep analysis.
 *
 * Trigger modes:
 *   WEEKLY_RESEARCH             — 정기 주간 리서치 (새로운 전략/기법 탐색)
 *   PERSISTENT_UNDERPERFORMANCE — alpha < -3% for 14+ days (근본적 재설계 필요)
 *
 * Usage: node build-research-prompt.js [triggerType]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../utils/logger');

const log = createLogger('BUILD-RESEARCH-PROMPT');

const PROJECT_DIR = path.join(__dirname, '../../..');
const STRATEGY_FILE = path.join(PROJECT_DIR, 'src/strategies/current-strategy.js');
const CUSTOM_INDICATORS_FILE = path.join(PROJECT_DIR, 'src/strategies/custom-indicators.js');
const INDICATORS_FILE = path.join(PROJECT_DIR, 'src/core/indicators.js');
const MEMORY_FILE = path.join(PROJECT_DIR, 'data/batch-memory.json');
const PERFORMANCE_FILE = path.join(PROJECT_DIR, 'data/performance-ledger.json');
const METRICS_DIR = path.join(PROJECT_DIR, 'data/metrics');

const MAX_PROMPT_CHARS = 120000;

// --- Data loaders ---

function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return fallback;
}

function readFileSafe(filePath, maxLines) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf8');
        if (maxLines) {
            const lines = content.split('\n');
            return lines.slice(-maxLines).join('\n');
        }
        return content;
    } catch {
        return null;
    }
}

function loadMemory() {
    return loadJSON(MEMORY_FILE, { entries: [], knowledge: { confirmed: [], hypotheses: [], rejected: [] } });
}

function loadPerformance() {
    return loadJSON(PERFORMANCE_FILE, { entries: [], summary: null });
}

/**
 * Read strategy source, resolving re-export pattern if present.
 * e.g. module.exports = require('./adaptive-regime-mt')
 */
function loadStrategySource() {
    const code = readFileSafe(STRATEGY_FILE);
    if (!code) return null;

    // Check for re-export pattern
    const reExport = code.match(/module\.exports\s*=\s*require\(['"](\.\/[^'"]+)['"]\)/);
    if (reExport) {
        const reExportPath = reExport[1].replace(/\.js$/, '');
        const resolvedPath = path.resolve(path.dirname(STRATEGY_FILE), reExportPath + '.js');
        const resolved = readFileSafe(resolvedPath);
        if (resolved) {
            log.info(`Resolved re-export to: ${resolvedPath}`);
            return resolved;
        }
        // Fallback: try without .js extension
        const resolvedNoExt = readFileSafe(path.resolve(path.dirname(STRATEGY_FILE), reExportPath));
        if (resolvedNoExt) return resolvedNoExt;
    }

    return code;
}

/**
 * Load recent metrics files and extract regime-related data.
 */
function loadRecentMetrics(count) {
    if (!fs.existsSync(METRICS_DIR)) return [];
    const files = fs.readdirSync(METRICS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort();

    const recent = files.slice(-count);
    const results = [];

    for (const file of recent) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(METRICS_DIR, file), 'utf8'));
            results.push({ file, data });
        } catch {}
    }

    return results;
}

/**
 * Extract module.exports keys from indicators.js and build a catalog
 * with function signatures and JSDoc descriptions.
 */
function loadIndicatorCatalog() {
    const code = readFileSafe(INDICATORS_FILE);
    if (!code) return null;

    // Extract the module.exports block
    const exportsMatch = code.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (!exportsMatch) return null;

    const exportNames = exportsMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    // Extract JSDoc comments and signatures for each function
    const catalog = [];
    for (const name of exportNames) {
        const funcRegex = new RegExp(`(/\\*\\*[\\s\\S]*?\\*/\\s*)?function\\s+${name}\\s*\\(([^)]*)\\)`, 'm');
        const match = code.match(funcRegex);

        let description = '';
        let params = '';
        if (match) {
            params = match[2] || '';
            if (match[1]) {
                // Extract first meaningful line of JSDoc
                const docLines = match[1].split('\n')
                    .map(l => l.replace(/^\s*\*\s?/, '').trim())
                    .filter(l => l && !l.startsWith('/') && !l.startsWith('*') && !l.startsWith('@'));
                description = docLines[0] || '';
            }
        }

        catalog.push({ name, params, description });
    }

    return catalog;
}

// --- Section builders ---

function buildRoleSection(triggerType) {
    const triggerDescriptions = {
        WEEKLY_RESEARCH: '정기 주간 리서치. 새로운 트레이딩 전략, 기법, 인디케이터를 탐색하고 현 전략의 근본적 개선 방안을 연구합니다.',
        PERSISTENT_UNDERPERFORMANCE: '지속적 언더퍼포먼스 감지 (alpha < -3%, 14일+). 현 전략의 근본적 문제를 진단하고 대안 전략을 설계해야 합니다.',
    };

    const description = triggerDescriptions[triggerType] || triggerDescriptions.WEEKLY_RESEARCH;

    return `You are a quantitative research analyst for a multi-asset trading bot on Upbit (Korean crypto exchange).
역할: Quant research analyst. 근본적 전략 재설계를 제안할 수 있습니다.
봇은 한 번에 하나의 자산만 100% 보유하며, Upbit KRW 마켓에서 거래합니다.

**리서치 트리거**: ${triggerType}
${description}

**도구**: WebSearch가 사용 가능합니다. 최신 트레이딩 리서치, 논문, 기법을 검색하여 전략 개선에 활용하세요.
- 암호화폐 시장 구조 변화, 새로운 인디케이터, 레짐 감지 기법 등을 적극적으로 조사하세요.
- 검색 결과를 findings에 기록하고, 실행 가능한 인사이트를 전략 제안에 반영하세요.`;
}

function buildPerformanceHistorySection(performance) {
    const lines = ['## 전체 성과 이력 (Performance Ledger)'];

    // Summary
    if (performance.summary) {
        const s = performance.summary;
        lines.push('\n### 요약');
        lines.push(`- 총 수익률: ${s.totalReturnPct != null ? s.totalReturnPct + '%' : 'N/A'}`);
        lines.push(`- BTC Buy&Hold: ${s.btcReturnPct != null ? s.btcReturnPct + '%' : 'N/A'}`);
        lines.push(`- **알파 (vs BTC)**: ${s.alphaPct != null ? (s.alphaPct > 0 ? '+' : '') + s.alphaPct + '%' : 'N/A'}`);
        lines.push(`- 최대 MDD: ${s.maxMdd != null ? s.maxMdd + '%' : 'N/A'}`);
        lines.push(`- 총 거래: ${s.totalTrades || 0}회, 승률: ${s.winRate != null ? (s.winRate * 100).toFixed(1) + '%' : 'N/A'}`);
        lines.push(`- 추적 일수: ${s.daysTracked || 0}일`);

        if (s.alphaPct != null && s.alphaPct < -3) {
            lines.push(`\n**CRITICAL: BTC 대비 ${Math.abs(s.alphaPct)}% 언더퍼폼. 근본적 전략 재설계가 필요합니다.**`);
        }
    }

    // Full daily entries (last 30 for trend analysis)
    if (performance.entries && performance.entries.length > 0) {
        const entries = performance.entries.slice(-30);
        lines.push(`\n### 일별 성과 (최근 ${entries.length}일)`);
        lines.push('| 날짜 | 포트폴리오(KRW) | BTC수익률 | 알파 | MDD |');
        lines.push('|------|----------------|----------|------|-----|');
        for (const e of entries) {
            const alphaStr = e.alpha != null ? (e.alpha > 0 ? '+' : '') + e.alpha + '%' : 'N/A';
            const mddStr = e.mdd != null ? e.mdd + '%' : 'N/A';
            const btcStr = e.btcReturnPct != null ? (e.btcReturnPct > 0 ? '+' : '') + e.btcReturnPct + '%' : 'N/A';
            lines.push(`| ${e.date} | ${e.portfolioValueKrw?.toLocaleString() || 'N/A'} | ${btcStr} | ${alphaStr} | ${mddStr} |`);
        }

        // Trend analysis
        if (entries.length >= 7) {
            const recent7 = entries.slice(-7);
            const avgAlpha7 = recent7.reduce((sum, e) => sum + (e.alpha || 0), 0) / recent7.length;
            const avgAlpha30 = entries.reduce((sum, e) => sum + (e.alpha || 0), 0) / entries.length;

            lines.push('\n### 트렌드 분석');
            lines.push(`- 7일 평균 알파: ${avgAlpha7 > 0 ? '+' : ''}${avgAlpha7.toFixed(2)}%`);
            lines.push(`- ${entries.length}일 평균 알파: ${avgAlpha30 > 0 ? '+' : ''}${avgAlpha30.toFixed(2)}%`);

            // Check for persistent underperformance
            const negAlphaDays = entries.filter(e => (e.alpha || 0) < 0).length;
            lines.push(`- 음의 알파 일수: ${negAlphaDays}/${entries.length}일 (${Math.round(negAlphaDays / entries.length * 100)}%)`);
        }
    } else {
        lines.push('\n성과 기록 없음.');
    }

    return lines.join('\n');
}

function buildStrategySourceSection() {
    const source = loadStrategySource();
    if (!source) return '## 현재 전략 소스코드\n전략 파일을 읽을 수 없습니다.';

    return `## 현재 전략 소스코드
\`\`\`javascript
${source}
\`\`\``;
}

function buildCustomIndicatorsSection() {
    const source = readFileSafe(CUSTOM_INDICATORS_FILE);
    if (!source) return '## 커스텀 인디케이터\n커스텀 인디케이터 파일을 읽을 수 없습니다.';

    // Check if it's just an empty module
    const stripped = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (stripped === "'use strict';\nmodule.exports = {};" || stripped === 'module.exports = {};' || stripped.length < 30) {
        return '## 커스텀 인디케이터\n현재 커스텀 인디케이터 없음 (빈 모듈).';
    }

    return `## 커스텀 인디케이터 소스코드
\`\`\`javascript
${source}
\`\`\``;
}

function buildMarketRegimeHistorySection() {
    const recentMetrics = loadRecentMetrics(30);
    if (recentMetrics.length === 0) return '## 시장 레짐 이력\n메트릭 데이터 없음.';

    const lines = ['## 시장 레짐 이력 (최근 메트릭)'];

    const regimeEntries = [];
    for (const { file, data } of recentMetrics) {
        const mr = data.marketRegime;
        if (!mr) continue;

        const timestamp = file.replace('.json', '').replace('metrics-', '');
        regimeEntries.push({
            timestamp,
            direction: mr.direction,
            avgChange24h: mr.avgChange24h,
            dispersion: mr.dispersion,
            assetCount: mr.assetCount,
        });
    }

    if (regimeEntries.length === 0) {
        lines.push('레짐 데이터가 포함된 메트릭 없음.');
        return lines.join('\n');
    }

    lines.push(`\n총 ${regimeEntries.length}개 메트릭 파일에서 레짐 데이터 추출:\n`);
    lines.push('| 시간 | 방향 | 평균변화(24h) | 분산 |');
    lines.push('|------|------|--------------|------|');

    for (const entry of regimeEntries) {
        lines.push(`| ${entry.timestamp} | ${entry.direction} | ${entry.avgChange24h}% | ${entry.dispersion}% |`);
    }

    // Detect regime changes
    const regimeChanges = [];
    for (let i = 1; i < regimeEntries.length; i++) {
        if (regimeEntries[i].direction !== regimeEntries[i - 1].direction) {
            regimeChanges.push({
                from: regimeEntries[i - 1].direction,
                to: regimeEntries[i].direction,
                timestamp: regimeEntries[i].timestamp,
            });
        }
    }

    if (regimeChanges.length > 0) {
        lines.push(`\n### 레짐 전환 감지 (${regimeChanges.length}회)`);
        for (const change of regimeChanges) {
            lines.push(`- ${change.timestamp}: ${change.from} -> ${change.to}`);
        }
    } else {
        lines.push('\n레짐 전환 감지 없음 — 일관된 시장 방향.');
    }

    return lines.join('\n');
}

function buildKnowledgeBaseSection(memory) {
    const knowledge = memory.knowledge || { confirmed: [], hypotheses: [], rejected: [] };
    const lines = ['## 전체 학습 기록 (Knowledge Base)'];

    if (knowledge.confirmed.length > 0) {
        lines.push('\n### 검증된 사실 (Confirmed)');
        for (const k of knowledge.confirmed) {
            lines.push(`- **${k.insight}**`);
            lines.push(`  근거: ${k.evidence || 'N/A'}${k.addedAt ? ' (' + k.addedAt + ')' : ''}`);
        }
    }

    if (knowledge.hypotheses.length > 0) {
        lines.push('\n### 검증 대기 가설 (Hypotheses)');
        for (const h of knowledge.hypotheses) {
            lines.push(`- [${h.status || 'unknown'}] ${h.hypothesis}${h.experimentId ? ' (실험: ' + h.experimentId + ')' : ''}`);
        }
    }

    if (knowledge.rejected.length > 0) {
        lines.push('\n### 반증된 가설 (Rejected)');
        for (const r of knowledge.rejected) {
            lines.push(`- ~~${r.hypothesis}~~`);
            lines.push(`  반증 사유: ${r.reason || 'N/A'}${r.rejectedAt ? ' (' + r.rejectedAt + ')' : ''}`);
        }
    }

    if (knowledge.confirmed.length === 0 && knowledge.hypotheses.length === 0 && knowledge.rejected.length === 0) {
        lines.push('학습 기록 없음.');
    }

    return lines.join('\n');
}

function buildIndicatorCatalogSection() {
    const catalog = loadIndicatorCatalog();
    if (!catalog) return '## 사용 가능 인디케이터\nindicators.js를 읽을 수 없습니다.';

    const lines = ['## 사용 가능 인디케이터 (`require(\'../core/indicators\')`)'];
    lines.push('전략에서 import하여 사용할 수 있는 내장 기술 지표 함수:\n');

    for (const { name, params, description } of catalog) {
        const desc = description ? ` — ${description}` : '';
        lines.push(`- \`${name}(${params})\`${desc}`);
    }

    lines.push('\n추가로 `require(\'./custom-indicators\')` (커스텀 인디케이터), `require(\'../utils/adf-test\')` (ADF 정상성 검정) 사용 가능.');

    return lines.join('\n');
}

function buildBacktestTrendsSection(memory) {
    const entries = (memory.entries || []).filter(e => e.backtestResult);
    if (entries.length === 0) return '## 백테스트 결과 트렌드\n백테스트 결과가 포함된 배치 기록 없음.';

    const recent = entries.slice(-15);
    const lines = ['## 백테스트 결과 트렌드 (최근 기록)'];

    for (const e of recent) {
        const bt = e.backtestResult;
        let btSummary = '';
        if (typeof bt === 'object') {
            const parts = [];
            if (bt.returnPct != null) parts.push(`수익 ${bt.returnPct}%`);
            if (bt.mdd != null) parts.push(`MDD ${bt.mdd}%`);
            if (bt.tradesPerDay != null) parts.push(`거래 ${bt.tradesPerDay}/일`);
            if (bt.gateResult) parts.push(`게이트: ${bt.gateResult}`);
            btSummary = parts.join(', ');
        } else {
            btSummary = String(bt);
        }
        const notes = e.notes ? ` | ${e.notes.slice(0, 100)}` : '';
        lines.push(`- [${e.timestamp}] **${e.action}** (conf: ${e.confidence}): ${btSummary}${notes}`);
    }

    return lines.join('\n');
}

function buildExplorationDirectives(triggerType) {
    const lines = ['## 탐색 지침 (Exploration Directives)'];

    lines.push(`이 리서치 세션에서는 **근본적 재설계가 가능**합니다.
- 기존 전략 프레임워크에 구애받지 않는 새로운 접근법을 탐색하세요.
- anti-keep 규칙이 적용되지 않습니다. no_action도 유효한 결론입니다.
- WebSearch를 활용하여 최신 퀀트 트레이딩 연구를 참고하세요.

### 탐색 영역 제안
1. **레짐 감지 개선**: 현재 방식 외 HMM, change-point detection, volatility clustering 등
2. **대안 전략 패러다임**: mean-reversion, momentum, breakout, statistical arbitrage 등
3. **새로운 인디케이터/피처**: 온체인 데이터 활용, 거래량 프로파일, 유동성 지표 등
4. **리스크 관리 혁신**: dynamic position sizing concepts (단일 자산 100%이지만 현금 전환 타이밍), adaptive stop-loss
5. **실행 최적화**: 진입/청산 타이밍, 슬리피지 최소화 기법`);

    if (triggerType === 'PERSISTENT_UNDERPERFORMANCE') {
        lines.push(`
### PERSISTENT_UNDERPERFORMANCE 특별 지시
- 현 전략의 **근본적 문제**를 진단하세요 (왜 BTC buy-and-hold를 이기지 못하는가?)
- 단순 파라미터 조정이 아닌 **구조적 변경**을 우선 검토하세요
- 필요하다면 전혀 다른 패러다임의 전략을 제안하세요
- 최근 시장 구조가 어떻게 변했는지 WebSearch로 확인하세요`);
    }

    return lines.join('\n');
}

function buildConstraintsSection() {
    return `## Constraints (전략 인터페이스 요구사항)
- Strategy must export: \`DEFAULT_CONFIG\`, \`createStrategyState()\`, \`onNewCandle(state, candleData, config?)\`
- \`candleData\`: \`{ 'KRW-BTC': { 15: [...], 240: [...] }, ... }\`
- Returns: \`{ action: 'HOLD'|'SWITCH'|'NONE', details: { ... } }\`
- SWITCH to CASH: \`{ action: 'SWITCH', details: { targetMarket: 'CASH', reason: '...' } }\`
- \`createStrategyState()\` must return \`{ assetHeld: 'KRW-BTC' }\`
- DEFAULT_CONFIG must include \`executionMode\` and \`smartEntry\` fields
- Available: \`require('../core/indicators')\`, \`require('./custom-indicators')\`, \`require('../utils/adf-test')\`
- No external npm packages beyond what exists
- Daily trade frequency: >= 0.15 and <= 10 trades/day
- Backtest: 0.1% slippage (0.05% smart) + 0.05% fee per side
- Walk-forward: replace uses 70/30 split, TEST period for gate evaluation
- Gates: replace(return diff >= 0%, MDD <= 2% worse, trades 0.15~10/day), modify(return diff >= -1%, MDD <= 3% worse, trades 0.1~10/day)
- Max candles: 10000 per market per interval (~104 days for 15m)
- Intervals: 15m (primary), 240m (4h higher-timeframe)
- 한 번에 하나의 자산만 100% 보유`;
}

function buildResponseFormatSection() {
    return `## Response Format
**모든 응답은 한국어로 작성하세요.**

리서치 분석 후 JSON 결정을 출력하세요:

\`\`\`json
{
  "action": "replace_strategy" | "propose_experiment" | "no_action",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "findings": [
    {
      "topic": "발견 주제",
      "summary": "발견 요약",
      "source": "출처 (WebSearch URL, 분석 결과 등)",
      "actionable": true
    }
  ],
  "knowledge": {
    "confirmed": [{"insight": "...", "evidence": "..."}],
    "hypotheses": [{"hypothesis": "...", "status": "proposed"}],
    "rejected": [{"hypothesis": "...", "reason": "..."}]
  },
  "experiment": {
    "hypothesis": "...",
    "design": {
      "type": "shadow_strategy",
      "duration": "7d",
      "changes": {},
      "successCriteria": "..."
    }
  },
  "notes": "다음 리서치를 위한 메모"
}
\`\`\`

### Action 별 추가 출력

**replace_strategy**:
- \`\`\`javascript 블록으로 전체 전략 코드 출력 (최대 3 변형, 첫줄에 \`// VARIANT: 라벨\`)
- 필요 시 \`\`\`custom-indicators 블록으로 커스텀 인디케이터 코드 출력
- 백테스트 게이트를 통과해야 배포됨

**propose_experiment**:
- experiment 필드에 shadow_strategy 타입 실험 설계 포함
- 4일간 페이퍼 트레이딩 후 alpha >= 2% 시 자동 승격
- 전략 코드는 \`\`\`javascript 블록으로 포함 필수

**no_action**:
- findings와 knowledge 업데이트만 기록
- 현재 전략이 최선이라는 근거를 제시하세요

### 리서치 품질 기준
- findings에 최소 2개 이상의 발견 사항을 기록하세요
- WebSearch 결과를 source 필드에 명시하세요
- actionable 여부를 명확히 구분하세요
- knowledge에 새로운 인사이트를 반드시 1개 이상 기록하세요`;
}

// --- Main build function ---

function buildResearchPrompt(triggerType) {
    triggerType = triggerType || process.env.RESEARCH_TRIGGER || 'WEEKLY_RESEARCH';

    if (!['WEEKLY_RESEARCH', 'PERSISTENT_UNDERPERFORMANCE'].includes(triggerType)) {
        log.warn(`Unknown trigger type: ${triggerType}, defaulting to WEEKLY_RESEARCH`);
        triggerType = 'WEEKLY_RESEARCH';
    }

    const memory = loadMemory();
    const performance = loadPerformance();

    const sections = [];

    // 1. Role definition + trigger context
    sections.push(buildRoleSection(triggerType));

    // 2. Full performance history
    sections.push(buildPerformanceHistorySection(performance));

    // 3. Current strategy source code (resolves re-exports)
    sections.push(buildStrategySourceSection());

    // 4. Custom indicators source
    sections.push(buildCustomIndicatorsSection());

    // 5. Market regime history (recent 30 metrics files)
    sections.push(buildMarketRegimeHistorySection());

    // 6. Complete knowledge base
    sections.push(buildKnowledgeBaseSection(memory));

    // 7. Available indicators catalog
    sections.push(buildIndicatorCatalogSection());

    // 8. Backtest result trends
    sections.push(buildBacktestTrendsSection(memory));

    // 9. Exploration directives
    sections.push(buildExplorationDirectives(triggerType));

    // 10. Constraints
    sections.push(buildConstraintsSection());

    // 11. Response format
    sections.push(buildResponseFormatSection());

    let prompt = sections.join('\n\n');

    // Enforce total prompt size limit
    if (prompt.length > MAX_PROMPT_CHARS) {
        log.warn(`Prompt exceeds ${MAX_PROMPT_CHARS} chars (${prompt.length}), truncating`);
        prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n\n... (프롬프트 용량 제한으로 일부 생략)';
    }

    return prompt;
}

if (require.main === module) {
    const triggerType = process.argv[2] || undefined;
    const prompt = buildResearchPrompt(triggerType);
    process.stdout.write(prompt);
}

module.exports = { buildResearchPrompt };
