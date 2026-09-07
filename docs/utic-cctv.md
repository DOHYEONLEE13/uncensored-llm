# UTIC CCTV 연결

## 구현

- 기존 ITS와 UTIC 메타데이터를 함께 조회해 2km 지도·거리순 목록·도로명 검색에 사용한다. UTIC만 설정해도 동작한다.
- 한 기관이 실패하면 다른 기관의 결과를 유지하고 누락 가능성을 표시한다. HTTP 200 안의 UTIC `resultCode: "04"`는 IP 승인 오류로 안내한다.
- 메타데이터는 20시간 캐시, 최대 23시간 보관, 실패 시 15분 재시도 제한을 적용한다. 두 공급자의 원래 수집 시각과 릴레이의 수집 시각을 유지하며, 일부 기관 복구 때문에 오래된 목록의 수명을 늘리지 않는다.
- Node와 Pages는 같은 UTIC 파서·공급자 조합을 사용한다. Pages 캐시를 공급자 및 인증 설정별로 분리한다.
- `CCTV 접근`은 기존 glass 팝업을 연다. 명시적으로 제공된 HLS·MP4·이미지와 자격 증명이 없는 공식 UTIC HTTPS 플레이어 URL을 구분한다. HTTPS 페이지에서 HTTP 영상은 기존과 같이 차단한다.
- 키가 포함된 URL, 카메라 접속 비밀번호·IP, 형식을 알 수 없는 전용 플레이어는 브라우저로 전달하지 않는다. 해당 CCTV의 이름·위치는 보존하고 재생 불가를 설명한다. `CCTVIP`를 스트림 주소로 추정하거나 키를 제거한 URL로 접근하지 않는다.
- UTIC가 제공한 항목에 `경찰청 도시교통정보센터(UTIC)` 출처를 표시한다. 사용자 GPS·카메라 목록·연결 진단은 저장된 대화 메타데이터에 남기지 않는다.

## 서버 환경변수

직접 연결은 승인된 공인 IP에서 실행되는 Node 서버가 적합하다.

```dotenv
ITS_API_KEY=기존_ITS_키
UTIC_API_KEY=발급받은_UTIC_키
```

`.env.local`에 저장하고 서버를 재시작한다. 두 키 모두 서버 전용이며 `VITE_` 접두사를 붙이지 않는다. Cloudflare에서 직접 요청하려면 Pages Secrets에 `UTIC_API_KEY`를 넣을 수 있으나, **실제로 요청하는 Cloudflare 서버 IP가 UTIC 승인 범위에 있어야 한다**. 방문자의 PC·휴대폰 주소 등록만으로 Cloudflare 요청이 승인되지는 않는다.

## Cloudflare + 승인 IP 연결 서버

승인된 IP에서 이 저장소의 Node 서버를 실행하고 HTTPS 역방향 프록시 또는 관리 중인 터널 뒤에 연결한다. 서버에는 다음 값을 설정한다.

```dotenv
UTIC_API_KEY=발급받은_UTIC_키
UTIC_RELAY_TOKEN=32자_이상의_무작위_공유_비밀값
```

`npm run build` 후 `npm start`로 실행한다. `/api/cctv/utic-catalog`는 이 토큰을 `Authorization: Bearer …` 헤더로 받은 경우에만 정제된 캐시 목록을 제공한다. 토큰을 URL에 넣지 않는다. 키/토큰 미설정 시 해당 경로는 404다. 이 경로만 Cloudflare가 접근할 HTTPS 주소로 노출하면 된다. Node 서버를 끄면 UTIC 신규 조회도 중단된다.

Cloudflare Pages의 **Secret**에 아래 두 값을 설정하고 재배포한다.

| 이름 | 값 |
| --- | --- |
| `UTIC_RELAY_URL` | `https://승인서버도메인/api/cctv/utic-catalog` |
| `UTIC_RELAY_TOKEN` | 승인 IP 서버와 동일한 공유 비밀값 |

릴레이를 쓰는 Pages에는 UTIC 키가 필요 없다. 기존 `ITS_API_KEY` 및 카카오 Vite 변수는 계속 사용한다. 요청마다 목적 URL을 받는 프록시가 아니며, 릴레이는 정해진 UTIC 목록 API만 요청한다. 영상 전체를 크롤링·중계하지 않는다.

## 2026-09-07 실제 확인 및 남은 작업

- 사용자 제공 키로 공식 HTTP/HTTPS 목록 API를 각각 요청한 결과 모두 HTTP 200, `[{"resultCode":"04","resultMsg":"허용된 IP가 아닙니다."}]`였다.
- 당시 PC의 외부 요청 공인 대역은 `211.221.146.0/24`로, 승인 메일의 두 대역에 포함되지 않았다. UTIC에 실제 서버의 공인 IP 등록을 수정해야 한다. IP가 변경될 수 있으므로 수정 요청 시 다시 확인한다.
- 성공 목록은 아직 확보하지 못했다. 파서가 지원하는 `cctvid/cctvname/xcoord/ycoord/cctvurl` 등 JSON/XML 계약은 테스트용 데이터와 공개 사이트 필드에 기반하며 **승인 API의 실제 성공 스키마와 영상 재생을 검증한 것으로 간주하지 않는다**.
- IP 승인 수정 뒤 목록 필드와 실제 영상 주소를 확인해 필요한 어댑터를 조정해야 한다. 공식 플레이어가 키·방문자 IP 인증을 요구하는 항목은 현재의 서버 전용 키 정책에서 재생하지 않는다. 키 없는 iframe 지원도 실제 UTIC에서 재생 성공을 확인한 것은 아니다.
- 승인 IP 연결 서버의 실제 HTTPS 주소/배포 및 Pages 릴레이 Secret 설정은 아직 구성하지 않았다.
- 푸시 대상만 분리한 체크아웃에서 테스트 151개와 전체 빌드가 통과했다. 개발 작업 폴더는 기존의 별도 수정 테스트 1개를 포함해 152개가 통과했다.
- Pages 전체 함수를 workerd에서 실제 키로 실행한 `올림픽대로` 검색은 HTTP 200, ITS 1곳과 `utic_ip_not_allowed` 안내를 반환했다. 두 번째 요청도 캐시를 사용하며 정상 응답했다. 키가 응답·푸시 diff·브라우저 빌드 133개 파일에 포함되지 않음을 확인했다.

공식 자료: [UTIC CCTV 레퍼런스](https://www.utic.go.kr/guide/utisRefCctv.do), [개방데이터 준수사항](https://www.utic.go.kr/guide/newUtisDataWrite.do), [공식 지도 플레이어 코드](https://www.utic.go.kr/js/cctvStream.js).
