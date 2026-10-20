# dsh-reference-session-collector (DRS) — Sitzungs-Projektionssynchronisierer

**DeepSeek-Harness(DSH)-Plugin**: Liest die Sitzungsprotokolle unter
`~/.dsh/sessions/**` **nur lesend**, dekodiert sie und projiziert sie in eine
eigene SQLite-Projektion (segments / replaces / FTS5). Über eine einzelne
fenced HTTP-Route `GET/POST /api/dsh-reference-session-collector` werden
Surface-Markierungen, Recall-Abgleich und chinesisch-taugliche
Volltextsuche bereitgestellt. **Es wird niemals in Sitzungsdateien
geschrieben.**

## Status

**Geliefert (v0.1.0)**: die komplette Host-Hälfte — reiner
Projektionskern, SQLite-Projektionsspeicher (node:sqlite / FTS5),
inkrementeller Synchronisierungsmotor (Watermark-Vorprüfung,
Archivverfolgung, Interval-Scheduling), Abfrageoberfläche mit
3-Schicht-Caching, fenced HTTP-Route. Gate-Kette `pnpm check` komplett grün
(9 Suiten / 66 Tests + Dist-Smoke). **Ausstehend**: Verbraucher-Anbindung
(Phase 1 CCI-Abgleich, Phase 2 Steward-Korpusumschaltung, Phase 3
Memory-Anker-Rückfüllung) und Effizienz-Benchmark T9.1.

## Architektur

```
~/.dsh/sessions/** (nur lesend) ──→ ProjectionSync (inkrementell, watermark=bytes+mtime)
                                   │ projectSessionEvents (reiner Kern)
                                   ▼
        ~/.dsh-reference-session-collector/projection.db (4 Tabellen + fts5 + 3-Schicht-Cache)
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session-collector     CCI (Phase 1)   Steward (2) / Memory (3)
```

## HTTP-Routentabelle

| op | Parameter | Rückgabe |
|---|---|---|
| `status` | — | Speicher-Selftest + Cache-Statistik + letzter Sync |
| `sessions` | `offset/limit` | Sitzungsübersicht (residente Map, 0 SQL) |
| `session` | `session=<id>`, optional `turn=` / `fields=search` | Segmente inkl. Suchfeldern |
| `surface` | `session=<id>` | Surface-Ledger (aktuelle Oberfläche + Ersetzer-Zeiger) |
| `recall` | `session=<id>` | Ersetzungspaare klassifiziert (Σb / Σ(a−b)) |
| `search` | `q=<query>`, optional `session=` | FTS5-BM25-Treffer (zh/en gleichtsegmentiert) |
| `sync` (POST) | `{op:'sync'}` | accepted + letztes Ergebnis |

## Nur-lesend-Disziplin

- Sitzungsdateien und `workspace.json` sind stets nur lesend;
- sämtliche Schreibvorgänge gehen ausschließlich nach
  `~/.dsh-reference-session-collector/projection.db`;
- pro Sitzung vollständiger Neu-Schreib-Ersatz (DELETE+INSERT in einer
  Transaktion), idempotent;
- **Maskierung liegt nicht bei DRS**: Rohtext-Speicherung,
  Expositionsfläche = die Sitzungsdateien selbst.

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | Sitzungsprotokoll-Wurzel |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | Projektion-DB-Verzeichnis |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | Sync-Intervall; `0` = nur manuell |

## Installation / Entwicklung

```
dsh plugin --profile web add dsh-reference-session-collector
pnpm install && pnpm check   # typecheck→lint→test→build→smoke
```

Node ≥ 22 erforderlich (`zlib.zstdDecompressSync` + `node:sqlite`).

## Lizenz

MIT
