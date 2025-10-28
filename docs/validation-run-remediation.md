# Plan de remédiation de la validation

Ce guide décrit la commande `npm run validation:remediation` qui synthétise les
points d'attention mentionnés dans la section « Triage & remédiations » du
checklist `AGENTS.md`. L'objectif est de produire automatiquement un plan
d'action structuré à partir des artefacts collectés durant la campagne.

## Artefacts générés

La commande écrit deux fichiers sous `validation_run/reports/` :

- `remediation_plan.json` — structure machine-readable listant les actions,
  sévérités et scénarios concernés.
- `REMEDIATION_PLAN.md` — rapport Markdown prêt à être partagé dans un changelog
  ou un compte-rendu d'incident.

Chaque action précise :

1. Le critère ou scénario concerné.
2. La sévérité (`critical`, `attention`, `info`).
3. Un résumé descriptif (détails acceptance, erreurs récurrentes, notes de
   scénarios).
4. Les recommandations concrètes à appliquer avant de rejouer le run.

## Quand lancer la commande ?

- Après avoir exécuté `npm run validation:report` afin de disposer d'un
  `summary.json` à jour.
- Une fois les `timings.json`, `errors.json` et artefacts d'extraction/langue
  consolidés pour tous les scénarios.
- À chaque itération de remédiation (`S0X_rerunN/`) pour suivre les actions
  restantes.

## Usage

```bash
npm run validation:remediation
```

La sortie console confirme les chemins écrits :

```
✔ remediation_plan.json écrit dans validation_run/reports/remediation_plan.json
✔ REMEDIATION_PLAN.md écrit dans validation_run/reports/REMEDIATION_PLAN.md
```

En cas d'échec (dossier manquant, artefacts incomplets), la commande affiche
l'erreur et retourne un code non nul. Il suffit alors de compléter les
artefacts, relancer la génération du rapport puis ré-exécuter la commande.

## Interprétation du plan

- `status: blocked` : au moins une action critique empêche la clôture de la
  campagne (ex. performance non respectée, idempotence cassée).
- `status: attention` : corrections recommandées avant validation finale (notes
  de scénario, erreurs réseaux récurrentes, critères « unknown »).
- `status: clear` : aucune action détectée, la campagne peut être archivée.

Chaque action comporte des recommandations alignées sur les suggestions de la
section 7 du checklist (latence Searx, robots, taille max, dédoublonnage, etc.).
Consignez les remédiations appliquées, rejouez les scénarios concernés puis
régénérez le plan pour vérifier que les actions critiques disparaissent.
