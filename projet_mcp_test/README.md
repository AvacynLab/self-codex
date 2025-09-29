# Mini-projet MCP : Pipeline GraphForge et GraphState

Ce dossier rassemble les artefacts générés lors de l'atelier d'exploration du serveur MCP. Le pipeline et les analyses associées ont été produits à l'aide des outils `graph_forge_analyze`, `graph_state_autosave`, `plan_fanout` et `graph_state_inactivity`.

## Structure du pipeline

Le fichier [`graph/pipeline.gf`](graph/pipeline.gf) décrit un graphe orienté pondéré composé de trois étapes :

```
node Ingestion
node Traitement
node Stockage
edge Ingestion -> Traitement [weight=2]
edge Traitement -> Stockage [weight=3]
```

Ce pipeline représente un flux linéaire classique : ingestion des données, traitement applicatif puis stockage persistant. Les pondérations reflètent le coût relatif de chaque transition dans le workflow.

## Analyse `shortestPath`

L'appel à `graph_forge_analyze` avec l'option `shortestPath` retourne la distance minimale entre `Ingestion` et `Stockage` via le chemin `Ingestion -> Traitement -> Stockage`. Le résultat est sérialisé dans [`analyse_pipeline.json`](analyse_pipeline.json) :

- Distance cumulée : `5` (somme des poids `2` et `3`).
- Chemin retenu : `["Ingestion", "Traitement", "Stockage"]`.

## Autosauvegarde de l'état du graphe

L'outil `graph_state_autosave` a été activé avec un intervalle de `5` secondes. Les battements (`HEARTBEAT`) émis par le job `plan_fanout` sont capturés dans [`etat_graph.json`](etat_graph.json). On y retrouve :

- L'horodatage d'activation de l'autosauvegarde.
- Le nombre de snapshots enregistrés pendant la session.
- Les informations de suivi pour chaque enfant du fanout (statut courant et dernier heartbeat).

### Extrait significatif

```json
{
  "jobId": "job-20250217-001",
  "tool": "plan_fanout",
  "status": "HEARTBEAT",
  "children": [
    {
      "nodeId": "fanout-child-1",
      "status": "RUNNING"
    }
  ]
}
```

## Détection d'inactivité

Une fois l'autosauvegarde interrompue, `graph_state_inactivity` a permis d'identifier les enfants inactifs du job `plan_fanout`. Le rapport [`inactivite.json`](inactivite.json) liste l'enfant concerné avec l'horodatage de son dernier heartbeat et la durée d'inactivité mesurée (`46` secondes dans notre cas d'étude).

## Journal d'exécution et rapport d'incident

Les journaux détaillés de la session sont conservés dans [`logs/workflow.log`](logs/workflow.log). Ils retracent les appels outils, les réponses structurées et les validations manuelles réalisées.

Le fichier [`REPORT.md`](REPORT.md) documente les incidents rencontrés (notamment une première tentative d'analyse échouée à cause d'un chemin mal renseigné) ainsi que la démarche de résolution.
