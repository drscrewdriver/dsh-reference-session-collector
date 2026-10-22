# dsh-reference-session-collector (DRSC) — 세션 원문 투영 동기화기

**DeepSeek Harness(DSH) 플러그인**: `~/.dsh/sessions/**` 세션 로그를
**읽기 전용**으로 스캔하여 디코딩 후 자체 SQLite 투영
(segments / replaces / FTS5)에 적재. 단일 fenced HTTP 라우트
`GET/POST /api/dsh-reference-session-collector`로 surface 마크, 리콜 대사(對社),
중국어 전문 검색면을 제공합니다. **세션 파일에는 절대 기록하지 않습니다.**

## 상태

**전달 완료(v0.1.0)**: 호스트 하프 전체 — 순수 투영 코어, SQLite 투영
스토어(node:sqlite / FTS5), 증분 동기화 엔진(watermark 사전 조회 / 아카이브
추종 / interval 스케줄링), 3계층 캐시 조회면, fenced HTTP 라우트. 게이트
체인 `pnpm check` 전부 녹색(9 스위트 / 66 테스트 + dist 스모크).
**남은 작업**: 컨슈머 배선(1단계 CCI 대사 / 2단계 steward 코퍼스 전환 /
3단계 memory 앵커 백필)과 성능 벤치마크 T9.1.

## 아키텍처

```
~/.dsh/sessions/**(읽기 전용) ──→ ProjectionSync(증분, watermark=bytes+mtime)
                                   │ projectSessionEvents(순수 코어)
                                   ▼
        ~/.dsh-reference-session-collector/projection.db(4개 테이블 + fts5 + 3계층 캐시)
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session-collector     CCI(1단계)   steward(2단계)/memory(3단계)
```

## HTTP 라우트 표

| op | 파라미터 | 반환 |
|---|---|---|
| `status` | — | 스토어 자가 진단 + 캐시 통계 + 최근 동기화 |
| `sessions` | `offset/limit` | 세션 요약 페이지(상주 Map, 0 SQL) |
| `session` | `session=<id>`, 선택 `turn=` / `fields=search` | segments 상세(검색면 필드) |
| `surface` | `session=<id>` | surface 대장(현재 표면 + 치환 포인터) |
| `recall` | `session=<id>` | 치환 쌍 분류(Σb / Σ(a−b)) |
| `search` | `q=<질의>`, 선택 `session=` | FTS5 BM25 히트(중·영 동일 분사) |
| `sync`(POST) | `{op:'sync'}` | accepted + 최근 결과 |

## 읽기 전용 규율

- 세션 파일과 `workspace.json`은 상시 읽기 전용;
- 모든 기록은 `~/.dsh-reference-session-collector/projection.db`에만;
- 세션 단위 전체 재작성 치환(트랜잭션 내 DELETE+INSERT), 멱등;
- **마스킹 책임은 DRSC에 없음**: 원문 저장, 노출면=세션 파일 자체.

## 환경 변수

| 변수 | 기본값 | 의미 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 세션 로그 루트 |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | 투영 DB 디렉터리 |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | 동기화 주기; `0`=수동 전용 |

## 설치 / 개발

```
dsh plugin --profile web add dsh-reference-session-collector
pnpm install && pnpm check   # typecheck→lint→test→build→smoke
```

Node ≥ 22 필요(`zlib.zstdDecompressSync` + `node:sqlite`).

## 라이선스

MIT
