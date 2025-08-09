# Video Speed Up Extension Architecture

이 문서는 Video Speed Up 크롬 확장 프로그램의 아키텍처, 설계 원칙, 주요 구성 요소의 역할, 그리고 데이터 흐름을 설명합니다.

## 1. 설계 원칙 (Guiding Principles)

- **견고함 (Robustness):** 예기치 않은 상황(스크립트 충돌, 연결 끊김, 동적 콘텐츠 로딩)에서도 기능이 안정적으로 동작해야 합니다.
- **성능 (Performance):** 사용자 경험에 영향을 주지 않도록 리소스 사용을 최소화하고 빠르게 반응해야 합니다.
- **유지보수성 (Maintainability):** 코드 구조가 명확하고, 각 부분이 독립적으로 이해되고 수정될 수 있어야 합니다.
- **사용자 중심 (User-Centric):** 모든 기능은 직관적이고 편리한 사용자 경험을 제공하는 것을 최우선으로 합니다.

## 2. 아키텍처 다이어그램 (Architecture Diagram)

```
+---------------------------------------------------------------------------------+
|                                  User Interaction                               |
+---------------------------------------------------------------------------------+
      |                                      |                                |
      | (Shortcut)                           | (Popup UI)                     | (Web Page)
      |                                      |                                |
+-----v-----+                            +-----v----+                       +---v---+
|  Chrome   |                            |          |                       |       |
|  Commands |<-------------------------->| popup.js |                       | video |
+-----------+                            |          |                       | element
      |                                  +----------+                       +---^---+
      |                                      |                                |
      |                                      | (Message)                      | (Control)
+-----v--------------------------------------v----------------------------------+
|                                                                               |
|                            background.js (Service Worker)                     |
|                                (Central Controller)                           |
|                                                                               |
|  +------------------+      +-----------------+      +-----------------------+ |
|  | Tab/Nav Listener |----->| Script Injector |----->| State/Storage Manager | |
|  +------------------+      +-----------------+      +-----------------------+ |
|          ^                         |                        ^                 |
|          | (Event)                 | (Inject)               | (Data)          |
|          |                         |                        |                 |
+----------|-------------------------v------------------------|-----------------+
           |                                                  |
     (Long-lived Port Connection)                             | (chrome.storage)
           |                                                  |
+----------|--------------------------------------------------v-----------------+
|          |                                                                    |
|          |                         content.js                                 |
|          |                      (In-Page Agent)                               |
|          |                                                                    |
|  +-------v--------+      +-------------------+      +-----------------------+ |
|  | Connection/Msg |----->| DOM/URL Observer  |----->| Video/UI Controller   | |
|  +----------------+      +-------------------+      +-----------------------+ |
|                                                                               |
+-------------------------------------------------------------------------------+
```

## 3. 주요 구성 요소 (Core Components)

### 1. `background.js` (중앙 관제 센터)

백그라운드 스크립트는 확장 프로그램의 두뇌 역할을 하며, **신뢰할 수 있는 단일 소스(Single Source of Truth)** 로서 모든 것을 조율합니다.

- **주요 책임:**
  - **탭 생명주기 관리:** `chrome.tabs`, `chrome.webNavigation` API를 사용하여 모든 탭의 생성, 업데이트, 소멸을 추적하고, 이에 맞춰 스크립트 주입 및 정리를 수행합니다.
  - **스크립트 주입 및 검증:** `content.js`를 대상 탭에 주입하고, 주기적인 Ping-Pong 메시지를 통해 `content.js`의 컨텍스트가 유효한지 확인하며, 무효화 시 자동으로 재주입합니다.
  - **전역 이벤트 처리:** `chrome.commands.onCommand`를 통해 단축키 입력을 감지하고, `chrome.runtime.onInstalled`로 확장 프로그램의 설치/업데이트 이벤트를 처리합니다.
  - **상태 및 데이터 관리:** 모든 탭의 상태(스크립트 주입 여부, 연결 상태, 현재 속도)를 중앙에서 관리하며, `chrome.storage`와의 통신을 총괄합니다. 인메모리 캐싱을 통해 성능을 최적화합니다.

### 2. `content.js` (현장 요원)

콘텐츠 스크립트는 실제 웹 페이지에 주입되어 비디오 제어, UI 생성 등 실질적인 작업을 수행합니다.

- **주요 책임:**
  - **DOM 제어:** 페이지 내의 모든 `<video>` 요소를 찾아 `playbackRate` 속성을 직접 조작합니다. 특히 유튜브와 같이 복잡한 구조를 가진 사이트에 대한 특화 로직을 포함합니다.
  - **동적 환경 적응:** `MutationObserver`와 `history.pushState` 후킹을 통해 SPA 환경에서 비동기적으로 추가되는 비디오나 URL 변경에 신속하게 대응합니다.
  - **페이지 내 UI 제공:** `background.js`로부터 명령을 받으면, 페이지 상에 속도 조절 입력창 UI를 직접 생성하여 사용자에게 보여줍니다.
  - **상태 보고:** `chrome.runtime.connect`를 통해 `background.js`와 장기 연결(Long-lived Port)을 수립하고, 자신의 상태를 보고하며 명령을 수신합니다. 연결 안정성을 위해 자체적인 복구 로직을 갖추고 있습니다.

### 3. `popup.js` & `popup.html` (사용자 인터페이스)

팝업은 사용자가 확장 프로그램 아이콘을 클릭했을 때 마주하는 설정 창입니다.

- **주요 책임:**
  - **단순한 뷰(View) 역할:** 팝업은 복잡한 로직을 가지지 않습니다. 오직 `background.js`에 데이터를 요청하고, 받은 데이터를 화면에 그리며, 사용자 입력을 다시 `background.js`에 전달하는 역할만 수행합니다.
  - **사용자 입력 처리:** 사용자의 버튼 클릭이나 입력 값에 따라 `background.js`에 속도 변경, 사이트별 설정 추가 등의 작업을 요청합니다.

## 4. 주요 기술 과제 및 해결 방안

이 아키텍처는 다음과 같은 크롬 확장 프로그램 개발의 주요 난제들을 해결하기 위해 설계되었습니다.

1.  **서비스 워커의 비활성화 (Service Worker Inactivity):** Manifest V3의 서비스 워커는 언제든 비활성화될 수 있습니다.
    - **해결:** `background.js`는 상태 정보를 `chrome.storage`에 저장하고, `content.js`는 연결이 끊겼을 때 지수 백오프(exponential backoff)를 사용한 재연결을 시도하여 상태의 일관성을 유지합니다.
2.  **SPA의 페이지 전환 (SPA Navigation):** `youtube.com`과 같은 SPA는 페이지 이동 없이 동적으로 콘텐츠를 변경합니다.
    - **해결:** `history.pushState` API를 후킹하고 `webNavigation` 이벤트를 감지하여, URL이 변경될 때마다 사이트별 설정을 다시 적용합니다.
3.  **동적 비디오 로딩 (Dynamic Video Loading):** 스크롤 시 새로운 비디오가 로드되는 무한 스크롤 페이지들.
    - **해결:** `MutationObserver`를 사용하여 `<body>` 전체의 DOM 변화를 감지하고, 새로운 `<video>` 요소가 추가되면 즉시 제어 목록에 포함시킵니다.
4.  **컨텍스트 무효화 (Context Invalidation):** 페이지가 새로고침되거나 스크립트 간의 연결이 끊어지는 경우.
    - **해결:** `background.js`와 `content.js`가 주기적으로 Ping-Pong 메시지를 교환하여 서로의 상태를 확인합니다. 응답이 없으면 컨텍스트가 무효화된 것으로 간주하고, `background.js`가 `content.js`를 다시 주입하여 연결을 복구합니다.

## 5. 권장 아키텍처: 모듈화 (Proposed Architecture: Modularization)

현재의 견고한 기능은 유지하면서 유지보수성과 확장성을 극대화하기 위해, 아래와 같은 모듈화 구조를 적극 권장합니다.

- **기대 효과:**
  - **관심사 분리 (Separation of Concerns):** 각 모듈이 명확한 하나의 책임만 가지므로 코드 이해가 쉬워집니다.
  - **테스트 용이성 (Testability):** 각 모듈을 독립적으로 테스트할 수 있어 코드 품질을 높일 수 있습니다.
  - **재사용성 (Reusability):** 공통 로직(e.g., `storage`, `constants`)을 여러 곳에서 재사용할 수 있습니다.
  - **협업 효율성 (Collaboration):** 여러 개발자가 충돌 없이 다른 모듈을 동시에 작업할 수 있습니다.

```
src/
├── background/
│   ├── index.js            # 모듈 초기화 및 통합
│   ├── state.js            # 전역 상태 및 설정
│   ├── tab-manager.js      # 탭 생명주기 관리
│   ├── script-injector.js  # 스크립트 주입 로직
│   ├── message-handler.js  # 메시지 라우팅
│   └── command-handler.js  # 단축키 처리
│
├── content/
│   ├── index.js            # 모듈 초기화 및 통합
│   ├── state.js            # 페이지 상태 관리
│   ├── video-controller.js # 비디오 제어
│   ├── youtube-handler.js  # 유튜브 특화 로직
│   ├── observers.js        # DOM 및 URL 변경 감지
│   ├── connection.js       # 백그라운드 연결 관리
│   └── ui.js               # 페이지 내 UI 관리
│
├── popup/
│   ├── popup.js
│   ├── popup.html
│   └── popup.css
│
└── shared/
    ├── constants.js        # 메시지 액션 등 공통 상수
    └── storage.js          # 스토리지 접근 래퍼 (백그라운드 전용)
```
