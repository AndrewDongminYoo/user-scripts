# Claude Chat Exporter

Claude.ai 대화 페이지에서 현재 대화를 **Markdown 파일로 내려받는** 사용자 스크립트입니다.
(HTML/PDF 내보내기는 후순위 계획입니다.)

## 주요 기능

- 우측 하단에 두 개의 플로팅 버튼 표시
  - `⬇ Export MD` — 현재 대화를 Markdown 파일로 다운로드
  - `⬇ Export All` — 계정의 모든 대화를 대화별 `.md`로 만들어 하나의 `.zip`으로 다운로드
- Claude 웹앱이 사용하는 것과 동일한 same-origin API로 대화 내용을 읽음 (로그인 세션의 쿠키 사용, 별도 인증 없음)
- 전체 내보내기는 동시 요청 4개로 제한(예의 있는 호출)하고 진행률을 버튼에 표시
- **extended thinking**, **도구 호출/결과**(접기 가능한 요약), **첨부파일 텍스트**를 Markdown/JSON 양쪽 모두에 캡처
- ⚙️ 설정 패널: 출력 포맷(Markdown/JSON), frontmatter, 메시지별 타임스탬프, 그리고 Extended thinking / Tool calls / Attachments 세 개의 토글(기본 켜짐)을 선택 (설정은 저장됨)
  - Markdown은 각 항목을 `<details>`로 접어서 넣고 블록당 약 2000자로 잘라내며, JSON은 전체 내용을 그대로 담음
- JSON 출력은 `{ title, source, model, create_time, update_time, exported_at, messages[] }` 정규화 스키마
- 본인 계정의 대화만 대상으로 함

## 동작 환경

- 브라우저 확장: Tampermonkey(권장) 또는 호환 userscript 매니저
- 대상 페이지: `https://claude.ai/*` (대화 페이지 `https://claude.ai/chat/<id>`에서만 실제 동작)
- 로그인 상태에서 동작

## 설치 방법 (권장: 릴리즈 배포본)

이 저장소는 `main` 브랜치 릴리즈 시 userscript 파일을 자동 생성/업로드합니다.

릴리즈는 **패키지별로 태그**됩니다(`claude-chat-exporter-<날짜>`). 저장소 전역 `releases/latest`는 다른 패키지(Wanted·Gemini)의 릴리즈가 더 최신이면 이 파일을 찾지 못해 404가 나므로 사용하지 않습니다.

1. Tampermonkey를 설치합니다.
2. 아래 링크에서 가장 최근 `claude-chat-exporter-*` 릴리즈를 엽니다.

- https://github.com/AndrewDongminYoo/user-scripts/releases?q=claude-chat-exporter&expanded=true

3. 그 릴리즈의 Assets에서 `claude-chat-exporter.user.js`를 열어 Tampermonkey 설치 화면에서 설치합니다.

## 개발 모드 / 로컬 빌드 (개발자용)

```bash
cd claude-chat-exporter
pnpm install
pnpm build     # dist/claude-chat-exporter.user.js 생성
pnpm dev       # Vite 개발 서버 (터미널의 .user.js URL을 Tampermonkey에 등록)
```

## 동작 방식 요약

- URL `https://claude.ai/chat/<id>`에서 대화 `id`를 추출
- 조직 UUID를 `lastActiveOrg` 쿠키 또는 `GET /api/organizations`에서 획득
- `GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true`로 대화 JSON을 조회
- 각 메시지의 `content[].text`(없으면 `text`)를 역할(`👤 User` / `🤖 Claude`) 헤더와 함께 Markdown으로 조립
- `Blob` + 임시 앵커 클릭으로 `<제목>.md` 다운로드
- 전체 내보내기는 `GET /api/organizations/{org}/chat_conversations`로 목록을 받아 각 대화를 렌더한 뒤, 의존성 없는 store 방식 `.zip`(UTF-8 파일명)으로 묶어 다운로드

## 제한 사항

- Claude 내부 API/DOM 변경 시 동작하지 않을 수 있습니다 (요청·파싱 코드는 한곳에 격리되어 있어 수리가 국소적입니다).
- 업로드한 이미지 파일(`files[]`)과 텍스트 블록의 인용(citations)은 내보내지 않습니다. 아티팩트, 분기(branch) 대화도 후순위입니다.
- `.zip` 파일명은 UTF-8 플래그를 사용합니다. macOS Finder·Windows 탐색기·7-Zip 등은 정상 처리하나, 구형 Info-ZIP `unzip` CLI는 한글 파일명을 깨뜨릴 수 있습니다.
- 본인 계정 대화 내보내기 용도이며, 탐지 우회/대량 수집 목적이 아닙니다.
