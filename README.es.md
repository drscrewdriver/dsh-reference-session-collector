# dsh-reference-session-collector (DRS) — sincronizador de proyección de sesiones

**Complemento de DeepSeek Harness (DSH)**: escanea **solo en lectura** los
registros de sesión en `~/.dsh/sessions/**`, los decodifica y los proyecta
en una proyección SQLite propia (segments / replaces / FTS5). Una única
ruta HTTP acotada `GET/POST /api/dsh-reference-session-collector` expone marcas de
superficie, conciliación de recuperaciones (recall) y búsqueda de texto
completo con soporte de chino. **Nunca escribe en los archivos de sesión.**

## Estado

**Entregado (v0.1.0)**: la mitad anfitriona completa — núcleo de proyección
puro, almacén SQLite (node:sqlite / FTS5), motor de sincronización
incremental (preconsulta de marca de agua, seguimiento de archivo,
programación por intervalo), capa de consultas con caché de 3 niveles y
ruta HTTP acotada. Cadena de puertas `pnpm check` totalmente en verde
(9 suites / 66 pruebas + humo de dist). **Pendiente**: cableado de
consumidores (fase 1 conciliación CCI, fase 2 cambio de corpus de steward,
fase 3 relleno de anclas de memory) y banco de pruebas de eficiencia T9.1.

## Arquitectura

```
~/.dsh/sessions/** (solo lectura) ──→ ProjectionSync (incremental, watermark=bytes+mtime)
                                   │ projectSessionEvents (núcleo puro)
                                   ▼
        ~/.dsh-reference-session-collector/projection.db (4 tablas + fts5 + caché de 3 niveles)
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session-collector     CCI (fase 1)   steward (2) / memory (3)
```

## Tabla de rutas HTTP

| op | parámetros | devuelve |
|---|---|---|
| `status` | — | autodiagnóstico + estadísticas de caché + última sincronización |
| `sessions` | `offset/limit` | resumen de sesiones (Map residente, 0 SQL) |
| `session` | `session=<id>`, opcional `turn=` / `fields=search` | detalle de segments (campos de búsqueda) |
| `surface` | `session=<id>` | registro de superficie (estado actual + punteros de reemplazo) |
| `recall` | `session=<id>` | pares de reemplazo clasificados (Σb / Σ(a−b)) |
| `search` | `q=<consulta>`, opcional `session=` | resultados FTS5 BM25 (segmentación idéntica zh/en) |
| `sync` (POST) | `{op:'sync'}` | accepted + último resultado |

## Disciplina de solo lectura

- los archivos de sesión y `workspace.json` son siempre de solo lectura;
- toda escritura del complemento va únicamente a
  `~/.dsh-reference-session-collector/projection.db`;
- reemplazo de reescritura completa por sesión (DELETE+INSERT en una
  transacción), idempotente;
- **la desensibilización no es responsabilidad de DRS**: almacena texto
  original; la superficie de exposición son los propios archivos de sesión.

## Variables de entorno

| variable | valor por defecto | significado |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | raíz de registros de sesión |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | directorio de la BD de proyección |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | intervalo de sincronización; `0` = solo manual |

## Instalación / desarrollo

```
dsh plugin --profile web add dsh-reference-session-collector
pnpm install && pnpm check   # typecheck→lint→test→build→smoke
```

Requiere Node ≥ 22 (`zlib.zstdDecompressSync` + `node:sqlite`).

## Licencia

MIT
