# AI Prompt Interviewer Desktop

AI 앱에서 작성한 초안을 가로채 짧은 인터뷰를 진행하고, 답변을 반영한 구체적인 최종 프롬프트를 원래 입력창으로 돌려보내는 Windows 데스크톱 앱입니다.

이 저장소는 데스크톱 앱 전용입니다. Chrome 확장 프로그램은 [AI-prompt-interviewer](https://github.com/Seongppak/AI-prompt-interviewer) 저장소에서 관리합니다.

## 주요 기능

- ChatGPT, Claude, Codex 및 IDE AI 채팅 입력창의 Enter·전송 버튼 가로채기
- 한글을 포함한 UTF-8 프롬프트 캡처 및 원래 채팅창 자동 입력
- 인터뷰 답변을 반영한 역할·목표·제약·절차·출력 형식·품질 기준 생성
- Gemini를 이용한 추가 품질 보정
- Gemini API 키 암호화 저장
- 프로젝트와 인터뷰 기록 영구 저장
- 전역 클립보드 캡처 단축키

## 설치

[Releases](https://github.com/Seongppak/AI-prompt-interviewer-desktop/releases)에서 최신 Windows x64 설치 파일을 내려받아 실행합니다.

현재 실행 파일은 코드 서명 인증서로 서명되지 않아 Windows SmartScreen 경고가 표시될 수 있습니다. 저장소와 릴리스 출처를 확인한 뒤 실행하세요.

## 소스에서 실행

필요 환경: Windows 10/11 64비트, Node.js, .NET SDK

```bash
npm install
npm run dev
```

## 빌드 및 패키징

```bash
npm test
npm run build
npm run package:desktop:win
```

Windows 설치 파일은 `release-desktop/AI Prompt Interviewer-Setup-<version>-x64.exe`에 생성됩니다.

## 구조

| 경로 | 역할 |
|---|---|
| `apps/desktop/` | Electron 데스크톱 앱과 Windows 네이티브 인터셉터 |
| `packages/core/` | 플랫폼 독립 인터뷰·질문 생성·프롬프트 최적화 로직 |
| `packages/protocol/` | 공용 메시지·이벤트·Target Adapter 경계 |
| `adapters/desktop/` | 데스크톱 AI 채팅 대상 어댑터 |
| `adapters/clipboard/` | 클립보드 대상 어댑터 |
| `adapters/gemini/` | Gemini API 어댑터 |
| `prompts/targets.md` | 대상 AI별 최적화 지침 |

## 버전

현재 버전: `4.0.0`
