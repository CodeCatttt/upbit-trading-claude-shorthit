/**
 * update-memory.js
 * Appends batch decision entries to data/batch-memory.json.
 * Trims to maxEntries and updates strategicNotes.
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
    strategicNotes: '',
};

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        }
    } catch {}
    return { ...DEFAULT_MEMORY };
}

function saveMemory(memory) {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
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
    };

    memory.entries.push(entry);

    // Trim to maxEntries
    if (memory.entries.length > memory.maxEntries) {
        memory.entries = memory.entries.slice(-memory.maxEntries);
    }

    // Update strategicNotes if provided
    if (data.strategicNotes !== undefined && data.strategicNotes !== null) {
        memory.strategicNotes = data.strategicNotes;
    }

    saveMemory(memory);
    return entry;
}

// CLI entry point
if (require.main === module) {
    const input = process.argv[2];
    if (!input) {
        console.error('Usage: node update-memory.js \'{"action":"keep",...}\'');
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

module.exports = { loadMemory, appendEntry };
