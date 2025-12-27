# Video Speed Controller 🎥

브라우저에서 비디오 재생 속도를 쉽게 제어할 수 있는 Chrome/Edge 확장 프로그램입니다.

**크롬 웹스토어**: [다운로드](https://chromewebstore.google.com/detail/%EB%B9%84%EB%94%94%EC%98%A4-%EC%86%8D%EB%8F%84-%EC%BB%A8%ED%8A%B8%EB%A1%A4%EB%9F%AC/begolcfbgiopgodhfijbppokmnddchei?authuser=6&hl=ko)

## 주요 기능 ✨

- 🎚️ **속도 조절**: 0.1x ~ 16x 범위의 재생 속도 지원
- ⚡ **프리셋 버튼**: 0.5x, 1.0x, 1.5x, 2.0x 빠른 선택
- ➕➖ **상대 속도 조절**: +/- 0.25, +/- 1 버튼
- ⌨️ **키보드 단축키**: `Ctrl + .`으로 빠른 속도 입력 팝업
- 🌙 **다크 모드**: 시스템 테마 연동 및 수동 전환
- 🌐 **사이트별 자동 설정**: URL 패턴 기반 자동 속도 적용
- 🔒 **사용자 설정 우선**: 수동 조작 시 자동 설정보다 우선 적용

## 단축키 ⌨️

| 단축키 | 기능 |
|--------|------|
| `Ctrl + .` | 속도 입력 팝업 열기/닫기 |

## 사용 방법 📝

1. 확장 프로그램 설치 후 브라우저 상단의 아이콘을 클릭합니다.
2. 팝업창에서 원하는 재생 속도 버튼을 클릭하거나 직접 입력합니다.
3. `Ctrl + .` 단축키로 빠르게 속도를 조절할 수 있습니다.
4. **사이트별 자동 설정**에서 URL 패턴을 등록하면 해당 사이트 방문 시 자동으로 속도가 적용됩니다.
   - URL 패턴 예시: `*.youtube.com`, `lecture.site.com/*`
   - 각 설정의 토글 스위치로 활성화/비활성화 가능
   - **수동으로 속도를 변경하면 자동 설정보다 우선** 적용됩니다 (새로고침 전까지 유지)

## 최근 업데이트 📋

### v1.1.0 (2024-12-27)

#### 버그 수정
- ✅ `Ctrl + .` 단축키 팝업이 두 번 뜨거나 바로 닫히는 문제 해결
- ✅ 1.0배속에서 `+1` 버튼이 잘못 하이라이트되는 버그 수정
- ✅ 라프텔 등 SPA 사이트에서 에피소드 전환 시 속도 초기화 문제 해결

#### 기능 개선
- 🔒 **사용자 설정 우선 적용**: 수동으로 속도 변경 시 사이트별 자동 설정이 덮어쓰지 않음
- 🎨 **UI 개선**: 다크모드 토글 위치 변경, 테두리 정리, 배경색 조정
- ⚡ **성능 최적화**: 정규식 캐싱, setInterval 주기 통일, 중복 실행 방지

### 해결된 주요 이슈 🔧

| 이슈 | 원인 | 해결 |
|------|------|------|
| Extension Context Invalidated | 컨텍스트 유효성 검사 실패 | 재시도 메커니즘 및 상태 복구 로직 |
| 중복 초기화 | 다중 상태 관리 객체 충돌 | ExtensionController로 통합 |
| 이벤트 리스너 중복 등록 | 다중 초기화 | cleanup 시스템 구현 |
| SPA 사이트 속도 초기화 | ratechange 이벤트 처리 오류 | 속도 복원 로직 추가 |

## 기술 스택 🛠️

- Chrome Extensions Manifest V3
- JavaScript (ES6+)
- Chrome Storage API / Commands API
- MutationObserver API

## 파일 구조 📂

```
Video-Speed-Up-Chrome-Extension/
├── manifest.json     # 확장 프로그램 설정
├── popup.html        # 팝업 UI
├── popup.css         # 팝업 스타일
├── popup.js          # 팝업 동작 제어
├── content.js        # 웹 페이지 내 비디오 제어
├── background.js     # 백그라운드 작업 처리
└── utils.js          # 공통 유틸리티
```

## 설치 방법 🚀

### 웹스토어 (권장)
[크롬 웹스토어에서 설치](https://chromewebstore.google.com/detail/%EB%B9%84%EB%94%94%EC%98%A4-%EC%86%8D%EB%8F%84-%EC%BB%A8%ED%8A%B8%EB%A1%A4%EB%9F%AC/begolcfbgiopgodhfijbppokmnddchei?authuser=6&hl=ko)

### 수동 설치 (개발용)
1. 저장소를 클론합니다.
2. `chrome://extensions`로 이동합니다.
3. "개발자 모드"를 활성화합니다.
4. "압축해제된 확장 프로그램을 로드합니다"를 클릭합니다.
5. 클론한 폴더를 선택합니다.

## 기여 방법 💡

1. 저장소를 포크합니다.
2. 새로운 브랜치를 생성합니다.
3. 변경사항을 커밋합니다.
4. Pull Request를 생성합니다.

## 라이선스 📄

MIT License

## 문제 해결 🔧

문제가 발생하면 [Issues](https://github.com/ataraxia7899/Video-Speed-Up-Chrome-Extension/issues) 탭에서 새로운 이슈를 생성해 주세요.
