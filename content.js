// Content Script Controller
(() => {
  const state = {
    contextValid: false,
    currentSpeed: 1.0,
    initialized: false,
    cleanup: new Set(),
    initializedVideos: new Set(),
    lastUrl: window.location.href,
    pendingSpeedUpdate: null,
    videoObserver: null,
    documentObserver: null,
    autoSpeedApplied: false,
    retryAttempts: 0,
    maxRetries: 5,
    retryDelay: 1000,
    initializationQueue: Promise.resolve(),
    youtubeConfig: {
      RETRY_INTERVAL: 50,  // 100ms에서 50ms로 감소
      MAX_RETRIES: 20,     // 재시도 횟수 감소
      MUTATION_DEBOUNCE: 50, // 100ms에서 50ms로 감소
      isYouTube: window.location.hostname.includes('youtube.com'),
      lastSpeedUpdate: 0,
      updateDelay: 100,    // 250ms에서 100ms로 감소
      retryCount: 0,
      isShortsPage: false,
      shortsObserver: null,
      lastShortsVideoId: null
    },
    connectionConfig: {
      reconnectAttempts: 0,
      maxReconnectAttempts: 10,
      reconnectDelay: 1000,
      maxReconnectDelay: 10000,
      connectionTimeout: 5000,
      lastReconnectTime: 0,
      minReconnectInterval: 500,
    },
    portConnection: null
  };

  // 재연결 상태 추가
  const reconnectionState = {
    isReconnecting: false,
    lastErrorTime: 0,
    errorCount: 0,
    errorThreshold: 5000, // 5초 동안의 에러 횟수를 추적
    maxErrorsInThreshold: 3, // 5초 동안 최대 3번까지만 에러 로깅
    recoveryMode: false
  };

  // 오류 로깅 최적화 함수
  function throttledError(message, error = null) {
    const now = Date.now();
    
    // 재연결 시도 중이면 로그 출력 안함
    if (reconnectionState.isReconnecting) {
      return;
    }

    // 에러 임계값 시간이 지났으면 카운터 초기화
    if (now - reconnectionState.lastErrorTime > reconnectionState.errorThreshold) {
      reconnectionState.errorCount = 0;
    }

    // 최대 에러 출력 횟수를 초과하지 않았을 때만 로그 출력
    if (reconnectionState.errorCount < reconnectionState.maxErrorsInThreshold) {
      if (error) {
        console.error(message, error);
      } else {
        console.error(message);
      }
      reconnectionState.errorCount++;
    }

    reconnectionState.lastErrorTime = now;
  }

  // 빠른 초기화를 위한 즉시 실행 함수
  const quickInit = () => {
    const videos = document.getElementsByTagName('video');
    if (videos.length > 0) {
      chrome.storage.sync.get(['siteSettings'], (result) => {
        if (chrome.runtime.lastError) return;
        
        const siteSettings = result.siteSettings || {};
        const currentUrl = window.location.href;
        
        for (const [pattern, setting] of Object.entries(siteSettings)) {
          const speed = typeof setting === 'object' ? setting.speed : setting;
          const enabled = typeof setting === 'object' ? setting.enabled : true;
          
          if (enabled && matchUrlPattern(pattern, currentUrl)) {
            for (const video of videos) {
              video.playbackRate = speed;
            }
            state.currentSpeed = speed;
            state.autoSpeedApplied = true;
            break;
          }
        }
      });
    }
  };

  // URL 패턴 매칭 최적화
  function matchUrlPattern(pattern, url) {
    try {
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\//g, '\\/');
      return new RegExp(regexPattern).test(url);
    } catch {
      return false;
    }
  }

  // 비디오 요소 초기화 큐 관리
  function queueInitialization(fn) {
    state.initializationQueue = state.initializationQueue.then(fn).catch(error => {
      console.error('Initialization error:', error);
    });
    return state.initializationQueue;
  }

  // 연결 관리 함수 개선
  async function establishConnection() {
    if (reconnectionState.isReconnecting) {
      return false;
    }

    try {
      if (state.portConnection) {
        try {
          state.portConnection.disconnect();
        } catch {}
      }

      state.portConnection = chrome.runtime.connect({ name: "videoSpeedController" });
      
      state.portConnection.onDisconnect.addListener(async () => {
        state.contextValid = false;
        state.portConnection = null;
        
        // 재연결 모드가 아닐 때만 handleDisconnect 호출
        if (!reconnectionState.recoveryMode) {
          await handleDisconnect();
        }
      });

      state.portConnection.postMessage({ action: 'ping' });
      state.contextValid = true;
      state.connectionConfig.reconnectAttempts = 0;
      
      // 연결 성공 시 재연결 상태 초기화
      reconnectionState.isReconnecting = false;
      reconnectionState.recoveryMode = false;
      return true;
    } catch (error) {
      throttledError('Connection establishment failed:', error);
      return false;
    }
  }

  // 연결 해제 처리 함수 개선
  async function handleDisconnect() {
    if (reconnectionState.isReconnecting) {
      return;
    }

    const config = state.connectionConfig;
    const now = Date.now();

    if (now - config.lastReconnectTime < config.minReconnectInterval || 
        config.reconnectAttempts >= config.maxReconnectAttempts) {
      return;
    }

    reconnectionState.isReconnecting = true;
    config.reconnectAttempts++;
    config.lastReconnectTime = now;

    try {
      const delay = Math.min(
        config.reconnectDelay * Math.pow(1.5, config.reconnectAttempts - 1),
        config.maxReconnectDelay
      );

      await new Promise(resolve => setTimeout(resolve, delay));
      
      const success = await establishConnection();
      if (success) {
        await applySiteSettings(true);
      }
    } catch (error) {
      throttledError('Reconnection attempt failed:', error);
    } finally {
      reconnectionState.isReconnecting = false;
    }
  }

  // 컨텍스트 복구 함수 개선
  async function attemptRecovery(force = false) {
    if (reconnectionState.isReconnecting && !force) {
      return false;
    }

    const config = state.connectionConfig;
    if (!force && config.reconnectAttempts >= config.maxReconnectAttempts) {
      return false;
    }

    reconnectionState.recoveryMode = true;
    
    try {
      const connected = await establishConnection();
      if (!connected) {
        return false;
      }

      const valid = await validateContext();
      if (valid) {
        state.contextValid = true;
        config.reconnectAttempts = 0;
        reconnectionState.recoveryMode = false;
        return true;
      }

      return false;
    } catch (error) {
      throttledError('Recovery attempt failed:', error);
      reconnectionState.recoveryMode = false;
      return false;
    }
  }

  // 컨텍스트 검증 함수 개선
  async function validateContext() {
    try {
      // 포트 연결 확인
      if (!state.portConnection) {
        await establishConnection();
      }

      // Ping 메시지로 컨텍스트 유효성 확인
      const response = await sendMessageWithTimeout(
        { action: 'ping' },
        state.connectionConfig.connectionTimeout
      );

      return response?.success === true;
    } catch (error) {
      console.error('Context validation failed:', error);
      return false;
    }
  }

  // 메시지 전송 타임아웃 래퍼
  async function sendMessageWithTimeout(message, timeout) {
    return Promise.race([
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Message timeout')), timeout)
      ),
    ]);
  }

  // 사이트별 설정 적용 함수 개선
  async function applySiteSettings(force = false) {
    if (!state.contextValid && !force) {
      state.contextValid = await attemptRecovery();
      if (!state.contextValid) return false;
    }

    try {
      const result = await chrome.storage.sync.get(['siteSettings']);
      const siteSettings = result.siteSettings || {};
      const currentUrl = window.location.href;
      
      // URL이 변경되지 않았고 이미 적용되었다면 스킵
      if (!force && currentUrl === state.lastUrl && state.autoSpeedApplied) {
        return true;
      }

      state.lastUrl = currentUrl;
      let settingApplied = false;

      for (const [pattern, setting] of Object.entries(siteSettings)) {
        const speed = typeof setting === 'object' ? setting.speed : setting;
        const enabled = typeof setting === 'object' ? setting.enabled : true;
        
        if (enabled && matchUrlPattern(pattern, currentUrl)) {
          state.currentSpeed = speed;
          state.pendingSpeedUpdate = speed;

          // YouTube Shorts인 경우 특별 처리
          if (pattern.includes('youtube.com/shorts')) {
            return await handleYouTubeShortsVideo(speed);
          }

          // 일반 비디오 처리
          const videos = document.getElementsByTagName('video');
          const applications = await Promise.all(
            Array.from(videos).map(video => applySpeedToVideo(video, speed))
          );

          settingApplied = applications.some(success => success);
          
          if (!settingApplied) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const retryApplications = await Promise.all(
              Array.from(videos).map(video => applySpeedToVideo(video, speed))
            );
            settingApplied = retryApplications.some(success => success);
          }

          break;
        }
      }

      state.autoSpeedApplied = settingApplied;
      return settingApplied;
    } catch (error) {
      console.error('Error applying site settings:', error);
      return false;
    }
  }

  // 재연결 시도 함수 추가
  async function tryReconnect() {
    if (reconnectionState.isReconnecting) {
      return;
    }

    reconnectionState.isReconnecting = true;
    try {
      await chrome.runtime.sendMessage({ action: 'reloadContentScript' });
      await new Promise(resolve => setTimeout(resolve, 500));
      await attemptRecovery(true);
    } catch (error) {
      throttledError('Reconnection failed:', error);
    } finally {
      reconnectionState.isReconnecting = false;
    }
  }

  // 메시지 핸들러 개선
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const handleMessage = async () => {
      try {
        switch (request.action) {
          case 'ping':
            return { success: true };

          case 'cleanup':
            state.cleanup.forEach(cleanup => cleanup());
            return { success: true };

          case 'toggleSpeedInput':
          case 'showSpeedInput':
            if (!state.contextValid) {
              const recovered = await attemptRecovery(true);
              if (!recovered) {
                throw new Error('Failed to recover context');
              }
            }
            showSpeedInputPopup();
            return { success: true };

          case 'setSpeed':
            if (!state.contextValid) {
              const recovered = await attemptRecovery(true);
              if (!recovered) {
                throw new Error('Failed to recover context');
              }
            }
            if (typeof request.speed === 'number' && request.speed >= 0.1 && request.speed <= 16) {
              await applySpeedToAllVideos(request.speed);
              return { success: true, speed: request.speed };
            }
            return { error: 'Invalid speed value' };

          case 'initializeCheck':
            return { success: state.initialized };

          default:
            return { error: 'Unknown action' };
        }
      } catch (error) {
        return { error: error.message };
      }
    };

    // 비동기 응답 처리
    handleMessage().then(sendResponse);
    return true;
  });

  // 초기화 함수 개선
  async function initialize() {
    try {
      await establishConnection();
      
      // 상태 초기화
      state.lastUrl = window.location.href;
      state.autoSpeedApplied = false;
      state.currentSpeed = 1.0;
      
      // 관찰자 설정
      observeVideoElements();
      observeUrlChanges();

      if (state.youtubeConfig.isYouTube) {
        observeYouTubeShortsNavigation();
      }

      // 사이트별 설정 적용
      await applySiteSettings(true);

      state.initialized = true;
      return true;
    } catch (error) {
      console.error('Initialization failed:', error);
      state.initialized = false;
      return false;
    }
  }

  // 속도 적용 함수 개선
  async function applySpeedToAllVideos(speed) {
    if (!speed || typeof speed !== 'number' || speed < 0.1 || speed > 16) {
      return false;
    }

    const videos = document.getElementsByTagName('video');
    if (videos.length === 0) {
      return false;
    }

    try {
      const applications = await Promise.all(
        Array.from(videos).map(video => applySpeedToVideo(video, speed))
      );

      const success = applications.some(result => result);
      if (success) {
        state.currentSpeed = speed;
      }

      return success;
    } catch (error) {
      console.error('Error applying speed to videos:', error);
      return false;
    }
  }

  // 비디오 속도 적용 함수 개선
  async function applySpeedToVideo(video, speed) {
    if (!video || !speed || typeof speed !== 'number') return false;

    try {
      // YouTube Shorts 처리
      if (state.youtubeConfig.isYouTube && detectYouTubeShortsPage()) {
        return await handleYouTubeShortsVideo(speed);
      }

      // 일반 YouTube 비디오 처리
      if (state.youtubeConfig.isYouTube) {
        return await handleYouTubeVideo(speed);
      }

      // 일반 비디오 처리
      const applySpeed = () => {
        video.playbackRate = speed;
        return video.playbackRate === speed;
      };

      // 첫 시도
      if (applySpeed()) {
        return true;
      }

      // 비디오가 준비될 때까지 대기
      if (video.readyState < 3) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Video load timeout')), 5000);
          
          const onReady = () => {
            clearTimeout(timeout);
            resolve();
          };

          video.addEventListener('canplay', onReady, { once: true });
          video.addEventListener('loadeddata', onReady, { once: true });
        });
      }

      // 재시도
      return applySpeed();
    } catch (error) {
      throttledError('Error applying speed to video:', error);
      return false;
    }
  }

  // YouTube 기능 관련 유틸리티 함수들
  function detectYouTubeShortsPage() {
    return window.location.pathname.includes('/shorts/');
  }

  async function handleYouTubeShortsVideo(speed) {
    if (!state.youtubeConfig.isYouTube || !detectYouTubeShortsPage()) {
      return false;
    }

    const findActiveVideo = () => {
      const containers = document.querySelectorAll([
        'ytd-reel-video-renderer[is-active]',
        '#shorts-container ytd-shorts-player-renderer',
        '[page-type="SHORTS"] ytd-shorts[is-active]'
      ].join(','));

      for (const container of containers) {
        const video = container.querySelector('video');
        if (video && isElementInViewport(container)) {
          return video;
        }
      }
      return null;
    };

    let retryCount = 0;
    const maxRetries = state.youtubeConfig.MAX_RETRIES;

    while (retryCount < maxRetries) {
      try {
        const video = findActiveVideo();
        if (!video) {
          await new Promise(resolve => setTimeout(resolve, state.youtubeConfig.RETRY_INTERVAL));
          retryCount++;
          continue;
        }

        if (video.readyState < 3) {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Video load timeout')), 5000);
            video.addEventListener('canplay', () => {
              clearTimeout(timeout);
              resolve();
            }, { once: true });
          });
        }

        video.playbackRate = speed;
        await new Promise(resolve => setTimeout(resolve, 50));

        return video.playbackRate === speed;
      } catch (error) {
        retryCount++;
        await new Promise(resolve => 
          setTimeout(resolve, state.youtubeConfig.RETRY_INTERVAL * Math.pow(1.5, retryCount))
        );
      }
    }

    return false;
  }

  async function handleYouTubeVideo(speed) {
    if (!state.youtubeConfig.isYouTube) return false;

    try {
      const video = document.querySelector('video');
      if (!video) return false;

      // 비디오가 준비될 때까지 대기
      if (video.readyState < 3) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Video load timeout')), 5000);
          const onReady = () => {
            clearTimeout(timeout);
            resolve();
          };
          video.addEventListener('canplay', onReady, { once: true });
          video.addEventListener('loadeddata', onReady, { once: true });
        });
      }

      // YouTube 플레이어 API를 통한 속도 설정 시도
      try {
        if (window.yt?.player?.getPlayerByElement) {
          const player = window.yt.player.getPlayerByElement(video);
          if (player?.setPlaybackRate) {
            player.setPlaybackRate(speed);
          }
        }
      } catch {}

      video.playbackRate = speed;
      await new Promise(resolve => setTimeout(resolve, 50));

      return video.playbackRate === speed;
    } catch (error) {
      throttledError('YouTube video speed setting error:', error);
      return false;
    }
  }

  // 비디오 초기화 함수 추가
  async function initializeVideo(video) {
    if (!video || state.initializedVideos.has(video)) return;

    try {
      // 초기 속도 설정
      if (state.pendingSpeedUpdate !== null) {
        await applySpeedToVideo(video, state.pendingSpeedUpdate);
      } else if (state.currentSpeed !== 1.0) {
        await applySpeedToVideo(video, state.currentSpeed);
      }

      // 속도 변경 이벤트 리스너
      const handleSpeedChange = () => {
        if (video.playbackRate !== state.currentSpeed) {
          state.currentSpeed = video.playbackRate;
        }
      };

      video.addEventListener('ratechange', handleSpeedChange);
      
      // 정리 함수 등록
      state.cleanup.add(() => {
        video.removeEventListener('ratechange', handleSpeedChange);
        state.initializedVideos.delete(video);
      });

      state.initializedVideos.add(video);
    } catch (error) {
      console.error('Video initialization error:', error);
    }
  }

  // 뷰포트 내 요소 확인 함수
  function isElementInViewport(element) {
    const rect = element.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }

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
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-width: 200px;  /* 240px에서 200px로 변경 */
      max-width: 200px;  /* 최대 너비 추가 */
    `;

    // 스타일 추가
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
      #speed-input-popup {
        animation: fadeInScale 0.2s ease-out;
        border: 1px solid rgba(0, 0, 0, 0.1);
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
        color: #1a1a1a;
        font-size: 18px;
        font-weight: 600;
        text-align: center;
        margin: 0;
        padding: 0;
      }
      .input-container {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .speed-input {
        width: 120px;  /* input 박스 너비 조정 */
        padding: 12px;
        font-size: 20px;
        text-align: center;
        border: 2px solid #e2e8f0;
        border-radius: 8px;
        outline: none;
        transition: all 0.2s ease;
        margin: 0 auto;  /* 중앙 정렬을 위해 추가 */
        display: block;  /* 블록 레벨 요소로 변경 */
      }
      .speed-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
      }
      .shortcut-info {
        color: #64748b;
        font-size: 13px;
        text-align: center;
        padding: 8px;
        background: #f8fafc;
        border-radius: 6px;
        margin-top: -4px;
      }
      .shortcut-key {
        background: #e2e8f0;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 500;
        color: #475569;
      }
    `;
    document.head.appendChild(style);

    // 제목 추가
    const title = document.createElement('div');
    title.className = 'popup-title';
    title.textContent = '재생 속도 설정';

	// 입력 컨테이너
	const inputContainer = document.createElement('div');
	inputContainer.className = 'input-container';

	// 입력 필드
	const input = document.createElement('input');
	input.type = 'number';
	input.className = 'speed-input';
	input.min = '0.1';
	input.max = '16';
	input.step = '0.1';
	input.value = document.querySelector('video')?.playbackRate || '1.0';

    // 단축키 정보
    const shortcutInfo = document.createElement('div');
    shortcutInfo.className = 'shortcut-info';
    shortcutInfo.innerHTML = '<span class="shortcut-key">Enter</span> 적용 | <span class="shortcut-key">ESC</span> 취소';

    // 요소 조립
    inputContainer.appendChild(input);
    popup.appendChild(title);
    popup.appendChild(inputContainer);
    popup.appendChild(shortcutInfo);

    return { popup, input };
  }

  // 팝업 표시 함수 개선
  function showSpeedInputPopup() {
    try {
      // 이미 존재하는 팝업 제거
      const existingPopup = document.getElementById('speed-input-popup');
      if (existingPopup) {
        existingPopup.remove();
        return;
      }

      const { popup, input } = createSpeedInputPopup();
      
      // 팝업을 body의 가장 마지막에 추가
      document.body.appendChild(popup);
      
      // 포커스 및 선택
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });

      // 키보드 이벤트 리스너
      const handleKeyDown = async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const speed = parseFloat(input.value);
          if (!isNaN(speed) && speed >= 0.1 && speed <= 16) {
            await applySpeedToAllVideos(speed);
            popup.remove();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          popup.remove();
        }
        e.stopPropagation();
      };

      input.addEventListener('keydown', handleKeyDown);

      // 팝업 외부 클릭 시 닫기
      const handleOutsideClick = (e) => {
        if (!popup.contains(e.target)) {
          popup.remove();
          document.removeEventListener('click', handleOutsideClick);
        }
      };

      // 약간의 지연 후 외부 클릭 리스너 등록
      setTimeout(() => {
        document.addEventListener('click', handleOutsideClick);
      }, 100);

      // 정리 함수 등록
      state.cleanup.add(() => {
        popup.remove();
        document.removeEventListener('click', handleOutsideClick);
      });
    } catch (error) {
      console.error('Error showing speed input popup:', error);
    }
  }

  // 단축키 이벤트 핸들러 개선
  document.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.key === '.') {
      e.preventDefault();
      e.stopPropagation();
      
      if (!state.contextValid) {
        await attemptRecovery(true);
      }
      
      showSpeedInputPopup();
    }
  }, true);

  // URL 변경 감지 함수 개선
  function observeUrlChanges() {
    if (state.documentObserver) {
      state.documentObserver.disconnect();
    }

    const handleUrlChange = async () => {
      if (document.location.href !== state.lastUrl) {
        state.lastUrl = document.location.href;
        state.autoSpeedApplied = false;

        if (!state.contextValid) {
          await attemptRecovery(true);
        }

        await applySiteSettings(true);
      }
    };

    // History API 변경 감지 최적화
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function() {
      originalPushState.apply(this, arguments);
      debouncedUrlChange();
    };

    history.replaceState = function() {
      originalReplaceState.apply(this, arguments);
      debouncedUrlChange();
    };

    // DOM 변경 감지
    state.documentObserver = new MutationObserver(() => {
      if (document.location.href !== state.lastUrl) {
        handleUrlChange();
      }
    });

    state.documentObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });

    // 정리 함수
    state.cleanup.add(() => {
      if (state.documentObserver) {
        state.documentObserver.disconnect();
        state.documentObserver = null;
      }
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('pushState', handleUrlChange);
      window.removeEventListener('replaceState', handleUrlChange);
    });
  }

  // 비디오 감지 함수
  function observeVideoElements() {
    if (state.videoObserver) {
      state.videoObserver.disconnect();
    }

    // 현재 비디오 처리
    const videos = document.getElementsByTagName('video');
    for (const video of videos) {
      if (!state.initializedVideos.has(video)) {
        initializeVideo(video);
      }
    }

    // 새로운 비디오 감지
    state.videoObserver = new MutationObserver((mutations) => {
      const hasNewVideos = mutations.some(mutation => 
        Array.from(mutation.addedNodes).some(node => 
          node.nodeName === 'VIDEO' || node.getElementsByTagName?.('video').length > 0
        )
      );

      if (hasNewVideos) {
        const videos = document.getElementsByTagName('video');
        for (const video of videos) {
          if (!state.initializedVideos.has(video)) {
            initializeVideo(video);
          }
        }
      }
    });

    state.videoObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    state.cleanup.add(() => {
      if (state.videoObserver) {
        state.videoObserver.disconnect();
        state.videoObserver = null;
      }
    });
  }

  // YouTube Shorts 네비게이션 감지 함수
  function observeYouTubeShortsNavigation() {
    if (!state.youtubeConfig.isYouTube) return;

    const observer = new MutationObserver(async (mutations) => {
      const isRelevantChange = mutations.some(mutation => {
        return mutation.target.matches?.('ytd-reel-video-renderer[is-active]') ||
          mutation.target.getAttribute?.('page-type') === 'SHORTS' ||
          mutation.target.matches?.('[page-type="SHORTS"]') ||
          mutation.target.id === 'progress';
      });

      if (isRelevantChange) {
        const currentVideoId = new URL(window.location.href).pathname.split('/').pop();
        if (currentVideoId !== state.youtubeConfig.lastShortsVideoId) {
          state.youtubeConfig.lastShortsVideoId = currentVideoId;
          state.autoSpeedApplied = false;
          await applySiteSettings(true);
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['is-active', 'page-type', 'aria-hidden']
    });

    state.youtubeConfig.shortsObserver = observer;
    state.cleanup.add(() => {
      if (state.youtubeConfig.shortsObserver) {
        state.youtubeConfig.shortsObserver.disconnect();
        state.youtubeConfig.shortsObserver = null;
      }
    });
  }

  // 성능 개선을 위한 디바운스 함수
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // URL 변경 이벤트 핸들러 최적화
  const debouncedUrlChange = debounce(async () => {
    if (document.location.href !== state.lastUrl) {
      state.lastUrl = document.location.href;
      state.autoSpeedApplied = false;

      if (!state.contextValid) {
        await attemptRecovery(true);
      }

      await applySiteSettings(true);
    }
  }, 150);

  // 주기적 상태 검사 개선
  const checkInterval = 5000; // 5초마다 검사
  let lastCheck = 0;

  setInterval(async () => {
    const now = Date.now();
    
    // 마지막 검사 후 충분한 시간이 지났는지 확인
    if (now - lastCheck < checkInterval) {
      return;
    }
    
    lastCheck = now;

    // 재연결 시도 중이면 스킵
    if (reconnectionState.isReconnecting || reconnectionState.recoveryMode) {
      return;
    }

    if (!state.contextValid || !state.autoSpeedApplied) {
      if (!state.contextValid) {
        await attemptRecovery(true);
      }
      if (state.contextValid) {
        await applySiteSettings(true);
      }
    }
  }, 2000);

  // 페이지 언로드 시 정리 함수 개선
  window.addEventListener('beforeunload', () => {
    state.cleanup.forEach(cleanup => {
      try {
        cleanup();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    });
    state.cleanup.clear();
  });

  // 성능 최적화된 컨텍스트 초기화 방지
  let contextValidationTimeout;
  const contextValidationHandler = async () => {
    if (!state.contextValid && document.visibilityState === 'visible') {
      try {
        await attemptRecovery(true);
      } catch (error) {
        throttledError('Context recovery failed:', error);
      }
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (contextValidationTimeout) {
        clearTimeout(contextValidationTimeout);
      }
      contextValidationTimeout = setTimeout(contextValidationHandler, 1000);
    }
  }, { passive: true });

  // 초기화 실행 개선
  initialize().catch(async error => {
    console.error('Initial setup failed:', error);
    await new Promise(resolve => setTimeout(resolve, 1000));
    tryReconnect().catch(console.error);
  });
})();
