/**
 * update-memory.js
 * Appends batch decision entries to data/batch-memory.json.
 * Manages structured knowledge base (confirmed/hypotheses/rejected).
 * Trims to maxEntries.
 *
 * Usage: node src/batch/update-memory.js '{"action":"keep","reasoning":"...","confidence":0.7,"outcome":"kept"}'
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '../../data/batch-memory.json');

const DEFAULT_MEMORY = {
    maxEntries: 50,
    entries: [],
    knowledge: {
        confirmed: [],
        hypotheses: [],
        rejected: [],
    },
    // Legacy field kept for backward compat reads; no longer written to
    strategicNotes: '',
};

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            const mem = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
            // Ensure knowledge structure exists (migration)
            if (!mem.knowledge) {
                mem.knowledge = { confirmed: [], hypotheses: [], rejected: [] };
            }
            return mem;
        }
    } catch {}
    return { ...DEFAULT_MEMORY, knowledge: { ...DEFAULT_MEMORY.knowledge } };
}

function saveMemory(memory) {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write
    const tmpFile = MEMORY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(memory, null, 2));
    fs.renameSync(tmpFile, MEMORY_FILE);
}

/**
 * Merge incoming knowledge updates into the knowledge base.
 * - confirmed: append new insights (deduplicate by insight text)
 * - hypotheses: append new, update existing by hypothesis text
 * - rejected: append new rejections
 * Caps each category at 20 entries (keep most recent).
 */
function mergeKnowledge(memory, incomingKnowledge) {
    if (!incomingKnowledge) return;

    const kb = memory.knowledge;
    const now = new Date().toISOString().slice(0, 10);

    // Confirmed insights
    if (Array.isArray(incomingKnowledge.confirmed)) {
        for (const item of incomingKnowledge.confirmed) {
            if (!item.insight) continue;
            const exists = kb.confirmed.some(k => k.insight === item.insight);
            if (!exists) {
                kb.confirmed.push({
                    insight: item.insight,
                    evidence: item.evidence || '',
                    addedAt: item.addedAt || now,
                });
            }
        }
        if (kb.confirmed.length > 20) {
            kb.confirmed = kb.confirmed.slice(-20);
        }
    }

    // Hypotheses
    if (Array.isArray(incomingKnowledge.hypotheses)) {
        for (const item of incomingKnowledge.hypotheses) {
            if (!item.hypothesis) continue;
            const existing = kb.hypotheses.find(h => h.hypothesis === item.hypothesis);
            if (existing) {
                // Update status
                if (item.status) existing.status = item.status;
                if (item.experimentId) existing.experimentId = item.experimentId;
            } else {
                kb.hypotheses.push({
                    hypothesis: item.hypothesis,
                    status: item.status || 'proposed',
                    experimentId: item.experimentId || null,
                    addedAt: item.addedAt || now,
                });
            }
        }
        if (kb.hypotheses.length > 20) {
            kb.hypotheses = kb.hypotheses.slice(-20);
        }
    }

    // Rejected
    if (Array.isArray(incomingKnowledge.rejected)) {
        for (const item of incomingKnowledge.rejected) {
            if (!item.hypothesis) continue;
            const exists = kb.rejected.some(r => r.hypothesis === item.hypothesis);
            if (!exists) {
                kb.rejected.push({
                    hypothesis: item.hypothesis,
                    reason: item.reason || '',
                    rejectedAt: item.rejectedAt || now,
                });
                // Also remove from hypotheses if present
                kb.hypotheses = kb.hypotheses.filter(h => h.hypothesis !== item.hypothesis);
            }
        }
        if (kb.rejected.length > 20) {
            kb.rejected = kb.rejected.slice(-20);
        }
    }
}

function appendEntry(data) {
    const memory = loadMemory();

    const entry = {
        timestamp: new Date().toISOString(),
        action: data.action || 'unknown',
        reasoning: data.reasoning || '',
        confidence: data.confidence || 0,
        parameters: data.parameters || null,
        markets: data.markets || null,
        improvementAreas: data.improvementAreas || null,
        backtestResult: data.backtestResult || null,
        outcome: data.outcome || 'unknown',
        notes: data.notes || '',
        retryAttempts: data.retryAttempts || null,
        variantsTested: data.variantsTested || null,
        diagnosis: data.diagnosis || null,
        triggerType: data.triggerType || null,
    };

    memory.entries.push(entry);

    // Trim to maxEntries
    const max = memory.maxEntries || 50;
    if (memory.entries.length > max) {
        memory.entries = memory.entries.slice(-max);
    }

    // Merge structured knowledge if provided
    if (data.knowledge) {
        mergeKnowledge(memory, data.knowledge);
    }

    // Legacy: still accept strategicNotes for backward compat
    if (data.strategicNotes !== undefined && data.strategicNotes !== null) {
        memory.strategicNotes = data.strategicNotes;
    }

    saveMemory(memory);
    return entry;
}

/**
 * Migrate existing batch-memory.json from old format (strategicNotes string)
 * to new format (knowledge object). Safe to run multiple times.
 */
function migrateMemory() {
    const memory = loadMemory();

    // Already migrated
    if (memory.knowledge && (memory.knowledge.confirmed.length > 0 ||
        memory.knowledge.hypotheses.length > 0 ||
        memory.knowledge.rejected.length > 0)) {
        return false;
    }

    // Parse strategicNotes into confirmed insights
    if (memory.strategicNotes && typeof memory.strategicNotes === 'string') {
        const notes = memory.strategicNotes.split(/\d+\)\s*/).filter(Boolean);
        const now = new Date().toISOString().slice(0, 10);

        for (const note of notes) {
            const trimmed = note.trim();
            if (!trimmed) continue;
            memory.knowledge.confirmed.push({
                insight: trimmed,
                evidence: 'migrated from strategicNotes',
                addedAt: now,
            });
        }
    }

    saveMemory(memory);
    return true;
}

// CLI entry point
if (require.main === module) {
    const input = process.argv[2];

    if (input === '--migrate') {
        const migrated = migrateMemory();
        console.log(migrated ? 'Migration complete.' : 'Already migrated or no data.');
        process.exit(0);
    }

    if (!input) {
        console.error('Usage: node update-memory.js \'{"action":"keep",...}\' | --migrate');
        process.exit(1);
    }
    try {
        const data = JSON.parse(input);
        const entry = appendEntry(data);
        console.log(JSON.stringify(entry, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}

module.exports = { loadMemory, appendEntry, mergeKnowledge, migrateMemory };
