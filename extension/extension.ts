import * as vscode from "vscode";
import { ClawChatViewProvider } from "./chatViewProvider";
import { ClawProcess } from "./clawProcess";

let chatProvider: ClawChatViewProvider;

export function activate(context: vscode.ExtensionContext) {
  const clawProcess = new ClawProcess();
  chatProvider = new ClawChatViewProvider(context.extensionUri, clawProcess);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "milo-code.chatView",
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("milo-code.newChat", () => {
      chatProvider.newChat();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("milo-code.stopGeneration", () => {
      chatProvider.stopGeneration();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("milo-code.openSettings", () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "miloCode"
      );
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("miloCode")) {
        // ClawProcess reads config fresh on each run — no reload needed
      }
    })
  );
}

export function deactivate() {}
