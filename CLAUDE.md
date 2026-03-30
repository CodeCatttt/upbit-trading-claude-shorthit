# upbit-trading-claude-day-trading

Upbit 고빈도 단타(스캘핑) 트레이딩 봇 with WebSocket real-time data + Claude-powered batch strategy analysis.

## Architecture

- **Day Trading Bot** (`src/core/day-trading-bot.js`): PM2 process, WebSocket real-time data, 5-second analysis loop
- **WebSocket Client** (`src/core/websocket-client.js`): Upbit WebSocket for real-time ticker/trade/orderbook
- **Candle Manager** (`src/core/candle-manager.js`): Builds 1m/5m candles from real-time trade data
- **Risk Manager** (`src/core/risk-manager.js`): Stop-loss 0.3%, take-profit 0.5%, daily loss limit, dynamic throttling
- **Strategy** (`src/strategies/scalping-strategy.js`): Hot-swappable scalping strategy (EMA/RSI/BB/VWAP/MACD/Volume)
- **Custom Indicators** (`src/strategies/custom-indicators.js`): Claude-managed custom indicator functions
- **Batch Scheduler** (`src/batch/pipeline/batch-scheduler.js`): PM2 process — 3-tier trigger-based adaptive batch scheduling (5min checks)
- **Batch Memory** (`data/batch-memory.json`): Decision history + structured knowledge base for cross-batch learning
- **Performance Tracker** (`src/batch/learning/performance-tracker.js`): Daily real P&L vs BTC benchmark tracking
- **Experiment Manager** (`src/batch/learning/experiment-manager.js`): Structured hypothesis → test → learn cycle
- **Shadow Manager** (`src/batch/learning/shadow-manager.js`): Paper-trading parallel strategy evaluation
- **Config** (`trading-config.json`): Dynamic market list, updated by Claude at each batch
- **Legacy Bot** (`src/core/bot.js`): Original 15-minute swing trading bot (preserved for reference)

### 3-Tier Autonomous Batch System

| Tier | 역할 | 주기 | 수정 대상 | 파이프라인 |
|------|------|------|-----------|-----------|
| **strategy** | 시장 대응, 파라미터 조정, 전략 교체 | 트리거 기반 (2h min, 긴급 1h) | scalping-strategy.js, custom-indicators.js | `run-batch.sh` |
| **infra_fix** | 버그 수정, 코드 안정성 개선 | 주 1회 / PM2 crash 시 (24h min) | src/ 전체 (전략 파일 제외) | `run-infra-fix.sh` |
| **research** | 전략 연구, 근본적 전략 교체 | 주 1회 / 성과 부진 시 (7d min) | scalping-strategy.js + custom-indicators.js | `run-research.sh` |

**Cross-tier 동시 실행 규칙:**
- strategy + infra_fix: 가능 (다른 파일 수정)
- strategy + research: 불가 (둘 다 전략 파일 수정 가능)
- infra_fix + research: 가능 (다른 파일 수정)

## Strategy Interface (Scalping)

All strategies must export:
```javascript
module.exports = {
  DEFAULT_CONFIG,                      // Object with strategy parameters
  analyze(candles1m, candles5m, config?)
    // candles1m: Array of 1-minute candles [{ open, high, low, close, volume, timestamp }]
    // candles5m: Array of 5-minute candles (same format)
    // Returns:
    //   { action: 'BUY', score: 0.45, signals: { ... } }
    //   { action: 'SELL', score: -0.5, signals: { ... } }
    //   { action: 'HOLD', score: 0.1, signals: { ... } }
};
```

### Action Types
- `BUY`: Enter position (buy market order)
- `SELL`: Exit position (sell market order)
- `HOLD`: No action
- Risk management (stop-loss/take-profit) handled by RiskManager, not strategy

### Current Strategy: Adaptive Regime Multi-Timeframe
- **15m 캔들**: 빠른 리스크 신호 (crash detection, trailing stop)
- **4h 캔들**: 트렌드 스코어링, 레짐 감지, 스위칭 결정
- **CASH 전환**: trailing stop (7%) + 24h crash detection (4%) → 자동 현금 전환
- **적응형 쿨다운**: 트렌딩 시장 3일, 횡보 시장 5일 (choppiness 기반 보간) + 기회 오버라이드 (advantage > threshold × 1.3 시 쿨다운 무시)
- **스마트 재진입**: RSI > 50 + ADX > 20(트렌드 확인) + Stochastic < 85(과매수 방지) + 양의 스코어 후 매수
- **그레이스 기간**: 진입 후 12h 동안 리스크 체크 비활성화 (whipsaw 방지)
- **복합 스코어링**: 모멘텀(35%) + EMA 트렌드×ADX(35%) + 거래량(15%) + 볼린저(15%)

### Available Imports
- `require('../core/indicators')` — built-in technical indicators (EMA, RSI, ATR, Kalman, etc.)
- `require('./custom-indicators')` — Claude-managed custom indicator functions
- `require('../utils/adf-test')` — ADF stationarity test

## Candle Data
- Max candles stored: **10000** per market per interval (~104 days for 15m)
- Intervals: 15m (primary), 240m (4h higher-timeframe context)
- Backtest runs on 15m candles; 240m aligned by timestamp at each step

## Batch Scheduling (3-Tier Adaptive)

**Trigger-based scheduling** with per-tier intervals:

| Priority | Trigger | Tier | Condition | Interval |
|----------|---------|------|-----------|----------|
| 1 | PM2_CRASH | infra_fix | PM2 restart +3회 | 24h |
| 2 | DRAWDOWN_ALERT | strategy | Portfolio MDD > 8% | 3h (긴급) |
| 3 | REGIME_CHANGE | strategy | 24h price change > 5% | 3h (긴급) |
| 4 | EXPERIMENT_REVIEW | strategy | Active experiment duration met | 6h |
| 5 | WEEKLY_MAINTENANCE | infra_fix | 마지막 점검 7일 경과 | 24h |
| 6 | PERSISTENT_UNDERPERFORMANCE | research | 14일 평균 alpha < -3% | 7d |
| 7 | STAGNATION | strategy | 7+ days since last trade | 6h |
| 8 | DAILY_REVIEW | strategy | Daily candle close (UTC 0:00) | 6h |
| 9 | WEEKLY_RESEARCH | research | 마지막 연구 7일 경과 | 7d |

- Per-tier lockfiles: `.batch-lock`, `.infra-fix-lock`, `.research-lock`
- `scheduler-state.json`: per-tier state tracking (auto-migrated from old flat format)
- PM2 process: `batch-scheduler` (checks every 15 minutes)

## Batch Memory & Knowledge Base
- File: `data/batch-memory.json`
- Stores last 50 batch decisions with action, reasoning, outcome, notes
- **Structured Knowledge** (replaces flat strategicNotes):
  - `knowledge.confirmed`: 백테스트+실거래로 검증된 사실 (max 20)
  - `knowledge.hypotheses`: 검증 대기 중인 가설 (max 20)
  - `knowledge.rejected`: 실험으로 반증된 가설 (max 20)
- Helper: `src/batch/learning/update-memory.js` — auto-called by run-batch.sh

## Performance Tracking
- File: `data/performance-ledger.json`
- Daily recording: portfolio value, BTC benchmark, alpha, MDD
- Tracked automatically during `collect-metrics.js`
- Summary (totalReturn, btcReturn, alpha, maxMdd, winRate) included in batch prompt

## Experiment Framework
- File: `data/experiments.json`
- Lifecycle: propose → backtest → deploy/reject → evaluate → learn
- Max 3 active experiments simultaneously
- Types: `parameter_test`, `shadow_strategy`
- Batch response `"action": "experiment"` triggers proposal
- Completed experiments generate knowledge entries (confirmed/rejected)

## Shadow Strategy System
- Directory: `data/shadow-strategies/`
- Performance: `data/shadow-performance.json`
- New strategies run in paper-trading mode alongside live strategy
- Bot executes shadow cycles each 15-minute tick (no real orders)
- 4-day evaluation period before promotion decision
- **Auto-promotion**: alpha >= 2% (vs live strategy) 시 배치에서 자동 승격 및 배포

## Custom Indicators
- File: `src/strategies/custom-indicators.js`
- Claude can define new indicator functions via ```custom-indicators code block
- Backed up alongside strategy on deploy; rolled back together on failure
- Strategy uses via `require('./custom-indicators')`

## Strategy Goals & Constraints

### Objectives
- 연 수익률 목표: 시장 평균(BTC buy-and-hold) 대비 초과 수익
- 리스크 관리: 최대 낙폭(MDD) 15% 이내 유지
- 한 번에 하나의 자산만 100% 보유 (현행 유지)

### Asset Selection Criteria
- Upbit KRW 마켓에서 거래 가능한 종목만 대상
- 시가총액 상위 100위 이내 종목만 거래
- 24시간 거래량 일정 수준 이상 (유동성 확보)
- `trading-config.json`의 markets 배열로 관리

### Prohibited Patterns
- 일일 10회 이상 거래 금지 (백테스트 게이트: 10회/일, 최소 0.15회/일)
- 시가총액 100위 밖 종목 거래 금지
- 레버리지/마진 거래 불가 (Upbit 현물만)
- 단일 배치에서 전략 교체 + 종목 변경 동시 수행 자제

### Backtest & Safety Gates
- 백테스트에 슬리피지 0.1% (smart 모드 0.05%) + 수수료 0.05% 포함 (per side)
- Walk-forward 백테스트: 70/30 분할, TEST 구간 기준 평가 (최소 200캔들, 미만 시 단일패스)
- 티어드 게이트 (완화):
  - `replace`: 수익률 차이 >= 0%, MDD 악화 <= 2%, 일일거래 0.15~10
  - `modify`: 수익률 차이 >= -1%, MDD 악화 <= 3%, 일일거래 0.1~10
- PM2 헬스체크 + 자동 롤백
- 배포 전 드라이런: 실제 캔들 데이터로 onNewCandle 100회 반복, 런타임 에러 사전 차단

### Batch Self-Improvement
- **재시도 루프**: replace 게이트 실패 시 최대 2회 재시도 (총 3회 시도)
  - 실패 진단 (`diagnose-failure.js`): 수익률/MDD/거래빈도 각 항목 분석 + 개선 제안
  - 재시도 프롬프트 (`build-retry-prompt.js`): 실패 코드 + 진단 + 게이트 기준 → 타겟 수정 지시
- **멀티변형**: replace 시 최대 3개 전략 변형 제출, 모두 독립 백테스트 → 게이트 통과 중 최고 성과 선택
  - 각 ```javascript 블록 첫줄에 `// VARIANT: 라벨` 작성
- **배치 메모리 강화**: 실패 시 retryAttempts, variantsTested, diagnosis 기록 → 다음 배치 학습

## Key Files

| File | Purpose |
|------|---------|
| **Core** | |
| `src/core/bot.js` | Main bot (PM2 24/7, multi-timeframe + shadow execution) |
| `src/core/upbit-api.js` | Upbit API wrapper (+ orderbook, ticker) |
| `src/core/indicators.js` | Technical indicators library |
| `src/execution/smart-entry.js` | Smart entry module (RSI dip, pullback, Bollinger) |
| `src/strategies/current-strategy.js` | Active strategy (replaced on deploy) |
| `src/strategies/custom-indicators.js` | Custom indicator functions (Claude-managed) |
| **Batch — Pipeline** | |
| `src/batch/pipeline/batch-scheduler.js` | 3-tier adaptive batch scheduler (PM2, trigger-based) |
| `src/batch/pipeline/run-batch.sh` | Strategy tier pipeline (retry + multi-variant + experiment) |
| `src/batch/pipeline/run-infra-fix.sh` | Infra_fix tier pipeline (backup + patch + health check + rollback) |
| `src/batch/pipeline/run-research.sh` | Research tier pipeline (WebSearch + backtest + deploy) |
| `src/batch/pipeline/notify.js` | Discord notifications (strategy + infra + research) |
| **Batch — Prompt (Strategy)** | |
| `src/batch/prompt/build-prompt.js` | Strategy prompt assembly (trigger-focused) |
| `src/batch/prompt/parse-response.js` | Strategy response parsing (+ experiment action) |
| `src/batch/prompt/build-retry-prompt.js` | Focused retry prompt builder |
| `src/batch/prompt/diagnose-failure.js` | Gate failure diagnosis for retry prompts |
| **Batch — Prompt (Infra)** | |
| `src/batch/prompt/build-infra-prompt.js` | Infra_fix prompt assembly (PM2 logs + error traces + source) |
| `src/batch/prompt/parse-infra-response.js` | Infra_fix response parsing (file blocks + path validation) |
| **Batch — Prompt (Research)** | |
| `src/batch/prompt/build-research-prompt.js` | Research prompt assembly (full history + indicators + WebSearch) |
| `src/batch/prompt/parse-research-response.js` | Research response parsing (reuses strategy validators) |
| **Batch — Eval** | |
| `src/batch/eval/backtest.js` | Multi-timeframe backtest engine with slippage |
| `src/batch/eval/collect-metrics.js` | Enhanced metrics (Sharpe, win rate, orderbook, trade intensity) |
| `src/batch/eval/deploy.js` | Safe deploy with dry-run + rollback (strategy + custom indicators) |
| `src/batch/eval/apply-modify.js` | Strategy parameter modification |
| **Batch — Learning** | |
| `src/batch/learning/update-memory.js` | Batch memory + structured knowledge management |
| `src/batch/learning/performance-tracker.js` | Real P&L vs BTC benchmark daily tracking |
| `src/batch/learning/experiment-manager.js` | Structured experiment lifecycle management |
| `src/batch/learning/shadow-manager.js` | Shadow (paper-trading) strategy parallel execution |
| **Data & Config** | |
| `trading-config.json` | Dynamic market list + intervals |
| `data/batch-memory.json` | Batch decisions + structured knowledge base |
| `data/performance-ledger.json` | Daily portfolio performance records |
| `data/experiments.json` | Active/completed experiments |
| `data/shadow-strategies/` | Shadow strategy files |
| `data/shadow-performance.json` | Shadow strategy performance tracking |
| `bot-state.json` | Bot state (assetHeld as market code) |
| `deploy-log.json` | Deploy history |
| `data/execution-log.json` | Execution log (smart entry results, max 100) |
| `data/infra-fix-log.json` | Infra_fix 수정 이력 (max 30) |
| `data/research-log.json` | Research 연구 세션 이력 (max 30) |

## Execution Modes

DEFAULT_CONFIG에 실행 설정 포함:
```javascript
executionMode: 'market',    // 'market' | 'smart' (배치가 전환 가능)
smartEntry: {
    candleInterval: 5,      // 5분 캔들 모니터링
    maxWaitMinutes: 15,     // 최대 대기시간 (초과 시 시장가)
    pollIntervalMs: 15000,  // 폴링 간격
    entryMethod: 'rsi_dip', // 'rsi_dip' | 'pullback' | 'bollinger_touch'
    rsiThreshold: 40,       // RSI 진입 임계값
    pullbackPct: 0.3,       // 풀백 진입 %
},
```

- `market`: 즉시 시장가 주문 (기본값)
- `smart`: 매도 즉시 → 매수는 단기 모니터링 후 유리한 타이밍에 진입
- 실행 로그: `data/execution-log.json` (최대 100건)

## Batch Response Format

```json
{
  "action": "keep" | "modify" | "replace" | "experiment",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "parameters": {},
  "markets": ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
  "improvementAreas": ["strategy", "execution", "risk", "assets", "regime"],
  "notes": "다음 배치를 위한 메모 (선택사항)",
  "knowledge": {
    "confirmed": [{"insight": "...", "evidence": "..."}],
    "hypotheses": [{"hypothesis": "...", "status": "proposed"}],
    "rejected": [{"hypothesis": "...", "reason": "..."}]
  },
  "experiment": {
    "hypothesis": "...",
    "design": {"type": "parameter_test", "changes": {}, "duration": "7d", "successCriteria": "..."}
  }
}
```

For "replace" action, additional code blocks:
- ```javascript — complete new strategy file (최대 3개 변형 가능, 첫줄에 `// VARIANT: 라벨`)
- ```custom-indicators — custom indicator functions (optional)

## Infra_fix Response Format

```json
{
  "action": "fix" | "no_action",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "fixes": [{ "file": "src/core/bot.js", "description": "...", "severity": "critical|important|minor" }],
  "knowledge": { "confirmed": [], "hypotheses": [], "rejected": [] },
  "notes": "다음 인프라 체크를 위한 메모"
}
```

- `fix` action: 각 파일은 ```file:path 코드 블록으로 전체 내용 출력
- 수정 가능: src/ 하위 (current-strategy.js, custom-indicators.js 제외)
- 수정 불가: .env, data/, node_modules/, backups/
- 최대 3개 파일, 크기 0.3x~3x 원본

## Research Response Format

```json
{
  "action": "replace_strategy" | "propose_experiment" | "no_action",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "findings": [{ "topic": "...", "summary": "...", "source": "...", "actionable": true }],
  "knowledge": { "confirmed": [], "hypotheses": [], "rejected": [] },
  "experiment": { "hypothesis": "...", "design": { "type": "shadow_strategy", "duration": "7d" } },
  "notes": "..."
}
```

- `replace_strategy`: ```javascript 코드 블록 (기존 replace와 동일 게이트 적용)
- `propose_experiment`: experiment-manager + shadow-manager 재사용
- `no_action`: findings만 지식베이스에 저장 (연구 가치 누적)

## Safety

- Tiered backtest gates: replace (return diff >= 0%, MDD <= 2% worse, trades 0.15~10/day), modify (return diff >= -1%, MDD <= 3% worse, trades 0.1~10/day)
- Walk-forward: replace uses 70/30 split, TEST period for gate evaluation
- Slippage model: 0.1% per trade (market mode), 0.05% (smart mode)
- Pre-deploy dry-run: 실제 캔들 데이터로 100회 반복 실행하여 런타임 에러 사전 차단
- Syntax + interface validation before deploy (strategy + custom indicators)
- Auto-rollback on PM2 crash after deploy (strategy + custom indicators)
- Replace retry loop: 게이트 실패 시 최대 2회 자동 재시도 (진단 기반 타겟 수정)
- Atomic state file writes (crash-safe)
- Market removal safety: 보유 종목은 자동으로 관심 리스트에 유지
- Batch memory: 최근 50개 결정 기록 + 구조화된 학습 지식 추적
- Shadow strategies: 새 전략을 4일간 페이퍼 트레이딩 후 alpha >= 2% 시 자동 승격
- Adaptive scheduling: 트리거 기반 배치 실행, per-tier 간격 보장
- Infra_fix: 경로 허용목록, 문법 검사, 크기 검사, PM2 헬스체크 후 자동 롤백
- Research: 기존 backtest + deploy 재사용, WebSearch로 최신 연구 접근 가능
