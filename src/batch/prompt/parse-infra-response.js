/**
 * parse-infra-response.js
 * Parses Claude's infra_fix response to extract decision JSON and file code blocks.
 * Validates JSON schema, file paths, syntax, and safety constraints.
 *
 * Usage: echo "$CLAUDE_OUTPUT" | node parse-infra-response.js
 * Outputs validated JSON to stdout with { valid, decision, fileChanges, errors }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('../../utils/logger');

const log = createLogger('PARSE-INFRA-RESPONSE');

const PROJECT_DIR = path.join(__dirname, '../../..');
const TMP_PREFIX = path.join(__dirname, '.tmp-infra-check-');

// --- Forbidden paths ---

const FORBIDDEN_PATTERNS = ['.env', 'node_modules', 'backups/'];
const FORBIDDEN_FILES = [
    'src/strategies/current-strategy.js',
    'src/strategies/custom-indicators.js',
];
const FORBIDDEN_DIR_PREFIXES = ['data/'];

// --- Extraction helpers ---

function extractLastJsonBlock(text) {
    const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)];
    if (matches.length === 0) return null;
    const raw = matches[matches.length - 1][1].trim();
    try {
        return JSON.parse(raw);
    } catch (e) {
        log.error('JSON parse error:', e.message);
        return null;
    }
}

function extractFileBlocks(text) {
    const blocks = [];
    const regex = /```file:(.+?)\s*\n([\s\S]*?)\n\s*```/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const filePath = match[1].trim();
        const content = match[2];
        blocks.push({ path: filePath, content });
    }

    return blocks;
}

// --- Validation ---

function validateDecision(decision) {
    const errors = [];

    if (!decision) {
        errors.push('No decision JSON found');
        return errors;
    }

    // action
    if (!['fix', 'no_action'].includes(decision.action)) {
        errors.push(`Invalid action: ${decision.action} (must be "fix" or "no_action")`);
    }

    // reasoning
    if (typeof decision.reasoning !== 'string' || decision.reasoning.length === 0) {
        errors.push('Missing or empty reasoning');
    }

    // confidence
    if (typeof decision.confidence !== 'number' || decision.confidence < 0 || decision.confidence > 1) {
        errors.push(`Invalid confidence: ${decision.confidence} (must be 0-1)`);
    }

    // fixes array (required if action is fix)
    if (decision.action === 'fix') {
        if (!Array.isArray(decision.fixes) || decision.fixes.length === 0) {
            errors.push('action="fix" requires non-empty fixes array');
        } else {
            for (let i = 0; i < decision.fixes.length; i++) {
                const fix = decision.fixes[i];
                if (typeof fix.file !== 'string' || fix.file.length === 0) {
                    errors.push(`fixes[${i}].file must be a non-empty string`);
                }
                if (typeof fix.description !== 'string' || fix.description.length === 0) {
                    errors.push(`fixes[${i}].description must be a non-empty string`);
                }
                if (fix.severity && !['critical', 'important', 'minor'].includes(fix.severity)) {
                    errors.push(`fixes[${i}].severity must be critical, important, or minor`);
                }
            }
        }
    }

    // knowledge (optional)
    if (decision.knowledge !== undefined && typeof decision.knowledge !== 'object') {
        errors.push('knowledge must be an object with confirmed/hypotheses/rejected arrays');
    }

    // notes (optional)
    if (decision.notes !== undefined && typeof decision.notes !== 'string') {
        errors.push('notes must be a string');
    }

    return errors;
}

function isPathAllowed(filePath) {
    // Check forbidden patterns
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (filePath.includes(pattern)) {
            return { allowed: false, reason: `Path contains forbidden pattern: ${pattern}` };
        }
    }

    // Check forbidden exact files
    for (const forbidden of FORBIDDEN_FILES) {
        if (filePath === forbidden) {
            return { allowed: false, reason: `File is protected: ${forbidden}` };
        }
    }

    // Check forbidden directory prefixes
    for (const prefix of FORBIDDEN_DIR_PREFIXES) {
        if (filePath.startsWith(prefix)) {
            return { allowed: false, reason: `Path under forbidden directory: ${prefix}` };
        }
    }

    // Must start with src/ or be a root-level .js/.sh file
    const isSrcPath = filePath.startsWith('src/');
    const isRootFile = !filePath.includes('/') && /\.(js|sh)$/.test(filePath);

    if (!isSrcPath && !isRootFile) {
        return { allowed: false, reason: `Path must start with src/ or be a root-level .js/.sh file` };
    }

    return { allowed: true };
}

function checkSyntax(filePath, content) {
    const ext = path.extname(filePath);
    if (ext !== '.js' && ext !== '.sh') return null; // skip unknown types

    const tmpFile = `${TMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

    try {
        fs.writeFileSync(tmpFile, content);

        if (ext === '.js') {
            execSync(`node -c "${tmpFile}"`, { stdio: 'pipe', timeout: 10000 });
        } else if (ext === '.sh') {
            execSync(`bash -n "${tmpFile}"`, { stdio: 'pipe', timeout: 10000 });
        }

        return null; // no error
    } catch (e) {
        const stderr = e.stderr?.toString().trim() || e.message;
        return `Syntax error in ${filePath}: ${stderr}`;
    } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
    }
}

function validateFileChanges(fileBlocks) {
    const errors = [];

    // Max 3 files
    if (fileBlocks.length > 3) {
        errors.push(`Too many file changes: ${fileBlocks.length} (max 3)`);
        return errors;
    }

    for (const block of fileBlocks) {
        const filePath = block.path;

        // Path safety check
        const pathCheck = isPathAllowed(filePath);
        if (!pathCheck.allowed) {
            errors.push(`Forbidden file: ${filePath} — ${pathCheck.reason}`);
            continue;
        }

        // Check file existence (new files only allowed under src/)
        const fullPath = path.join(PROJECT_DIR, filePath);
        const fileExists = fs.existsSync(fullPath);

        if (!fileExists && !filePath.startsWith('src/')) {
            errors.push(`File does not exist and new files only allowed under src/: ${filePath}`);
            continue;
        }

        // File size sanity check (only for existing files)
        if (fileExists) {
            const originalSize = fs.statSync(fullPath).size;
            const newSize = Buffer.byteLength(block.content, 'utf8');

            if (originalSize > 0) {
                const ratio = newSize / originalSize;
                if (ratio < 0.3) {
                    errors.push(`File ${filePath}: new content is ${Math.round(ratio * 100)}% of original size (min 30%). Suspiciously small — likely truncated.`);
                    continue;
                }
                if (ratio > 3.0) {
                    errors.push(`File ${filePath}: new content is ${Math.round(ratio * 100)}% of original size (max 300%). Suspiciously large.`);
                    continue;
                }
            }
        }

        // Syntax check
        const syntaxError = checkSyntax(filePath, block.content);
        if (syntaxError) {
            errors.push(syntaxError);
        }
    }

    return errors;
}

// --- Main parse function ---

function parseInfraResponse(text) {
    const errors = [];

    // 1. Extract and validate decision JSON
    const decision = extractLastJsonBlock(text);
    const decisionErrors = validateDecision(decision);
    errors.push(...decisionErrors);

    // 2. Extract file code blocks
    const fileBlocks = extractFileBlocks(text);

    // 3. Validate file changes
    let fileChanges = [];
    if (decision && decision.action === 'fix') {
        const fileErrors = validateFileChanges(fileBlocks);
        errors.push(...fileErrors);

        // Cross-check: number of file blocks must match fixes array length
        if (decision.fixes && Array.isArray(decision.fixes)) {
            if (fileBlocks.length !== decision.fixes.length) {
                errors.push(
                    `Mismatch: ${decision.fixes.length} fixes declared but ${fileBlocks.length} file blocks provided`
                );
            }
        }

        // Only include file changes if no file-level errors
        if (fileErrors.length === 0) {
            fileChanges = fileBlocks.map(b => ({ path: b.path, content: b.content }));
        }
    } else if (decision && decision.action === 'no_action' && fileBlocks.length > 0) {
        // Warn but don't error: file blocks with no_action are ignored
        log.warn(`action="no_action" but ${fileBlocks.length} file blocks found — ignoring file blocks`);
    }

    return {
        valid: errors.length === 0,
        decision: decision || null,
        fileChanges,
        errors,
    };
}

// --- CLI entry point ---

if (require.main === module) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
        const result = parseInfraResponse(input);
        console.log(JSON.stringify(result, null, 2));
        if (!result.valid) {
            log.error('Validation failed:', result.errors);
            process.exit(1);
        }
    });
}

module.exports = { parseInfraResponse, extractLastJsonBlock, extractFileBlocks };
