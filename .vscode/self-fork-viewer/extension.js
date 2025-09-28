// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * @param {unknown} value
 * @returns {string}
 */
const toStringSafe = (value) => {
  if (value === undefined || value === null) return '';
  return String(value);
};

/**
 * @param {unknown} value
 * @returns {number}
 */
const toNumberSafe = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Normalise the snapshot content into jobs, children and events.
 * @param {any} raw
 */
function parseSnapshot(raw) {
  if (!raw) {
    return { jobs: [], childrenByJob: new Map(), events: [] };
  }
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes : Array.isArray(raw?.data?.nodes) ? raw.data.nodes : [];
  const edges = Array.isArray(raw?.edges) ? raw.edges : Array.isArray(raw?.data?.edges) ? raw.data.edges : [];

  /** @type {Map<string, any>} */
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node.attributes ?? {});
  }

  const stripPrefix = (value, prefix) => (value && value.startsWith(prefix) ? value.slice(prefix.length) : value);

  const jobs = nodes
    .filter((node) => (node.attributes?.type ?? '') === 'job')
    .map((node) => {
      const attrs = node.attributes ?? {};
      const id = stripPrefix(node.id ?? '', 'job:');
      return {
        id,
        state: toStringSafe(attrs.state ?? ''),
        goal: toStringSafe(attrs.goal ?? ''),
        createdAt: toNumberSafe(attrs.created_at ?? 0)
      };
    });

  const childrenMap = new Map();
  for (const node of nodes) {
    if ((node.attributes?.type ?? '') !== 'child') continue;
    const attrs = node.attributes ?? {};
    const id = stripPrefix(node.id ?? '', 'child:');
    childrenMap.set(id, {
      id,
      name: toStringSafe(attrs.name ?? id),
      runtime: toStringSafe(attrs.runtime ?? 'codex'),
      state: toStringSafe(attrs.state ?? ''),
      waitingFor: toStringSafe(attrs.waiting_for ?? ''),
      pendingId: toStringSafe(attrs.pending_id ?? ''),
      transcriptSize: toNumberSafe(attrs.transcript_size ?? 0),
      lastTs: toNumberSafe(attrs.last_ts ?? 0)
    });
  }

  const childrenByJob = new Map();
  for (const edge of edges) {
    if ((edge.attributes?.type ?? '') !== 'owns') continue;
    const jobId = stripPrefix(edge.from ?? '', 'job:');
    const childId = stripPrefix(edge.to ?? '', 'child:');
    const child = childrenMap.get(childId);
    if (!child) continue;
    if (!childrenByJob.has(jobId)) {
      childrenByJob.set(jobId, []);
    }
    childrenByJob.get(jobId).push(child);
  }

  const events = nodes
    .filter((node) => (node.attributes?.type ?? '') === 'event')
    .map((node) => {
      const attrs = node.attributes ?? {};
      return {
        id: node.id,
        seq: toNumberSafe(attrs.seq ?? 0),
        ts: toNumberSafe(attrs.ts ?? 0),
        kind: toStringSafe(attrs.kind ?? ''),
        level: toStringSafe(attrs.level ?? ''),
        jobId: toStringSafe(attrs.job_id ?? ''),
        childId: toStringSafe(attrs.child_id ?? '')
      };
    })
    .sort((a, b) => b.seq - a.seq);

  return { jobs, childrenByJob, events };
}

function activate(context) {
  let panel = /** @type {vscode.WebviewPanel | null} */ (null);
  let fileWatcher = /** @type {vscode.FileSystemWatcher | null} */ (null);
  /** @type {vscode.Disposable[]} */
  let fileWatcherSubs = [];

  /** @type {{ path: string; snap: any; error: string | null; parsed: ReturnType<typeof parseSnapshot> }} */
  let snapshotState = { path: '', snap: null, error: null, parsed: parseSnapshot(null) };

  const getAutosavePath = () => {
    const cfg = vscode.workspace.getConfiguration('selfForkViewer');
    let p = cfg.get('autosavePath');
    if (typeof p !== 'string' || !p.length) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      p = path.join(root, 'graph-autosave.json');
    }
    p = p.replace('${workspaceFolder}', vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '');
    return p;
  };

  const readSnapshot = () => {
    const autosavePath = getAutosavePath();
    try {
      const data = fs.readFileSync(autosavePath, 'utf8');
      const snap = JSON.parse(data);
      return { path: autosavePath, snap, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { path: autosavePath, snap: null, error: message };
    }
  };

  const loadSnapshot = () => {
    const info = readSnapshot();
    snapshotState = {
      path: info.path,
      snap: info.snap,
      error: info.error,
      parsed: parseSnapshot(info.snap)
    };
  };

  const disposeWatcher = () => {
    if (fileWatcher) {
      fileWatcher.dispose();
      fileWatcher = null;
    }
    for (const sub of fileWatcherSubs.splice(0, fileWatcherSubs.length)) {
      sub.dispose();
    }
  };

  const resetWatcher = () => {
    disposeWatcher();
    const autosavePath = getAutosavePath();
    const dir = path.dirname(autosavePath);
    const file = path.basename(autosavePath);
    try {
      fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, file));
    } catch {
      fileWatcher = null;
      return;
    }
    const onChange = () => refreshSnapshot();
    fileWatcherSubs = [
      fileWatcher.onDidChange(onChange),
      fileWatcher.onDidCreate(onChange),
      fileWatcher.onDidDelete(onChange)
    ];
    context.subscriptions.push(fileWatcher, ...fileWatcherSubs);
  };

  const sendToWebview = () => {
    if (!panel) return;
    panel.webview.postMessage({
      type: 'snapshot',
      path: snapshotState.path,
      snap: snapshotState.snap,
      error: snapshotState.error
    });
  };

  /** @type {JobsTreeProvider | undefined} */
  let jobsProvider;
  /** @type {EventsTreeProvider | undefined} */
  let eventsProvider;

  const notifyViews = () => {
    jobsProvider?.refresh();
    eventsProvider?.refresh();
    sendToWebview();
  };

  const refreshSnapshot = () => {
    loadSnapshot();
    notifyViews();
  };

  class JobsTreeProvider {
    constructor() {
      this._onDidChangeTreeData = new vscode.EventEmitter();
    }
    refresh() {
      this._onDidChangeTreeData.fire();
    }
    get onDidChangeTreeData() {
      return this._onDidChangeTreeData.event;
    }
    /**
     * @param {{ type: 'job'; job: any } | { type: 'child'; child: any } | undefined} element
     */
    getChildren(element) {
      const parsed = snapshotState.parsed;
      if (!element) {
        return parsed.jobs.map((job) => ({ type: 'job', job }));
      }
      if (element.type === 'job') {
        const children = parsed.childrenByJob.get(element.job.id) ?? [];
        return children.map((child) => ({ type: 'child', child }));
      }
      return [];
    }
    /**
     * @param {{ type: 'job'; job: any } | { type: 'child'; child: any }} element
     */
    getTreeItem(element) {
      if (element.type === 'job') {
        const childCount = (snapshotState.parsed.childrenByJob.get(element.job.id) ?? []).length;
        const label = `${element.job.id} (${element.job.state || 'unknown'})`;
        const item = new vscode.TreeItem(label, childCount ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        if (element.job.goal) item.tooltip = element.job.goal;
        item.description = childCount ? `${childCount} enfant${childCount > 1 ? 's' : ''}` : undefined;
        item.contextValue = 'selfForkJob';
        return item;
      }
      const child = element.child;
      const label = child.name || child.id;
      const descParts = [];
      if (child.state) descParts.push(child.state);
      if (child.runtime) descParts.push(child.runtime);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = descParts.join(' · ');
      item.tooltip = `child:${child.id}\nstate: ${child.state || 'unknown'}\nruntime: ${child.runtime || 'codex'}`;
      item.command = {
        command: 'selfForkViewer.openConversation',
        title: 'Ouvrir la conversation',
        arguments: [{ child_node_id: `child:${child.id}` }]
      };
      item.contextValue = 'selfForkChild';
      return item;
    }
  }

  class EventsTreeProvider {
    constructor() {
      this._onDidChangeTreeData = new vscode.EventEmitter();
    }
    refresh() {
      this._onDidChangeTreeData.fire();
    }
    get onDidChangeTreeData() {
      return this._onDidChangeTreeData.event;
    }
    getChildren() {
      return snapshotState.parsed.events.slice(0, 200).map((event) => ({ type: 'event', event }));
    }
    /**
     * @param {{ type: 'event'; event: any }} element
     */
    getTreeItem(element) {
      const { event } = element;
      const label = `#${event.seq} ${event.kind}`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const dt = new Date(event.ts);
      const time = Number.isFinite(event.ts) && event.ts > 0 ? dt.toLocaleTimeString() : '';
      const descParts = [];
      if (time) descParts.push(time);
      if (event.childId) descParts.push(`child:${event.childId}`);
      item.description = descParts.join(' · ');
      item.tooltip = `niveau: ${event.level || 'info'}\njob: ${event.jobId || '-'}\nchild: ${event.childId || '-'}`;
      if (event.childId) {
        item.command = {
          command: 'selfForkViewer.openConversation',
          title: 'Ouvrir la conversation',
          arguments: [{ child_id: event.childId }]
        };
      }
      item.contextValue = 'selfForkEvent';
      return item;
    }
  }

  jobsProvider = new JobsTreeProvider();
  eventsProvider = new EventsTreeProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('selfForkViewer.jobsView', jobsProvider),
    vscode.window.registerTreeDataProvider('selfForkViewer.eventsView', eventsProvider)
  );

  const html = (webview) => {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'view.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'view.js'));
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link href="${cssUri}" rel="stylesheet" />
        <title>Self Fork Orchestrator Viewer</title>
      </head>
      <body>
        <header>
          <div>Self Fork Orchestrator Viewer</div>
          <div class="path" id="autosavePath"></div>
          <div class="actions">
            <button id="refresh">Refresh</button>
            <button id="configure">Configure Path</button>
            <button id="live">Live Events</button>
          </div>
        </header>
        <main>
          <section class="left">
            <h3>Children</h3>
            <ul id="children"></ul>
            <h3>Events</h3>
            <div class="events-controls">
              <label>Limit <input id="eventsLimit" type="number" value="100" min="1" /></label>
            </div>
            <ul id="events"></ul>
          </section>
          <section class="right">
            <h3 id="conversationTitle">Conversation</h3>
            <div id="conversation" class="conversation"></div>
          </section>
        </main>
        <script nonce="${nonce}" src="${jsUri}"></script>
      </body>
    </html>`;
  };

  const open = () => {
    loadSnapshot();
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside);
      sendToWebview();
      return;
    }
    panel = vscode.window.createWebviewPanel(
      'selfForkViewer',
      'Self Fork Orchestrator Viewer',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = html(panel.webview);
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'refresh') {
        refreshSnapshot();
      } else if (msg?.type === 'configure') {
        await configurePath();
      } else if (msg?.type === 'live') {
        await focusLiveEvents();
      }
    });
    panel.onDidDispose(() => { panel = null; });
    sendToWebview();
  };

  const openConversation = (args) => {
    open();
    const id = typeof args === 'string' ? args : args?.child_id || args?.child_node_id;
    if (id) {
      panel?.webview.postMessage({ type: 'selectChild', id: id.startsWith('child:') ? id : `child:${id}` });
    }
  };

  const configurePath = async () => {
    const current = getAutosavePath();
    const input = await vscode.window.showInputBox({ prompt: 'Autosave JSON path', value: current });
    if (!input) return;
    const cfg = vscode.workspace.getConfiguration('selfForkViewer');
    await cfg.update('autosavePath', input, vscode.ConfigurationTarget.Workspace);
    resetWatcher();
    refreshSnapshot();
  };

  const focusLiveEvents = async () => {
    await vscode.commands.executeCommand('workbench.view.extension.selfForkViewer');
    await vscode.commands.executeCommand('selfForkViewer.eventsView.focus');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('selfForkViewer.open', open),
    vscode.commands.registerCommand('selfForkViewer.openConversation', openConversation),
    vscode.commands.registerCommand('selfForkViewer.configurePath', configurePath),
    vscode.commands.registerCommand('selfForkViewer.refresh', refreshSnapshot),
    vscode.commands.registerCommand('selfForkViewer.openLiveEvents', focusLiveEvents)
  );

  const handler = {
    handleUri: (uri) => {
      try {
        if (!uri) return;
        const params = new URLSearchParams(uri.query);
        const childId = params.get('child_id');
        const childNodeId = params.get('child_node_id');
        const id = childNodeId || (childId ? `child:${childId}` : null);
        if (id) openConversation({ child_node_id: id }); else open();
      } catch {
        open();
      }
    }
  };
  context.subscriptions.push(vscode.window.registerUriHandler(handler));

  loadSnapshot();
  resetWatcher();
  notifyViews();
}

function deactivate() {}

module.exports = { activate, deactivate };
