# 도메인 분석

채팅 입력창의 **+ → 도메인 분석**에서 도메인 또는 웹 주소를 입력한다. 기존 MIRA 모델 선택을 사용해 수집 결과를 해설한다. 결과는 팝업의 요약, 연결 지도, 타임라인, 보안 단서, 출처에서 확인한다. 결과·입력 도메인·AI 해설은 대화 기록이나 localStorage에 저장하지 않는다. 닫기/취소는 브라우저 요청과 AI 스트림을 취소한다.

## 수집 범위

| 출처 | 기본 동작 | 의미와 제한 |
| --- | --- | --- |
| Google Public DNS | A/AAAA/MX/NS/TXT/CAA 및 `_dmarc` TXT | 조회 시점의 응답. AD=false를 DNSSEC 미설정으로 판정하지 않는다. 상위 도메인 DMARC 상속은 검사하지 않는다. |
| IANA / RDAP | IANA가 게시한 HTTPS registry에서 등록정보 조회 | 하위 도메인은 registry의 404 응답에 한해 부모 이름을 최대 4회 탐색한다. 등록 대행사·상태·날짜만 표시하고 비공개 소유자 정보는 수집하지 않는다. .kr 등 IANA HTTPS RDAP 미제공 TLD는 확인 불가. |
| crt.sh | 공개 인증서의 이름 최대 60개·최근 기록 8개 | 와일드카드는 패턴으로 보존한다. 존재·운영·현재 TLS 연결의 증거가 아니다. 공개 시각 미제공 시 유효 시작일을 별도 이름으로 표시한다. |
| Wayback | 입력 호스트 루트 페이지의 최근 보관 기록 | 전체 변경 이력이나 최초 생성일이 아니다. 원본 스냅샷 링크로 이동할 수 있다. |
| urlscan | 정확히 일치하는 task/page 호스트의 기존 공개 기록 5건 | 새 스캔을 제출하지 않는다. 기본 기록은 무키로 조회 가능하나 상세 API는 키/권한에 따라 제한된다. HTTPS 최종 문서의 헤더가 실제 제공될 때만 HSTS/CSP/nosniff/CORS를 해석한다. 쿠키 값·이름·요청 인증 헤더는 보관하지 않는다. |
| SecurityTrails | 선택 연결, 과거 A 레코드 20건 | 관측 기간을 보여주며 제공자의 전체 기록·현재 원본 서버를 보장하지 않는다. |
| BuiltWith | 선택 연결, 공통 식별자 관계 40개 | rv4 Relationships/Identifiers/Matches를 사용한다. 기간 겹침·관측 시점을 표시하며 동일 운영자라고 판정하지 않는다. |
| VirusTotal | 선택 연결, 기존 도메인 분류 기록 | 업체 분류와 날짜를 표시한다. 미탐지·탐지 모두 안전/악성 확정 점수가 아니다. |

광고 판매 파일(`ads.txt`/`sellers.json`), 사이트맵/robots.txt, 실제 웹페이지·TLS 접속 및 능동 취약점 검증은 이번 구현의 자동 수집 범위에 포함하지 않는다. 이 항목들이 검사된 것처럼 표시하지 않는다. 키가 필요한 출처와 부분 실패는 `출처` 화면에서 별도로 표시한다.

## 환경변수

기본 DNS/RDAP/인증서/Wayback/urlscan 검색에는 추가 키가 필요 없다. 선택 기능은 다음 키를 `.env.local` 또는 Cloudflare Pages의 **Variables and secrets → Secret**으로 설정한다. `VITE_`를 붙이지 않는다. 연결 후 재배포한다.

```dotenv
URLSCAN_API_KEY=
SECURITYTRAILS_API_KEY=
BUILTWITH_API_KEY=
VIRUSTOTAL_API_KEY=
```

제공자의 API 요금제와 이용 범위에 맞는 키가 필요하다. 키의 존재만으로 상세 데이터 이용 권한이 보장되지는 않는다. BuiltWith 키도 쿼리 문자열 대신 `Authorization` 헤더로 전달한다. AI는 이미 연결된 MIRA 모델 API를 이용하므로 별도 AI 키나 에이전트 하네스를 추가하지 않는다.

## 구현과 데이터 흐름

- 프런트: `DomainAnalysisDialog.tsx`를 `+` 메뉴에서 지연 로딩한다. native dialog/portal, 초점 복원, Esc, 좁은 화면, reduced-motion을 지원한다.
- API: `POST /api/domain/analyze`, JSON `{ "domain": "example.com" }`. Node와 Pages가 `server/domainAnalysis.ts`, `server/domainHttp.ts`의 동일한 코드를 사용한다.
- 네트워크: 고정 공개 정보 제공자와 IANA bootstrap에 등록된 HTTPS registry에만 요청한다. 사용자 입력 도메인, 스캔 결과 속 URL, redirect Location으로 직접 요청하지 않는다. 제공자 redirect는 따라가지 않는다. IP·내부 이름·사용자 정보·비표준 포트를 입력으로 거부한다.
- 제한: 입력 4 KiB, 도메인 253자, 제공자 응답 2 MB(urlscan 상세 4 MB), 요청별 7초, 전체 25초, 외부 요청 동시 4개, 분석 동시 3개. 실행 인스턴스별 클라이언트 분당 12회. 전역 분산 rate limit은 아니므로 대규모 서비스에는 Cloudflare rate limiting을 별도 적용한다.
- 캐시: 인스턴스 메모리의 도메인별 최대 32개, 정상 5분·일부 실패 1분, 동일 도메인 동시 요청 병합. 공용 공개 정보만 저장하며 사용자별 탐색 이력을 구성하지 않는다. 클라이언트 IP는 로그 없이 인스턴스 내 요청 제한에만 사용한다.
- AI: 수집된 결과를 먼저 표시한다. 기존 `/api/chat`에 `webSearchMode: off`로 정제한 증거 요약을 전달하며 AI가 네트워크 검사 대상을 결정하지 않는다. raw HTML, TXT 인증 토큰, 쿠키 값, 제공자 원문 오류는 전달하지 않는다. 모델 실패 시 원래 결과를 유지하고 해설만 재시도한다.

## 검증

`tests/domainAnalysis.test.ts`: 입력/SSRF 경계, 고정 제공자/redirect, 부분 실패, 응답 크기/시간 제한, 요청 병합과 캐시, RDAP/CT/urlscan/선택 제공자 스키마, 날짜 단위, 민감 값 제외, 불완전 헤더 오판 방지.

`tests/domainUi.test.ts`: 실제 App의 + 메뉴 진입, AI보다 먼저 결과 표시, 관계 노드 선택, 취소/닫기/초점 복원, 늦은 응답 무시, AI 실패·재시도, 대화 저장소 미기록.

실제 공개 `example.com`으로 Node 수집 및 Cloudflare workerd 라우트를 검증한다. 선택 서비스는 키가 없어 실제 인증 조회 대신 공식 응답 형식의 테스트를 사용한다. 실제 관측 서비스의 접근 제한을 숨기지 않는다.

공식 자료: [DNS JSON](https://developers.google.com/speed/public-dns/docs/doh/json), [IANA RDAP](https://www.iana.org/assignments/rdap-dns), [Wayback API](https://archive.org/help/wayback_api.php), [urlscan](https://urlscan.io/docs/api/), [SecurityTrails](https://docs.securitytrails.com/reference/dns-history-by-record-type-old-1), [BuiltWith](https://api.builtwith.com/relationships-api), [VirusTotal](https://docs.virustotal.com/reference/domains-object).
