Salut Agent — voici ta **liste de tâches à cocher**, *fichier par fichier*, pour que Codex Cloud puisse utiliser les tools du serveur MCP dans **tous les environnements** (HTTP, STDIO ou via **FS-Bridge**), et pour solidifier l’orchestration self-provider (enfants = sessions logiques).
J’inclus des **snippets exacts** quand c’est un peu délicat. Coche chaque case quand c’est fait et validé localement.

---

## 0) Pré-requis communs

* [ ] **Variables d’environnement** (infrastructure) : `MCP_HTTP_ENABLE=1`, `MCP_HTTP_HOST=127.0.0.1`, `MCP_HTTP_PORT=8765`, `MCP_HTTP_PATH=/mcp`, `MCP_HTTP_JSON=on`, `MCP_HTTP_STATELESS=yes`, `MCP_HTTP_TOKEN=<uuid>` (optionnel mais recommandé), `START_MCP_BG=1`, `MCP_FS_IPC_DIR=~/.codex/ipc`.
* [ ] **Scripts de setup/maintenance** déjà en place (ceux fournis précédemment).
* [ ] **Build** : `npm ci` (si lockfile) ou `npm install --omit=dev --no-save --no-package-lock` + `npx typescript tsc` (fallback), puis `dist/` présent.

---

## 1) `src/server.ts` — exposer un **adaptateur JSON-RPC** et l’**auth HTTP**

### 1.1 Exposer un **adaptateur** que le FS-Bridge peut appeler

* [x] Ajouter / exposer une fonction `handleJsonRpc(req)` qui délègue à ton routeur JSON-RPC existant.

```ts
// src/server.ts (ajoute en bas, ou dans un module dédié si tu préfères)
import type { JsonRpcRequest, JsonRpcResponse } from "./types"; // adapte si besoin

export async function handleJsonRpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  // 1) Valide la forme minimale (jsonrpc, id, method)
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return { jsonrpc: "2.0", id: req?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  // 2) Route vers ta logique existante (ex: routeJsonRpcRequest)
  try {
    const result = await routeJsonRpcRequest(req.method, req.params); // <-- ta fonction actuelle
    return { jsonrpc: "2.0", id: req.id, result };
  } catch (e:any) {
    return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: String(e?.message || e) } };
  }
}
```

### 1.2 **Auth HTTP** stateless (si `MCP_HTTP_TOKEN` défini)

* [ ] Dans le handler HTTP existant, insère le contrôle suivant **avant** de traiter la requête :

```ts
// Dans la branche HTTP de src/server.ts (là où tu traites POST /mcp)
const requiredToken = process.env.MCP_HTTP_TOKEN || "";
if (requiredToken) {
  const auth = req.headers["authorization"] || "";
  const ok = typeof auth === "string" && auth.startsWith("Bearer ") && auth.slice(7) === requiredToken;
  if (!ok) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: 401, message: "E-MCP-AUTH" } }));
    return;
  }
}
```

### 1.3 **Propagation du contexte enfant** (self-provider)

* [ ] Récupérer `X-Child-Id` et, si présent, l’insérer dans le **contexte** (logs + events + budgets).

```ts
// Toujours dans la route HTTP JSON-RPC
const childId = typeof req.headers["x-child-id"] === "string" ? String(req.headers["x-child-id"]) : undefined;
const limitsHdr = typeof req.headers["x-child-limits"] === "string" ? String(req.headers["x-child-limits"]) : undefined;

let childLimits: { cpuMs?: number; memMb?: number; wallMs?: number } | undefined;
if (limitsHdr) {
  try {
    childLimits = JSON.parse(Buffer.from(limitsHdr, "base64").toString("utf8"));
  } catch { /* ignore malformed limits */ }
}

// Passe ce contexte à ta couche d’orchestration (ex.)
const ctx = { childId, childLimits, transport: "http" };
// Exemple: routeJsonRpcRequest(method, params, ctx)
```

* [ ] **Journaliser** systématiquement `childId`, `runId`, `opId` dans les events/logs (si ce n’est pas déjà fait).

---

## 2) `src/bridge/fsBridge.ts` — **FS-Bridge** (plan C sans réseau)

* [x] **Créer** ce nouveau fichier.

```ts
// src/bridge/fsBridge.ts
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleJsonRpc } from "../server";

const HOME = process.env.HOME || process.cwd();
const IPC_DIR = process.env.MCP_FS_IPC_DIR || join(HOME, ".codex", "ipc");
const REQ_DIR = join(IPC_DIR, "requests");
const RES_DIR = join(IPC_DIR, "responses");
const ERR_DIR = join(IPC_DIR, "errors");

async function ensureDirs() {
  for (const d of [IPC_DIR, REQ_DIR, RES_DIR, ERR_DIR]) await fs.mkdir(d, { recursive: true });
}

async function processReqFile(fname: string) {
  const path = join(REQ_DIR, fname);
  try {
    const req = JSON.parse(await fs.readFile(path, "utf8"));
    const res = await handleJsonRpc(req);
    const out = JSON.stringify(res);
    const outName = fname.replace(/\.json$/, "") + `.${randomUUID()}.json`;
    await fs.writeFile(join(RES_DIR, outName), out, "utf8");
    await fs.unlink(path);
  } catch (e:any) {
    const outName = fname.replace(/\.json$/, "") + `.${randomUUID()}.json`;
    await fs.writeFile(join(ERR_DIR, outName), JSON.stringify({ ok:false, error: String(e?.message||e) }), "utf8");
    await fs.unlink(path).catch(()=>{});
  }
}

async function scanOnce() {
  const files = (await fs.readdir(REQ_DIR)).filter(f => f.endsWith(".json"));
  for (const f of files) await processReqFile(f);
}

async function watchLoop() {
  await ensureDirs();
  await scanOnce();
  // simple poll (compat large): évite inotify capricieux en cloud
  setInterval(scanOnce, 200); // 5 Hz
}

watchLoop().catch(err => {
  console.error("[fs-bridge] fatal", err);
  process.exit(1);
});
```

* [ ] **Build** : assure-toi que ce fichier est inclus par `tsconfig.json` (normalement oui si `src/**`).

---

## 3) `src/childRuntime.ts` — enfants = **sessions HTTP logiques**

* [ ] Dans le code de `child_spawn_codex`, **ne spawn** pas un nouveau process dans l’environnement Cloud : **définis** un descripteur pointant vers **le même endpoint HTTP**, avec entêtes de contexte.

```ts
// src/childRuntime.ts (extrait conceptuel)
export async function child_spawn_codex(params: {
  role: string;
  prompt?: string;
  limits?: { cpuMs?: number; memMb?: number; wallMs?: number };
}) {
  const childId = crypto.randomUUID();
  const endpoint = {
    url: `http://${process.env.MCP_HTTP_HOST || "127.0.0.1"}:${process.env.MCP_HTTP_PORT || "8765"}${process.env.MCP_HTTP_PATH || "/mcp"}`,
    headers: {
      ...(process.env.MCP_HTTP_TOKEN ? { Authorization: `Bearer ${process.env.MCP_HTTP_TOKEN}` } : {}),
      "X-Child-Id": childId,
      "X-Child-Limits": Buffer.from(JSON.stringify(params.limits || {}), "utf8").toString("base64"),
    }
  };
  // enregistre dans ton index
  childrenIndex.set(childId, { childId, role: params.role, endpoint, limits: params.limits || {} });
  return { childId };
}
```

* [ ] Dans les appels tools “depuis un enfant”, **réutiliser** `endpoint` (HTTP POST) + entêtes.

---

## 4) `package.json` — scripts

* [x] Ajouter les **scripts de démarrage** :

```json
{
  "scripts": {
    "start:http": "node dist/server.js --http --http-host 127.0.0.1 --http-port 8765 --http-path /mcp --http-json on --http-stateless yes",
    "start:stdio": "node dist/server.js",
    "start:fsbridge": "node dist/bridge/fsBridge.js"
  }
}
```

---

## 5) `tsconfig.json` — inclusion FS-Bridge (si nécessaire)

* [x] Vérifier que `src/bridge/fsBridge.ts` est inclus (normalement oui via `"include": ["src"]`).
* [ ] **Optionnel** : activer `esModuleInterop`/`moduleResolution` selon tes imports.

---

## 6) `tests/e2e/fs-bridge.test.ts` — test minimal FS-Bridge

* [x] Ajouter un test simple pour valider l’IPC fichier (utile en cloud très restrictif).

```ts
// tests/e2e/fs-bridge.test.ts
import { promises as fs } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || process.cwd();
const IPC_DIR = process.env.MCP_FS_IPC_DIR || join(HOME, ".codex", "ipc");
const REQ = join(IPC_DIR, "requests");
const RES = join(IPC_DIR, "responses");

test("fs-bridge mcp_info roundtrip", async () => {
  await fs.mkdir(REQ, { recursive: true });
  await fs.mkdir(RES, { recursive: true });

  const req = { jsonrpc: "2.0", id: "t1", method: "mcp_info", params: {} };
  const reqFile = join(REQ, "req-t1.json");
  await fs.writeFile(reqFile, JSON.stringify(req), "utf8");

  const deadline = Date.now() + 5000;
  let resJson: any = null;
  while (Date.now() < deadline) {
    const files = (await fs.readdir(RES)).filter(f => f.startsWith("req-t1."));
    if (files.length) {
      const raw = await fs.readFile(join(RES, files[0]), "utf8");
      resJson = JSON.parse(raw);
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  expect(resJson).toBeTruthy();
  expect(resJson.result?.server?.name).toBeDefined();
}, 10_000);
```

---

## 7) `tests/e2e/child.http.test.ts` — enfant = session HTTP

* [ ] Teste qu’un `child_spawn_codex` crée bien un `childId` et qu’un appel tool **porte** `X-Child-Id`.

```ts
// tests/e2e/child.http.test.ts (pseudo-code)
import fetch from "node-fetch";
test("child headers propagated", async () => {
  const { childId } = await child_spawn_codex({ role: "worker", limits:{wallMs:2000} });
  const url = `http://${process.env.MCP_HTTP_HOST||"127.0.0.1"}:${process.env.MCP_HTTP_PORT||"8765"}${process.env.MCP_HTTP_PATH||"/mcp"}`;
  const body = { jsonrpc:"2.0", id:"x", method:"mcp_info", params:{} };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.MCP_HTTP_TOKEN ? { authorization: `Bearer ${process.env.MCP_HTTP_TOKEN}` } : {}),
      "x-child-id": childId
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  expect(json.result?.server).toBeDefined();
});
```

---

## 8) `src/events/bus.ts` & `src/monitor/log.ts` — corrélation systématique

* [ ] S’assurer que **tous** les events/logs portent `seq` monotone, et les clés : `runId`, `opId`, `childId?`, `graphId?`, `component`, `stage`, `elapsedMs?`.

```ts
// Exemple d’enrichissement à la création d’event
function emitEvent(partial: any, ctx: { runId?: string; opId?: string; childId?: string }) {
  const ev = {
    ts: Date.now(),
    seq: ++GLOBAL_SEQ,
    runId: ctx.runId,
    opId: ctx.opId,
    childId: ctx.childId,
    ...partial,
  };
  eventSink.next(ev);
}
```

---

## 9) `src/infra/idempotency.ts` — header ⇒ clé

* [ ] Mapper l’en-tête `Idempotency-Key` HTTP → `ctx.idempotencyKey` et l’utiliser dans les endpoints `tx_begin`, `child_batch_create`, etc.

```ts
// Dans HTTP handler
const idem = typeof req.headers["idempotency-key"] === "string" ? String(req.headers["idempotency-key"]) : undefined;
// passe idem au contexte de la requête
```

---

## 10) **Vérifications finales**

* [ ] **HTTP** : `mcp_info` répond (200), les calls tools passent.
* [ ] **STDIO** (si activé) : tools disponibles dans Codex.
* [ ] **FS-Bridge** : un fichier `.json` dans `requests/` produit une réponse dans `responses/`.
* [ ] **Enfants** : `child_spawn_codex` → appels avec header `X-Child-Id` visibles côté serveur (logs).
* [ ] **Annulation** : `op_cancel` / `plan_cancel` interrompent proprement et journalisent `cancelled`.
* [ ] **Transactions** : `tx_*` atomiques ; `graph_patch` refuse les violations d’invariants ; **locks** efficaces ; **idempotency** démontrée (réponses identiques).
* [ ] **Events** : `seq` strictement croissant ; corrélation `runId/opId/childId`.

---

### Notes d’implémentation / attentes

* Si `routeJsonRpcRequest` n’existe pas sous cette forme, adapte l’appel dans `handleJsonRpc`.
* Si ton serveur HTTP est déjà factorisé ailleurs, place l’auth/token et la lecture des headers dans ce middleware existant plutôt que directement dans `server.ts`.
* Le **FS-Bridge** poll à 5 Hz (simple et robuste en cloud). Si tu veux `fs.watch`, ajoute un fallback sur Linux containerisé (inotify parfois capricieux).

---

Quand tu as coché tout ça et validé les tests rapides, on lance la **campagne complète** (introspection → graph/tx → children → plans → values/assist → events/logs/resources) depuis le harness `validation_runs/` pour produire `findings.json` + `summary.md`.

---

## Historique
- 2025-10-08 – Agent `gpt-5-codex` (iteration 63) — Réinitialisation du fichier avec la nouvelle checklist MCP HTTP/FS-Bridge.
- 2025-10-08 – Agent `gpt-5-codex` (iteration 64) — Ajout de l’adaptateur JSON-RPC (`handleJsonRpc`), du FS-Bridge (polling + start/stop), des scripts `start:*`, et du test e2e `fs-bridge` validant la boucle disque.
