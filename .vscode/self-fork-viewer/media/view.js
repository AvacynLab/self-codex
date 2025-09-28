(function(){
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  el('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  el('configure').addEventListener('click', () => vscode.postMessage({ type: 'configure' }));
  const liveBtn = document.getElementById('live');
  if (liveBtn) liveBtn.addEventListener('click', () => vscode.postMessage({ type: 'live' }));

  /** @type {any} */
  let SNAP = null;
  /** @type {Record<string, any>} */
  let INDEX = { nodes: {}, out: {}, events: [] };
  let selectedChild = null;

  window.addEventListener('message', (evt) => {
    const msg = evt.data;
    if (msg?.type === 'snapshot') {
      renderPath(msg.path, msg.error);
      if (msg.snap) { SNAP = msg.snap; buildIndex(); renderChildren(); renderEvents(); if (selectedChild) renderConversation(selectedChild); }
      else { clearUI(); }
    } else if (msg?.type === 'selectChild') {
      const id = msg.id;
      if (id) { selectedChild = id; renderConversation(id); }
    }
  });

  function renderPath(p, error){
    el('autosavePath').textContent = error ? `${p} (error: ${error})` : p;
  }

  function clearUI(){
    el('children').innerHTML = '';
    el('events').innerHTML = '';
    el('conversation').innerHTML = '';
    el('conversationTitle').textContent = 'Conversation';
  }

  function buildIndex(){
    INDEX = { nodes: {}, out: {}, events: [] };
    const nodes = SNAP.nodes || SNAP.data?.nodes || [];
    const edges = SNAP.edges || SNAP.data?.edges || [];
    for (const n of nodes) { INDEX.nodes[n.id] = n; }
    for (const e of edges) { (INDEX.out[e.from] ||= []).push(e); }
    const eventNodes = nodes.filter(n => n.attributes?.type === 'event');
    INDEX.events = eventNodes.map(n => ({ seq: Number(n.attributes.seq||0), ts: Number(n.attributes.ts||0), kind: String(n.attributes.kind||''), id: n.id })).sort((a,b)=>b.seq-a.seq);
  }

  function renderChildren(){
    const list = el('children'); list.innerHTML = '';
    const children = Object.values(INDEX.nodes).filter(n => n.attributes?.type === 'child');
    children.sort((a,b)=> String(a.attributes.name||'').localeCompare(String(b.attributes.name||'')));
    for (const n of children) {
      const li = document.createElement('li');
      li.textContent = `${n.attributes.name || n.id} [${n.id}]`;
      li.addEventListener('click', ()=>{ selectedChild = n.id; renderConversation(n.id) });
      list.appendChild(li);
    }
  }

  function renderEvents(){
    const list = el('events'); list.innerHTML = '';
    const lim = Math.max(1, Number(el('eventsLimit').value || 100));
    const slice = INDEX.events.slice(0, lim);
    for (const e of slice) {
      const li = document.createElement('li');
      li.textContent = `#${e.seq} ${new Date(e.ts).toLocaleTimeString()} ${e.kind}`;
      list.appendChild(li);
    }
  }
  el('eventsLimit').addEventListener('change', renderEvents);

  function renderConversation(childNodeId){
    const convEl = el('conversation'); convEl.innerHTML = '';
    const title = el('conversationTitle');
    const child = INDEX.nodes[childNodeId];
    title.textContent = `Conversation: ${child?.attributes?.name || childNodeId}`;
    const edges = (INDEX.out[childNodeId] || []).filter(e => String(e.attributes?.type||'') === 'message').sort((a,b)=> Number(a.attributes.order||0)-Number(b.attributes.order||0));
    for (const e of edges) {
      const msg = INDEX.nodes[e.to];
      if (!msg) continue;
      const role = String(msg.attributes?.role||'assistant');
      const div = document.createElement('div');
      div.className = `msg ${role}`;
      div.textContent = `[${role}] ${msg.attributes?.content||''}`;
      convEl.appendChild(div);
    }
  }
})();
