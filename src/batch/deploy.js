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
const { createLogger } = require('../utils/logger');

const log = createLogger('DEPLOY');

const PROJECT_ROOT = path.join(__dirname, '../..');
const CURRENT_STRATEGY = path.join(__dirname, '../strategies/current-strategy.js');
const CUSTOM_INDICATORS = path.join(__dirname, '../strategies/custom-indicators.js');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');
const DEPLOY_LOG_FILE = path.join(PROJECT_ROOT, 'deploy-log.json');
const HEARTBEAT_FILE = path.join(PROJECT_ROOT, 'data/bot-heartbeat.json');
const HEALTH_CHECK_WAIT_MS = 30000;
const PM2_NAME = 'upbit-trading-bot';

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
        if (newRestarts > 2) {
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

async function deploy(strategyCode, backtestComparison = null) {
    log.info('=== Starting deployment ===');

    // 0. Record restart count before deploy
    const restartsBefore = getPM2RestartCount();

    // 1. Backup
    const backupPath = backupCurrentStrategy();

    // 2. Write new strategy
    fs.writeFileSync(CURRENT_STRATEGY, strategyCode);
    log.info('New strategy written to current-strategy.js');

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

module.exports = { deploy, checkBotHealth };
