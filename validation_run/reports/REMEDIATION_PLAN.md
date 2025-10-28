# Plan de remédiation

Généré le : 2025-10-28T23:30:35.368Z

Statut global : attention

## Actions
| Critère | Sévérité | Description | Scénarios | Recommandations |
| --- | --- | --- | --- | --- |
| S10_qualite_rag | attention | Des notes subsistent pour ce scénario (fichiers manquants, journaux incomplets ou artefacts partiels). | S10_qualite_rag | kg_changes.ndjson vide |
| erreur:network_error | attention | Erreurs réseau détectées lors de la collecte (timeouts/5xx). (6 occurrences). | S01_pdf_science, S07_sources_instables | Stabiliser les sources instables ou réduire le parallélisme (`SEARCH_PARALLEL_FETCH`).<br />Consigner les URLs fautives dans `errors.json` puis envisager un rerun ciblé. |
| erreur:parse_error | attention | Échecs de parsing détectés (HTML/PDF non traités). (2 occurrences). | S02_html_long_images | Inspecter les payloads dans `artifacts/` et ajuster la stratégie Unstructured.<br />Relancer l'extraction après correction pour vérifier la résilience. |
| erreur:robots_denied | attention | Des robots.txt ont refusé l'accès à certaines ressources. (2 occurrences). | S06_robots_taille_max | Activer `SEARCH_FETCH_RESPECT_ROBOTS=1` et ajouter un throttle par domaine si nécessaire.<br />Documenter les domaines bloqués et ajuster la stratégie de crawling. |
| erreur:max_size_exceeded | attention | Des contenus ont dépassé la taille maximale autorisée. (2 occurrences). | S06_robots_taille_max | Augmenter `SEARCH_FETCH_MAX_BYTES` pour les scénarios nécessitant de gros fichiers.<br />Filtrer les requêtes ou limiter les domaines renvoyant des archives volumineuses. |
