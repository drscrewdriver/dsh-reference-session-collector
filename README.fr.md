# dsh-reference-session-collector (DRSC) — Synchroniseur de projection de sessions

**Plugin DeepSeek Harness (DSH)** : balaie les journaux de session sous
`~/.dsh/sessions/**` en **lecture seule**, les décode et les projette dans
une projection SQLite propriétaire (segments / replaces / FTS5). Une unique
route HTTP cloisonnée `GET/POST /api/dsh-reference-session-collector` expose le marquage de
surface, le rapprochement des rappels et une recherche en texte intégral
compatible chinois. **N'écrit jamais dans les fichiers de session.**

## Statut

**Livré (v0.1.0)** : la moitié hôte complète — noyau de projection pur,
dépôt SQLite (node:sqlite / FTS5), moteur de synchronisation incrémental
(pré-vérification watermark, suivi des archivées, ordonnancement interval),
face de requêtes à cache 3 couches, route HTTP cloisonnée. Chaîne de gates
`pnpm check` entièrement verte (9 suites / 66 tests + smoke dist).
**Restant** : câblage des consommateurs (phase 1 rapprochement CCI,
phase 2 bascule du corpus steward, phase 3 réancrage mémoire) et benchmark
d'efficacité T9.1.

## Architecture

```
~/.dsh/sessions/** (lecture seule) ──→ ProjectionSync (incrémental, watermark=bytes+mtime)
                                   │ projectSessionEvents (noyau pur)
                                   ▼
        ~/.dsh-reference-session-collector/projection.db (4 tables + fts5 + cache 3 couches)
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session-collector     CCI (phase 1)   steward (2) / memory (3)
```

## Table des routes HTTP

| op | paramètres | retour |
|---|---|---|
| `status` | — | auto-diagnostic dépôt + stats cache + dernier sync |
| `sessions` | `offset/limit` | résumé des sessions (Map résidente, 0 SQL) |
| `session` | `session=<id>`, `turn=` / `fields=search` optionnels | détail segments (champs de recherche) |
| `surface` | `session=<id>` | registre de surface (état courant + pointeurs de remplacement) |
| `recall` | `session=<id>` | paires de remplacement classées (Σb / Σ(a−b)) |
| `search` | `q=<requête>`, `session=` optionnel | résultats FTS5 BM25 (segmentation zh/en identique) |
| `sync` (POST) | `{op:'sync'}` | accepted + dernier résultat |

## Discipline de lecture seule

- fichiers de session et `workspace.json` toujours en lecture seule ;
- toutes les écritures vont uniquement dans
  `~/.dsh-reference-session-collector/projection.db` ;
- remplacement réécriture-complète par session (DELETE+INSERT dans une
  transaction), idempotent ;
- **l'anonymisation n'est pas la responsabilité de DRSC** : texte brut
  stocké, surface d'exposition = les fichiers de session eux-mêmes.

## Variables d'environnement

| variable | défaut | signification |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | racine des journaux de session |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | répertoire de la BD de projection |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | intervalle de sync ; `0` = manuel uniquement |

## Installation / Développement

```
dsh plugin --profile web add dsh-reference-session-collector
pnpm install && pnpm check   # typecheck→lint→test→build→smoke
```

Node ≥ 22 requis (`zlib.zstdDecompressSync` + `node:sqlite`).

## Licence

MIT
