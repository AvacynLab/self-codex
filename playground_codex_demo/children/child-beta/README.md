# Filtrage de métriques QA

## Objectif
Ce module transforme un JSON selon l'instruction : **Identifier les métriques qui violent la couverture minimale de 85% ou un runtime supérieur à 12 minutes.**.

## Fichiers générés
- `module.mjs` — implémentation ES Module documentée.
- `input.json` — exemple d'entrée utilisé pour le test.
- `expected_output.json` — sortie attendue pour l'exemple.
- `test.mjs` — test automatisé à exécuter avec `node test.mjs`.

## Exécution
```bash
node test.mjs
```

