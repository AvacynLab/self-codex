# Orchestration des enfants Codex

## Résumé des outils simulés

### plan_fanout

- **Input** :
```json
{
  "template": "json-transform-module",
  "children": [
    {
      "id": "child-alpha",
      "language": "JavaScript",
      "transformation": "Trier les tâches par priorité décroissante et échéance croissante en ajoutant un rang."
    },
    {
      "id": "child-beta",
      "language": "JavaScript",
      "transformation": "Identifier les métriques qui violent la couverture minimale de 85% ou un runtime supérieur à 12 minutes."
    },
    {
      "id": "child-gamma",
      "language": "JavaScript",
      "transformation": "Comparer la durée moyenne par stage (lint/test/build/package) pour repérer le goulet d'étranglement."
    }
  ]
}
```
- **Résultat** :
```json
{
  "assignedChildren": [
    {
      "id": "child-alpha",
      "status": "prepared"
    },
    {
      "id": "child-beta",
      "status": "prepared"
    },
    {
      "id": "child-gamma",
      "status": "prepared"
    }
  ]
}
```
- **Verdict** : SIMULATED_OK

### child_create

- **Input** :
```json
{
  "childId": "child-alpha",
  "tools_allow": [
    "fs"
  ],
  "idleSec": 60,
  "totalSec": 300
}
```
- **Résultat** :
```json
{
  "workdir": "children/child-alpha/workspace",
  "inbox": "children/child-alpha/inbox",
  "outbox": "children/child-alpha/outbox"
}
```
- **Verdict** : SIMULATED_OK

### child_send

- **Input** :
```json
{
  "childId": "child-alpha",
  "payload": {
    "instructions": "Trier les tâches par priorité décroissante et échéance croissante en ajoutant un rang.",
    "language": "JavaScript",
    "artefacts": [
      "module.mjs",
      "README.md",
      "test.mjs",
      "input.json",
      "expected_output.json"
    ]
  }
}
```
- **Résultat** :
```json
{
  "acknowledgement": "received"
}
```
- **Verdict** : SIMULATED_OK

### child_status

- **Input** :
```json
{
  "childId": "child-alpha"
}
```
- **Résultat** :
```json
{
  "state": "ready",
  "lastLog": "Test OK pour child-alpha"
}
```
- **Verdict** : SIMULATED_OK

### child_collect

- **Input** :
```json
{
  "childId": "child-alpha"
}
```
- **Résultat** :
```json
{
  "artefacts": {
    "module": "children/child-alpha/workspace/module.mjs",
    "test": "children/child-alpha/workspace/test.mjs",
    "output": "children/child-alpha/outbox/output.json"
  }
}
```
- **Verdict** : SIMULATED_OK
- **Artefacts** : `children/child-alpha/workspace/module.mjs`, `children/child-alpha/workspace/test.mjs`, `children/child-alpha/outbox/output.json`

### child_create

- **Input** :
```json
{
  "childId": "child-beta",
  "tools_allow": [
    "fs"
  ],
  "idleSec": 60,
  "totalSec": 300
}
```
- **Résultat** :
```json
{
  "workdir": "children/child-beta/workspace",
  "inbox": "children/child-beta/inbox",
  "outbox": "children/child-beta/outbox"
}
```
- **Verdict** : SIMULATED_OK

### child_send

- **Input** :
```json
{
  "childId": "child-beta",
  "payload": {
    "instructions": "Identifier les métriques qui violent la couverture minimale de 85% ou un runtime supérieur à 12 minutes.",
    "language": "JavaScript",
    "artefacts": [
      "module.mjs",
      "README.md",
      "test.mjs",
      "input.json",
      "expected_output.json"
    ]
  }
}
```
- **Résultat** :
```json
{
  "acknowledgement": "received"
}
```
- **Verdict** : SIMULATED_OK

### child_status

- **Input** :
```json
{
  "childId": "child-beta"
}
```
- **Résultat** :
```json
{
  "state": "ready",
  "lastLog": "Test OK pour child-beta"
}
```
- **Verdict** : SIMULATED_OK

### child_collect

- **Input** :
```json
{
  "childId": "child-beta"
}
```
- **Résultat** :
```json
{
  "artefacts": {
    "module": "children/child-beta/workspace/module.mjs",
    "test": "children/child-beta/workspace/test.mjs",
    "output": "children/child-beta/outbox/output.json"
  }
}
```
- **Verdict** : SIMULATED_OK
- **Artefacts** : `children/child-beta/workspace/module.mjs`, `children/child-beta/workspace/test.mjs`, `children/child-beta/outbox/output.json`

### child_create

- **Input** :
```json
{
  "childId": "child-gamma",
  "tools_allow": [
    "fs"
  ],
  "idleSec": 60,
  "totalSec": 300
}
```
- **Résultat** :
```json
{
  "workdir": "children/child-gamma/workspace",
  "inbox": "children/child-gamma/inbox",
  "outbox": "children/child-gamma/outbox"
}
```
- **Verdict** : SIMULATED_OK

### child_send

- **Input** :
```json
{
  "childId": "child-gamma",
  "payload": {
    "instructions": "Comparer la durée moyenne par stage (lint/test/build/package) pour repérer le goulet d'étranglement.",
    "language": "JavaScript",
    "artefacts": [
      "module.mjs",
      "README.md",
      "test.mjs",
      "input.json",
      "expected_output.json"
    ]
  }
}
```
- **Résultat** :
```json
{
  "acknowledgement": "received"
}
```
- **Verdict** : SIMULATED_OK

### child_status

- **Input** :
```json
{
  "childId": "child-gamma"
}
```
- **Résultat** :
```json
{
  "state": "ready",
  "lastLog": "Test OK pour child-gamma"
}
```
- **Verdict** : SIMULATED_OK

### child_collect

- **Input** :
```json
{
  "childId": "child-gamma"
}
```
- **Résultat** :
```json
{
  "artefacts": {
    "module": "children/child-gamma/workspace/module.mjs",
    "test": "children/child-gamma/workspace/test.mjs",
    "output": "children/child-gamma/outbox/output.json"
  }
}
```
- **Verdict** : SIMULATED_OK
- **Artefacts** : `children/child-gamma/workspace/module.mjs`, `children/child-gamma/workspace/test.mjs`, `children/child-gamma/outbox/output.json`

### plan_join

- **Input** :
```json
{
  "joinPolicy": "all",
  "expected": [
    "child-alpha",
    "child-beta",
    "child-gamma"
  ]
}
```
- **Résultat** :
```json
{
  "completed": [
    "child-alpha",
    "child-beta",
    "child-gamma"
  ]
}
```
- **Verdict** : SIMULATED_OK

### plan_reduce

- **Input** :
```json
{
  "reducer": "merge_json",
  "mergeOrder": [
    "child-alpha",
    "child-beta",
    "child-gamma"
  ]
}
```
- **Résultat** :
```json
{
  "mergedReport": "reports/children_merge.json"
}
```
- **Verdict** : SIMULATED_OK
- **Artefacts** : `reports/children_merge.json`

## Synthèse agrégée

| Enfant | Description | Artefact principal |
| --- | --- | --- |
| child-alpha | Trier les tâches par priorité décroissante et échéance croissante en ajoutant un rang. | [output](../children/child-alpha/outbox/output.json) |
| child-beta | Identifier les métriques qui violent la couverture minimale de 85% ou un runtime supérieur à 12 minutes. | [output](../children/child-beta/outbox/output.json) |
| child-gamma | Comparer la durée moyenne par stage (lint/test/build/package) pour repérer le goulet d'étranglement. | [output](../children/child-gamma/outbox/output.json) |

Le fichier `children_merge.json` propose un agrégat direct des sorties pour faciliter les analyses ultérieures.
