/**
 * build-infra-prompt.js
 * Assembles the infrastructure fix prompt for Claude.
 * Collects PM2 status, error logs, batch memory notes, and relevant source files
 * to help Claude diagnose and fix infrastructure issues.
 *
 * Trigger modes:
 *   PM2_CRASH          — 긴급: 프로세스 크래시 감지
 *   WEEKLY_MAINTENANCE  — 정기 점검
 *
 * Usage: node build-infra-prompt.js [triggerType]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('../../utils/logger');

const log = createLogger('BUILD-INFRA-PROMPT');

const PROJECT_DIR = path.join(__dirname, '../../..');
const MEMORY_FILE = path.join(PROJECT_DIR, 'data/batch-memory.json');
const CLAUDE_MD_FILE = path.join(PROJECT_DIR, 'CLAUDE.md');
const PM2_LOG_DIR = path.join(process.env.HOME, '.pm2/logs');

const MAX_PROMPT_CHARS = 100000;

// --- Data loaders ---

function loadJSON(fp, fallback) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return fallback;
}

function loadMemory() {
    return loadJSON(MEMORY_FILE, { entries: [], knowledge: { confirmed: [], hypotheses: [], rejected: [] } });
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

// --- Section builders ---

function buildRoleSection(triggerType) {
    const triggerDescriptions = {
        PM2_CRASH: '긴급: 프로세스 크래시 감지. 즉시 원인 분석 및 수정 필요.',
        WEEKLY_MAINTENANCE: '정기 점검. 잠재적 버그, 성능 이슈, 안정성 개선 탐색.',
    };

    const description = triggerDescriptions[triggerType] || triggerDescriptions.WEEKLY_MAINTENANCE;

    return `You are an infrastructure engineer for the Upbit trading bot.
역할: Upbit 트레이딩 봇 인프라 엔지니어. 버그 발견 및 수정 담당.

**인프라 트리거**: ${triggerType}
${description}`;
}

function buildPM2StatusSection() {
    const lines = ['## PM2 프로세스 상태'];

    try {
        const raw = execSync('pm2 jlist', { encoding: 'utf8', timeout: 10000 });
        const processes = JSON.parse(raw);

        if (processes.length === 0) {
            lines.push('PM2 프로세스 없음.');
            return lines.join('\n');
        }

        for (const proc of processes) {
            const name = proc.name || 'unknown';
            const status = proc.pm2_env?.status || 'unknown';
            const restarts = proc.pm2_env?.restart_time || 0;
            const uptime = proc.pm2_env?.pm_uptime
                ? Math.round((Date.now() - proc.pm2_env.pm_uptime) / 1000 / 60) + 'min'
                : 'N/A';
            const memory = proc.monit?.memory
                ? Math.round(proc.monit.memory / 1024 / 1024) + 'MB'
                : 'N/A';

            lines.push(`- **${name}**: status=${status}, restarts=${restarts}, uptime=${uptime}, memory=${memory}`);
        }
    } catch (e) {
        lines.push(`PM2 상태 조회 실패: ${e.message}`);
    }

    return lines.join('\n');
}

function buildErrorLogSection() {
    const logFiles = [
        { name: 'upbit-trading-bot', file: 'upbit-trading-bot-error.log' },
        { name: 'batch-scheduler', file: 'batch-scheduler-error.log' },
    ];

    const MAX_ERROR_LOG_CHARS = 20000;
    const lines = ['## PM2 에러 로그 (최근)'];
    let totalChars = 0;

    for (const { name, file } of logFiles) {
        const logPath = path.join(PM2_LOG_DIR, file);
        const content = readFileSafe(logPath, 100);

        if (content === null) {
            lines.push(`\n### ${name}\n파일 없음: ${file}`);
            continue;
        }

        let trimmed = content.trim();
        if (trimmed.length === 0) {
            lines.push(`\n### ${name}\n에러 로그 비어 있음.`);
            continue;
        }

        // Enforce per-section budget
        const remaining = MAX_ERROR_LOG_CHARS - totalChars;
        if (remaining < 500) {
            lines.push(`\n### ${name}\n(용량 제한으로 생략)`);
            continue;
        }
        if (trimmed.length > remaining) {
            trimmed = trimmed.slice(-remaining);
        }

        lines.push(`\n### ${name}`);
        lines.push('```');
        lines.push(trimmed);
        lines.push('```');
        totalChars += trimmed.length;
    }

    return lines.join('\n');
}

function buildBatchMemoryInfraSection(memory) {
    const infraKeywords = /버그|bug|error|crash|에러|fix|수정필요|null|undefined|NaN/i;

    const lines = ['## 배치 메모리 인프라 관련 노트'];

    const relevant = (memory.entries || []).filter(e =>
        e.notes && infraKeywords.test(e.notes)
    );

    if (relevant.length === 0) {
        lines.push('인프라 관련 노트 없음.');
        return lines.join('\n');
    }

    for (const entry of relevant.slice(-10)) {
        lines.push(`- [${entry.timestamp}] **${entry.action}**: ${entry.notes.slice(0, 300)}`);
    }

    return lines.join('\n');
}

function buildKnowledgeInfraSection(memory) {
    const infraKeywords = /버그|bug|error|crash|에러|fix|수정|infra|PM2|restart|null|undefined|NaN|메모리|memory|leak|timeout/i;
    const knowledge = memory.knowledge || { confirmed: [], hypotheses: [], rejected: [] };

    const lines = ['## 인프라 관련 학습 기록'];

    const confirmedInfra = (knowledge.confirmed || []).filter(k =>
        infraKeywords.test(k.insight || '') || infraKeywords.test(k.evidence || '')
    );
    const hypothesesInfra = (knowledge.hypotheses || []).filter(h =>
        infraKeywords.test(h.hypothesis || '')
    );

    if (confirmedInfra.length === 0 && hypothesesInfra.length === 0) {
        lines.push('인프라 관련 학습 기록 없음.');
        return lines.join('\n');
    }

    if (confirmedInfra.length > 0) {
        lines.push('\n### 검증된 인프라 사실');
        for (const k of confirmedInfra) {
            lines.push(`- ${k.insight} (근거: ${k.evidence})`);
        }
    }

    if (hypothesesInfra.length > 0) {
        lines.push('\n### 인프라 관련 가설');
        for (const h of hypothesesInfra) {
            lines.push(`- [${h.status}] ${h.hypothesis}`);
        }
    }

    return lines.join('\n');
}

function extractReferencedFilePaths(errorLogContent) {
    if (!errorLogContent) return [];

    const fileRegex = /(?:src\/[^\s:)]+\.(?:js|sh))/g;
    const matches = errorLogContent.match(fileRegex) || [];

    // Count frequency
    const freq = {};
    for (const m of matches) {
        const normalized = m.replace(/:\d+/g, ''); // strip line numbers
        freq[normalized] = (freq[normalized] || 0) + 1;
    }

    // Sort by frequency descending, take top 5
    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([filePath, count]) => ({ filePath, count }));
}

function buildRelevantSourceSection() {
    const lines = ['## 에러 로그에서 참조된 소스 파일'];

    // Gather all error log content
    const logFiles = [
        'upbit-trading-bot-error.log',
        'batch-scheduler-error.log',
    ];

    let allLogContent = '';
    for (const file of logFiles) {
        const content = readFileSafe(path.join(PM2_LOG_DIR, file), 200);
        if (content) allLogContent += content + '\n';
    }

    const referenced = extractReferencedFilePaths(allLogContent);

    if (referenced.length === 0) {
        lines.push('에러 로그에서 참조된 소스 파일 없음.');
        return lines.join('\n');
    }

    lines.push(`에러 빈도 순 상위 ${referenced.length}개 파일:\n`);

    let totalSourceChars = 0;
    const SOURCE_BUDGET = 40000; // reserve budget for source files

    for (const { filePath, count } of referenced) {
        const fullPath = path.join(PROJECT_DIR, filePath);

        if (!fs.existsSync(fullPath)) {
            lines.push(`### ${filePath} (참조 ${count}회) — 파일 없음`);
            continue;
        }

        const content = readFileSafe(fullPath);
        if (!content) continue;

        // Budget check: truncate if needed
        if (totalSourceChars + content.length > SOURCE_BUDGET) {
            const remaining = SOURCE_BUDGET - totalSourceChars;
            if (remaining < 500) {
                lines.push(`\n### ${filePath} (참조 ${count}회) — 용량 제한으로 생략`);
                continue;
            }
            lines.push(`\n### ${filePath} (참조 ${count}회, 일부 생략)`);
            lines.push('```javascript');
            lines.push(content.slice(0, remaining));
            lines.push('```');
            totalSourceChars += remaining;
        } else {
            lines.push(`\n### ${filePath} (참조 ${count}회)`);
            const ext = path.extname(filePath);
            const lang = ext === '.sh' ? 'bash' : 'javascript';
            lines.push('```' + lang);
            lines.push(content);
            lines.push('```');
            totalSourceChars += content.length;
        }
    }

    return lines.join('\n');
}

function buildArchitectureSection() {
    const lines = ['## 아키텍처 요약 (CLAUDE.md)'];

    const content = readFileSafe(CLAUDE_MD_FILE);
    if (!content) {
        lines.push('CLAUDE.md 파일을 읽을 수 없음.');
        return lines.join('\n');
    }

    // Include first ~3000 chars
    const summary = content.slice(0, 3000);
    lines.push(summary);
    if (content.length > 3000) {
        lines.push('\n... (이하 생략)');
    }

    return lines.join('\n');
}

function buildConstraintsSection() {
    return `## Constraints
- 수정 가능: src/ 하위 파일 (current-strategy.js, custom-indicators.js 제외)
- 수정 불가: .env, data/, node_modules/, backups/
- 최대 3개 파일 수정 가능
- 각 수정 파일은 \`\`\`file:relative/path\`\`\` 코드 블록으로 전체 파일 내용 제공
- 새 파일 생성은 src/ 하위에서만 허용
- 전략 파일(current-strategy.js, custom-indicators.js)은 절대 수정 금지`;
}

function buildResponseFormatSection() {
    return `## Response Format
**모든 응답은 한국어로 작성하세요.**

간결한 분석 후 JSON 결정을 출력하세요:

\`\`\`json
{
  "action": "fix" | "no_action",
  "reasoning": "한국어 사유",
  "confidence": 0.0~1.0,
  "fixes": [
    {
      "file": "src/core/bot.js",
      "description": "수정 내용 설명",
      "severity": "critical|important|minor"
    }
  ],
  "knowledge": {
    "confirmed": [{"insight": "...", "evidence": "..."}],
    "hypotheses": [{"hypothesis": "...", "status": "proposed"}],
    "rejected": [{"hypothesis": "...", "reason": "..."}]
  },
  "notes": "다음 인프라 체크를 위한 메모"
}
\`\`\`

- action="fix" 시: fixes 배열에 수정 파일 목록, 각 파일은 \`\`\`file:경로\`\`\` 코드 블록으로 전체 내용 출력
- action="no_action" 시: fixes 비어있거나 생략 가능
- 최대 3개 파일 수정
- 각 코드 블록은 해당 파일의 **전체 내용**을 포함 (diff가 아닌 완전한 파일)

예시:
\`\`\`file:src/core/bot.js
// ... 전체 파일 내용 ...
\`\`\``;
}

// --- Main build function ---

function buildInfraPrompt(triggerType) {
    triggerType = triggerType || process.env.INFRA_TRIGGER || 'WEEKLY_MAINTENANCE';

    if (!['PM2_CRASH', 'WEEKLY_MAINTENANCE'].includes(triggerType)) {
        log.warn(`Unknown trigger type: ${triggerType}, defaulting to WEEKLY_MAINTENANCE`);
        triggerType = 'WEEKLY_MAINTENANCE';
    }

    const memory = loadMemory();

    const sections = [];

    // 1. Role definition + trigger context
    sections.push(buildRoleSection(triggerType));

    // 2. PM2 process status
    sections.push(buildPM2StatusSection());

    // 3. PM2 error logs
    sections.push(buildErrorLogSection());

    // 4. Batch memory infra notes
    sections.push(buildBatchMemoryInfraSection(memory));

    // 5. Known issues from knowledge base
    sections.push(buildKnowledgeInfraSection(memory));

    // 6. Relevant source files (from error log references)
    sections.push(buildRelevantSourceSection());

    // 7. Architecture summary
    sections.push(buildArchitectureSection());

    // 8. Constraints
    sections.push(buildConstraintsSection());

    // 9. Response format
    sections.push(buildResponseFormatSection());

    let prompt = sections.join('\n\n');

    // Enforce total prompt size limit — preserve tail (constraints + response format)
    if (prompt.length > MAX_PROMPT_CHARS) {
        log.warn(`Prompt exceeds ${MAX_PROMPT_CHARS} chars (${prompt.length}), truncating middle`);
        const tail = sections.slice(-2).join('\n\n'); // constraints + response format
        const headBudget = MAX_PROMPT_CHARS - tail.length - 100;
        const head = sections.slice(0, -2).join('\n\n').slice(0, headBudget);
        prompt = head + '\n\n... (프롬프트 용량 제한으로 중간 생략)\n\n' + tail;
    }

    return prompt;
}

if (require.main === module) {
    const triggerType = process.argv[2] || undefined;
    const prompt = buildInfraPrompt(triggerType);
    process.stdout.write(prompt);
}

module.exports = { buildInfraPrompt };
