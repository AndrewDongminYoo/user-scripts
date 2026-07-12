# Gemini Chat Exporter

gemini.google.com 대화 페이지에서 현재 대화를 **Markdown 또는 JSON 파일로 내려받는** 사용자 스크립트입니다.
Gemini는 안정적인 대화 조회 API를 제공하지 않아(내부 `batchexecute` RPC는 빌드마다 난독화됨), 렌더링된 DOM을 직접 읽어 추출합니다.

## 주요 기능

- 사이드바(대화 목록 드로어)가 열려 있으면 "새 채팅" 근처에 네이티브 `⬇ Export` 행을 삽입하고, 드로어가 닫혀 있으면 우측 하단 플로팅 버튼으로 대체
- 두 트리거 모두 클릭하면 ⚙️ 설정 모달이 열리고, 모달의 **"⬇ Export this chat"** 버튼으로 현재 대화를 다운로드
- 대화의 각 턴(사용자 질문 + Gemini 응답)을 문서 순서대로 읽어 Markdown/JSON 양쪽 렌더러에 동일한 데이터를 공급
- **Extended thinking**(추론 과정)을 접기 가능한 `🧠 Thinking` 블록으로, **첨부파일**은 파일명만 캡처 (둘 다 토글로 켜고 끌 수 있음)
- 무한 스크롤 대화 목록을 최상단까지 스크롤해 모든 턴이 로드됐는지 확인한 뒤 한 번에 수집 (긴 대화도 누락 없이 내보내기)
- ⚙️ 설정 패널: 출력 포맷(Markdown/JSON), frontmatter(Markdown 전용), Extended thinking, Attachments 토글을 선택 (설정은 `GM_setValue`로 저장되어 새로고침 후에도 유지)

## 동작 환경

- 브라우저 확장: Tampermonkey(권장) 또는 호환 userscript 매니저
- 대상 페이지: `https://gemini.google.com/*` (대화 페이지 `https://gemini.google.com/app/<id>`에서 실제 동작)
- 로그인 상태에서 동작

## 설치 방법 (권장: 릴리즈 배포본)

이 저장소는 `main` 브랜치 릴리즈 시 userscript 파일을 자동 생성/업로드합니다.

릴리즈는 **패키지별로 태그**됩니다(`gemini-chat-exporter-<날짜>`). 저장소 전역 `releases/latest`는 다른 패키지(Wanted·Claude)의 릴리즈가 더 최신이면 이 파일을 찾지 못해 404가 나므로 사용하지 않습니다.

1. Tampermonkey를 설치합니다.
2. 아래 링크에서 가장 최근 `gemini-chat-exporter-*` 릴리즈를 엽니다.

- https://github.com/AndrewDongminYoo/user-scripts/releases?q=gemini-chat-exporter&expanded=true

3. 그 릴리즈의 Assets에서 `gemini-chat-exporter.user.js`를 열어 Tampermonkey 설치 화면에서 설치합니다.

## 개발 모드 / 로컬 빌드 (개발자용)

```bash
cd gemini-chat-exporter
pnpm install
pnpm build     # dist/gemini-chat-exporter.user.js 생성
pnpm dev       # Vite 개발 서버 (터미널의 .user.js URL을 Tampermonkey에 등록)
pnpm test      # dist를 빌드한 뒤 Node 샌드박스에서 회귀 테스트 실행
```

## 동작 방식 요약

- URL `https://gemini.google.com/app/<id>`에서 대화 `id`를 추출
- `infinite-scroller.chat-history`를 반복적으로 최상단(`scrollTop = 0`)으로 스크롤해, 렌더된 턴 개수가 안정될 때까지 지연 로딩된 과거 턴을 모두 불러옴
- `.conversation-container`마다 사용자 질문(`user-query .query-text`)과 Gemini 응답(`model-response .markdown`)을 읽고, 접힌 `thinking-overlay`는 필요 시 토글 버튼을 클릭해 펼친 뒤 텍스트를 읽음
- 응답의 HTML을 의존성 없는 자체 변환기로 Markdown으로 변환(제목, 목록, 표, 코드블록, 링크, 굵게/기울임, 인용문 지원)
- `Blob` + 임시 앵커 클릭으로 `<제목>.md`(또는 `.json`) 다운로드

## 제한 사항

- **전체 내보내기(Export All)는 v1에 없습니다.** Gemini는 대화 목록을 여는 안정적인 API가 없어(내부 `batchexecute`는 취약함) v1.1로 계획을 미뤘습니다. 설계 초안은 [`docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md`](../docs/plans/2026-07-12-gemini-export-all-batchexecute-blueprint.md) 참고.
- **Deep Research의 몰입형(immersive) 리포트**는 대상 외입니다. 일반 대화 DOM 구조와 달라 별도 지원이 필요합니다.
- **이미지 바이트**는 내보내지 않습니다. 첨부파일은 파일명만 캡처합니다.
- Gemini의 렌더링 DOM을 직접 스크레이핑하므로, Google이 마크업/클래스명을 바꾸면 셀렉터(`SEL`, `src/main.ts`)를 갱신해야 동작합니다 — API가 아니므로 이런 변경에 상대적으로 취약합니다.
- 본인 계정 대화 내보내기 용도이며, 탐지 우회/대량 수집 목적이 아닙니다.
