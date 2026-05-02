"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStatusBar = createStatusBar;
const vscode = __importStar(require("vscode"));
const agentClient_1 = require("./agentClient");
const terminal_1 = require("./terminal");
let previousCommand = null;
let offlineCount = 0;
let offlineNotified = false;
function createStatusBar(context) {
    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    bar.command = 'gitmind.showPanel';
    bar.text = '$(git-commit) GitMind starting...';
    bar.tooltip = 'GitMind — click to open panel';
    bar.show();
    setInterval(async () => {
        const s = await (0, agentClient_1.getStatus)();
        // Offline detection
        if (!s) {
            offlineCount++;
            bar.text = '$(warning) GitMind offline';
            bar.tooltip = 'Agent not running. Start it with: python main.py';
            if (offlineCount >= 3 && !offlineNotified) {
                offlineNotified = true;
                const choice = await vscode.window.showWarningMessage('GitMind agent is not running. Start it with: cd agent && python main.py', 'Open Terminal');
                if (choice === 'Open Terminal') {
                    vscode.commands.executeCommand('workbench.action.terminal.new');
                }
            }
            return;
        }
        // Reset offline state when agent comes back
        offlineCount = 0;
        offlineNotified = false;
        // Terminal echo — fires only when last_command changes
        if (s.last_command && s.last_command !== previousCommand) {
            previousCommand = s.last_command;
            (0, terminal_1.echoCommand)(s.last_command);
        }
        // Update status bar text
        if (s.running) {
            const mins = Math.floor(s.next_commit_in / 60);
            const secs = String(s.next_commit_in % 60).padStart(2, '0');
            bar.text = `$(git-commit) GitMind ${mins}m ${secs}s`;
            bar.tooltip = `Last commit: ${s.last_commit}`;
        }
        else {
            bar.text = '$(circle-slash) GitMind paused';
            bar.tooltip = 'GitMind is paused';
        }
    }, 5000);
    context.subscriptions.push(bar);
}
//# sourceMappingURL=statusBar.js.map