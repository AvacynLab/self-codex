# Dashboard & Heatmaps

Cette vue synthétise les données SSE collectées depuis le dashboard (`src/monitor/dashboard.ts`).

| Métrique | Valeur max | Nœud concerné | Commentaire |
| --- | --- | --- | --- |
| Temps d'attente | 5400 ms | child-beta | Temps de réponse long après sandbox, surveiller |
| Tokens consommés | 1850 | child-alpha | Analyse complète avec plusieurs itérations MetaCritic |
| Alertes boucle | 1 | child-gamma | Avertissement résolu après reset du prompt |

Un export JSON compact est disponible dans `../logs/dashboard_heatmap.json`.
