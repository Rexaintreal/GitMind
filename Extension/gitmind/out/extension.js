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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const statusBar_1 = require("./statusBar");
const agentClient_1 = require("./agentClient");
const terminal_1 = require("./terminal");
function activate(context) {
    console.log('GitMind is now active');
    (0, statusBar_1.createStatusBar)(context);
    // Start command — asks for interval first
    context.subscriptions.push(vscode.commands.registerCommand('gitmind.start', async () => {
        const input = await vscode.window.showInputBox({
            prompt: 'Auto-commit every X minutes',
            value: '5',
            validateInput: v => isNaN(Number(v)) ? 'Enter a number' : null
        });
        if (!input) {
            return;
        }
        await (0, agentClient_1.sendCommand)('start', { interval_minutes: Number(input) });
        (0, terminal_1.echoInfo)('Agent started — committing every ' + input + ' minutes');
        vscode.window.showInformationMessage(`GitMind started ✓ — committing every ${input} min`);
    }));
    // Stop command
    context.subscriptions.push(vscode.commands.registerCommand('gitmind.stop', async () => {
        await (0, agentClient_1.sendCommand)('stop');
        (0, terminal_1.echoInfo)('Agent stopped');
        vscode.window.showInformationMessage('GitMind stopped');
    }));
    // Pause command
    context.subscriptions.push(vscode.commands.registerCommand('gitmind.pause', async () => {
        await (0, agentClient_1.sendCommand)('pause');
        (0, terminal_1.echoInfo)('Agent paused');
        vscode.window.showInformationMessage('GitMind paused');
    }));
    // Commit now command
    context.subscriptions.push(vscode.commands.registerCommand('gitmind.commitNow', async () => {
        await (0, agentClient_1.sendCommand)('commit_now');
        (0, terminal_1.echoInfo)('Manual commit triggered');
        vscode.window.showInformationMessage('GitMind — committing now...');
    }));
    // Placeholder for status bar click
    context.subscriptions.push(vscode.commands.registerCommand('gitmind.showPanel', () => {
        vscode.window.showInformationMessage('GitMind panel coming soon!');
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map