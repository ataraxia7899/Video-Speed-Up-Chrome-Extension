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
			RETRY_INTERVAL: 50,
			MAX_RETRIES: 20,
			MUTATION_DEBOUNCE: 50,
			isYouTube: window.location.hostname.includes('youtube.com'),
			lastSpeedUpdate: 0,
			updateDelay: 100,
			retryCount: 0,
			isShortsPage: false,
			shortsObserver: null,
			lastShortsVideoId: null,
			defaultSpeed: 1.0, // YouTube의 기본 재생 속도
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
		portConnection: null,
	};

	// 재연결 상태 추가
	const reconnectionState = {
		isReconnecting: false,
		lastErrorTime: 0,
		errorCount: 0,
		errorThreshold: 5000, // 5초 동안의 에러 횟수를 추적
		maxErrorsInThreshold: 3, // 5초 동안 최대 3번까지만 에러 로깅
		recoveryMode: false,
	};

	// 오류 로깅 최적화 함수
	function throttledError(message, error = null) {
		const now = Date.now();

		// 재연결 시도 중이면 로그 출력 안함
		if (reconnectionState.isReconnecting) {
			return;
		}

		// 에러 임계값 시간이 지났으면 카운터 초기화
		if (
			now - reconnectionState.lastErrorTime >
			reconnectionState.errorThreshold
		) {
			reconnectionState.errorCount = 0;
		}

		// 최대 에러 출력 횟수를 초과하지 않았을 때만 로그 출력
		if (reconnectionState.errorCount < reconnectionState.maxErrorsInThreshold) {
			if (error) {
				// console.error(message, error);
			} else {
				// console.error(message);
			}
			reconnectionState.errorCount++;
		}

		reconnectionState.lastErrorTime = now;
	}

	// 빠른 초기화를 위한 즉시 실행 함수
	const quickInit = async () => {
		const videos = document.getElementsByTagName('video');
		if (videos.length > 0) {
			chrome.storage.sync.get(['siteSettings'], async (result) => {
				if (chrome.runtime.lastError) return;

				const siteSettings = result.siteSettings || {};
				const currentUrl = window.location.href;
				let matchFound = false;

				for (const [pattern, setting] of Object.entries(siteSettings)) {
					const speed = typeof setting === 'object' ? setting.speed : setting;
					const enabled = typeof setting === 'object' ? setting.enabled : true;

					if (enabled && matchUrlPattern(pattern, currentUrl)) {
						await applySpeedToAllVideos(speed);
						state.autoSpeedApplied = true;
						matchFound = true;
						break;
					}
				}

				// 매칭되는 패턴이 없을 경우 기본 속도로 설정
				if (!matchFound) {
					await applySpeedToAllVideos(state.youtubeConfig.defaultSpeed);
					state.autoSpeedApplied = false;
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
		state.initializationQueue = state.initializationQueue
			.then(fn)
			.catch((error) => {
				// console.error('Initialization error:', error);
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

			state.portConnection = chrome.runtime.connect({
				name: 'videoSpeedController',
			});

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

		if (
			now - config.lastReconnectTime < config.minReconnectInterval ||
			config.reconnectAttempts >= config.maxReconnectAttempts
		) {
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

			await new Promise((resolve) => setTimeout(resolve, delay));

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
			// console.error('Context validation failed:', error);
			return false;
		}
	}

	// 메시지 전송 타임아웃 래퍼
	async function sendMessageWithTimeout(message, timeout) {
		return Promise.race([
			new Promise((resolve, reject) => {
				try {
					chrome.runtime.sendMessage(message, (response) => {
						if (chrome.runtime.lastError) {
							// 연결 실패 시 자동 복구 요청
							chrome.runtime.sendMessage({ action: 'reconnect' });
							reject(chrome.runtime.lastError);
						} else {
							resolve(response);
						}
					});
				} catch (e) {
					// 연결 실패 시 자동 복구 요청
					chrome.runtime.sendMessage({ action: 'reconnect' });
					reject(e);
				}
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

					await applySpeedToAllVideos(speed);

					settingApplied = true;
					break;
				}
			}

			

			state.autoSpeedApplied = settingApplied;
			return settingApplied;
		} catch (error) {
			// console.error('Error applying site settings:', error);
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
			await new Promise((resolve) => setTimeout(resolve, 500));
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
						state.cleanup.forEach((cleanup) => cleanup());
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

					case 'getCurrentSpeed':
						const video = document.querySelector('video');
						const speed = video ? video.playbackRate : state.currentSpeed;
						return { success: true, speed };

					case 'setSpeed':
						if (
							typeof request.speed === 'number' &&
							request.speed >= 0.1 &&
							request.speed <= 16
						) {
							state.pendingSpeedUpdate = request.speed;
							const success = await applySpeedToAllVideos(request.speed);
							return { success, speed: request.speed };
						}
						return { success: false, error: 'Invalid speed value' };

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
			if (!state.initialized) {
				await establishConnection();

				// 상태 초기화
				state.lastUrl = window.location.href;
				state.autoSpeedApplied = false;

				// 저장된 속도 불러오기
				try {
					const response = await chrome.runtime.sendMessage({
						action: 'getSpeed',
					});
					if (response?.success && response.speed) {
						state.currentSpeed = response.speed;
						state.pendingSpeedUpdate = response.speed;
					}
				} catch (error) {
					// console.error('Error loading saved speed:', error);
				}

				// 관찰자 설정
				observeVideoElements();
				observeUrlChanges();

				if (state.youtubeConfig.isYouTube) {
					observeYouTubeShortsNavigation();
				}

				// 현재 비디오 요소들 초기화
				const videos = document.getElementsByTagName('video');
				for (const video of videos) {
					await initializeVideo(video);
				}

				// 사이트별 설정 적용
				// await applySiteSettings(true); // Removed this line

				state.initialized = true;
			}
			return true;
		} catch (error) {
			// console.error('Initialization failed:', error);
			state.initialized = false;
			return false;
		}
	}

	// 비디오 초기화 함수 개선
	async function initializeVideo(video) {
		if (!video || state.initializedVideos.has(video)) return;

		try {
			// 이벤트 리스너 등록 전에 현재 속도 적용
			if (state.pendingSpeedUpdate !== null) {
				video.playbackRate = state.pendingSpeedUpdate;
			} else if (state.currentSpeed !== 1.0) {
				video.playbackRate = state.currentSpeed;
			}

			// 비디오 이벤트 리스너
			const handleLoadedMetadata = async () => {
				if (state.pendingSpeedUpdate !== null) {
					await setVideoSpeed(video, state.pendingSpeedUpdate);
				} else if (state.currentSpeed !== 1.0) {
					await setVideoSpeed(video, state.currentSpeed);
				}
			};

			const handleRateChange = async () => {
				// 속도 변경 시 항상 상태 업데이트
				await setVideoSpeed(video, video.playbackRate);
			};

			// 이벤트 리스너 등록
			video.addEventListener('loadedmetadata', handleLoadedMetadata);
			video.addEventListener('ratechange', handleRateChange);
			video.addEventListener('play', handleLoadedMetadata);

			// 현재 재생 가능한 상태면 바로 속도 적용
			if (video.readyState >= 1) {
				await handleLoadedMetadata();
			}

			// 정리 함수 등록
			state.cleanup.add(() => {
				video.removeEventListener('loadedmetadata', handleLoadedMetadata);
				video.removeEventListener('ratechange', handleRateChange);
				video.removeEventListener('play', handleLoadedMetadata);
				state.initializedVideos.delete(video);
			});

			state.initializedVideos.add(video);
		} catch (error) {
			// console.error('Video initialization error:', error);
		}
	}

	// 비디오 속도 설정 함수 추가
	async function setVideoSpeed(video, speed) {
		if (!video || typeof speed !== 'number' || speed < 0.1 || speed > 16)
			return false;

		try {
			let success = false;
			// YouTube 비디오 처리
			if (state.youtubeConfig.isYouTube) {
				if (detectYouTubeShortsPage()) {
					success = await handleYouTubeShortsVideo(speed);
				} else {
					success = await handleYouTubeVideo(speed);
				}
			} else {
				// 일반 비디오 처리
				const applySpeed = () => {
					video.playbackRate = speed;
					return Math.abs(video.playbackRate - speed) < 0.01;
				};

				// 첫 시도
				if (applySpeed()) {
					success = true;
				} else {
					// 재시도 (최대 3회)
					let retries = 3;
					while (retries > 0) {
						await new Promise((resolve) => setTimeout(resolve, 100));
						if (applySpeed()) {
							success = true;
							break;
						}
						retries--;
					}
				}
			}

			if (success) {
				state.currentSpeed = speed;
				state.pendingSpeedUpdate = null;
				// Send message to background script after successful speed application
				await chrome.runtime.sendMessage({ action: 'setSpeed', speed: speed });
				return true;
			}

			return false;
		} catch (error) {
			// console.error('Error setting video speed:', error);
			return false;
		}
	}

	// 모든 비디오에 속도 적용
	async function applySpeedToAllVideos(speed) {
		if (!speed || typeof speed !== 'number') return false;

		try {
			const videos = document.getElementsByTagName('video');
			const results = await Promise.all(
				Array.from(videos).map((video) => setVideoSpeed(video, speed))
			);

			if (results.some((success) => success)) {
				// 성공적으로 적용된 경우 background script에 알림
				await chrome.runtime.sendMessage({
					action: 'setSpeed',
					speed: speed,
				});
				return true;
			}

			return false;
		} catch (error) {
			// console.error('Error applying speed to all videos:', error);
			return false;
		}
	}

	// 비디오 감지 함수 개선
	function observeVideoElements() {
		if (state.videoObserver) {
			state.videoObserver.disconnect();
		}

		// 현재 비디오 처리
		const videos = document.getElementsByTagName('video');
		for (const video of videos) {
			if (!state.initializedVideos.has(video)) {
				queueVideoInitialization(video);
			}
		}

		// 새로운 비디오 감지
		state.videoObserver = new MutationObserver((mutations) => {
			let needsUpdate = false;

			for (const mutation of mutations) {
				// 새로운 비디오 요소 확인
				const checkNode = (node) => {
					if (node.nodeName === 'VIDEO') {
						needsUpdate = true;
					} else if (node.getElementsByTagName) {
						const videos = node.getElementsByTagName('video');
						if (videos.length > 0) {
							needsUpdate = true;
						}
					}
				};

				// 추가된 노드 확인
				mutation.addedNodes.forEach(checkNode);

				// 속성 변경 확인 (src 변경 등)
				if (
					mutation.type === 'attributes' &&
					mutation.target.nodeName === 'VIDEO' &&
					!state.initializedVideos.has(mutation.target)
				) {
					needsUpdate = true;
				}
			}

			if (needsUpdate) {
				const videos = document.getElementsByTagName('video');
				for (const video of videos) {
					if (!state.initializedVideos.has(video)) {
						queueVideoInitialization(video);
					}
				}
			}
		});

		// 옵저버 설정
		state.videoObserver.observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['src', 'currentSrc'],
		});

		// 정리 함수
		state.cleanup.add(() => {
			if (state.videoObserver) {
				state.videoObserver.disconnect();
				state.videoObserver = null;
			}
		});
	}

	// 비디오 초기화 큐 관리
	const videoInitQueue = new Set();
	let processingQueue = false;

	function queueVideoInitialization(video) {
		videoInitQueue.add(video);

		if (!processingQueue) {
			processingQueue = true;
			requestAnimationFrame(processVideoQueue);
		}
	}

	async function processVideoQueue() {
		try {
			const videos = Array.from(videoInitQueue);
			videoInitQueue.clear();

			for (const video of videos) {
				if (!state.initializedVideos.has(video)) {
					await initializeVideo(video);
				}
			}
		} catch (error) {
			// console.error('Error processing video queue:', error);
		} finally {
			processingQueue = false;

			// 큐에 남은 항목이 있으면 다시 처리
			if (videoInitQueue.size > 0) {
				requestAnimationFrame(processVideoQueue);
			}
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
			const containers = document.querySelectorAll(
				[
					'ytd-reel-video-renderer[is-active]',
					'#shorts-container ytd-shorts-player-renderer',
					'[page-type="SHORTS"] ytd-shorts[is-active]',
				].join(',')
			);

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
					await new Promise((resolve) =>
						setTimeout(resolve, state.youtubeConfig.RETRY_INTERVAL)
					);
					retryCount++;
					continue;
				}

				if (video.readyState < 3) {
					await new Promise((resolve, reject) => {
						const timeout = setTimeout(
							() => reject(new Error('Video load timeout')),
							5000
						);
						video.addEventListener(
							'canplay',
							() => {
								clearTimeout(timeout);
								resolve();
							},
							{ once: true }
						);
					});
				}

				video.playbackRate = speed;
				await new Promise((resolve) => setTimeout(resolve, 50));

				return video.playbackRate === speed;
			} catch (error) {
				retryCount++;
				await new Promise((resolve) =>
					setTimeout(
						resolve,
						state.youtubeConfig.RETRY_INTERVAL * Math.pow(1.5, retryCount)
					)
				);
			}
		}

		return false;
	}

	async function handleYouTubeVideo(speed) {
		if (!state.youtubeConfig.isYouTube) return false;

		try {
			// YouTube Shorts 페이지 감지 및 특별 처리
			if (detectYouTubeShortsPage()) {
				return await handleYouTubeShortsSpecific(speed);
			}

			const video = document.querySelector('video');
			if (!video) return false;

			// 비디오가 준비될 때까지 대기
			if (video.readyState < 3) {
				await new Promise((resolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error('Video load timeout')),
						5000
					);
					const onReady = () => {
						clearTimeout(timeout);
						resolve();
					};
					video.addEventListener('canplay', onReady, { once: true });
					video.addEventListener('loadeddata', onReady, { once: true });
				});
			}

			// 이벤트 전파 차단 추가
			const handleRateChange = (e) => {
				e.stopPropagation();
				e.stopImmediatePropagation();
			};

			// 기존 이벤트 리스너 제거 후 새로 등록
			video.removeEventListener('ratechange', handleRateChange);
			video.addEventListener('ratechange', handleRateChange);

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
			await new Promise((resolve) => setTimeout(resolve, 50));

			return video.playbackRate === speed;
		} catch (error) {
			throttledError('YouTube video speed setting error:', error);
			return false;
		}
	}

	// YouTube Shorts 전용 처리 함수 추가
	async function handleYouTubeShortsSpecific(speed) {
		try {
			// 댓글 로딩 상태 확인
			const commentSection = document.querySelector(
				'#comments, ytd-comments, #comment-teaser'
			);
			if (commentSection?.getAttribute('loading') === 'true') {
				// 댓글 로딩 완료까지 대기
				await new Promise((resolve) => setTimeout(resolve, 300));
			}

			// 활성 Shorts 비디오 찾기
			const findActiveShortsVideo = () => {
				const selectors = [
					'ytd-reel-video-renderer[is-active] video',
					'#shorts-container video',
					'ytd-shorts[is-active] video',
					'.ytd-shorts video',
				];

				for (const selector of selectors) {
					const video = document.querySelector(selector);
					if (
						video &&
						isElementInViewport(
							video.closest('ytd-reel-video-renderer, ytd-shorts')
						)
					) {
						return video;
					}
				}
				return document.querySelector('video'); // 폴백
			};

			const video = findActiveShortsVideo();
			if (!video) return false;

			// Shorts 전용 이벤트 처리
			const handleShortsRateChange = (e) => {
				e.stopPropagation();
				e.stopImmediatePropagation();

				// 댓글 영역 DOM 조작 방지
				const commentElements = document.querySelectorAll(
					'#comments, ytd-comments, #comment-teaser'
				);
				commentElements.forEach((el) => {
					if (el.style) {
						el.style.pointerEvents = 'auto';
					}
				});
			};

			// 기존 리스너 정리 후 새로 등록
			video.removeEventListener('ratechange', handleShortsRateChange);
			video.addEventListener('ratechange', handleShortsRateChange);

			// 속도 설정
			video.playbackRate = speed;

			// Shorts에서는 더 짧은 대기 시간
			await new Promise((resolve) => setTimeout(resolve, 100));

			return video.playbackRate === speed;
		} catch (error) {
			throttledError('YouTube Shorts speed setting error:', error);
			return false;
		}
	}

	// 뷰포트 내 요소 확인 헬퍼 함수
	function isElementInViewport(element) {
		if (!element) return false;
		const rect = element.getBoundingClientRect();
		return (
			rect.top >= 0 &&
			rect.left >= 0 &&
			rect.bottom <=
				(window.innerHeight || document.documentElement.clientHeight) &&
			rect.right <= (window.innerWidth || document.documentElement.clientWidth)
		);
	}

	// 팝업 생성 함수
	function createSpeedInputPopup() {
		const popup = document.createElement('div');
		popup.id = 'speed-input-popup';

		// 스타일 추가
		const style = document.createElement('style');
		style.textContent = `
      #speed-input-popup {
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
        min-width: 200px;
        max-width: 200px;
        transition: all 0.3s ease;
      }

      .popup-title {
        font-size: 18px;
        font-weight: 600;
        text-align: center;
        margin: 0;
        padding: 0;
        color: #1a1a1a;
      }

      .input-container {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .speed-input {
        width: 120px;
        padding: 12px;
        font-size: 20px;
        text-align: center;
        border: 2px solid #e2e8f0;
        border-radius: 8px;
        outline: none;
        transition: all 0.2s ease;
        margin: 0 auto;
        display: block;
        background: #ffffff;
        color: #1a1a1a;
      }

      .speed-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
      }

      .info-container {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f8fafc;
        border-radius: 6px;
        padding: 8px;
      }

      .shortcut-info {
        color: #64748b;
        font-size: 13px;
        text-align: center;
      }

      .shortcut-key {
        background: #e2e8f0;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 500;
        color: #475569;
      }

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
		input.min = '0.1';
		input.max = '16';
		input.step = '0.1';
		input.value = document.querySelector('video')?.playbackRate || '1.0';

		const infoContainer = document.createElement('div');
		infoContainer.className = 'info-container';

		const shortcutInfo = document.createElement('div');
		shortcutInfo.className = 'shortcut-info';
		shortcutInfo.innerHTML =
			'<span class="shortcut-key">Enter</span> 적용 | <span class="shortcut-key">ESC</span> 취소';

		infoContainer.appendChild(shortcutInfo);
		inputContainer.appendChild(input);

		popup.appendChild(title);
		popup.appendChild(inputContainer);
		popup.appendChild(infoContainer);

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
			// console.error('Error showing speed input popup:', error);
		}
	}

	// 단축키 이벤트 핸들러 개선
	document.addEventListener(
		'keydown',
		async (e) => {
			if (e.ctrlKey && e.key === '.') {
				e.preventDefault();
				e.stopPropagation();

				if (!state.contextValid) {
					await attemptRecovery(true);
				}

				showSpeedInputPopup();
			}
		},
		true
	);

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

		history.pushState = function () {
			originalPushState.apply(this, arguments);
			debouncedUrlChange();
		};

		history.replaceState = function () {
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
			attributeFilter: ['href'],
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
		state.cleanup.forEach((cleanup) => {
			try {
				cleanup();
			} catch (error) {
				// console.error('Cleanup error:', error);
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

	document.addEventListener(
		'visibilitychange',
		() => {
			if (document.visibilityState === 'visible') {
				if (contextValidationTimeout) {
					clearTimeout(contextValidationTimeout);
				}
				contextValidationTimeout = setTimeout(contextValidationHandler, 1000);
			}
		},
		{ passive: true }
	);

	// 초기화 실행 개선
	initialize().catch(async (error) => {
		// console.error('Initial setup failed:', error);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		tryReconnect().catch(console.error);
	});
})();
