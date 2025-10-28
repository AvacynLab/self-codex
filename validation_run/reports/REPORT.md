# Validation Report

Généré le : 2025-10-28T23:30:32.797Z

## Synthèse des scénarios
| Scénario | Durée (ms) | Docs ingérés | Erreurs | Notes |
| --- | ---: | ---: | ---: | --- |
| S01_pdf_science | 3650 | 9 | 2 | — |
| S02_html_long_images | 3200 | 6 | 2 | — |
| S03_actualites_fraicheur | 2880 | 9 | 0 | — |
| S04_multilingue_fr_en | 3180 | 9 | 0 | — |
| S05_idempotence | 3520 | 9 | 0 | — |
| S06_robots_taille_max | 2940 | 6 | 4 | — |
| S07_sources_instables | 3060 | 6 | 4 | — |
| S08_indexation_directe | 2480 | 6 | 0 | — |
| S09_charge_moderee | 5850 | 15 | 0 | — |
| S10_qualite_rag | 1200 | 3 | 0 | kg_changes.ndjson vide |

## Totaux agrégés
- Documents ingérés : 78
- Événements collectés : 111
- KG diffs : 49
- Vector upserts : 25
- Top domaines : arxiv.org (28.0%, 7) ; aclanthology.org (12.0%, 3) ; vectorlabs.ai (12.0%, 3) ; graphresearch.org (8.0%, 2) ; towardsdatascience.com (8.0%, 2) ; datahub.example.net (4.0%, 1) ; datasets.example.org (4.0%, 1) ; docs.example.org (4.0%, 1) ; research.facebook.com (4.0%, 1) ; status.example.com (4.0%, 1)
- Types de contenu : application/pdf (56.0%, 14) ; text/html (44.0%, 11)
- Erreurs classées : network_error: 6, parse_error: 2, robots_denied: 2, max_size_exceeded: 2

## Critères d'acceptation
- Fonctionnel : ✅ OK (S01_pdf_science, S02_html_long_images, S03_actualites_fraicheur, S04_multilingue_fr_en, S05_idempotence, S06_robots_taille_max, S07_sources_instables, S08_indexation_directe, S09_charge_moderee, S10_qualite_rag) – Chaque scénario instrumenté expose des documents ingérés ou des erreurs classées.
- Idempotence : ✅ OK (S01_pdf_science, S05_idempotence) – Les docIds et événements doc_ingested sont identiques entre S01_pdf_science et S05_idempotence.
- Extraction : ✅ OK (S01_pdf_science, S02_html_long_images, S03_actualites_fraicheur, S04_multilingue_fr_en, S05_idempotence, S06_robots_taille_max, S07_sources_instables, S08_indexation_directe, S09_charge_moderee) – Segments uniques: 100.0% (49/49)
- Langue : ✅ OK (S01_pdf_science, S02_html_long_images, S03_actualites_fraicheur, S04_multilingue_fr_en, S05_idempotence, S06_robots_taille_max, S07_sources_instables, S08_indexation_directe, S09_charge_moderee) – Détections valides: 100.0% (25/25) ; Top langues: en: 23, fr: 2
- RAG : ✅ OK (S10_qualite_rag) – La réponse S10 cite les sources ingérées (≥1 citation).
- Performance : ✅ OK (S09_charge_moderee) – Les seuils de latence (p95) et la durée totale respectent les contraintes de S09.
- Robustesse : ✅ OK (S01_pdf_science, S02_html_long_images, S06_robots_taille_max, S07_sources_instables) – Toutes les erreurs présentes sont classées et non bloquantes.

## Synthèse thématique
### Forces
- Fonctionnel validé (S01_pdf_science, S02_html_long_images, S03_actualites_fraicheur, S04_multilingue_fr_en, S05_idempotence, S06_robots_taille_max, S07_sources_instables, S08_indexation_directe, S09_charge_moderee, S10_qualite_rag) – Chaque scénario instrumenté expose des documents ingérés ou des erreurs classées.
- Idempotence validé (S01_pdf_science, S05_idempotence) – Les docIds et événements doc_ingested sont identiques entre S01_pdf_science et S05_idempotence.
- Extraction validé (S01_pdf_science, S02_html_long_images, S03_actualites_fraicheur, S04_multilingue_fr_en, S05_idempotence, S06_robots_taille_max, S07_sources_instables, S08_indexation_directe, S09_charge_moderee) – Segments uniques: 100.0% (49/49)
- Langue validé (S01_pdf_science, S02_html_long_images, S03_actualites_fraicheur, S04_multilingue_fr_en, S05_idempotence, S06_robots_taille_max, S07_sources_instables, S08_indexation_directe, S09_charge_moderee) – Détections valides: 100.0% (25/25) ; Top langues: en: 23, fr: 2
- RAG validé (S10_qualite_rag) – La réponse S10 cite les sources ingérées (≥1 citation).
- Performance validé (S09_charge_moderee) – Les seuils de latence (p95) et la durée totale respectent les contraintes de S09.
- Robustesse validé (S01_pdf_science, S02_html_long_images, S06_robots_taille_max, S07_sources_instables) – Toutes les erreurs présentes sont classées et non bloquantes.
- S03_actualites_fraicheur : 9 documents ingérés sans erreur classée.
- S04_multilingue_fr_en : 9 documents ingérés sans erreur classée.
- S05_idempotence : 9 documents ingérés sans erreur classée.
- S08_indexation_directe : 6 documents ingérés sans erreur classée.
- S09_charge_moderee : 15 documents ingérés sans erreur classée.
- S10_qualite_rag : 3 documents ingérés sans erreur classée.
- Couverture globale : 78 documents ingérés et 111 événements collectés.

### Faiblesses
- S10_qualite_rag : kg_changes.ndjson vide.

### Recommandations
- Résoudre kg_changes.ndjson vide pour S10_qualite_rag puis régénérer le rapport.

### Décisions
- Validation recommandée : tous les critères suivis sont au vert.
- Synthèse quantitative : 78 documents, 111 événements, 25 vector upserts.

### État des critères d'acceptation
- ✅ S01_pdf_science : docs=9, erreurs=2, log=6 lignes
- ✅ S02_html_long_images : docs=6, erreurs=2, log=6 lignes
- ✅ S03_actualites_fraicheur : docs=9, log=6 lignes
- ✅ S04_multilingue_fr_en : docs=9, log=6 lignes
- ✅ S05_idempotence : docs=9, log=6 lignes
- ✅ S06_robots_taille_max : docs=6, erreurs=4, log=6 lignes
- ✅ S07_sources_instables : docs=6, erreurs=4, log=6 lignes
- ✅ S08_indexation_directe : docs=6, log=6 lignes
- ✅ S09_charge_moderee : docs=15, log=6 lignes
- ⚠️ S10_qualite_rag : kg_changes.ndjson vide

## Observations détaillées
### S01_pdf_science – PDF scientifique
Recherche ciblée de PDF scientifiques sur arXiv (S01).

Timings (p95) :
- searxQuery=840 ms, fetchUrl=1116 ms, extract=937 ms
- ingestGraph=420 ms, ingestVector=430 ms
- Documents ingérés : 9
- Erreurs classées : 2
- Vector upserts : 3
- KG diffs : 6
- Événements : 13

### S02_html_long_images – HTML long + images
Contenu HTML riche avec images pour valider l'extraction (S02).

Timings (p95) :
- searxQuery=910 ms, fetchUrl=1178 ms, extract=1018.5 ms
- ingestGraph=380 ms, ingestVector=390 ms
- Documents ingérés : 6
- Erreurs classées : 2
- Vector upserts : 2
- KG diffs : 4
- Événements : 10

### S03_actualites_fraicheur – Actualités (fraîcheur)
Suivi de l'actualité récente pour tester la fraîcheur (S03).

Timings (p95) :
- searxQuery=760 ms, fetchUrl=976 ms, extract=816 ms
- ingestGraph=360 ms, ingestVector=370 ms
- Documents ingérés : 9
- Erreurs classées : 0
- Vector upserts : 3
- KG diffs : 5
- Événements : 12

### S04_multilingue_fr_en – Multilingue (FR/EN)
Comparaison FR/EN sur ACL Anthology pour la couverture multilingue (S04).

Timings (p95) :
- searxQuery=890 ms, fetchUrl=1048 ms, extract=929 ms
- ingestGraph=410 ms, ingestVector=420 ms
- Documents ingérés : 9
- Erreurs classées : 0
- Vector upserts : 3
- KG diffs : 6
- Événements : 12

### S05_idempotence – Idempotence (rejouer S01)
Double exécution de S01 pour vérifier l'idempotence (S05).

Timings (p95) :
- searxQuery=830 ms, fetchUrl=1097 ms, extract=927 ms
- ingestGraph=410 ms, ingestVector=420 ms
- Documents ingérés : 9
- Erreurs classées : 0
- Vector upserts : 3
- KG diffs : 6
- Événements : 12

### S06_robots_taille_max – robots & taille max
Test de respect des robots.txt et limites de taille (S06).

Timings (p95) :
- searxQuery=780 ms, fetchUrl=1048.5 ms, extract=819.5 ms
- ingestGraph=340 ms, ingestVector=350 ms
- Documents ingérés : 6
- Erreurs classées : 4
- Vector upserts : 2
- KG diffs : 4
- Événements : 11

### S07_sources_instables – Sources instables (5xx/timeout)
Gestion des sources sujettes aux erreurs 5xx ou timeouts (S07).

Timings (p95) :
- searxQuery=800 ms, fetchUrl=1178 ms, extract=859 ms
- ingestGraph=360 ms, ingestVector=365 ms
- Documents ingérés : 6
- Erreurs classées : 4
- Vector upserts : 2
- KG diffs : 4
- Événements : 11

### S08_indexation_directe – Indexation directe (sans Searx)
Ingestion directe d'URLs pour bypasser Searx (S08).

Timings (p95) :
- searxQuery=320 ms, fetchUrl=1038 ms, extract=899 ms
- ingestGraph=340 ms, ingestVector=345 ms
- Documents ingérés : 6
- Erreurs classées : 0
- Vector upserts : 2
- KG diffs : 4
- Événements : 9

### S09_charge_moderee – Charge modérée (K=12)
Charge accrue avec 12 résultats pour mesurer les performances (S09).

Timings (p95) :
- searxQuery=2380 ms, fetchUrl=1174 ms, extract=1016 ms
- ingestGraph=460 ms, ingestVector=470 ms
- Documents ingérés : 15
- Erreurs classées : 0
- Vector upserts : 5
- KG diffs : 10
- Événements : 18

### S10_qualite_rag – Qualité RAG (sanity)
Validation qualitative du RAG sans web avec citations (S10).

Timings (p95) :
- searxQuery=0 ms, fetchUrl=0 ms, extract=0 ms
- ingestGraph=0 ms, ingestVector=0 ms
- Documents ingérés : 3
- Erreurs classées : 0
- Vector upserts : 0
- KG diffs : 0
- Événements : 3
- Notes : kg_changes.ndjson vide

