# dsh-reference-session-collector (DRS) — sincronizzatore di proiezione delle sessioni

**Plugin DeepSeek Harness (DSH)**: scansisce **in sola lettura** i log di
sessione in `~/.dsh/sessions/**`, li decodifica e li proietta in una
proiezione SQLite proprietaria (segments / replaces / FTS5). Un singolo
endpoint HTTP delimitato `GET/POST /api/dsh-reference-session-collector` espone i
marchi di superficie, la riconciliazione dei recall e la ricerca full-text
con supporto del cinese. **Non scrive mai nei file di sessione.**

## Stato

**Consegnata (v0.1.0)**: tutta la metà host — nucleo di proiezione puro,
archivio SQLite (node:sqlite / FTS5), motore di sincronizzazione
incrementale (pre-verifica watermark, seguimento dell'archivio,
pianificazione a intervallo), superficie di query con cache a 3 livelli,
endpoint HTTP delimitato. Catena di gate `pnpm check` tutta verde
(9 suite / 66 test + smoke di dist). **Rimanente**: cablaggio dei
consumatori (fase 1 riconciliazione CCI, fase 2 commutazione del corpus
steward, fase 3 riempimento ancore memory) e benchmark di efficienza T9.1.

## Architettura

```
~/.dsh/sessions/** (sola lettura) ──→ ProjectionSync (incrementale, watermark=bytes+mtime)
                                   │ projectSessionEvents (nucleo puro)
                                   ▼
        ~/.dsh-reference-session-collector/projection.db (4 tabelle + fts5 + cache a 3 livelli)
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session-collector     CCI (fase 1)   steward (2) / memory (3)
```

## Tabella degli endpoint HTTP

| op | parametri | restituisce |
|---|---|---|
| `status` | — | auto-diagnosi archivio + statistiche cache + ultima sincronizzazione |
| `sessions` | `offset/limit` | riepilogo sessioni (Map residente, 0 SQL) |
| `session` | `session=<id>`, opzionali `turn=` / `fields=search` | dettaglio segments (campi di ricerca) |
| `surface` | `session=<id>` | registro di superficie (stato attuale + puntatori di sostituzione) |
| `recall` | `session=<id>` | coppie di sostituzione classificate (Σb / Σ(a−b)) |
| `search` | `q=<query>`, opzionale `session=` | risultati FTS5 BM25 (segmentazione identica zh/en) |
| `sync` (POST) | `{op:'sync'}` | accepted + ultimo risultato |

## Disciplina di sola lettura

- i file di sessione e `workspace.json` sono sempre in sola lettura;
- tutte le scritture del plugin finiscono esclusivamente in
  `~/.dsh-reference-session-collector/projection.db`;
- sostituzione con riscrittura completa per sessione (DELETE+INSERT in una
  transazione), idempotente;
- **la sanitizzazione non è responsabilità di DRS**: memorizza testo grezzo,
  superficie di esposizione = i file di sessione stessi.

## Variabili d'ambiente

| variabile | predefinito | significato |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | radice dei log di sessione |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | directory del DB di proiezione |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | intervallo di sincronizzazione; `0` = solo manuale |

## Installazione / sviluppo

```
dsh plugin --profile web add dsh-reference-session-collector
pnpm install && pnpm check   # typecheck→lint→test→build→smoke
```

Richiede Node ≥ 22 (`zlib.zstdDecompressSync` + `node:sqlite`).

## Licenza

MIT
