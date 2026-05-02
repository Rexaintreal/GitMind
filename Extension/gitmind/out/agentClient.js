"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStatus = getStatus;
exports.sendCommand = sendCommand;
exports.getLog = getLog;
const BASE = 'http://127.0.0.1:7432';
async function getStatus() {
    try {
        const res = await fetch(`${BASE}/status`);
        if (!res.ok) {
            return null;
        }
        return await res.json();
    }
    catch {
        return null;
    }
}
async function sendCommand(action, extra = {}) {
    try {
        await fetch(`${BASE}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...extra })
        });
    }
    catch {
        // agent offline, silently fail
    }
}
async function getLog() {
    try {
        const res = await fetch(`${BASE}/log`);
        if (!res.ok) {
            return null;
        }
        return await res.json();
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=agentClient.js.map