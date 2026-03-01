# upbit-trading-claude

Upbit 멀티에셋 자동매매 봇 + Claude 기반 자율 전략 개선 시스템.

단일 자산 100% 보유 원칙 하에, 트리거 기반 배치 스케줄러가 시장 상황을 감지하면 Claude(Opus)가 전략을 분석/개선하고, 백테스트 게이트를 통과한 변경만 배포합니다.

## 아키텍처

```
┌──────────────────────────────────────────────────────────────┐
│                 PM2: batch-scheduler (15분 체크)               │
│                                                               │
│  트리거 감지                                                    │
│  ├─ REGIME_CHANGE    24h 가격 변동 > 5%                        │
│  ├─ DRAWDOWN_ALERT   포트폴리오 MDD > 8%                       │
│  ├─ STAGNATION       7일+ 무거래                               │
│  ├─ DAILY_REVIEW     UTC 0:00 일봉 마감                        │
│  └─ EXPERIMENT_REVIEW 실험 기간 도래                            │
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │                  run-batch.sh 파이프라인                   │ │
│  │                                                          │ │
│  │  캔들수집 → 메트릭 → Claude 호출 → 파싱 → 백테스트 → 배포   │ │
│  │       ↑                                    │              │ │
│  │       └──── 게이트 실패 시 재시도 (최대 2회) ─┘              │ │
│  │                                                          │ │
│  │  replace: 멀티변형 (최대 3개) → 독립 백테스트 → 최고 선택    │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│              PM2: upbit-trading-bot (24/7 상시)                │
│                                                               │
│  15분마다 current-strategy.js → onNewCandle() 호출             │
│  ├─ SWITCH(targetMarket): 매도 → 매수 (market / smart entry)  │
│  ├─ SWITCH(CASH): trailing stop / crash detection → 현금 전환  │
│  ├─ HOLD: 포지션 유지                                          │
│  └─ NONE: 데이터 부족, 액션 없음                                │
│                                                               │
│  + 섀도우 전략 페이퍼 트레이딩 병렬 실행                          │
└──────────────────────────────────────────────────────────────┘
```

## 프로젝트 구조

```
upbit-trading-claude/
├── .env                          # Upbit API 키
├── ecosystem.config.js           # PM2 설정 (bot + scheduler)
├── trading-config.json           # 동적 종목 + 인터벌 설정
├── bot-state.json                # 봇 상태 (보유 자산)
├── deploy-log.json               # 배포 이력
│
├── src/
│   ├── core/                     # 핵심 서비스
│   │   ├── bot.js                # 매매 봇 (PM2, 15분 cron, 멀티에셋)
│   │   ├── upbit-api.js          # Upbit REST API 래퍼
│   │   └── indicators.js         # 기술 지표 라이브러리
│   │
│   ├── batch/                    # 배치 파이프라인 (flat)
│   │   ├── run-batch.sh          # 파이프라인 오케스트레이터
│   │   ├── batch-scheduler.js    # 트리거 기반 적응형 스케줄러
│   │   ├── build-prompt.js       # 트리거별 포커스드 프롬프트 조립
│   │   ├── collect-metrics.js    # 강화 메트릭 (Sharpe, 승률, 오더북 등)
│   │   ├── parse-response.js     # 응답 파싱 + 코드/종목 검증
│   │   ├── backtest.js           # 멀티타임프레임 백테스트 + 슬리피지
│   │   ├── deploy.js             # 안전 배포 + 드라이런 + 자동 롤백
│   │   ├── apply-modify.js       # 파라미터 수정 적용
│   │   ├── notify.js             # Discord 알림
│   │   ├── update-memory.js      # 배치 메모리 + 구조화 지식 관리
│   │   ├── build-retry-prompt.js # 게이트 실패 재시도 프롬프트
│   │   ├── diagnose-failure.js   # 게이트 실패 진단
│   │   ├── performance-tracker.js# 일별 P&L vs BTC 벤치마크
│   │   ├── experiment-manager.js # 실험 라이프사이클 관리
│   │   └── shadow-manager.js     # 섀도우 전략 페이퍼 트레이딩
│   │
│   ├── data/
│   │   ├── candle-fetcher.js     # 동적 종목 캔들 수집 (페이지네이션)
│   │   └── candle-store.js       # JSON 캔들 저장/병합/중복제거
│   │
│   ├── execution/
│   │   └── smart-entry.js        # 스마트 진입 (RSI dip, pullback, Bollinger)
│   │
│   ├── strategies/
│   │   ├── current-strategy.js   # 현재 활성 전략 (배치가 교체)
│   │   ├── custom-indicators.js  # 커스텀 지표 (Claude 관리)
│   │   └── strategy-ou-process.js# OU 프로세스 전략 (참조용)
│   │
│   └── utils/
│       ├── adf-test.js           # Augmented Dickey-Fuller 검정
│       ├── discord.js            # Discord 봇 API
│       └── logger.js             # 구조화된 로깅
│
├── data/
│   ├── candles/                  # 종목별 × 인터벌별 캔들 (최대 10000개)
│   ├── metrics/                  # 배치 메트릭 스냅샷
│   ├── backtest-results/         # 백테스트 결과
│   ├── batch-memory.json         # 배치 결정 기록 + 구조화 지식
│   ├── performance-ledger.json   # 일별 포트폴리오 성과
│   ├── experiments.json          # 실험 관리
│   ├── execution-log.json        # 실행 로그 (최대 100건)
│   ├── shadow-strategies/        # 섀도우 전략 파일
│   └── shadow-performance.json   # 섀도우 전략 성과
│
├── backups/                      # 전략 백업 (배포 전 자동 생성)
└── logs/
    └── batch/                    # 배치 실행 로그
```

## 설치 및 실행

### 사전 요구사항

- Node.js 18+
- PM2 (`npm install -g pm2`)
- Claude CLI (`claude` 명령어 사용 가능)
- Upbit API 키

### 설치

```bash
git clone git@github.com:CodeCatttt/upbit-trading-claude.git
cd upbit-trading-claude
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
# 초기 캔들 데이터 수집 (최초 1회)
node src/data/candle-fetcher.js

# PM2로 봇 + 배치 스케줄러 시작
pm2 start ecosystem.config.js
pm2 save
```

> **Note**: 별도 crontab 등록 불필요. `batch-scheduler`가 PM2 프로세스로 트리거 기반 배치를 자동 실행합니다.

## 배치 파이프라인

트리거 조건이 감지되면 `run-batch.sh`가 순차 실행:

```
Step 0    캔들 수집        동적 종목 × 인터벌 조합 캔들 수집
Step 1    메트릭 수집      잔고, 시세, Sharpe, 승률, 오더북, 거래 강도
Step 2    Claude 호출      트리거별 포커스드 프롬프트 + 종목 관리 지시
Step 3    응답 파싱        JSON 결정 + JS 코드 추출, 인터페이스 검증
Step 3.5  종목 갱신        markets 필드가 있으면 trading-config.json 업데이트
Step 4    백테스트         현재 vs 신규 전략 (슬리피지 + 수수료, walk-forward)
Step 5    배포             드라이런 → 백업 → 교체 → PM2 재시작 → 헬스체크 → (실패 시 롤백)
Step 6    git commit/push  변경사항 버전관리
```

### Claude의 4가지 선택지

| 결정 | 설명 | 후속 동작 |
|------|------|-----------|
| **keep** | 현재 전략 유지 | 종료 |
| **modify** | 파라미터만 조정 | DEFAULT_CONFIG 값 교체 → git commit |
| **replace** | 전략 전체 교체 | 멀티변형 백테스트 → 배포 → git commit & push |
| **experiment** | 실험 제안 | 가설 등록 → 섀도우/파라미터 테스트 시작 |

### 자율 개선 메커니즘

- **재시도 루프**: replace 게이트 실패 시 `diagnose-failure.js`로 원인 분석 후 최대 2회 재시도
- **멀티변형**: replace 시 최대 3개 전략 변형 제출, 모두 독립 백테스트 → 최고 성과 선택
- **배치 메모리**: 최근 50개 결정 기록 + 구조화 지식(confirmed/hypotheses/rejected) 추적

## 성과 추적

- **일별 기록**: 포트폴리오 가치, BTC 벤치마크, 알파, MDD (`data/performance-ledger.json`)
- **배치 프롬프트에 요약 포함**: totalReturn, btcReturn, alpha, maxMdd, winRate
- `collect-metrics.js` 실행 시 자동 기록 (idempotent)

## 실험 프레임워크

구조화된 가설 → 테스트 → 학습 사이클:

- 최대 2개 동시 실험
- 유형: `parameter_test` (파라미터 A/B), `shadow_strategy` (섀도우 전략 비교)
- 완료된 실험은 배치 메모리에 confirmed/rejected 지식으로 축적

## 섀도우 전략

- 새 전략을 실제 자금 없이 7일간 페이퍼 트레이딩
- 봇이 매 15분 틱마다 섀도우 전략도 병렬 실행
- 성과 우수 시 라이브 전략으로 승격, 미달 시 폐기

## 안전장치

| 장치 | 설명 |
|------|------|
| 티어드 백테스트 게이트 | replace: 수익률 diff >= -1%, MDD <= 3% 악화, 일일거래 <= 6 |
| Walk-forward 검증 | 70/30 분할, TEST 구간 기준 평가 |
| 슬리피지 모델 | 0.1% (market) / 0.05% (smart) + 0.05% 수수료 per side |
| 드라이런 검증 | 배포 전 실제 캔들로 100회 반복 실행, 런타임 에러 차단 |
| 구문/인터페이스 검증 | `node -c` + `require()` + mock `onNewCandle()` |
| PM2 헬스체크 + 자동 롤백 | 배포 후 30초 내 재시작 감지 시 백업 복원 |
| Atomic state write | tmp + rename으로 파일 손상 방지 |
| 종목 보호 | 보유 중인 종목은 markets 리스트에서 자동 유지 |
| 재시도 루프 | 게이트 실패 시 진단 기반 최대 2회 자동 재시도 |

## 운영 명령어

```bash
# 봇 상태 확인
pm2 list
pm2 logs upbit-trading-bot --lines 20
pm2 logs batch-scheduler --lines 20

# 하트비트 확인
cat data/bot-heartbeat.json

# 수동 배치 실행
bash src/batch/run-batch.sh

# 수동 백테스트
node src/batch/backtest.js

# 수동 캔들 수집
node src/data/candle-fetcher.js

# 수동 메트릭 수집
node src/batch/collect-metrics.js

# 성과 요약
node src/batch/performance-tracker.js --summary

# 배포 이력 / 관심 종목 확인
cat deploy-log.json | jq '.'
cat trading-config.json | jq '.'
```

## 기술 스택

- **Runtime**: Node.js
- **Process Manager**: PM2
- **AI**: Claude CLI (Opus 4.6)
- **Exchange**: Upbit REST API
- **Scheduling**: 트리거 기반 배치 스케줄러 (PM2) + node-cron (봇 15분 틱)
- **Notifications**: Discord Bot API (선택사항)
