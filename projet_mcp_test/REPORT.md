# Rapport d'incidents MCP

## 1. Analyse GraphForge – chemin introuvable
- **Symptôme :** L'appel initial à `graph_forge_analyze` retournait `ENOENT: no such file or directory`.
- **Cause identifiée :** Le chemin fourni au service pointait vers `./pipeline.gf` alors que le fichier résidait dans `graph/pipeline.gf`.
- **Résolution :** Relancer l'appel en fournissant le chemin relatif correct (`graph/pipeline.gf`).
- **Validation :** Le journal (`logs/workflow.log`) confirme la réponse avec `distance=5`.

## 2. Autosauvegarde – absence de heartbeat
- **Symptôme :** Après ~40 secondes, l'autosauvegarde signalait un délai de heartbeat pour `fanout-child-2`.
- **Cause identifiée :** Le job secondaire était volontairement ralenti pour tester la détection d'inactivité.
- **Résolution :** Aucun correctif requis. L'information est exploitée par `graph_state_inactivity` pour marquer le noeud comme inactif.
- **Validation :** `inactivite.json` expose `inactiveForSeconds = 46` pour l'enfant concerné.
