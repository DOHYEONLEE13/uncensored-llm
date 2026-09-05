# MIRA CCTV 지도 연결 상태

## 기존 구조

`src/cctv.ts`에서 위치를 한 번 읽고 POST `/api/cctv/nearby`로 전송한다.
`src/App.tsx`의 기존 명시적 CCTV 라우팅과 도구 버튼을 유지한다.
Node `server/cctv.ts`와 Pages `functions/_cctv.ts`의 ITS 메타데이터 캐시는 변경하지 않았다.
작업 시작 시 존재하던 채팅·모델·Web Search 수정도 보존했다.

## 사용한 지도 Provider

**카카오맵 JavaScript SDK.** 사용자가 Provider와 공개 JavaScript 키를 제공해 실제 SDK 어댑터를 연결했다.
SDK는 CCTV 결과를 열 때만 HTTPS로 불러오며 카카오 로그인 SDK, 주소 검색, 경로·거리 API는 사용하지 않는다.
현재 로컬 SDK 요청은 카카오의 `401 AccessDeniedError` 및 `domain mismatched` 응답으로 차단된다. 키가 등록된 앱에서 `http://127.0.0.1:5173` 도메인을 허용해야 실제 타일·마커를 검증할 수 있다.

## 환경변수

- `VITE_CCTV_MAP_PROVIDER`: `.env.local`에 `kakao`로 설정했다. `.env.example`에는 빈 값만 둔다.
- `VITE_KAKAO_MAP_JAVASCRIPT_KEY`: 사용자에게 받은 공개 JavaScript 키를 `.env.local`에 설정했다. 소스와 `.env.example`에는 키 원문이 없다. Vite가 이 공개 키를 브라우저 번들에 포함하는 것은 정상이다.
- `ITS_API_KEY`: 기존 서버 전용 키. 지도에 사용하지 않으며 frontend에서 참조하지 않는다.
- 지도 표시에 별도의 REST API 키나 서버용 카카오 키는 필요하지 않다.
- 카카오 개발자 콘솔 → 앱 → 플랫폼 키 → 해당 JavaScript 키 → JavaScript SDK 도메인에서 `http://127.0.0.1:5173`을 등록한다. `http://localhost:5173`으로도 접속한다면 그 주소도 별도 등록한다. 운영 주소도 실제 배포 origin만 등록한다.
- 카카오맵 사용 설정이 ON이어야 한다. 콘솔 접근 제한을 해제하거나 키의 허용 도메인을 무제한으로 넓히지 않는다.
- `.env.local`은 기존 `.gitignore`에 따라 계속 제외된다. 운영에서 공개 변수는 frontend 빌드 시 설정해야 한다.

## 수정 파일

- `src/App.tsx`: 2km·20개 요청, GPS를 메시지와 분리, 조회·대화 전환 시 위치 해제, 빈 결과 카드.
- `src/cctv.ts`: 요청 기본값, 서버 거리 유지, 반경 검사·정렬, 안전한 오류 문구.
- `src/CctvResults.tsx`: 거리순 선택 목록, 공통 선택 상태, 선택·영상 패널, 지도 오류 경계.
- `src/CctvMap.tsx`: 지도 컨테이너, 로딩·미연결·실패·재시도·위치 만료, 선택 거리 overlay, SDK lifecycle.
- `src/mapProvider.ts`: 작은 mount/setSelected/resize/destroy 계약, geodesic 원과 직선 데이터.
- `src/kakaoMapProvider.ts`: Kakao SDK lazy load, 2,000m 점선 Circle, 현재 위치/번호 마커, 직선, 확대·축소·반경 복귀 버튼, 리소스 정리.
- `src/CctvVideo.tsx`: 기존 native HLS / hls.js 재생 로직 추출 및 정리.
- `src/index.css`, `src/vite-env.d.ts`, `.env.example`: 반응형 CCTV 스타일과 환경 타입/변수.
- `tests/cctvClient.test.ts`, `tests/cctvMap.test.ts`, `tests/cctvUi.test.ts`, `tests/cctvApp.test.ts`: 요청·반경·geometry·선택·HLS·실패·GPS 저장 방지 테스트.
- `tests/kakaoMap.test.ts`: Kakao SDK 계약, 점선 반경, 실제 adapter의 선택·선 강조·해제, SDK 로딩 실패/취소/재시도 테스트.
- `package.json`, `package-lock.json`: DOM 테스트용 happy-dom devDependency, JSX 설정을 사용하는 테스트 실행.

## 지도 표시 흐름

CCTV 입력/버튼 → Geolocation 1회 → `{ latitude, longitude, radiusKm: 2, limit: 20 }` POST → 거리순 결과 카드 → `CctvMap` lazy import → `loadMapProvider`.
마지막 단계에서 Kakao adapter를 동적 import하고 공식 SDK를 `autoload=false`로 불러온 후 `kakao.maps.load()`를 기다린다. SDK 동시 로딩은 하나로 합친다.
SDK 로딩/초기 타일 대기 각각 12초, 지도 컴포넌트 전체 초기화 15초 한도로 실패를 처리한다. 타일 오류도 지도만 실패 처리하며 재시도는 위치나 ITS를 재조회하지 않는다.

## 위치 및 2km 반경

GPS는 현재 CCTV 화면을 위한 임시 React state에만 존재한다. 메시지·Conversation에는 넣지 않는다.
다음 CCTV 조회, 대화 생성·전환·삭제, 채팅 닫기에서 해제한다. 다시 연 대화는 GPS를 복원하지 않는다.
서버 거리 2,000m 이하인 ITS 결과만 최대 20개 사용한다. 클라이언트 Haversine 검사는 서버 반올림으로 경계 밖 항목이 들어오는 경우를 막는 용도이며 표시 거리를 바꾸지 않는다.
공통 geometry는 구면 지구 반지름 6,371,000m에서 계산한 128개 지점과 닫힘 지점 1개로 만든다. 실제 카카오맵은 미터 단위 `Circle.radius=2000`과 `strokeStyle='dashed'`를 사용한다.

## CCTV 선·거리 표시

각 연결선은 사용자 위치와 CCTV 위치 두 점으로 구성한 GeoJSON 형식 LineString이다. 거리 표시는 서버의 `distanceMeters`를 사용한다(320m / 1.4km).
현재 위치는 파란 점과 '내 위치', CCTV는 초록 번호 마커로 구분한다. 원 내부 불투명도는 0.035이다.
일반 직선은 MIRA 계열의 녹색 `#42796d`, 1px·낮은 불투명도로 표시한다. 선택한 선은 2px과 진한 녹색으로 강조하고 선택 마커도 밝게 바뀐다. 거리 overlay는 React의 선택 항목 하나만 사용한다.
지도 중심은 `scene.center`, 초기 viewport는 `Circle.getBounds()`에 24px 여백을 둔다. 초기 반경이 보이는 수준보다 더 축소되지 않도록 제한하고, 컨테이너 크기가 변경되면 반경을 다시 맞춘다.
휠/터치 확대 대신 별도 확대·축소 버튼을 사용한다. '2km' 버튼으로 현재 위치와 반경 전체로 돌아온다. 자동 카메라 이동에는 애니메이션을 사용하지 않는다. 지도 저작권 표시는 가리지 않는다.

## CCTV 선택 및 영상 재생

Provider 마커 클릭은 `onSelect(id)`로 전달하고, 목록 선택은 `setSelected(id)`로 지도에 전달한다.
Kakao CustomOverlay 내부의 실제 HTML 버튼으로 마커를 구성한다. 이름은 HTML로 해석하지 않고 text/attribute로 넣는다. 테스트용 좌표·CCTV는 테스트 파일에만 있다.
선택 패널에는 ITS, 이름, 직선거리, 도로 유형, 영상 보기/닫기를 표시한다. 선택만으로 영상을 요청하지 않는다.
다른 CCTV 선택·닫기·unmount 시 기존 player를 해제하고 HLS instance를 destroy한다.
Safari native HLS를 먼저 사용하고 미지원 시 hls.js를 lazy load한다. HTTPS에서 HTTP 영상/이미지는 요청하지 않는다.
실패 문구는 “현재 CCTV 영상을 불러올 수 없습니다.”이다.

## Mobile

지도 영역은 모바일 320px, 768px 이상 420px 높이이다. 카드 최대 너비 42rem 및 부모 100% 제한을 함께 적용한다.
패널은 지도 바로 아래 문서 흐름에 배치해 기존 입력창·키보드 viewport 코드를 유지한다.
목록은 모바일 1열, 데스크톱 2열이다. 긴 이름은 줄바꿈하며 버튼은 키보드 선택과 focus 표시, aria-label/aria-pressed를 제공한다.
`prefers-reduced-motion` CSS와 adapter 옵션으로 애니메이션을 줄인다.

## Privacy / Security

좌표는 자체 CCTV API의 POST body로만 전송하며 URL·localStorage·대화 내용·analytics·console에 기록하지 않는다.
CCTV 목록도 기존 저장 필터로 localStorage에서 제외한다. 지도 geometry는 외부로 저장하지 않는다.
API/SDK 원본 오류 문자열을 UI에 표시하거나 앱 console에 기록하지 않는다. 공개 키는 Kakao의 공식 SDK URL의 `appkey`로만 사용한다.
GPS의 자체 API 전송은 POST body뿐이다. 지도 SDK는 지도를 표시하기 위해 Kakao 타일 서버와 통신하며, 이 요청의 타일 주소에는 표시 지역 정보가 반영된다. 앱에서 정확한 사용자 GPS를 URL query나 저장소에 추가하지 않는다.
Kakao에는 공개 Map.destroy()가 없으므로 어댑터 해제 시 모든 overlay와 등록 listener를 제거하고, 지도 interaction을 끈 뒤 전용 DOM과 참조를 해제한다. 전역에는 SDK 로딩 중 Promise만 보관한다.

## Tests

검증 명령: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`. 작업 폴더의 테스트 105개 및 푸시 대상 파일만 복사한 검증 폴더의 테스트 104개가 통과했다. 기존 모델 관련 미커밋 변경은 이번 CCTV 커밋에 포함하지 않는다.
브라우저 bundle 검사에서는 `VITE_KAKAO_MAP_JAVASCRIPT_KEY` 공개 키 포함과 나머지 서버 secret 미포함을 구분한다. 키 원문은 출력하지 않는다.
지도 컴포넌트와 Kakao adapter는 별도 lazy chunk로 생성된다. 빌드에는 HLS/Mermaid 계열의 500kB 초과 청크 경고가 남는다.
DOM 테스트는 지도 callback, 선택 패널, HLS destroy, native HLS, HTTP 차단, 지도 로드/실행 실패 및 늦은 mount 정리를 확인한다.
실제 브라우저에서 로컬 ITS 결과, 영상 로딩, 키보드 선택, 320px·390px·1280px 너비와 가로 넘침을 확인했다.
실제 카카오 지도 마커·타일·viewport 검증은 로컬 도메인 허용 뒤에 가능하다. 모바일 소프트 키보드는 실제 기기에서 추가 확인해야 한다.

## Remaining limitations

카카오의 로컬 도메인 허용 설정이 필요하다. 실제 응답으로 확인된 차단 사유는 `domain mismatched! caller=http://127.0.0.1:5173`이다.
동일·인접 좌표의 마커는 겹칠 수 있으므로 동일한 거리순 목록을 항상 함께 제공한다.
영상 제공자 네트워크·CORS·HTTPS 조건에 따른 재생 제한은 남는다.
Git 연동 배포 시 빌드 환경에 `VITE_CCTV_MAP_PROVIDER=kakao`와 `VITE_KAKAO_MAP_JAVASCRIPT_KEY`를 설정하고 재빌드해야 한다. 서버의 ITS 키는 기존 `ITS_API_KEY`로 따로 설정한다. `.env.local`은 push에 포함되지 않는다.

공식 참고: [Kakao Maps 가이드](https://apis.map.kakao.com/web/guide/), [SDK 레퍼런스](https://apis.map.kakao.com/web/documentation/), [Kakao Maps 사용 설정](https://developers.kakao.com/docs/ko/kakaomap/common).

## Cloudflare CCTV 조회 실패 수정 (2026-09-05)

배포 API를 직접 확인한 결과, 스크린샷의 고정 배포 주소는 `configuration_error`를 반환했고 대표 주소는 `its_connection_error`를 반환했다. 고정 배포 주소는 그 배포 시점의 Secret 설정을 사용하므로 설정 변경 후에는 새 배포 또는 대표 주소에서 확인해야 한다.

연결 오류의 코드 원인은 `ItsCctvProvider`가 네이티브 `fetch`를 인스턴스 필드에 저장하고 `this.fetchImplementation(...)`으로 호출한 것이다. Cloudflare Workers에서는 이때 `this`가 전역 객체 대신 provider가 되어 `TypeError: Illegal invocation`이 발생했다. Node의 fetch와 화살표 함수 mock에서는 재현되지 않아 기존 테스트가 놓쳤다. 네이티브 fetch를 사용하는 Miniflare/workerd에서 동일 오류를 재현했다.

Node/Pages provider 모두 fetch를 `globalThis`에 바인딩하도록 수정했다. 수정 후 같은 Workers 런타임에서 실제 ITS 조회가 HTTP 200으로 성공하고 다음 요청이 캐시를 재사용하는 것을 확인했다. 호환성 날짜/9443 포트도 조사했으나, 확인된 호출 오류는 네트워크 요청 전에 발생했으므로 Cloudflare 설정 파일을 새로 도입하지 않았다. 기존 대시보드의 Secret·지도 빌드 환경변수 설정을 계속 사용한다.

클라이언트는 서버가 반환하는 오류 코드만 허용 목록으로 해석하여 인증 설정 누락, 제공 서버 연결 실패, 시간 초과, 데이터 오류를 구분한다. 원본 오류 메시지·임의 오류 코드는 채팅에 복사하지 않는다. `error: null` 응답도 브라우저 네트워크 오류로 잘못 처리하지 않는다. 연결 시간 초과는 Node/Pages에서 `its_timeout` / HTTP 504로 구분한다.

회귀 검증은 전역 receiver를 요구하는 네이티브 fetch 계약, 시간 초과/연결 실패 구분, 실제 배포 오류 응답의 사용자 메시지, 잘못된 오류 payload, 채팅/저장 이력의 진단 정보 비노출을 포함한다. 실제 사용자 위치 및 카카오 허용 도메인 설정은 별개이며, 지도 SDK는 CCTV API가 성공한 다음 로드된다.
