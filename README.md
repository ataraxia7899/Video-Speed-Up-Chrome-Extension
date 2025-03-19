# Video Speed Controller 🎥

브라우저에서 비디오 재생 속도를 쉽게 제어할 수 있는 Chrome/Edge 확장 프로그램입니다.
[크롬 웹스토어](https://chromewebstore.google.com/detail/%EB%B9%84%EB%94%94%EC%98%A4-%EC%86%8D%EB%8F%84-%EC%BB%A8%ED%8A%B8%EB%A1%A4%EB%9F%AC/begolcfbgiopgodhfijbppokmnddchei?authuser=6&hl=ko '배속 확장프로그램')

## 개발 진행상황 📝

### 완료된 기능 ✅

1. 기본 확장 프로그램 구조 설정

   - manifest.json 설정 완료
   - 주요 파일 구조 구성
   - 권한 설정 완료

2. 비디오 속도 제어 기능

   - 기본 속도 조절 (0.1x ~ 16x)
   - 커스텀 속도 입력 지원
   - 프리셋 버튼 구현 (1.0x, 1.5x, 2.0x)
   - 상대적 속도 조절 (+/-0.1, +/-1)

3. 단축키 시스템

   - 기본 단축키 설정
   - 커스텀 단축키 지원
   - Chrome Commands API 연동

4. UI/UX

   - 팝업 인터페이스 구현
   - 속도 표시 UI 개선
   - 실시간 속도 업데이트

5. 상태 관리

   - ExtensionController 통합
   - 전역 상태 관리 개선
   - 에러 처리 강화

6. 사이트별 자동 설정
   - URL 패턴 기반 자동 속도 설정
   - 토글 기능으로 설정 활성화/비활성화
   - 애니메이션 효과 적용
   - 설정 저장 및 동기화

### 진행 중인 작업 🔄

1. 성능 최적화
   - 컨텍스트 초기화 로직 개선
   - 메모리 사용량 최적화
   - 이벤트 리스너 관리 강화

### 해결된 주요 이슈 🔧

1. Extension Context Invalidated 오류

   - 원인: 확장 프로그램 컨텍스트 유효성 검사 실패
   - 해결: 재시도 메커니즘 및 상태 복구 로직 구현

2. 중복 초기화 문제

   - 원인: 다중 상태 관리 객체 충돌
   - 해결: ExtensionController로 상태 관리 통합

3. 이벤트 리스너 중복 등록

   - 원인: 여러 초기화 함수에서 리스너 중복 등록
   - 해결: cleanup 시스템 구현 및 리스너 관리 개선

4. URL 변경 시 속도 설정 초기화 문제

   - 원인: 컨텍스트 무효화 및 비동기 처리 타이밍
   - 해결: 재시도 메커니즘 및 상태 복구 로직 강화

5. 사이트별 설정 동기화 문제
   - 원인: 토글 상태 업데이트 불일치
   - 해결: 스토리지 이벤트 핸들링 개선

### 다음 작업 예정 📋

1. 성능 최적화
   - 코드 분할 및 모듈화
   - 캐시 시스템 구현
   - 로딩 성능 개선

## 주요 기능 ✨

- 사전 설정된 재생 속도 버튼 (1.0x, 1.5x, 2.0x)
- 커스텀 재생 속도 설정 (0.1x ~ 16x)
- 키보드 단축키 지원 ( 배속 설정창 생성 )
- YouTube 및 대부분의 웹사이트 비디오 지원
- 사이트별 자동 재생 속도 설정

## 단축키 ⌨️

- `Ctrl + .`: 배속 지정할 수 있는 팝업창 생성

## 설치 방법 🚀

~~

1. 이 저장소를 클론하거나 다운로드합니다.
2. Chrome/Edge 브라우저에서 `chrome://extensions` 또는 `edge://extensions`로 이동합니다.
3. 우측 상단의 "개발자 모드"를 활성화합니다.
4. "압축해제된 확장 프로그램을 로드합니다" 버튼을 클릭합니다.
5. 다운로드한 폴더를 선택합니다.
   ~~

[크롬 웹스토어](https://chromewebstore.google.com/detail/%EB%B9%84%EB%94%94%EC%98%A4-%EC%86%8D%EB%8F%84-%EC%BB%A8%ED%8A%B8%EB%A1%A4%EB%9F%AC/begolcfbgiopgodhfijbppokmnddchei?authuser=6&hl=ko '배속 확장프로그램')

## 사용 방법 📝

1. 확장 프로그램 설치 후 브라우저 상단의 아이콘을 클릭합니다.
2. 팝업창에서 원하는 재생 속도 버튼을 클릭하거나 커스텀 속도를 입력합니다.
3. 단축키를 사용하여 빠르게 속도를 조절할 수 있습니다.
4. 사이트별 자동 설정에서 URL 패턴과 원하는 재생 속도를 등록하면 해당 사이트 방문 시 자동으로 속도가 적용됩니다.
   - URL 패턴 예시: _.youtube.com, lecture.site.com/_
   - 각 설정의 토글 스위치로 활성화/비활성화 가능
   - 삭제 버튼으로 설정 제거 가능

## 기술 스택 🛠️

- Chrome Extensions Manifest V3
- JavaScript (ES6+)
- Chrome Storage API
- Chrome Commands API
- MutationObserver API

## 파일 구조 📂

```
chrome_1/
├── manifest.json        # 확장 프로그램 설정 파일
├── popup.html          # 팝업 UI
├── popup.js           # 팝업 동작 제어
├── content.js        # 웹 페이지 내 비디오 제어
└── background.js    # 백그라운드 작업 처리
```

## 기여 방법 💡

1. 이 저장소를 포크합니다.
2. 새로운 브랜치를 생성합니다.
3. 변경사항을 커밋합니다.
4. 브랜치에 푸시합니다.
5. Pull Request를 생성합니다.

## 라이선스 📄

MIT License

## 문제 해결 🔧

문제가 발생하면 Issues 탭에서 새로운 이슈를 생성해 주세요.
