# Validation run — Idempotence checks

Ce guide détaille la vérification de l'exigence d'idempotence décrite dans la
checklist (`S05 – Idempotence`). L'objectif est de confirmer qu'une seconde
exécution du scénario `S01` (enregistrée sous `S05`) ne génère aucun doublon :

- **DocIds identiques** : les documents ingérés lors de la première exécution
  doivent être exactement les mêmes que ceux de la ré-exécution.
- **Événements cohérents** : chaque événement `search:doc_ingested` doit
  correspondre à la même liste de `doc_id`, sans duplication interne.

Pour faciliter cette analyse, le dépôt fournit un module dédié et un CLI qui
peuvent être exécutés à tout moment sans toucher aux artefacts existants.

## CLI `validation:idempotence`

```bash
npm run validation:idempotence
```

Par défaut la commande compare `S01_pdf_science` (base) et `S05_idempotence`
(ré-exécution). Le script :

1. Lit `response.json` pour extraire la liste des `docId`.
2. Analyse `events.ndjson` et récupère tous les événements
   `search:doc_ingested`.
3. Détecte les différences entre les deux jeux d'identifiants et signale les
   doublons éventuels.
4. Retourne un statut global (`pass`, `fail` ou `unknown`) et affiche les
   remarques utiles pour compléter les artefacts.

### Options disponibles

| Option        | Description                                                         |
|---------------|---------------------------------------------------------------------|
| `--base <id>` | Identifiant du scénario de référence (par défaut : `1`).            |
| `--rerun <id>`| Identifiant du scénario à comparer (par défaut : `5`).              |
| `--root <dir>`| Dossier racine contenant `validation_run/` (par défaut `./`).       |
| `--json`      | Affiche le rapport complet au format JSON (idéal pour les scripts). |

### Codes de sortie

| Code | Signification                                                                 |
|------|-------------------------------------------------------------------------------|
| `0`  | Comparaison réussie (pas de divergence, pas de doublon détecté).              |
| `1`  | Divergence ou duplication détectée (action requise).                          |
| `2`  | Verdict indéterminé faute d'artefacts suffisants (consulter les notes).       |

### Exemple de sortie

```text
Idempotence summary {
  baseScenario: 'S01_pdf_science',
  rerunScenario: 'S05_idempotence',
  status: 'pass',
  documentDiff: { baseOnly: [], rerunOnly: [], shared: ['doc-1', 'doc-2'] },
  eventDiff: { baseOnly: [], rerunOnly: [], shared: ['doc-1', 'doc-2'] },
  baseDocumentCount: 2,
  rerunDocumentCount: 2,
  baseEventDocIds: 2,
  rerunEventDocIds: 2,
  baseDuplicates: { documents: [], events: [] },
  rerunDuplicates: { documents: [], events: [] }
}
```

Si des notes supplémentaires sont disponibles (fichier manquant, JSON invalide,
absence d'événements, etc.), elles sont listées après le résumé. Chaque note est
aussi propagée dans le rapport global (`REPORT.md`).

## Intégration avec le rapport de validation

Le module `src/validationRun/idempotence.ts` est utilisé par
`src/validationRun/reports.ts` pour renseigner automatiquement le critère
**Idempotence** du rapport final. Le statut `pass/fail/unknown` reflète
exactement la logique du CLI :

- `pass` : docIds identiques et aucun doublon dans les événements.
- `fail` : divergence détectée (docIds manquants/ajoutés ou duplication).
- `unknown` : données insuffisantes (artefact manquant ou vide).

Pour garantir un verdict `pass`, assurez-vous de :

1. Exécuter `S01` puis `S05` via `npm run validation:scenario:run`.
2. Conserver `response.json` et `events.ndjson` complets pour les deux scénarios.
3. Rejouer la comparaison (`npm run validation:idempotence`) et corriger les
   éventuels écarts signalés dans les notes.

Les notes générées par la comparaison sont visibles dans :

- `validation_run/reports/REPORT.md` (section « Faiblesses » ou « Décisions »).
- La sortie standard du CLI (utile pour intégrer la vérification dans un
  pipeline CI/CD ou un rapport manuel).

## Vérifications complémentaires

En complément du CLI, pensez à :

- Inspecter `validation_run/artifacts/S01_pdf_science/documents_summary.json`
  et `S05_idempotence/...` pour valider la cohérence des métadonnées.
- Consulter `validation_run/runs/S05_idempotence/errors.json` pour confirmer
  l'absence d'erreurs inattendues lors de la ré-exécution.
- Rejouer la comparaison après toute remédiation (`npm run validation:scenarios -- --rerun`)
  afin de documenter l'itération dans un dossier `S05_idempotence_rerunN`.

En suivant ces étapes, l'exigence d'idempotence sera documentée de bout en bout
et facilement partageable dans les rapports de validation.
