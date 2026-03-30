# upbit-trading-claude-shorthit

Upbit 고빈도 단타(스캘핑) 자동매매 봇 + Claude 기반 자율 전략 개선 시스템.

WebSocket 실시간 데이터로 5초마다 시장을 분석하고, 1분/5분 캔들 기반 멀티시그널 스캘핑 전략으로 하루 수십~수백 건 거래합니다. 3-tier 배치 시스템이 자율적으로 전략을 개선하며, 보수화 드리프트 방지 장치가 거래 빈도를 유지합니다.

## 시스템 흐름도

```
     ┌─────────────────────────────────────────────────────────┐
     │          PM2: upbit-day-trading-bot (24/7)              │
     │                                                         │
     │  WebSocket ──→ 실시간 체결/호가/티커 수신                   │
     │       │                                                 │
     │  CandleManager ──→ 1m/5m 캔들 실시간 생성 + 디스크 저장      │
     │       │                                                 │
     │  매 5초 ──→ scalping-strategy.js 분석                     │
     │       │    (EMA/RSI/BB/VWAP/MACD/Volume/Orderbook)       │
     │       │                                                 │
     │       ├─ BUY  → 시장가 매수 + ATR 기반 동적 SL/TP 설정      │
     │       ├─ SELL → 최소 수익 필터(0.15%) 통과 시 매도           │
     │       └─ HOLD → 대기                                     │
     │                                                         │
     │  RiskManager: ATR 손절 + 트레일링 익절 + 일일 -3% 한도       │
     │  MarketSelector: 매시간 24h 거래량 TOP 12 자동 갱신          │
     └─────────────────────────────────────────────────────────┘

     ┌─────────────────────────────────────────────────────────┐
     │          PM2: batch-scheduler (5분 체크)                  │
     │                                                         │
     │  트리거 감지 시 run-batch.sh 실행                           │
     │  ├─ DRAWDOWN_ALERT     MDD > 5%               (긴급 1h)  │
     │  ├─ REGIME_CHANGE      24h 가격 변동 > 3%      (긴급 1h)  │
     │  ├─ LOW_TRADE_FREQUENCY 일 10건 미만            (2h)      │
     │  ├─ POOR_WIN_RATE      3일 승률 < 40%          (2h)      │
     │  ├─ STAGNATION         4시간+ 무거래            (2h)      │
     │  ├─ DAILY_REVIEW       UTC 0:00 일봉 마감       (2h)      │
     │  └─ WEEKLY_RESEARCH    연구 3일 경과            (3d)      │
     └────────────────────┬────────────────────────────────────┘
                          │
                          ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                   run-batch.sh 파이프라인                      │
  │                                                              │
  │  캔들 수집 → 메트릭 → Claude 분석 → 파싱 → 분기:               │
  │  ├─ keep ──── 메모리 기록 후 종료                               │
  │  ├─ modify ── 파라미터 수정 → 백테스트 게이트 → PM2 재시작       │
  │  ├─ replace ─ 멀티변형 백테스트 → 최고 성과 배포 (최대 3회 재시도) │
  │  └─ experiment ── 가설 등록 → 섀도우 페이퍼 트레이딩              │
  │                                                              │
  │  보수화 드리프트 방지:                                          │
  │  ├─ entryThreshold 0.25 초과 금지                              │
  │  ├─ 거래 빈도가 기존 50% 미만인 전략은 게이트 차단                 │
  │  └─ 3회 연속 keep → 다음 배치 modify/replace 강제               │
  └──────────────────────────────────────────────────────────────┘
```

## 프로젝트 구조

```
upbit-trading-claude-day-trading/
├── .env                              # Upbit API 키
├── ecosystem.config.js               # PM2 설정 (day-trading-bot + scheduler)
├── trading-config.json               # 동적 종목 + 리스크 설정
├── bot-state.json                    # 봇 상태 (보유 자산)
│
├── src/
│   ├── core/                         # 핵심 서비스
│   │   ├── day-trading-bot.js        #   메인 봇 (5초 분석 루프, WebSocket)
│   │   ├── websocket-client.js       #   Upbit WebSocket 클라이언트
│   │   ├── candle-manager.js         #   실시간 1m/5m 캔들 생성
│   │   ├── candle-store.js           #   7일 롤링 캔들 저장소
│   │   ├── risk-manager.js           #   ATR 손절 + 트레일링 익절 + 일일 한도
│   │   ├── market-selector.js        #   동적 마켓 선택 (24h 거래량 TOP N)
│   │   ├── upbit-api.js              #   Upbit REST API 래퍼
│   │   └── indicators.js             #   기술 지표 라이브러리
│   │
│   ├── strategies/
│   │   ├── scalping-strategy.js      #   7시그널 스캘핑 전략 (배치가 교체)
│   │   ├── current-strategy.js       #   레거시 스윙 전략 (참고용)
│   │   └── custom-indicators.js      #   커스텀 지표 (Claude 관리)
│   │
│   ├── batch/
│   │   ├── pipeline/                 # 오케스트레이션
│   │   │   ├── batch-scheduler.js    #   5분 주기 트리거 스케줄러
│   │   │   ├── run-batch.sh          #   전략 파이프라인
│   │   │   ├── run-infra-fix.sh      #   인프라 수정 파이프라인
│   │   │   └── run-research.sh       #   연구 파이프라인
│   │   │
│   │   ├── prompt/                   # Claude 입출력
│   │   │   ├── build-prompt.js       #   스캘핑 맞춤 프롬프트 + 보수화 방지
│   │   │   ├── parse-response.js     #   응답 파싱 + 검증
│   │   │   ├── build-retry-prompt.js #   게이트 실패 재시도
│   │   │   └── diagnose-failure.js   #   실패 원인 진단
│   │   │
│   │   ├── eval/                     # 평가 & 배포
│   │   │   ├── scalping-backtest.js  #   1m/5m 스캘핑 백테스트 엔진
│   │   │   ├── backtest.js           #   레거시 백테스트 (게이트 비교)
│   │   │   ├── deploy.js             #   안전 배포 (스캘핑 인터페이스 지원)
│   │   │   └── collect-metrics.js    #   메트릭 수집
│   │   │
│   │   └── learning/                 # 학습 & 실험
│   │       ├── update-memory.js      #   배치 메모리 + 지식 관리
│   │       ├── performance-tracker.js#   일별 P&L vs BTC 벤치마크
│   │       ├── experiment-manager.js #   실험 라이프사이클
│   │       └── shadow-manager.js     #   섀도우 전략 페이퍼 트레이딩
│   │
│   └── utils/
│       └── logger.js                 #   구조화된 로깅
│
├── data/
│   ├── candles/                      # 7일 롤링 1m/5m 캔들 히스토리
│   ├── metrics/                      # 배치 메트릭 스냅샷
│   ├── batch-memory.json             # 배치 결정 + 구조화 지식
│   ├── daily-stats.json              # 일별 거래 통계
│   ├── performance-ledger.json       # 일별 포트폴리오 성과
│   └── execution-log.json            # 실행 로그
│
├── tests/                            # 110개 테스트
│   ├── candle-manager.test.js
│   ├── candle-store.test.js
│   ├── risk-manager.test.js
│   ├── scalping-strategy.test.js
│   ├── scalping-backtest.test.js
│   ├── websocket-client.test.js
│   ├── indicators.test.js
│   ├── market-selector.test.js
│   └── batch-integration.test.js
│
├── backups/                          # 전략 백업
└── logs/
    └── batch/                        # 배치 실행 로그
```

## 스캘핑 전략 — 7 시그널 복합 분석

| # | 시그널 | 가중치 | BUY 조건 | SELL 조건 |
|---|--------|--------|----------|-----------|
| 1 | EMA 5/13 교차 | 20% | 골든크로스 | 데드크로스 |
| 2 | RSI(6) | 15% | < 30 과매도 | > 70 과매수 |
| 3 | Bollinger Band | 12% | 하단 터치 | 상단 터치 |
| 4 | VWAP 이탈 | 12% | VWAP 아래 | VWAP 위 |
| 5 | MACD(6,13,5) | 13% | 히스토그램 + | 히스토그램 - |
| 6 | 거래량 스파이크 | 13% | 2x 이상 시 강화 | 2x 이상 시 강화 |
| 7 | 호가창 불균형 | 15% | 매수벽 > 1.5x | 매도벽 > 1.5x |

- **5분 트렌드 필터**: 역추세 진입 시 0.75배 페널티
- **진입 임계값**: netScore >= 0.15 (BUY) / <= -0.15 (SELL)

## 리스크 관리

| 기능 | 설명 |
|------|------|
| **ATR 동적 손절** | SL = ATR × 1.5 (코인별 변동성 맞춤) |
| **트레일링 익절** | ATR × 2.0 도달 시 활성화, 피크에서 0.2% 하락 시 청산 |
| **최소 수익 필터** | 전략 SELL 시 P&L >= 0.15% 필수 (수수료 보호) |
| **일일 손실 한도** | -3% 도달 시 당일 거래 중단 |
| **동적 스로틀링** | 30분 윈도우에서 0.5% 이상 손실 시 5분 일시정지 |
| **일일 거래 한도** | 최대 1000건/일 |

## 보수화 드리프트 방지

배치가 전략을 점점 보수적으로 만드는 악순환을 3중으로 방지:

| 계층 | 메커니즘 |
|------|----------|
| **스케줄러** | `LOW_TRADE_FREQUENCY` — 일 10건 미만 시 배치 강제 실행 |
| **프롬프트** | 일 20건 미만 or threshold > 0.3 → "더 공격적으로" 강제 지시, 0.25 초과 금지 |
| **백테스트 게이트** | 새 전략 거래량이 기존 50% 미만이면 배포 차단 |

## 설치 및 실행

### 사전 요구사항

- Node.js 22+
- PM2 (`npm install -g pm2`)
- Claude CLI (`claude` 명령어 사용 가능)
- Upbit API 키

### 설치

```bash
git clone git@github.com:CodeCatttt/upbit-trading-claude-shorthit.git
cd upbit-trading-claude-shorthit
npm install
```

### 환경 변수 설정

```bash
cat > .env << 'EOF'
UPBIT_ACCESS_KEY=your_access_key
UPBIT_SECRET_KEY=your_secret_key
DISCORD_BOT_TOKEN=your_discord_bot_token    # 선택사항
DISCORD_CHANNEL_ID=your_channel_id          # 선택사항
EOF
```

### 봇 시작

```bash
pm2 start ecosystem.config.js
pm2 save
```

> 별도 crontab 불필요. `batch-scheduler`가 5분마다 트리거를 체크하고, 봇이 자동으로 마켓을 선택하고 캔들을 수집합니다.

## 운영 명령어

```bash
# 상태 확인
pm2 list
pm2 logs upbit-day-trading-bot --lines 20
pm2 logs batch-scheduler --lines 20

# 하트비트 확인
cat data/bot-heartbeat.json | jq '.'

# 일별 통계
cat data/daily-stats.json | jq '.[-5:]'

# 수동 배치 실행
bash src/batch/pipeline/run-batch.sh

# 테스트
npm test

# 캔들 저장소 현황
node -e "const s=require('./src/core/candle-store');console.log(JSON.stringify(s.getStoreStats(),null,2))"
```

## 기술 스택

- **Runtime**: Node.js 22+
- **Process Manager**: PM2
- **AI**: Claude CLI (Opus 4.6)
- **Exchange**: Upbit REST API + WebSocket
- **Real-time**: `ws` (WebSocket 클라이언트)
- **Scheduling**: 트리거 기반 배치 스케줄러 (5분) + setInterval (봇 5초)
- **Testing**: Node.js native test runner (110 tests)
- **Notifications**: Discord Bot API (선택사항)
