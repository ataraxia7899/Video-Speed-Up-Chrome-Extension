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

  // 포트 연결 관리 함수
  async function establishConnection() {
    if (state.portConnection) {
      try {
        state.portConnection.disconnect();
      } catch (error) {
        console.error('Error disconnecting port:', error);
      }
    }

    try {
      state.portConnection = chrome.runtime.connect({ name: "videoSpeedController" });
      
      state.portConnection.onDisconnect.addListener(async () => {
        if (chrome.runtime.lastError) {
          console.error('Port disconnected:', chrome.runtime.lastError);
        }
        state.contextValid = false;
        state.portConnection = null;
        await handleDisconnect();
      });

      // 연결 확인을 위한 ping 전송
      state.portConnection.postMessage({ action: 'ping' });
      state.contextValid = true;
      state.connectionConfig.reconnectAttempts = 0;
      return true;
    } catch (error) {
      console.error('Connection establishment failed:', error);
      return false;
    }
  }

  // 연결 해제 처리 함수
  async function handleDisconnect() {
    const config = state.connectionConfig;
    const now = Date.now();

    // 재연결 시도 간격 제한
    if (now - config.lastReconnectTime < config.minReconnectInterval) {
      return;
    }

    if (config.reconnectAttempts >= config.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    config.reconnectAttempts++;
    config.lastReconnectTime = now;

    // 지수 백오프를 사용한 재시도 간격 계산
    const delay = Math.min(
      config.reconnectDelay * Math.pow(2, config.reconnectAttempts - 1),
      config.maxReconnectDelay
    );

    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      const success = await establishConnection();
      if (success) {
        await applySiteSettings(true);
      }
    } catch (error) {
      console.error('Reconnection attempt failed:', error);
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

  // 컨텍스트 복구 함수 개선
  async function attemptRecovery(force = false) {
    const config = state.connectionConfig;
    
    if (!force && config.reconnectAttempts >= config.maxReconnectAttempts) {
      return false;
    }

    try {
      // 컨텍스트 재설정 시도
      const connected = await establishConnection();
      if (!connected) {
        throw new Error('Failed to establish connection');
      }

      // 컨텍스트 유효성 검증
      const valid = await validateContext();
      if (valid) {
        state.contextValid = true;
        config.reconnectAttempts = 0;
        return true;
      }

      throw new Error('Context validation failed');
    } catch (error) {
      console.error('Recovery attempt failed:', error);
      return handleDisconnect();
    }
  }

  // YouTube Shorts 페이지 감지
  function detectYouTubeShortsPage() {
    const url = window.location.href;
    return url.includes('/shorts/');
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

  // YouTube Shorts 전용 비디오 처리 함수 개선
  async function handleYouTubeShortsVideo(speed) {
    if (!state.youtubeConfig.isYouTube || !detectYouTubeShortsPage()) return false;

    const findAndSetSpeed = async () => {
      // Shorts 컨테이너 찾기
      const shortsContainers = document.querySelectorAll([
        'ytd-reel-video-renderer[is-active]',
        '#shorts-container ytd-shorts-player-renderer',
        '[page-type="SHORTS"] ytd-shorts[is-active]'
      ].join(','));

      let currentShortsVideo = null;

      // 현재 보이는 Shorts 비디오 찾기
      for (const container of shortsContainers) {
        const video = container.querySelector('video');
        if (video && isElementInViewport(container)) {
          currentShortsVideo = video;
          break;
        }
      }

      if (!currentShortsVideo) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const retryVideo = document.querySelector('ytd-reel-video-renderer[is-active] video');
        if (!retryVideo) return false;
        currentShortsVideo = retryVideo;
      }

      try {
        // 비디오 준비 대기
        if (currentShortsVideo.readyState < 3) {
          await new Promise(resolve => {
            const readyCheck = () => {
              if (currentShortsVideo.readyState >= 3) {
                resolve();
              } else {
                setTimeout(readyCheck, 100);
              }
            };
            readyCheck();
            // 5초 타임아웃
            setTimeout(resolve, 5000);
          });
        }

        // 속도 설정
        currentShortsVideo.playbackRate = speed;
        await new Promise(resolve => setTimeout(resolve, 50));

        // 속도 설정 확인 및 재시도
        if (currentShortsVideo.playbackRate !== speed) {
          currentShortsVideo.playbackRate = speed;
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        return currentShortsVideo.playbackRate === speed;
      } catch (error) {
        console.error('YouTube Shorts speed setting error:', error);
        return false;
      }
    };

    // 속도 설정 시도
    let retryCount = 0;
    const maxRetries = 5;
    
    while (retryCount < maxRetries) {
      const success = await findAndSetSpeed();
      if (success) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 200 * Math.pow(2, retryCount)));
      retryCount++;
    }

    return false;
  }

  // Shorts 비디오 변경 감지 강화
  function observeShortsNavigation() {
    if (!state.youtubeConfig.isYouTube) return;

    const shortsObserver = new MutationObserver(async (mutations) => {
      const isRelevantChange = mutations.some(mutation => {
        const target = mutation.target;
        return (
          target.matches?.('ytd-reel-video-renderer[is-active]') ||
          target.getAttribute?.('page-type') === 'SHORTS' ||
          target.matches?.('[page-type="SHORTS"]') ||
          target.id === 'progress' ||
          mutation.addedNodes.length > 0
        );
      });

      if (isRelevantChange) {
        state.autoSpeedApplied = false;
        await applySiteSettings(true);
      }
    });

    shortsObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['is-active', 'page-type', 'aria-hidden']
    });

    state.cleanup.add(() => shortsObserver.disconnect());
  }

  // 요소가 뷰포트 내에 있는지 확인하는 함수
  function isElementInViewport(element) {
    const rect = element.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }

  // YouTube 전용 비디오 처리 함수
  async function handleYouTubeVideo(speed) {
    if (!state.youtubeConfig.isYouTube) return false;

    let retryCount = 0;
    const maxRetries = state.youtubeConfig.MAX_RETRIES;
    const interval = state.youtubeConfig.RETRY_INTERVAL;

    const findAndSetSpeed = async () => {
      const video = document.querySelector('video');
      if (!video) return false;

      try {
        // 비디오가 로드될 때까지 대기
        if (video.readyState < 3) {
          await new Promise(resolve => {
            video.addEventListener('canplay', resolve, { once: true });
            setTimeout(resolve, 1000); // 1초 타임아웃
          });
        }

        // 속도 설정 및 확인
        video.playbackRate = speed;
        await new Promise(resolve => setTimeout(resolve, 50));
        
        if (video.playbackRate !== speed) {
          video.playbackRate = speed;
          await new Promise(resolve => setTimeout(resolve, 50));
        }

        // YouTube 플레이어 API를 통한 추가 설정 시도
        if (window.yt?.player?.getPlayerByElement) {
          const player = window.yt.player.getPlayerByElement(video);
          if (player?.setPlaybackRate) {
            player.setPlaybackRate(speed);
          }
        }

        return video.playbackRate === speed;
      } catch (error) {
        console.error('YouTube speed setting error:', error);
        return false;
      }
    };

    // 속도 설정 재시도 로직
    while (retryCount < maxRetries) {
      const success = await findAndSetSpeed();
      if (success) {
        state.youtubeConfig.retryCount = 0;
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
      retryCount++;
    }

    return false;
  }

  // YouTube Shorts 네비게이션 감지
  function observeYouTubeShortsNavigation() {
    if (!state.youtubeConfig.isYouTube) return;

    // Shorts 페이지 변경 감지
    const handleShortsNavigation = async () => {
      const isShortsPage = detectYouTubeShortsPage();
      if (isShortsPage !== state.youtubeConfig.isShortsPage) {
        state.youtubeConfig.isShortsPage = isShortsPage;
        if (isShortsPage) {
          state.autoSpeedApplied = false;
          await applySiteSettings(true);
        }
      }
    };

    // URL 변경 감지
    const observer = new MutationObserver(async (mutations) => {
      const urlChanged = mutations.some(mutation => 
        mutation.target.nodeName === 'TITLE' ||
        mutation.target.id === 'page-manager' ||
        (mutation.target.tagName === 'VIDEO' && detectYouTubeShortsPage())
      );

      if (urlChanged) {
        await handleShortsNavigation();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-url']
    });

    // Shorts 특화 이벤트 리스너
    window.addEventListener('yt-navigate-start', handleShortsNavigation);
    window.addEventListener('yt-navigate-finish', handleShortsNavigation);
  }

  // YouTube URL 변경 감지 함수
  function detectYouTubeNavigation() {
    if (!state.youtubeConfig.isYouTube) return;

    // YouTube의 동적 네비게이션 감지
    const observer = new MutationObserver(async (mutations) => {
      const titleChanged = mutations.some(mutation => 
        mutation.target.nodeName === 'TITLE' ||
        mutation.target.id === 'content' ||
        mutation.target.id === 'page-manager'
      );

      if (titleChanged) {
        state.autoSpeedApplied = false;
        await applySiteSettings(true);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-url']
    });

    // YouTube 특화 history 변경 감지
    const handleYouTubeNavigation = async () => {
      state.autoSpeedApplied = false;
      await new Promise(resolve => setTimeout(resolve, 500)); // 페이지 로드 대기
      await applySiteSettings(true);
    };

    window.addEventListener('yt-navigate-start', handleYouTubeNavigation);
    window.addEventListener('yt-navigate-finish', handleYouTubeNavigation);
  }

  // 비디오 요소에 속도 적용 함수 강화
  async function applySpeedToVideo(video, speed) {
    if (!video || !speed) return false;

    try {
      // YouTube Shorts인 경우 전용 처리
      if (state.youtubeConfig.isYouTube && detectYouTubeShortsPage()) {
        const now = Date.now();
        if (now - state.youtubeConfig.lastSpeedUpdate < state.youtubeConfig.updateDelay) {
          return false;
        }
        state.youtubeConfig.lastSpeedUpdate = now;
        return await handleYouTubeShortsVideo(speed);
      }

      // YouTube인 경우 전용 처리
      if (state.youtubeConfig.isYouTube) {
        const now = Date.now();
        if (now - state.youtubeConfig.lastSpeedUpdate < state.youtubeConfig.updateDelay) {
          return false;
        }
        state.youtubeConfig.lastSpeedUpdate = now;
        return await handleYouTubeVideo(speed);
      }

      // 이미 올바른 속도가 설정되어 있다면 스킵
      if (video.playbackRate === speed) return true;

      // 속도 설정 시도
      video.playbackRate = speed;
      
      // 설정 확인 및 재시도
      if (video.playbackRate !== speed) {
        // 비디오가 준비될 때까지 대기
        await new Promise(resolve => {
          const checkReady = () => {
            if (video.readyState >= 3) {
              resolve();
            } else {
              setTimeout(checkReady, 100);
            }
          };
          checkReady();
        });

        // 재시도
        video.playbackRate = speed;
        
        // 최종 확인
        if (video.playbackRate !== speed) {
          console.warn('Failed to set video speed after retry');
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error('Error applying speed to video:', error);
      return false;
    }
  }

  // 비디오 요소 초기화 함수 개선
  async function initializeVideo(video) {
    if (!video || state.initializedVideos.has(video)) return;

    try {
      if (state.pendingSpeedUpdate !== null) {
        video.playbackRate = state.pendingSpeedUpdate;
      }

      const handleSpeedChange = () => {
        if (video.playbackRate !== state.currentSpeed) {
          state.currentSpeed = video.playbackRate;
        }
      };

      video.addEventListener('ratechange', handleSpeedChange);
      state.cleanup.add(() => video.removeEventListener('ratechange', handleSpeedChange));

      if (state.currentSpeed !== 1.0) {
        video.playbackRate = state.currentSpeed;
      }

      state.initializedVideos.add(video);
    } catch (error) {
      console.error('Video initialization failed:', error);
    }
  }

  // 비디오 감지 최적화
  function observeVideoElements() {
    if (state.videoObserver) {
      state.videoObserver.disconnect();
    }

    // 즉시 실행 함수로 현재 비디오 처리
    const videos = document.getElementsByTagName('video');
    for (const video of videos) {
      if (!state.initializedVideos.has(video)) {
        initializeVideo(video);
      }
    }

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

  // URL 변경 감지 함수 강화
  function observeUrlChanges() {
    if (state.documentObserver) {
      state.documentObserver.disconnect();
    }

    // 페이지 변경 감지
    state.documentObserver = new MutationObserver(async (mutations) => {
      if (document.location.href !== state.lastUrl) {
        queueInitialization(async () => {
          state.autoSpeedApplied = false;
          await applySiteSettings(true);
        });
      }
    });

    state.documentObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // History API 변경 감지
    const handleUrlChange = () => {
      if (document.location.href !== state.lastUrl) {
        queueInitialization(async () => {
          state.autoSpeedApplied = false;
          await applySiteSettings(true);
        });
      }
    };

    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('pushState', handleUrlChange);
    window.addEventListener('replaceState', handleUrlChange);

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

  // History API 메소드 오버라이드
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function() {
    originalPushState.apply(this, arguments);
    window.dispatchEvent(new Event('pushState'));
  };

  history.replaceState = function() {
    originalReplaceState.apply(this, arguments);
    window.dispatchEvent(new Event('replaceState'));
  };

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
              applySpeedToVideo(video, request.speed);
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
              applySpeedToVideo(video, newSpeed);
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
            applySpeedToVideo(video, speed);
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

  // 초기화 함수 개선
  async function initialize() {
    try {
      // 빠른 초기 적용
      quickInit();

      // 컨텍스트 설정
      if (!state.contextValid) {
        const recovered = await attemptRecovery(true);
        if (!recovered) {
          throw new Error('Failed to establish valid context');
        }
      }

      // 감시자 설정
      observeVideoElements();
      observeUrlChanges();

      state.initialized = true;

      // 초기 사이트 설정 적용
      await applySiteSettings(true);
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

  // 초기화 즉시 실행
  initialize().catch(console.error);

  // 주기적인 상태 검사 개선
  setInterval(async () => {
    if (!state.contextValid || !state.autoSpeedApplied) {
      if (!state.contextValid) {
        await attemptRecovery(true);
      }
      if (state.contextValid) {
        await applySiteSettings(true);
      }
    }
  }, 2000);
})();
