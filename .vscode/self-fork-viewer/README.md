# Self Fork Orchestrator Viewer (VS Code)

A lightweight VS Code extension to browse the self‑fork orchestrator state (graph autosave) and quickly inspect:
- Children (agents) and their conversations
- Recent events

## Usage

1. In your orchestrator, start autosave:
   - Tool: `graph_state_autosave`
   - Input: `{ "action": "start", "path": "graph-autosave.json", "interval_ms": 3000 }`
2. In VS Code, open the workspace where the autosave file lives.
3. Install this extension locally (run from `vscode-extension/`):
   - `F5` in VS Code (launch Extension Development Host) or pack with `vsce`.
4. Run command “Self Fork: Open Viewer”.
5. Adjust the autosave path via “Self Fork: Configure Autosave Path” if needed.

The viewer will watch the autosave file and update the UI (children, conversation, events).

## Notes
- No direct MCP client is required: the extension reads the autosave JSON snapshot.
- If you want live streaming (tools over MCP), add a dedicated MCP client inside the extension in a future iteration.

