function toNullableString(value) {
    if (value === undefined)
        return null;
    const s = String(value);
    return s.length ? s : null;
}
function toNullableNumber(value) {
    if (value === undefined)
        return null;
    const n = Number(value);
    return Number.isFinite(n) && n !== 0 ? n : null;
}
function normalizeString(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return value;
}
export class GraphState {
    nodes = new Map();
    edges = [];
    adjacency = new Map();
    reverseAdjacency = new Map();
    directives = new Map();
    messageCounters = new Map();
    pendingIndex = new Map();
    subscriptionIndex = new Map();
    options = {
        maxTranscriptPerChild: 1000,
        maxEventNodes: 5000
    };
    constructor() {
        this.directives.set("graph", "orchestrator");
    }
    configureRetention(opts) {
        if (typeof opts.maxTranscriptPerChild === "number" && opts.maxTranscriptPerChild > 0) {
            this.options.maxTranscriptPerChild = Math.floor(opts.maxTranscriptPerChild);
        }
        if (typeof opts.maxEventNodes === "number" && opts.maxEventNodes > 0) {
            this.options.maxEventNodes = Math.floor(opts.maxEventNodes);
        }
    }
    createJob(jobId, meta) {
        const nodeId = this.jobNodeId(jobId);
        this.nodes.set(nodeId, {
            id: nodeId,
            attributes: {
                type: "job",
                state: normalizeString(meta.state ?? "running"),
                created_at: meta.createdAt,
                goal: normalizeString(meta.goal ?? null)
            }
        });
    }
    patchJob(jobId, updates) {
        const node = this.nodes.get(this.jobNodeId(jobId));
        if (!node) {
            return;
        }
        const attributes = { ...node.attributes };
        if (updates.state !== undefined) {
            attributes.state = normalizeString(updates.state);
        }
        if (updates.goal !== undefined) {
            attributes.goal = normalizeString(updates.goal);
        }
        this.nodes.set(node.id, { id: node.id, attributes });
    }
    getJob(jobId) {
        const node = this.nodes.get(this.jobNodeId(jobId));
        if (!node)
            return undefined;
        const childIds = this.getOutgoingEdges(node.id)
            .filter((edge) => edge.attributes.type === "owns")
            .map((edge) => this.extractChildId(edge.to));
        return {
            id: jobId,
            state: normalizeString(String(node.attributes.state ?? "")),
            createdAt: Number(node.attributes.created_at ?? 0),
            goal: toNullableString(node.attributes.goal),
            childIds
        };
    }
    listJobs() {
        const jobs = [];
        for (const [id, node] of this.nodes.entries()) {
            if (node.attributes.type === "job") {
                jobs.push(this.getJob(this.extractJobId(id)));
            }
        }
        return jobs;
    }
    listJobsByState(state) {
        return this.listJobs().filter((job) => job.state === state);
    }
    createChild(jobId, childId, spec, options) {
        const nodeId = this.childNodeId(childId);
        const ttl = options.ttlAt ?? null;
        const attributes = {
            type: "child",
            job_id: jobId,
            name: normalizeString(spec.name),
            state: "idle",
            runtime: normalizeString(spec.runtime ?? "codex"),
            waiting_for: "",
            pending_id: "",
            ttl_at: ttl ?? 0,
            system_message: normalizeString(spec.system ?? null),
            transcript_size: 0,
            last_ts: 0
        };
        if (spec.goals?.length) {
            attributes.goals = normalizeString(spec.goals.join("\n"));
        }
        this.nodes.set(nodeId, { id: nodeId, attributes });
        this.messageCounters.set(childId, 0);
        this.addEdge(this.jobNodeId(jobId), nodeId, { type: "owns" });
        if (spec.system) {
            this.appendMessage(childId, {
                role: "system",
                content: spec.system,
                ts: options.createdAt,
                actor: "orchestrator"
            });
        }
        if (spec.goals?.length) {
            const content = `Objectifs:\n- ${spec.goals.join("\n- ")}`;
            this.appendMessage(childId, {
                role: "user",
                content,
                ts: options.createdAt,
                actor: "user"
            });
        }
    }
    patchChild(childId, updates) {
        const nodeId = this.childNodeId(childId);
        const node = this.nodes.get(nodeId);
        if (!node)
            return;
        const attributes = { ...node.attributes };
        if (updates.state !== undefined) {
            attributes.state = normalizeString(updates.state);
        }
        if (updates.waitingFor !== undefined) {
            attributes.waiting_for = normalizeString(updates.waitingFor);
        }
        if (updates.pendingId !== undefined) {
            attributes.pending_id = normalizeString(updates.pendingId);
        }
        if (updates.ttlAt !== undefined) {
            attributes.ttl_at = updates.ttlAt ?? 0;
        }
        if (updates.name !== undefined) {
            attributes.name = normalizeString(updates.name);
        }
        if (updates.systemMessage !== undefined) {
            attributes.system_message = normalizeString(updates.systemMessage);
        }
        if (updates.runtime !== undefined) {
            attributes.runtime = normalizeString(updates.runtime);
        }
        if (updates.lastTs !== undefined) {
            attributes.last_ts = updates.lastTs ?? 0;
        }
        this.nodes.set(nodeId, { id: nodeId, attributes });
    }
    getChild(childId) {
        const node = this.nodes.get(this.childNodeId(childId));
        if (!node)
            return undefined;
        return this.childFromNode(node);
    }
    listChildren(jobId) {
        const edges = this.getOutgoingEdges(this.jobNodeId(jobId));
        const childIds = edges.filter((edge) => edge.attributes.type === "owns").map((edge) => this.extractChildId(edge.to));
        return childIds
            .map((id) => this.getChild(id))
            .filter((snapshot) => !!snapshot);
    }
    listChildSnapshots() {
        const children = [];
        for (const node of this.nodes.values()) {
            if (node.attributes.type === "child") {
                children.push(this.childFromNode(node));
            }
        }
        return children;
    }
    findJobIdByChild(childId) {
        const edges = this.getIncomingEdges(this.childNodeId(childId));
        const owningEdge = edges.find((edge) => edge.attributes.type === "owns");
        return owningEdge ? this.extractJobId(owningEdge.from) : undefined;
    }
    appendMessage(childId, message) {
        const nodeId = this.childNodeId(childId);
        const childNode = this.nodes.get(nodeId);
        if (!childNode) {
            throw new Error(`Child ${childId} not found`);
        }
        const order = this.nextMessageIndex(childId);
        const messageNodeId = this.messageNodeId(childId, order);
        const actor = message.actor ? String(message.actor) : "";
        this.nodes.set(messageNodeId, {
            id: messageNodeId,
            attributes: {
                type: "message",
                order,
                role: message.role,
                content: message.content,
                ts: message.ts,
                actor,
                child_id: childId
            }
        });
        this.addEdge(nodeId, messageNodeId, { type: "message", order });
        const newSize = order + 1;
        const attributes = { ...childNode.attributes, transcript_size: newSize, last_ts: message.ts };
        this.nodes.set(nodeId, { id: nodeId, attributes });
        // Retention: trim earliest messages if exceeding limit
        this.trimChildTranscript(childId);
    }
    getTranscript(childId, options = {}) {
        const nodeId = this.childNodeId(childId);
        const child = this.nodes.get(nodeId);
        if (!child) {
            return { total: 0, items: [] };
        }
        const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 1000) : 200;
        const edges = this.getOutgoingEdges(nodeId).filter((edge) => edge.attributes.type === "message");
        edges.sort((a, b) => Number(a.attributes.order ?? 0) - Number(b.attributes.order ?? 0));
        const mapped = edges.map((edge) => {
            const messageNode = this.nodes.get(edge.to);
            if (!messageNode) {
                return null;
            }
            const idx = Number(edge.attributes.order ?? 0);
            const role = String(messageNode.attributes.role ?? "assistant");
            const content = String(messageNode.attributes.content ?? "");
            const ts = Number(messageNode.attributes.ts ?? 0);
            const actorAttr = toNullableString(messageNode.attributes.actor);
            return { idx, role, content, ts, actor: actorAttr };
        });
        let items = mapped.filter((entry) => entry !== null);
        if (typeof options.sinceIndex === "number") {
            const start = options.sinceIndex + 1;
            items = items.filter((item) => item.idx >= start);
        }
        else if (typeof options.sinceTs === "number") {
            items = items.filter((item) => item.ts > options.sinceTs);
        }
        if (options.reverse) {
            items = items.slice(-limit).reverse();
        }
        else {
            items = items.slice(0, limit);
        }
        const total = Number(child.attributes.transcript_size ?? items.length);
        return { total, items };
    }
    resetChild(childId, opts) {
        const nodeId = this.childNodeId(childId);
        const child = this.nodes.get(nodeId);
        if (!child)
            return;
        const messageEdges = this.getOutgoingEdges(nodeId).filter((edge) => edge.attributes.type === "message");
        for (const edge of messageEdges) {
            this.nodes.delete(edge.to);
        }
        this.removeEdges((edge) => edge.from === nodeId && edge.attributes.type === "message");
        this.messageCounters.set(childId, 0);
        this.clearPendingForChild(childId);
        this.patchChild(childId, {
            state: "idle",
            waitingFor: null,
            pendingId: null,
            lastTs: null
        });
        this.updateChildTranscriptStats(childId, 0, 0);
        if (opts.keepSystem) {
            const systemText = toNullableString(child.attributes.system_message);
            if (systemText) {
                this.appendMessage(childId, {
                    role: "system",
                    content: systemText,
                    ts: opts.timestamp,
                    actor: "orchestrator"
                });
            }
        }
    }
    setPending(childId, pendingId, createdAt) {
        const current = this.getChild(childId);
        if (!current)
            return;
        if (current.pendingId && current.pendingId !== pendingId) {
            this.clearPending(current.pendingId);
        }
        const nodeId = this.pendingNodeId(pendingId);
        this.nodes.set(nodeId, {
            id: nodeId,
            attributes: { type: "pending", child_id: childId, created_at: createdAt }
        });
        this.pendingIndex.set(pendingId, { childId, createdAt });
        this.addEdge(this.childNodeId(childId), nodeId, { type: "pending" });
        this.patchChild(childId, { pendingId });
    }
    clearPending(pendingId) {
        const snapshot = this.pendingIndex.get(pendingId);
        if (!snapshot)
            return;
        const nodeId = this.pendingNodeId(pendingId);
        this.pendingIndex.delete(pendingId);
        this.nodes.delete(nodeId);
        this.removeEdges((edge) => edge.to === nodeId || edge.from === nodeId);
        this.patchChild(snapshot.childId, { pendingId: null });
    }
    clearPendingForChild(childId) {
        const child = this.getChild(childId);
        if (child?.pendingId) {
            this.clearPending(child.pendingId);
        }
    }
    getPending(pendingId) {
        return this.pendingIndex.get(pendingId);
    }
    createSubscription(snapshot) {
        const nodeId = this.subscriptionNodeId(snapshot.id);
        this.subscriptionIndex.set(snapshot.id, snapshot);
        this.nodes.set(nodeId, {
            id: nodeId,
            attributes: {
                type: "subscription",
                job_id: normalizeString(snapshot.jobId ?? null),
                child_id: normalizeString(snapshot.childId ?? null),
                last_seq: snapshot.lastSeq,
                created_at: snapshot.createdAt,
                wait_ms: snapshot.waitMs ?? 0
            }
        });
        if (snapshot.jobId) {
            this.addEdge(this.jobNodeId(snapshot.jobId), nodeId, { type: "subscription" });
        }
        if (snapshot.childId) {
            this.addEdge(this.childNodeId(snapshot.childId), nodeId, { type: "subscription" });
        }
    }
    updateSubscription(id, updates) {
        const snapshot = this.subscriptionIndex.get(id);
        if (!snapshot)
            return;
        const merged = { ...snapshot, ...updates };
        this.subscriptionIndex.set(id, merged);
        const nodeId = this.subscriptionNodeId(id);
        const node = this.nodes.get(nodeId);
        if (!node)
            return;
        const attributes = { ...node.attributes };
        if (updates.lastSeq !== undefined)
            attributes.last_seq = updates.lastSeq;
        if (updates.waitMs !== undefined)
            attributes.wait_ms = updates.waitMs;
        this.nodes.set(nodeId, { id: nodeId, attributes });
    }
    deleteSubscription(id) {
        const snapshot = this.subscriptionIndex.get(id);
        if (!snapshot)
            return;
        this.subscriptionIndex.delete(id);
        const nodeId = this.subscriptionNodeId(id);
        this.nodes.delete(nodeId);
        this.removeEdges((edge) => edge.to === nodeId || edge.from === nodeId);
    }
    recordEvent(event) {
        const nodeId = this.eventNodeId(event.seq);
        this.nodes.set(nodeId, {
            id: nodeId,
            attributes: {
                type: "event",
                seq: event.seq,
                ts: event.ts,
                kind: event.kind,
                level: event.level,
                job_id: normalizeString(event.jobId ?? null),
                child_id: normalizeString(event.childId ?? null)
            }
        });
        if (event.jobId) {
            this.addEdge(this.jobNodeId(event.jobId), nodeId, { type: "event" });
        }
        if (event.childId) {
            this.addEdge(this.childNodeId(event.childId), nodeId, { type: "event" });
        }
        // Retention for events
        const events = Array.from(this.nodes.values()).filter((n) => n.attributes.type === "event");
        if (events.length > this.options.maxEventNodes) {
            const excess = events.length - this.options.maxEventNodes;
            const sorted = events
                .map((n) => ({ id: n.id, seq: Number(n.attributes.seq ?? 0) }))
                .sort((a, b) => a.seq - b.seq)
                .slice(0, excess);
            for (const ev of sorted) {
                this.nodes.delete(ev.id);
                this.removeEdges((e) => e.from === ev.id || e.to === ev.id);
            }
        }
    }
    serialize() {
        const nodes = Array.from(this.nodes.values(), (node) => ({ id: node.id, attributes: { ...node.attributes } }));
        const edges = this.edges.map((edge) => ({ from: edge.from, to: edge.to, attributes: { ...edge.attributes } }));
        const directives = {};
        for (const [k, v] of this.directives)
            directives[k] = v;
        return { nodes, edges, directives };
    }
    resetFromSnapshot(snapshot) {
        this.nodes.clear();
        this.edges = [];
        this.adjacency.clear();
        this.reverseAdjacency.clear();
        this.directives.clear();
        this.messageCounters.clear();
        this.pendingIndex.clear();
        this.subscriptionIndex.clear();
        for (const [k, v] of Object.entries(snapshot.directives ?? {}))
            this.directives.set(k, v);
        for (const node of snapshot.nodes ?? [])
            this.nodes.set(node.id, { id: node.id, attributes: { ...node.attributes } });
        for (const edge of snapshot.edges ?? [])
            this.addEdge(edge.from, edge.to, { ...edge.attributes });
        const childIds = new Set();
        for (const node of this.nodes.values()) {
            if (node.attributes.type === "child")
                childIds.add(this.extractChildId(node.id));
            if (node.attributes.type === "pending") {
                const childId = String(node.attributes.child_id ?? "");
                const createdAt = Number(node.attributes.created_at ?? Date.now());
                const pid = this.extractPendingId(node.id);
                this.pendingIndex.set(pid, { childId, createdAt });
            }
            if (node.attributes.type === "subscription") {
                const id = this.extractSubscriptionId(node.id);
                this.subscriptionIndex.set(id, {
                    id,
                    jobId: node.attributes.job_id ? String(node.attributes.job_id) : undefined,
                    childId: node.attributes.child_id ? String(node.attributes.child_id) : undefined,
                    lastSeq: Number(node.attributes.last_seq ?? 0),
                    createdAt: Number(node.attributes.created_at ?? Date.now()),
                    waitMs: Number(node.attributes.wait_ms ?? 0)
                });
            }
        }
        for (const childId of childIds) {
            const edges = this.getOutgoingEdges(this.childNodeId(childId)).filter((e) => e.attributes.type === "message");
            const maxOrder = edges.reduce((m, e) => Math.max(m, Number(e.attributes.order ?? 0)), -1);
            this.messageCounters.set(childId, maxOrder + 1);
        }
    }
    // --- Query helpers ---
    getNodeRecord(id) {
        const n = this.nodes.get(id);
        if (!n)
            return undefined;
        return { id: n.id, attributes: { ...n.attributes } };
    }
    listNodeRecords() {
        return Array.from(this.nodes.values(), (n) => ({ id: n.id, attributes: { ...n.attributes } }));
    }
    listEdgeRecords() {
        return this.edges.map((e) => ({ from: e.from, to: e.to, attributes: { ...e.attributes } }));
    }
    neighbors(nodeId, direction = "both", edgeType) {
        const outEdges = direction === "in" ? [] : this.getOutgoingEdges(nodeId);
        const inEdges = direction === "out" ? [] : this.getIncomingEdges(nodeId);
        let edges = [...outEdges, ...inEdges];
        if (edgeType)
            edges = edges.filter((e) => String(e.attributes.type ?? "") === edgeType);
        const nodeIds = new Set();
        for (const e of edges) {
            if (e.from !== nodeId)
                nodeIds.add(e.from);
            if (e.to !== nodeId)
                nodeIds.add(e.to);
        }
        const nodes = [];
        for (const id of nodeIds) {
            const n = this.nodes.get(id);
            if (n)
                nodes.push({ id: n.id, attributes: { ...n.attributes } });
        }
        const edgeCopies = edges.map((e) => ({ from: e.from, to: e.to, attributes: { ...e.attributes } }));
        return { nodes, edges: edgeCopies };
    }
    filterNodes(where, limit) {
        const results = [];
        for (const n of this.nodes.values()) {
            if (this.matches(n.attributes, where)) {
                results.push({ id: n.id, attributes: { ...n.attributes } });
                if (limit && results.length >= limit)
                    break;
            }
        }
        return results;
    }
    filterEdges(where, limit) {
        const results = [];
        for (const e of this.edges) {
            if (this.matches(e.attributes, where)) {
                results.push({ from: e.from, to: e.to, attributes: { ...e.attributes } });
                if (limit && results.length >= limit)
                    break;
            }
        }
        return results;
    }
    updateChildTranscriptStats(childId, size, lastTs) {
        const nodeId = this.childNodeId(childId);
        const node = this.nodes.get(nodeId);
        if (!node)
            return;
        const attributes = { ...node.attributes, transcript_size: size, last_ts: lastTs };
        this.nodes.set(nodeId, { id: nodeId, attributes });
    }
    nextMessageIndex(childId) {
        const current = this.messageCounters.get(childId) ?? 0;
        this.messageCounters.set(childId, current + 1);
        return current;
    }
    addEdge(from, to, attributes) {
        const edge = { from, to, attributes };
        this.edges.push(edge);
        this.indexEdge(edge);
    }
    indexEdge(edge) {
        if (!this.adjacency.has(edge.from)) {
            this.adjacency.set(edge.from, []);
        }
        if (!this.reverseAdjacency.has(edge.to)) {
            this.reverseAdjacency.set(edge.to, []);
        }
        this.adjacency.get(edge.from).push(edge);
        this.reverseAdjacency.get(edge.to).push(edge);
    }
    removeEdges(predicate) {
        let removed = false;
        const kept = [];
        for (const edge of this.edges) {
            if (predicate(edge)) {
                removed = true;
            }
            else {
                kept.push(edge);
            }
        }
        if (!removed)
            return;
        this.edges = kept;
        this.adjacency.clear();
        this.reverseAdjacency.clear();
        for (const edge of this.edges) {
            this.indexEdge(edge);
        }
    }
    getOutgoingEdges(id) {
        return this.adjacency.get(id) ?? [];
    }
    getIncomingEdges(id) {
        return this.reverseAdjacency.get(id) ?? [];
    }
    jobNodeId(jobId) {
        return `job:${jobId}`;
    }
    childNodeId(childId) {
        return `child:${childId}`;
    }
    messageNodeId(childId, order) {
        return `message:${childId}:${order}`;
    }
    pendingNodeId(pendingId) {
        return `pending:${pendingId}`;
    }
    subscriptionNodeId(id) {
        return `subscription:${id}`;
    }
    eventNodeId(seq) {
        return `event:${seq}`;
    }
    trimChildTranscript(childId) {
        const nodeId = this.childNodeId(childId);
        const edges = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
        const max = this.options.maxTranscriptPerChild;
        if (edges.length <= max)
            return;
        const toRemove = edges
            .map((e) => ({ edge: e, order: Number(e.attributes.order ?? 0) }))
            .sort((a, b) => a.order - b.order)
            .slice(0, edges.length - max);
        for (const item of toRemove) {
            const msgNodeId = item.edge.to;
            this.nodes.delete(msgNodeId);
            this.removeEdges((e) => e.to === msgNodeId || e.from === msgNodeId);
        }
        const childNode = this.nodes.get(nodeId);
        if (childNode) {
            const remaining = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
            this.nodes.set(nodeId, {
                id: nodeId,
                attributes: { ...childNode.attributes, transcript_size: remaining.length }
            });
        }
    }
    extractChildId(nodeId) {
        return nodeId.replace(/^child:/, "");
    }
    extractJobId(nodeId) {
        return nodeId.replace(/^job:/, "");
    }
    extractPendingId(nodeId) {
        return nodeId.replace(/^pending:/, "");
    }
    extractSubscriptionId(nodeId) {
        return nodeId.replace(/^subscription:/, "");
    }
    matches(attrs, where) {
        for (const [k, v] of Object.entries(where)) {
            const a = attrs[k];
            if (typeof v === "number") {
                if (Number(a) !== v)
                    return false;
            }
            else if (typeof v === "boolean") {
                if (Boolean(a) !== v)
                    return false;
            }
            else {
                if (String(a) !== String(v))
                    return false;
            }
        }
        return true;
    }
    // Public prune helpers
    pruneChildTranscript(childId, keepLast) {
        if (keepLast < 0)
            return;
        const nodeId = this.childNodeId(childId);
        const edges = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
        const sorted = edges
            .map((e) => ({ edge: e, order: Number(e.attributes.order ?? 0) }))
            .sort((a, b) => a.order - b.order);
        const removeCount = Math.max(0, sorted.length - keepLast);
        const toRemove = sorted.slice(0, removeCount);
        for (const item of toRemove) {
            const msgNodeId = item.edge.to;
            this.nodes.delete(msgNodeId);
            this.removeEdges((e) => e.to === msgNodeId || e.from === msgNodeId);
        }
        const remaining = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
        const lastTs = remaining
            .map((e) => this.nodes.get(e.to))
            .filter((n) => !!n)
            .reduce((m, n) => Math.max(m, Number(n.attributes.ts ?? 0)), 0);
        this.updateChildTranscriptStats(childId, remaining.length, lastTs);
    }
    pruneEvents(maxEvents, jobId, childId) {
        if (maxEvents <= 0)
            return;
        const events = Array.from(this.nodes.values()).filter((n) => n.attributes.type === "event");
        const filtered = events.filter((n) => {
            const matchJob = jobId ? String(n.attributes.job_id ?? "") === jobId : true;
            const matchChild = childId ? String(n.attributes.child_id ?? "") === childId : true;
            return matchJob && matchChild;
        });
        if (filtered.length <= maxEvents)
            return;
        const excess = filtered.length - maxEvents;
        const sorted = filtered
            .map((n) => ({ id: n.id, seq: Number(n.attributes.seq ?? 0) }))
            .sort((a, b) => a.seq - b.seq)
            .slice(0, excess);
        for (const ev of sorted) {
            this.nodes.delete(ev.id);
            this.removeEdges((e) => e.from === ev.id || e.to === ev.id);
        }
    }
    childFromNode(node) {
        const id = this.extractChildId(node.id);
        const jobId = normalizeString(String(node.attributes.job_id ?? ""));
        const waitingFor = toNullableString(node.attributes.waiting_for);
        const pendingId = toNullableString(node.attributes.pending_id);
        const ttlAt = toNullableNumber(node.attributes.ttl_at);
        const systemMessage = toNullableString(node.attributes.system_message);
        const transcriptSize = Number(node.attributes.transcript_size ?? 0);
        const lastTs = toNullableNumber(node.attributes.last_ts);
        return {
            id,
            jobId,
            name: normalizeString(String(node.attributes.name ?? id)),
            state: normalizeString(String(node.attributes.state ?? "idle")),
            runtime: normalizeString(String(node.attributes.runtime ?? "codex")),
            waitingFor,
            pendingId,
            ttlAt,
            systemMessage,
            transcriptSize,
            lastTs
        };
    }
}
