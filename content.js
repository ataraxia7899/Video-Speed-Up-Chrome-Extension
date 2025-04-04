// Content Script Controller
(() => {
  const state = {
    contextValid: false,
    currentSpeed: 1.0,
    initialized: false,
    cleanup: new Set(),
    initializedVideos: new Set()
  };

  // 컨텍스트 유효성 검사 함수
  function isContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  // 복구 시도 함수
  async function attemptRecovery(maxAttempts = 3) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (!state.contextValid) {
          const success = await validateContext();
          if (success) {
            state.contextValid = true;
            return true;
          }
        }
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      } catch (error) {
        console.error('Recovery attempt failed:', error);
      }
    }
    return false;
  }

  // 컨텍스트 검증
  async function validateContext() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'ping' });
      return response?.success === true;
    } catch {
      return false;
    }
  }

  // 비디오 요소 초기화
  async function initializeVideo(video) {
    if (!video || state.initializedVideos.has(video)) return;

    try {
      if (!state.contextValid) {
        state.contextValid = await attemptRecovery();
        if (!state.contextValid) return;
      }

      // 속도 변경 이벤트 리스너
      const handleSpeedChange = () => {
        if (video.playbackRate !== state.currentSpeed) {
          state.currentSpeed = video.playbackRate;
        }
      };

      video.addEventListener('ratechange', handleSpeedChange);
      state.cleanup.add(() => video.removeEventListener('ratechange', handleSpeedChange));

      // 현재 속도 적용
      if (state.currentSpeed !== 1.0) {
        video.playbackRate = state.currentSpeed;
      }

      state.initializedVideos.add(video);
    } catch (error) {
      console.error('Video initialization failed:', error);
    }
  }

  // 비디오 요소 감시
  function observeVideoElements() {
    const observer = new MutationObserver((mutations) => {
      const shouldCheck = mutations.some(mutation => 
        Array.from(mutation.addedNodes).some(node => 
          node.nodeName === 'VIDEO' || node.getElementsByTagName?.('video').length > 0
        )
      );

      if (shouldCheck) {
        initializeAllVideos();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    state.cleanup.add(() => observer.disconnect());
  }

  // 모든 비디오 요소 초기화
  async function initializeAllVideos() {
    const videos = document.getElementsByTagName('video');
    for (const video of videos) {
      await initializeVideo(video);
    }
  }

  // 메시지 핸들러
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handleMessage = async () => {
      try {
        if (!state.contextValid) {
          state.contextValid = await attemptRecovery();
          if (!state.contextValid) {
            return { error: 'Invalid context' };
          }
        }

        switch (request.action) {
          case 'ping':
            return { success: true };

          case 'setSpeed':
            if (typeof request.speed !== 'number' || request.speed < 0.1 || request.speed > 16) {
              return { error: 'Invalid speed value' };
            }

            const videos = document.getElementsByTagName('video');
            if (videos.length === 0) {
              return { error: 'No video elements found' };
            }

            state.currentSpeed = request.speed;
            for (const video of videos) {
              video.playbackRate = request.speed;
            }
            return { success: true, speed: request.speed };

          case 'getSpeed':
            const firstVideo = document.querySelector('video');
            return { 
              success: true, 
              speed: firstVideo ? firstVideo.playbackRate : state.currentSpeed 
            };

          case 'toggleSpeedControl':
            // 팝업을 열 수 없을 때의 대체 동작
            const currentSpeed = document.querySelector('video')?.playbackRate || 1.0;
            const newSpeed = currentSpeed === 1.0 ? 2.0 : 1.0; // 1.0과 2.0 사이를 토글
            
            const videoElements = document.getElementsByTagName('video');
            for (const video of videoElements) {
              video.playbackRate = newSpeed;
            }
            
            return { success: true, speed: newSpeed };

          case 'toggleSpeedInput':
            showSpeedInputPopup();
            return { success: true };

          default:
            return { error: 'Unknown action' };
        }
      } catch (error) {
        console.error('Message handler error:', error);
        return { error: error.message };
      }
    };

    handleMessage().then(sendResponse);
    return true;
  });

  // 속도 입력 팝업 UI 생성 함수
  function createSpeedInputPopup() {
    const popup = document.createElement('div');
    popup.id = 'speed-input-popup';
    popup.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: #ffffff;
        padding: 24px;
        width: 200px;
        border-radius: 16px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 20px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        animation: fadeInScale 0.2s ease-out;
        border: 1px solid rgba(226, 232, 240, 0.8);
    `;

    const style = document.createElement('style');
    style.textContent = `
        @keyframes fadeInScale {
            from {
                opacity: 0;
                transform: translate(-50%, -50%) scale(0.95);
            }
            to {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
        }
        #speed-input-popup input::-webkit-outer-spin-button,
        #speed-input-popup input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        #speed-input-popup input[type=number] {
            -moz-appearance: textfield;
        }
        .popup-title {
            text-align: center;
            font-size: 18px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: -8px;
        }
        .input-container {
            display: flex;
            flex-direction: column;
            gap: 8px;
            position: relative;
            margin-bottom: -8px;
        }
        .speed-input {
            width: 100%;
            padding: 12px;
            font-size: 20px;
            text-align: center;
            border: 2px solid #e2e8f0;
            border-radius: 12px;
            outline: none;
            transition: all 0.2s ease;
            color: #1a1a1a;
            background: #ffffff;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        }
        .speed-input:focus {
            border-color: #6366f1;
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
        }
        .shortcut-info {
            text-align: center;
            padding: 8px 12px;
            background: #f8fafc;
            border-radius: 8px;
            font-size: 14px;
            color: #64748b;
            border: 1px solid #e2e8f0;
        }
        .shortcut-key {
            font-weight: 600;
            color: #4b5563;
            margin: 0 2px;
        }
    `;
    document.head.appendChild(style);

    const title = document.createElement('div');
    title.className = 'popup-title';
    title.textContent = '재생 속도 설정';

    const inputContainer = document.createElement('div');
    inputContainer.className = 'input-container';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'speed-input';
    input.style.cssText = `
        width: 100px;
        margin: 0 auto;
        display: block;
        padding: 12px;
        font-size: 20px;
        text-align: center;
        border: 2px solid #e2e8f0;
        border-radius: 12px;
        outline: none;
        transition: all 0.2s ease;
        color: #1a1a1a;
        background: white;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    `;
    input.min = '0.1';
    input.max = '16';
    input.step = '0.1';
    input.value = document.querySelector('video')?.playbackRate || '1.0';

    const shortcutInfo = document.createElement('div');
    shortcutInfo.className = 'shortcut-info';
    shortcutInfo.innerHTML = '<span class="shortcut-key">Enter</span>: 적용 | <span class="shortcut-key">ESC</span>: 취소';

    inputContainer.appendChild(input);
    popup.appendChild(title);
    popup.appendChild(inputContainer);
    popup.appendChild(shortcutInfo);

    return { popup, input };
  }

  // 속도 입력 팝업 표시 함수
  function showSpeedInputPopup() {
    // 이미 존재하는 팝업 제거
    const existingPopup = document.getElementById('speed-input-popup');
    if (existingPopup) {
      existingPopup.remove();
      return;
    }

    const { popup, input } = createSpeedInputPopup();
    document.body.appendChild(popup);
    
    // 입력 필드 포커스
    input.focus();
    input.select();

    // Enter 키 처리
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const speed = parseFloat(input.value);
        if (!isNaN(speed) && speed >= 0.1 && speed <= 16) {
          document.querySelectorAll('video').forEach(video => {
            video.playbackRate = speed;
          });
          popup.remove();
        }
      } else if (e.key === 'Escape') {
        popup.remove();
      }
    });

    // 팝업 외부 클릭 시 닫기
    document.addEventListener('click', function closePopup(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', closePopup);
      }
    });
  }

  // 단축키 이벤트 처리
  document.addEventListener('keydown', (e) => {
    // Ctrl + . 입력 감지
    if (e.ctrlKey && e.key === '.') {
      e.preventDefault();
      e.stopPropagation();
      showSpeedInputPopup();
    }
  }, true);  // 이벤트 캡처링 단계에서 처리

  // 초기화 함수
  async function initialize() {
    try {
      if (!state.contextValid) {
        state.contextValid = await attemptRecovery();
        if (!state.contextValid) {
          throw new Error('Failed to establish valid context');
        }
      }

      await initializeAllVideos();
      observeVideoElements();
      
      // 포트 연결 설정
      const port = chrome.runtime.connect({ name: "videoSpeedController" });
      port.onDisconnect.addListener(async () => {
        state.contextValid = false;
        await attemptRecovery();
      });

      state.initialized = true;
    } catch (error) {
      console.error('Initialization failed:', error);
      throw error;
    }
  }

  // 정리 함수
  function cleanup() {
    state.cleanup.forEach(cleanup => cleanup());
    state.cleanup.clear();
    state.initializedVideos.clear();
    state.initialized = false;
    state.contextValid = false;
  }

  // 이벤트 리스너 설정
  window.addEventListener('content-script-cleanup', cleanup);

  // 초기화 실행
  initialize().catch(console.error);
})();
