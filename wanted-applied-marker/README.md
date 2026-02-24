# Wanted Applied Marker

원티드(Wanted) 채용 공고 목록에서 이미 지원한 공고를 시각적으로 표시해 주는 사용자 스크립트입니다.

## 주요 기능

- 이미 지원한 공고에 `지원완료` 배지를 표시
- 공고 카드를 흐리게 처리해서 미지원 공고와 구분
- 지원 상태 텍스트가 있으면 `지원완료 (상태)` 형태로 표시
- 무한 스크롤로 새로 로드된 공고도 자동 스캔
- `GM_getValue`/`GM_setValue` 기반 14일 캐시로 API 호출 최소화

## 동작 환경

- 브라우저 확장: Tampermonkey(권장) 또는 호환 userscript 매니저
- 대상 페이지: `https://www.wanted.co.kr/wdlist/*`
- 로그인 상태에서 동작 (Wanted API 응답 필요)

## 설치 방법 (권장: 릴리즈 배포본)

이 저장소는 `main` 브랜치 릴리즈 시 userscript 파일을 자동 생성/업로드합니다.
일반 사용자는 저장소를 클론하거나 `dist`를 직접 빌드할 필요가 없습니다.

1. Tampermonkey를 설치합니다.
2. 아래 최신 배포본 링크를 브라우저에서 엽니다.

- https://github.com/AndrewDongminYoo/user-scripts/releases/latest/download/wanted-applied-marker.user.js

3. Tampermonkey 설치 화면에서 스크립트를 설치합니다.

## 개발 모드 사용 (개발자용)

```bash
cd wanted-applied-marker
pnpm dev
```

- 실행 후 터미널에 표시되는 `.user.js` 개발 URL을 Tampermonkey에 등록하면 수정 사항을 빠르게 확인할 수 있습니다.

## 로컬 빌드 (개발자용)

```bash
cd wanted-applied-marker
pnpm install
pnpm build
```

- 빌드 결과물: `wanted-applied-marker/dist/wanted-applied-marker.user.js`

## 동작 방식 요약

- 공고 링크(`a[href*="/wd/"]`)에서 `jobId`를 추출
- Wanted 상세 API(`/api/chaos/jobs/v4/{jobId}/details`)로 지원 여부 확인
- 지원 이력(`data.application`)이 있으면 배지/스타일 적용
- `MutationObserver`로 DOM 변화를 감지해 재스캔

## 제한 사항

- Wanted DOM/API 변경 시 일부 기능이 동작하지 않을 수 있습니다.
- 현재 기본 설정은 지원 완료 공고를 숨기지 않고 표시만 합니다.
