/**
 * deploy.js
 * Safe deployment with backup, PM2 restart, health check, and auto-rollback.
 *
 * Usage: node deploy.js <path-to-new-strategy.js>
 * Or require and call deploy(strategyCode, backtestResult)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('../../utils/logger');

const log = createLogger('DEPLOY');

const PROJECT_ROOT = path.join(__dirname, '../../..');
const SCALPING_STRATEGY = path.join(__dirname, '../../strategies/scalping-strategy.js');
const CURRENT_STRATEGY = path.join(__dirname, '../../strategies/current-strategy.js');
const CUSTOM_INDICATORS = path.join(__dirname, '../../strategies/custom-indicators.js');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');
const DEPLOY_LOG_FILE = path.join(PROJECT_ROOT, 'deploy-log.json');
const HEARTBEAT_FILE = path.join(PROJECT_ROOT, 'data/bot-heartbeat.json');
const HEALTH_CHECK_WAIT_MS = 30000;
const PM2_NAME = 'upbit-day-trading-bot';

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeReadJSON(fp) {
    try {
        if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {}
    return null;
}

function getDeployLog() {
    return safeReadJSON(DEPLOY_LOG_FILE) || [];
}

function appendDeployLog(entry) {
    const log = getDeployLog();
    log.push(entry);
    fs.writeFileSync(DEPLOY_LOG_FILE, JSON.stringify(log, null, 2));
}

function checkBotHealth() {
    const hb = safeReadJSON(HEARTBEAT_FILE);
    if (!hb) {
        log.warn('No heartbeat file found');
        return false;
    }
    const age = (Date.now() - new Date(hb.timestamp).getTime()) / 1000;
    if (age > 1200) {
        log.warn(`Bot heartbeat stale: ${age.toFixed(0)}s old`);
        return false;
    }
    return true;
}

function backupCurrentStrategy() {
    ensureDir(BACKUP_DIR);
    if (!fs.existsSync(CURRENT_STRATEGY)) return null;

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `strategy-${ts}.js`);
    fs.copyFileSync(CURRENT_STRATEGY, backupPath);
    log.info(`Backed up current strategy to: ${backupPath}`);

    // Also backup custom-indicators.js
    if (fs.existsSync(CUSTOM_INDICATORS)) {
        const ciBackupPath = path.join(BACKUP_DIR, `custom-indicators-${ts}.js`);
        fs.copyFileSync(CUSTOM_INDICATORS, ciBackupPath);
        log.info(`Backed up custom indicators to: ${ciBackupPath}`);
    }

    return backupPath;
}

function restartPM2() {
    try {
        execSync(`pm2 restart ${PM2_NAME}`, { stdio: 'pipe' });
        log.info('PM2 restart successful');
        return true;
    } catch (e) {
        log.error('PM2 restart failed:', e.message);
        return false;
    }
}

function getPM2RestartCount() {
    try {
        const output = execSync(`pm2 jlist`, { encoding: 'utf8' });
        const processes = JSON.parse(output);
        const bot = processes.find(p => p.name === PM2_NAME);
        return bot ? bot.pm2_env.restart_time : -1;
    } catch {
        return -1;
    }
}

function checkPM2Status(restartsBefore) {
    try {
        const output = execSync(`pm2 jlist`, { encoding: 'utf8' });
        const processes = JSON.parse(output);
        const bot = processes.find(p => p.name === PM2_NAME);
        if (!bot) {
            log.error('Bot process not found in PM2');
            return false;
        }
        if (bot.pm2_env.status !== 'online') {
            log.error(`Bot status: ${bot.pm2_env.status}`);
            return false;
        }
        const newRestarts = bot.pm2_env.restart_time - restartsBefore;
        if (newRestarts > 3) {
            log.error(`Too many new restarts since deploy: ${newRestarts} (before: ${restartsBefore}, now: ${bot.pm2_env.restart_time})`);
            return false;
        }
        log.info(`PM2 status OK: ${bot.pm2_env.status}, new restarts since deploy: ${newRestarts}`);
        return true;
    } catch (e) {
        log.error('PM2 status check failed:', e.message);
        return false;
    }
}

function preDeployValidation(strategyCode) {
    log.info('Running pre-deploy dry-run validation...');
    const tmpFile = path.join(__dirname, '../../strategies/.tmp-dryrun-strategy.js');
    const errors = [];

    try {
        fs.writeFileSync(tmpFile, strategyCode);

        // Clear require cache
        delete require.cache[require.resolve(tmpFile)];
        const mod = require(tmpFile);

        // Detect strategy type: scalping (analyze) vs legacy (onNewCandle)
        const isScalping = typeof mod.analyze === 'function';
        const isLegacy = typeof mod.onNewCandle === 'function' && typeof mod.createStrategyState === 'function';

        if (!isScalping && !isLegacy) {
            errors.push('Missing required exports (analyze for scalping or createStrategyState+onNewCandle for legacy)');
            try { fs.unlinkSync(tmpFile); } catch {}
            return { pass: false, errors };
        }

        // Load real candle data for dry-run
        const candleDir = path.join(PROJECT_ROOT, 'data/candles');
        const candleData = {};
        if (fs.existsSync(candleDir)) {
            const files = fs.readdirSync(candleDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const match = file.match(/^(.+)_(\d+)m\.json$/);
                if (!match) continue;
                const [, market, interval] = match;
                if (!candleData[market]) candleData[market] = {};
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(candleDir, file), 'utf8'));
                    candleData[market][parseInt(interval)] = data.slice(-200);
                } catch {}
            }
        }

        if (isScalping) {
            // Scalping strategy dry-run: needs 1m data
            const markets = Object.keys(candleData).filter(m => candleData[m][1]?.length >= 50 || candleData[m][5]?.length >= 30);
            if (markets.length === 0) {
                log.warn('No sufficient 1m/5m candle data for scalping dry-run, skipping');
                try { fs.unlinkSync(tmpFile); } catch {}
                return { pass: true, errors: [], skipped: true };
            }

            const market = markets[0];
            const candles1m = candleData[market][1] || [];
            const candles5m = candleData[market][5] || [];
            const config = mod.DEFAULT_CONFIG || {};
            let errorCount = 0;

            for (let i = 50; i <= 150 && i <= candles1m.length; i++) {
                try {
                    const slice1m = candles1m.slice(0, i);
                    const slice5m = candles5m.slice(0, Math.max(1, Math.floor(i / 5)));
                    const result = mod.analyze(slice1m, slice5m, config);
                    if (!result || !result.action) {
                        errorCount++;
                        if (errorCount >= 5) {
                            errors.push(`analyze returned invalid result at iteration ${i - 50 + 1}`);
                            break;
                        }
                    } else if (!['BUY', 'SELL', 'HOLD'].includes(result.action)) {
                        errors.push(`Invalid action "${result.action}" at iteration ${i - 50 + 1}`);
                        break;
                    }
                } catch (e) {
                    errors.push(`Runtime error at iteration ${i - 50 + 1}: ${e.message}`);
                    break;
                }
            }
        } else {
            // Legacy strategy dry-run
            const markets = Object.keys(candleData).filter(m => candleData[m][15]?.length >= 50);
            if (markets.length === 0) {
                log.warn('No sufficient candle data for dry-run, skipping');
                try { fs.unlinkSync(tmpFile); } catch {}
                return { pass: true, errors: [], skipped: true };
            }

            const state = mod.createStrategyState();
            const config = mod.DEFAULT_CONFIG || {};
            let errorCount = 0;

            for (let i = 50; i <= 150 && i <= (candleData[markets[0]][15]?.length || 0); i++) {
                const slicedData = {};
                for (const market of markets) {
                    slicedData[market] = {};
                    if (candleData[market][15]) {
                        slicedData[market][15] = candleData[market][15].slice(0, i);
                    }
                    if (candleData[market][240]) {
                        const ratio = Math.max(1, Math.floor(i / 16));
                        slicedData[market][240] = candleData[market][240].slice(0, ratio);
                    }
                }

                try {
                    const result = mod.onNewCandle(state, slicedData, config);
                    if (!result || !result.action) {
                        errorCount++;
                        if (errorCount >= 5) {
                            errors.push(`onNewCandle returned invalid result at iteration ${i - 50 + 1}`);
                            break;
                        }
                    } else if (!['SWITCH', 'HOLD', 'NONE'].includes(result.action)) {
                        errors.push(`Invalid action "${result.action}" at iteration ${i - 50 + 1}`);
                        break;
                    } else if (result.action === 'SWITCH' && result.details?.targetMarket) {
                        state.assetHeld = result.details.targetMarket;
                    }
                } catch (e) {
                    errors.push(`Runtime error at iteration ${i - 50 + 1}: ${e.message}`);
                    break;
                }
            }
        }

        log.info(`Dry-run complete: ${errors.length === 0 ? 'PASSED' : 'FAILED'}`);
    } catch (e) {
        errors.push(`Dry-run setup error: ${e.message}`);
    }

    try { fs.unlinkSync(tmpFile); } catch {}
    // Clean require cache
    try { delete require.cache[require.resolve(tmpFile)]; } catch {}

    return { pass: errors.length === 0, errors };
}

async function deploy(strategyCode, backtestComparison = null) {
    log.info('=== Starting deployment ===');

    // 0a. Pre-deploy dry-run validation
    const dryRun = preDeployValidation(strategyCode);
    if (!dryRun.pass) {
        log.error('Pre-deploy dry-run FAILED:', dryRun.errors);
        appendDeployLog({
            timestamp: new Date().toISOString(),
            success: false,
            reason: 'dryrun_failed',
            rollback: false,
            dryRunErrors: dryRun.errors,
        });
        return { success: false, reason: 'dryrun_failed', errors: dryRun.errors };
    }

    // Detect strategy type
    const isScalping = strategyCode.includes('analyze') && !strategyCode.includes('onNewCandle');
    const targetFile = isScalping ? SCALPING_STRATEGY : CURRENT_STRATEGY;
    const targetName = isScalping ? 'scalping-strategy.js' : 'current-strategy.js';

    // 0. Record restart count before deploy
    const restartsBefore = getPM2RestartCount();

    // 1. Backup
    const backupPath = backupCurrentStrategy();

    // 2. Write new strategy
    fs.writeFileSync(targetFile, strategyCode);
    log.info(`New strategy written to ${targetName}`);

    // 3. PM2 restart
    if (!restartPM2()) {
        // Rollback
        if (backupPath) {
            fs.copyFileSync(backupPath, CURRENT_STRATEGY);
            // Rollback custom indicators
            const ciBackup = backupPath.replace('strategy-', 'custom-indicators-');
            if (fs.existsSync(ciBackup)) {
                fs.copyFileSync(ciBackup, CUSTOM_INDICATORS);
            }
            restartPM2();
        }
        appendDeployLog({
            timestamp: new Date().toISOString(),
            success: false,
            reason: 'pm2_restart_failed',
            rollback: true,
        });
        return { success: false, reason: 'pm2_restart_failed', rollback: true };
    }

    // 4. Health check (30 second wait)
    log.info(`Waiting ${HEALTH_CHECK_WAIT_MS / 1000}s for health check...`);
    await new Promise(r => setTimeout(r, HEALTH_CHECK_WAIT_MS));

    const pm2Ok = checkPM2Status(restartsBefore);
    if (!pm2Ok) {
        log.error('Post-deploy health check FAILED. Rolling back...');
        if (backupPath) {
            fs.copyFileSync(backupPath, CURRENT_STRATEGY);
            // Rollback custom indicators
            const ciBackup = backupPath.replace('strategy-', 'custom-indicators-');
            if (fs.existsSync(ciBackup)) {
                fs.copyFileSync(ciBackup, CUSTOM_INDICATORS);
            }
            restartPM2();
            log.info('Rollback complete.');
        }
        appendDeployLog({
            timestamp: new Date().toISOString(),
            success: false,
            reason: 'health_check_failed',
            rollback: true,
            backupPath,
        });
        return { success: false, reason: 'health_check_failed', rollback: true };
    }

    // 5. Success
    log.info('=== Deployment SUCCESSFUL ===');
    const entry = {
        timestamp: new Date().toISOString(),
        success: true,
        backupPath,
        backtestComparison,
    };
    appendDeployLog(entry);
    return { success: true, ...entry };
}

if (require.main === module) {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('Usage: node deploy.js <path-to-new-strategy.js>');
        process.exit(1);
    }
    const code = fs.readFileSync(path.resolve(filePath), 'utf8');
    deploy(code)
        .then(result => {
            console.log(JSON.stringify(result, null, 2));
            process.exit(result.success ? 0 : 1);
        })
        .catch(e => {
            log.error('Deploy fatal:', e.message);
            process.exit(1);
        });
}

module.exports = { deploy, checkBotHealth, preDeployValidation };
