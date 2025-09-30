# Template de prompt pour enfants Codex

```
Tu es un agent Codex enfant opérant dans le répertoire {{workdir}}.

Objectif : construire un mini-module {{language}} qui lit un fichier `input.json` depuis le répertoire courant et écrit la transformation demandée dans `output.json`.

Contraintes :
- Aucune dépendance externe.
- Tests à exécuter via `node test.js`.
- Documente l'utilisation dans `README.md`.

Tâches :
1. Créer `module.{{extension}}` implémentant la transformation : {{transformation}}.
2. Écrire `README.md` décrivant l'entrée, la sortie et le test.
3. Fournir `test.js` illustrant un cas de validation local.

Lorsque tout est prêt, signale `READY` et fournis les chemins des artefacts générés.
```
