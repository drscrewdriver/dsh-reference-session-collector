# dsh-reference-session-collector (DRS)

**Session reference projection synchronizer** — a DeepSeek Harness (DSH) plugin.

Reads session logs under `~/.dsh/sessions` (**read-only**) and decodes them into
one shared SQLite **projection store**: original text indexed by
`session × turn/step × seq`, DeepSeek-vocabulary token lengths, CCI surface
replacement markers, recall pointers, and an FTS5 full-text index — so context
compression (cci), the session steward, and prime-memory all read the same
projection instead of each decoding logs on their own.

> Naming: `dsh-reference-session-collector` abbreviates to **DRS**, which is also the
> first three letters of drscrewdriver.

## Status

**Delivered (v0.1.0)**: the whole host half — pure projection core, SQLite
projection store (node:sqlite, FTS5), incremental sync engine (watermark
pre-check, archive-set following, interval scheduling), query surface with
3-layer caching, and the fenced HTTP route. Gate chain `pnpm check` green
(9 suites / 66 tests) plus dist smoke (`pnpm smoke`). **Remaining**: consumer
wiring (phase 1 CCI reconciliation, phase 2 steward corpus switch, phase 3
memory anchor backfill) and the efficiency benchmark (T9.1). The route table
and store schema below are finalized.

## Architecture

```
~/.dsh/sessions/** (read-only) ──→ ProjectionSync (incremental, watermark)
                                   │ projectSessionEvents (pure core)
                                   ▼
       projection.db (~/.dsh-reference-session-collector/, 4 tables + fts5, 3-layer cache)
                                   │
           ┌───────────────────────┼────────────────────┐
 /api/dsh-reference-session-collector     cci (phase 1)     steward (2) / memory (3)
 (status/surface/recall/…)      savings/recheck   corpus / history backfill
```

- **Store**: `sessions` (watermark + aggregates) / `segments` (original text ×
  turn/step × tokens × surface marker × search vista) / `replaces` (replace
  pair pointers, a/b/kind) + `segments_fts` (bm25 over Intl.Segmenter('zh')
  word-segmented text in a unicode61 table).
- **CCI assists**: surface-marker recognition (what is on the surface now, and
  what replaced it) + surface recall pointer statistics (replace pairs with
  b>a are re-reads; Σb accounts for negative savings directly).
- **Three cache layers**: SQLite mmap/WAL always on; sessions aggregates
  resident in memory; per-session ledger LRU keyed by sync generation.

## HTTP route

Single fenced route, op dispatch:

| op | params | returns |
|---|---|---|
| `status` (default) | — | store/cache/sync status |
| `sessions` | `limit` `offset` | paginated session summaries |
| `session` | `id`, optional `turn=` range, optional `fields=search` | session projection detail |
| `surface` | `id` | surface marker ledger |
| `recall` | `id` | recall pairs + Σb (negative-savings stats, range pointers) |
| `search` | `q`, `limit`, `session?` | fts5 hits (CJK-capable) |
| `sync` (POST) | — | kick incremental sync; returns accepted + lastResult |

Without the webServer service the plugin still syncs; only the HTTP face is
missing (fail-soft).

## Read-only discipline

`readFileSync` is the **only** call this plugin makes against session files,
and it has no write counterpart — ever. The plugin writes only to
`~/.dsh-reference-session-collector/projection.db`. That database holds **unsanitized
original text**; its exposure equals the session files themselves. Any
"sanitized corpus" requirement belongs to consumers, not DRS.

## Configuration (v0)

No settings face yet (lands with phase-2 wiring). Environment variables:

| variable | default | meaning |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | session log root |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | projection db dir |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | sync interval; `0` = manual only |

## Roadmap

1. **Phase 1 · cci reconciliation**: monitor/verify gains a DRS recall column —
   claims vs formula vs projection, three-column accounting (read-only HTTP).
2. **Phase 2 · steward corpus switch**: the steward's inlined search engine
   reads DRS (segments.time/on_surface/search_text + last_time_ms/archived
   cover its whole hit face; field mapping in
   `.agents/plans/drs-start/findings.md`).
3. **Phase 3 · memory history projection (read-only)**: the l0 write path does
   **not** move (sanitization/redaction/record_id ownership stays in memory's
   capture side; it is semantically incompatible with full-session rewrite).
   DRS only serves historical anchor backfill and corpus. Vector layer
   (BGE-M3 int8) is a separate optional batch job.

## Development

```bash
pnpm install
pnpm check       # typecheck → lint → test → build → smoke (one chain)
```

Plan and progress: `.agents/plans/drs-start/` (spec / findings / checklist /
tasks).

## License

MIT
