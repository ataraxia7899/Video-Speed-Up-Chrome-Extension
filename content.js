(function () {
	// 단일 상태 관리 객체
	const state = {
		DEBUG: false, // 디버깅 모드 비활성화
		initialized: false,
		initializationInProgress: false,
		initPromise: null,
		retryCount: 0,
		MAX_RETRIES: 3,
		RETRY_DELAY: 1000,
		currentSpeed: 1.0,
		speedPopup: null,
		autoSpeedObserver: null,
		eventListenersInitialized: false,
		keyHandlerInstalled: false,
		cleanup: new Set(),
		lastUrl: window.location.href,
		videoObserver: null,
		initializedVideos: new Set(), // WeakSet을 Set으로 변경
		pageInitialized: false, // 페이지 초기화 상태 추적
		currentUrl: window.location.href, // 현재 URL 저장
		lastEventTime: 0,
		throttleDelay: 100, // 쓰로틀링 딜레이 (ms)
		isInitializing: false,
		initializationTimeout: null,
		initializationQueue: null,
		initializationLock: false,
		lastInitializationAttempt: 0,
		MIN_RETRY_INTERVAL: 1000, // 최소 재시도 간격 (1초)
		initializationDelay: 100,
		urlChangeDebounceDelay: 150,
		lastUrlCheck: 0,
		urlCheckInterval: 500, // URL 체크 간격 (ms)
		autoSpeedApplied: false, // 자동 배속 적용 상태 추적
		contextRecoveryDelay: 100,
		maxContextRecoveryTime: 5000,
		contextCheckInterval: 100,
		pendingContextCheck: null,
		lastContextCheck: 0,
		contextRecoveryConfig: {
			minDelay: 50,
			maxDelay: 1000,
			timeout: 3000,
			maxAttempts: 5,
			backoffFactor: 1.5,
		},
		contextValid: false,
		initializationRetryDelay: 500,
		pendingRecovery: null,
		recoveryTimeout: null,
		lastRecoveryAttempt: 0,
		recoveryInProgress: false,
	};

	// YouTube 특정 초기화 상태
	const youtubeState = {
		lastVideoId: null,
		pageType: null,
		navigationCounter: 0,
		recoveryMode: false,
		videoCheckInterval: null,
		lastVideoCheck: 0,
		VIDEO_CHECK_DELAY: 200,
	};

	// 핵심 유틸리티 함수
	const utils = {
		// 무작동 로그 함수
		log: () => {}, // noop 함수로 대체
		isValidSpeed(speed) {
			const parsed = parseFloat(speed);
			return !isNaN(parsed) && parsed >= 0.1 && parsed <= 16;
		},
	};

	// 초기화 전략 개선
	async function initWithRetry(maxAttempts = 3) {
		let attempt = 0;
		let lastError = null;

		while (attempt < maxAttempts) {
			try {
				// DOM 준비 상태 확인
				if (document.readyState === 'loading') {
					await new Promise((resolve) =>
						document.addEventListener('DOMContentLoaded', resolve, {
							once: true,
						})
					);
				}

				// Chrome 컨텍스트 대기
				const contextValid = await waitForChromeContext();
				if (!contextValid) {
					throw new Error('Failed to establish Chrome context');
				}

				// 초기화 실행
				await initialize();
				state.retryCount = 0;
				return;
			} catch (error) {
				lastError = error;
				console.warn(`Initialization attempt ${attempt + 1} failed:`, error);
				attempt++;

				if (attempt < maxAttempts) {
					await new Promise((resolve) =>
						setTimeout(
							resolve,
							state.initializationRetryDelay * Math.pow(2, attempt)
						)
					);
				}
			}
		}

		throw new Error(
			`Maximum initialization attempts reached: ${
				lastError?.message || 'Unknown error'
			}`
		);
	}

	// Chrome 컨텍스트 대기 함수 개선
	async function waitForChromeContext(timeout = 5000) {
		const startTime = Date.now();
		let lastAttempt = 0;
		const minInterval = 100;

		while (Date.now() - startTime < timeout) {
			try {
				const now = Date.now();
				if (now - lastAttempt < minInterval) {
					await new Promise((resolve) => setTimeout(resolve, minInterval));
					continue;
				}
				lastAttempt = now;

				const contextValid = await checkExtensionContext();
				if (contextValid) {
					return true;
				}

				const recovered = await attemptContextRecovery();
				if (recovered) {
					return true;
				}

				await new Promise((resolve) => setTimeout(resolve, minInterval));
			} catch (error) {
				console.warn('Error checking extension context:', error);
				await new Promise((resolve) => setTimeout(resolve, minInterval));
			}
		}

		throw new Error('Timeout waiting for Chrome context');
	}

	// 초기화 및 실행
	async function initialize() {
		try {
			if (!(await checkExtensionContext())) {
				throw new Error('Extension context invalid during initialization');
			}

			// 메시지 핸들러 재설정
			setupMessageHandler();

			// 스토리지/쿠키 리스너 설정
			setupStorageListener();
			setupCookieListener();

			await applySiteSettings();
			initializeVideoElements();
			observeVideoElements();

			state.pageInitialized = true;
		} catch (error) {
			console.error('Initialization failed:', error);
			throw error;
		}
	}

	// 비디오 요소 초기화 로직
	async function initializeVideoElements() {
		const videos = document.getElementsByTagName('video');
		for (const video of videos) {
			if (!state.initializedVideos.has(video)) {
				await initializeVideoElement(video);
			}
		}
	}

	// 비디오 요소 초기화 로직 강화
	async function initializeVideoElement(video) {
		if (!video || state.initializedVideos.has(video)) return;

		try {
			// 컨텍스트 유효성 확인
			if (!state.contextValid) {
				state.contextValid = await attemptContextRecovery();
				if (!state.contextValid) {
					throw new Error('Unable to initialize video - invalid context');
				}
			}

			// 비디오 요소가 여전히 DOM에 존재하는지 확인
			if (!document.contains(video)) {
				return;
			}

			// 이벤트 리스너 추가
			const ratechangeHandler = throttle(() => {
				state.currentSpeed = video.playbackRate;
			}, state.throttleDelay);

			video.addEventListener('ratechange', ratechangeHandler);
			state.cleanup.add(() => {
				video.removeEventListener('ratechange', ratechangeHandler);
			});

			// 현재 설정된 속도 적용
			if (state.currentSpeed !== 1.0) {
				video.playbackRate = state.currentSpeed;
			}

			state.initializedVideos.add(video);
		} catch (error) {
			console.error('Error initializing video element:', error);
		}
	}

	// 동적으로 추가되는 비디오 요소 감시
	function observeVideoElements() {
		if (state.videoObserver) {
			state.videoObserver.disconnect();
		}

		state.videoObserver = new MutationObserver((mutations) => {
			const hasNewVideos = mutations.some((mutation) => {
				return Array.from(mutation.addedNodes).some((node) => {
					return (
						node.nodeName === 'VIDEO' ||
						node.getElementsByTagName?.('video').length > 0
					);
				});
			});

			if (hasNewVideos) {
				debounce(initializeVideoElements, 100)();
			}
		});

		state.videoObserver.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});

		state.cleanup.add(() => {
			if (state.videoObserver) {
				state.videoObserver.disconnect();
				state.videoObserver = null;
			}
		});
	}

	// 사이트별 설정을 가져오고 적용하는 함수
	async function applySiteSettings() {
		try {
			if (state.autoSpeedApplied) {
				return; // 이미 적용된 경우 중복 적용 방지
			}

			const settings = await safeStorageAccess(() =>
				chrome.storage.sync.get('siteSettings')
			);
			const siteSettings = settings.siteSettings || {};
			const currentUrl = window.location.href;
			let appliedSpeed = null;

			// URL 패턴 매칭 검사
			for (const [pattern, setting] of Object.entries(siteSettings)) {
				const regex = new RegExp(pattern.replace(/\*/g, '.*'));
				if (regex.test(currentUrl) && setting.enabled) {
					appliedSpeed = parseFloat(setting.speed);
					break;
				}
			}

			// 속도 적용
			if (appliedSpeed !== null) {
				const videos = document.getElementsByTagName('video');
				for (const video of videos) {
					video.playbackRate = appliedSpeed;
				}
				state.currentSpeed = appliedSpeed;
				state.autoSpeedApplied = true;

				// MutationObserver 설정
				setupVideoSpeedObserver();
			}
		} catch (error) {
			console.error('Error applying site settings:', error);
		}
	}

	// 비디오 속도 감시 및 유지
	function setupVideoSpeedObserver() {
		if (state.videoSpeedObserver) {
			state.videoSpeedObserver.disconnect();
		}

		state.videoSpeedObserver = new MutationObserver((mutations) => {
			mutations.forEach((mutation) => {
				if (
					mutation.type === 'attributes' &&
					mutation.attributeName === 'playbackRate'
				) {
					const video = mutation.target;
					if (video.playbackRate !== state.currentSpeed) {
						video.playbackRate = state.currentSpeed;
					}
				}
			});
		});

		// 모든 비디오에 옵저버 적용
		const videos = document.getElementsByTagName('video');
		for (const video of videos) {
			state.videoSpeedObserver.observe(video, {
				attributes: true,
				attributeFilter: ['playbackRate'],
			});
		}
	}

	// 재초기화 큐 관리 함수 개선
	async function queueInitialization(attempt = 0) {
		// 이전 초기화로부터 최소 간격이 지나지 않았다면 무시
		const now = Date.now();
		if (now - state.lastInitializationAttempt < state.MIN_RETRY_INTERVAL) {
			return state.initializationQueue;
		}

		// 이미 진행 중인 초기화가 있다면 그것을 반환
		if (state.initializationQueue) {
			return state.initializationQueue;
		}

		state.lastInitializationAttempt = now;
		state.initializationQueue = (async () => {
			try {
				await reinitialize(attempt);
			} finally {
				state.initializationQueue = null;
			}
		})();

		return state.initializationQueue;
	}

	// 컨텍스트 복구 메커니즘 강화
	async function attemptContextRecovery() {
		if (state.recoveryInProgress) {
			return state.pendingRecovery;
		}

		const now = Date.now();
		if (
			now - state.lastRecoveryAttempt <
			state.contextRecoveryConfig.minDelay
		) {
			return state.pendingRecovery;
		}

		state.recoveryInProgress = true;
		state.lastRecoveryAttempt = now;
		let recoverySuccess = false;

		state.pendingRecovery = (async () => {
			try {
				let attempt = 0;
				const config = state.contextRecoveryConfig;

				while (attempt < config.maxAttempts && !recoverySuccess) {
					try {
						// DOM 상태 확인
						if (!document.documentElement) {
							await new Promise((resolve) => requestAnimationFrame(resolve));
							continue;
						}

						// Chrome 객체 초기화 대기
						if (typeof chrome === 'undefined') {
							await new Promise((resolve) =>
								setTimeout(
									resolve,
									config.minDelay * Math.pow(config.backoffFactor, attempt)
								)
							);
							attempt++;
							continue;
						}

						// Extension 컨텍스트 복구 시도
						const extensionReady = await validateExtensionContext(
							config.timeout
						);
						if (!extensionReady) {
							attempt++;
							if (attempt < config.maxAttempts) {
								await new Promise((resolve) =>
									setTimeout(
										resolve,
										config.minDelay * Math.pow(config.backoffFactor, attempt)
									)
								);
							}
							continue;
						}

						state.contextValid = true;
						recoverySuccess = true;
						return true;
					} catch (error) {
						console.warn(
							`Context recovery attempt ${attempt + 1} failed:`,
							error
						);
						attempt++;
						if (attempt < config.maxAttempts) {
							await new Promise((resolve) =>
								setTimeout(
									resolve,
									config.minDelay * Math.pow(config.backoffFactor, attempt)
								)
							);
						}
					}
				}

				return false;
			} finally {
				state.recoveryInProgress = false;
			}
		})();

		try {
			return await state.pendingRecovery;
		} finally {
			state.pendingRecovery = null;
		}
	}

	// 확장프로그램 컨텍스트 검증 함수 추가
	async function validateExtensionContext(timeout) {
		try {
			const result = await Promise.race([
				new Promise(async (resolve) => {
					try {
						// Runtime 가용성 체크
						if (!chrome.runtime || !chrome.runtime.id) {
							resolve(false);
							return;
						}

						// 메시지 전송 테스트
						chrome.runtime.sendMessage({ action: 'ping' }, (response) => {
							if (chrome.runtime.lastError) {
								resolve(false);
								return;
							}
							resolve(!!response?.success);
						});
					} catch {
						resolve(false);
					}
				}),
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error('Context validation timeout')),
						timeout
					)
				),
			]);

			return result;
		} catch {
			return false;
		}
	}

	// 컨텍스트 유효성 검사 함수 개선
	async function checkExtensionContext() {
		try {
			const now = Date.now();
			if (now - state.lastContextCheck < state.contextCheckInterval) {
				return state.contextValid;
			}

			state.lastContextCheck = now;

			// DOM 상태 확인
			if (!document.documentElement || document.readyState === 'loading') {
				return false;
			}

			// Chrome 객체 확인
			if (typeof chrome === 'undefined') {
				return false;
			}

			// Extension 컨텍스트 확인
			const isValid = await validateExtensionContext(1000);
			state.contextValid = isValid;
			return isValid;
		} catch (error) {
			console.warn('Context check failed:', error);
			return false;
		}
	}

	// 재초기화 로직 개선
	async function reinitialize(attempt = 0) {
		if (state.isInitializing) {
			console.warn('Reinitialization already in progress');
			return;
		}

		state.isInitializing = true;
		let success = false;

		try {
			// 컨텍스트 복구 시도
			let contextValid = await checkExtensionContext();
			if (!contextValid) {
				// 컨텍스트가 유효하지 않은 경우 복구 시도
				console.warn('Context invalid, attempting recovery...');
				contextValid = await attemptContextRecovery();

				if (!contextValid) {
					throw new Error('Extension context recovery failed');
				}
			}

			// 상태 초기화
			state.currentUrl = window.location.href;
			state.pageInitialized = false;
			state.initializedVideos.clear();
			state.retryCount = attempt;
			state.autoSpeedApplied = false;

			// 초기화 실행
			await initialize();
			success = true;
		} catch (error) {
			console.error(`Reinitialization attempt ${attempt + 1} failed:`, error);

			// 재시도 로직
			if (attempt < state.MAX_RETRIES) {
				const delay = Math.min(
					state.RETRY_DELAY * Math.pow(2, attempt),
					state.maxContextRecoveryTime
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
				state.isInitializing = false;
				return queueInitialization(attempt + 1);
			} else {
				console.error('Final reinitialization error:', error);
				resetState();
			}
		} finally {
			state.isInitializing = false;
			if (success) {
				// 성공한 경우에만 카운터 초기화
				state.retryCount = 0;
			}
		}
	}

	// 상태 초기화 함수 개선
	function resetState() {
		state.initializationLock = false;
		state.pageInitialized = false;
		state.initializedVideos.clear();
		state.retryCount = 0;
		state.initializationQueue = null;
		state.lastInitializationAttempt = 0;
		state.contextValid = false;
		state.recoveryInProgress = false;
		state.pendingRecovery = null;
		state.lastRecoveryAttempt = 0;
		state.pendingContextCheck = null;
	}

	// 디바운스 함수 추가
	function debounce(func, delay) {
		let timeoutId;
		return function (...args) {
			clearTimeout(timeoutId);
			timeoutId = setTimeout(() => func.apply(this, args), delay);
		};
	}

	// 쓰로틀 함수 추가
	function throttle(func, limit) {
		let inThrottle;
		return function (...args) {
			if (!inThrottle) {
				func.apply(this, args);
				inThrottle = true;
				setTimeout(() => (inThrottle = false), limit);
			}
		};
	}

	// URL 변경 핸들러 개선
	async function handleUrlChange() {
		const currentUrl = window.location.href;
		const now = Date.now();

		if (now - state.lastUrlCheck < state.urlCheckInterval) {
			return;
		}
		state.lastUrlCheck = now;

		if (currentUrl !== state.currentUrl) {
			let contextValid = false;
			let recoveryAttempts = 0;
			const maxRecoveryAttempts = 3;

			while (!contextValid && recoveryAttempts < maxRecoveryAttempts) {
				try {
					contextValid = await checkExtensionContext();
					if (!contextValid) {
						contextValid = await attemptContextRecovery();
					}

					if (contextValid) {
						state.currentUrl = currentUrl;
						state.autoSpeedApplied = false;
						await initWithRetry();
						break;
					}
				} catch (error) {
					console.warn(
						`URL change recovery attempt ${recoveryAttempts + 1} failed:`,
						error
					);
				}

				recoveryAttempts++;
				if (recoveryAttempts < maxRecoveryAttempts) {
					await new Promise((resolve) =>
						setTimeout(
							resolve,
							state.contextRecoveryConfig.minDelay *
								Math.pow(2, recoveryAttempts)
						)
					);
				}
			}

			if (!contextValid) {
				console.error('Failed to recover context after URL change');
				resetState();
			}
		}
	}

	// 메시지 핸들러 설정
	function setupMessageHandler() {
		try {
			chrome.runtime.onMessage.removeListener(handleMessage);
			chrome.runtime.onMessage.addListener(handleMessage);
		} catch (error) {
			console.warn('Failed to setup message handler:', error);
		}
	}

	function handleMessage(request, sender, sendResponse) {
		const processMessage = async () => {
			try {
				// 컨텍스트 확인
				const contextValid = await checkExtensionContext();
				if (!contextValid) {
					return { error: 'Extension context invalid' };
				}

				switch (request.action) {
					case 'ping':
						return { success: true };

					case 'initializeCheck':
						if (!state.pageInitialized) {
							await queueInitialization();
							await applySiteSettings();
							return { success: true };
						} else {
							return { success: true };
						}

					case 'setSpeed':
						if (!utils.isValidSpeed(request.speed)) {
							return { error: 'Invalid speed value' };
						}

						const videos = document.getElementsByTagName('video');
						if (videos.length === 0) {
							return { error: 'No video elements found' };
						}

						for (const video of videos) {
							video.playbackRate = request.speed;
						}
						state.currentSpeed = request.speed;
						return { success: true, speed: request.speed };

					case 'getSpeed':
						const firstVideo = document.querySelector('video');
						return {
							success: true,
							speed: firstVideo ? firstVideo.playbackRate : state.currentSpeed,
						};

					default:
						return { error: 'Unknown action' };
				}
			} catch (error) {
				console.error('Message handler error:', error);
				return { error: error.message };
			}
		};

		// 비동기 응답 처리
		processMessage().then(sendResponse);
		return true;
	}

	// Chrome storage 접근 함수 개선
	async function safeStorageAccess(operation) {
		try {
			if (!state.contextValid) {
				state.contextValid = await attemptContextRecovery();
				if (!state.contextValid) {
					throw new Error('Invalid extension context');
				}
			}
			return await operation();
		} catch (error) {
			console.error('Storage access error:', error);
			throw error;
		}
	}

	// 스토리지 상태 변경 감지 함수
	function setupStorageListener() {
		window.addEventListener('storage', async (event) => {
			try {
				if (!state.contextValid) {
					state.contextValid = await attemptContextRecovery();
					if (state.contextValid) {
						await initWithRetry();
					}
				}
			} catch (error) {
				console.error('Storage event handler error:', error);
			}
		});
	}

	// 쿠키 변경 감지 함수
	function setupCookieListener() {
		const originalCookie = Object.getOwnPropertyDescriptor(
			Document.prototype,
			'cookie'
		);

		// cookie 프로퍼티 재정의
		Object.defineProperty(document, 'cookie', {
			get: function () {
				return originalCookie.get.call(this);
			},
			set: async function (value) {
				const result = originalCookie.set.call(this, value);

				try {
					if (!state.contextValid) {
						state.contextValid = await attemptContextRecovery();
						if (state.contextValid) {
							await initWithRetry();
						}
					}
				} catch (error) {
					console.error('Cookie change handler error:', error);
				}

				return result;
			},
			configurable: true,
		});
	}

	// SPA 컨텍스트 클린업 이벤트 리스너 추가
	window.addEventListener('content-script-cleanup', () => {
		// 기존 리소스 정리
		if (state.videoObserver) {
			state.videoObserver.disconnect();
			state.videoObserver = null;
		}
		if (state.urlObserver) {
			state.urlObserver.disconnect();
			state.urlObserver = null;
		}

		// 이벤트 리스너 정리
		state.cleanup.forEach((cleanup) => cleanup());
		state.cleanup.clear();

		// 상태 초기화
		state.initializedVideos.clear();
		state.pageInitialized = false;
		state.autoSpeedApplied = false;
		state.contextValid = false;
	});

	// YouTube 페이지 타입 감지
	function detectYouTubePageType() {
		const url = window.location.href;
		if (url.includes('/watch?')) return 'watch';
		if (url.includes('/shorts/')) return 'shorts';
		if (url.includes('/playlist?')) return 'playlist';
		return 'browse';
	}

	// YouTube 비디오 ID 추출
	function getYouTubeVideoId() {
		const url = window.location.href;
		let videoId = null;

		if (url.includes('/watch?')) {
			const urlParams = new URLSearchParams(window.location.search);
			videoId = urlParams.get('v');
		} else if (url.includes('/shorts/')) {
			const matches = url.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
			videoId = matches ? matches[1] : null;
		}

		return videoId;
	}

	// YouTube 비디오 요소 감시 개선
	function setupYouTubeVideoObserver() {
		if (state.videoObserver) {
			state.videoObserver.disconnect();
		}

		// 비디오 컨테이너 찾기
		const targetNode =
			document.querySelector('#movie_player') || document.documentElement;

		const observerConfig = {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['src', 'playbackRate'],
		};

		state.videoObserver = new MutationObserver(async (mutations) => {
			try {
				const now = Date.now();
				if (
					now - youtubeState.lastVideoCheck <
					youtubeState.VIDEO_CHECK_DELAY
				) {
					return;
				}
				youtubeState.lastVideoCheck = now;

				const currentVideoId = getYouTubeVideoId();
				if (currentVideoId && currentVideoId !== youtubeState.lastVideoId) {
					youtubeState.lastVideoId = currentVideoId;

					// 컨텍스트 확인 및 복구
					const contextValid = await checkExtensionContext();
					if (!contextValid && !youtubeState.recoveryMode) {
						youtubeState.recoveryMode = true;
						const recovered = await attemptContextRecovery();
						youtubeState.recoveryMode = false;

						if (!recovered) {
							console.warn('Failed to recover context for new video');
							return;
						}
					}

					// 새 비디오에 설정 적용
					await initializeVideoElements();
					await applySiteSettings();
				}
			} catch (error) {
				console.error('Error in video observer:', error);
			}
		});

		state.videoObserver.observe(targetNode, observerConfig);
		state.cleanup.add(() => {
			if (state.videoObserver) {
				state.videoObserver.disconnect();
				state.videoObserver = null;
			}
		});
	}

	// YouTube 전용 초기화 로직 개선
	async function initializeYouTube() {
		try {
			// 페이지 타입 감지
			const currentPageType = detectYouTubePageType();
			if (currentPageType !== youtubeState.pageType) {
				youtubeState.pageType = currentPageType;
				youtubeState.lastVideoId = null;
			}

			// DOM 준비 대기
			if (document.readyState !== 'complete') {
				await new Promise((resolve) => {
					const check = () => {
						if (document.readyState === 'complete') {
							resolve();
						} else {
							requestAnimationFrame(check);
						}
					};
					check();
				});
			}

			// 컨텍스트 복구 시도
			let contextValid = await checkExtensionContext();
			if (!contextValid && !youtubeState.recoveryMode) {
				youtubeState.recoveryMode = true;
				contextValid = await attemptContextRecovery();
				youtubeState.recoveryMode = false;

				if (!contextValid) {
					throw new Error('Failed to recover YouTube context');
				}
			}

			// 네비게이션 카운터 증가
			youtubeState.navigationCounter++;

			// YouTube 전용 비디오 감시 설정
			setupYouTubeVideoObserver();

			// Shorts 페이지 특별 처리
			if (currentPageType === 'shorts') {
				if (!youtubeState.videoCheckInterval) {
					youtubeState.videoCheckInterval = setInterval(() => {
						const currentVideoId = getYouTubeVideoId();
						if (currentVideoId !== youtubeState.lastVideoId) {
							initializeVideoElements().catch(console.error);
						}
					}, youtubeState.VIDEO_CHECK_DELAY);

					state.cleanup.add(() => {
						if (youtubeState.videoCheckInterval) {
							clearInterval(youtubeState.videoCheckInterval);
							youtubeState.videoCheckInterval = null;
						}
					});
				}
			} else if (youtubeState.videoCheckInterval) {
				clearInterval(youtubeState.videoCheckInterval);
				youtubeState.videoCheckInterval = null;
			}

			// 초기화 완료 후 설정 적용
			await applySiteSettings();
			state.pageInitialized = true;
		} catch (error) {
			console.error('YouTube initialization failed:', error);
			throw error;
		}
	}

	// URL 변경 감지 로직 개선
	const urlChangeHandler = debounce(async () => {
		const currentUrl = window.location.href;
		if (currentUrl !== state.lastUrl) {
			state.lastUrl = currentUrl;
			state.pageInitialized = false;
			state.initializedVideos.clear();

			if (currentUrl.includes('youtube.com')) {
				await initializeYouTube().catch(console.error);
			} else {
				await queueInitialization().catch(console.error);
			}
		}
	}, state.urlChangeDebounceDelay);

	// MutationObserver 설정 개선
	const urlObserver = new MutationObserver((mutations) => {
		const shouldCheckUrl = mutations.some(
			(mutation) =>
				(mutation.type === 'childList' && mutation.addedNodes.length > 0) ||
				(mutation.type === 'attributes' &&
					(mutation.target.tagName === 'A' ||
						mutation.target === document.documentElement))
		);

		if (shouldCheckUrl) {
			urlChangeHandler();
		}
	});

	urlObserver.observe(document.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ['href'],
	});

	state.cleanup.add(() => urlObserver.disconnect());

	// 페이지 로드 시 초기화
	document.addEventListener('DOMContentLoaded', () => {
		queueInitialization().catch(console.error);
	});

	// history API 이벤트 리스너 추가
	window.addEventListener('popstate', handleUrlChange);
	window.addEventListener('pushState', handleUrlChange);
	window.addEventListener('replaceState', handleUrlChange);

	// history API 메소드 오버라이드
	const originalPushState = history.pushState;
	const originalReplaceState = history.replaceState;

	history.pushState = function (...args) {
		originalPushState.apply(this, args);
		handleUrlChange();
	};

	history.replaceState = function (...args) {
		originalReplaceState.apply(this, args);
		handleUrlChange();
	};

	// URL 체크 간격 설정
	setInterval(handleUrlChange, state.urlCheckInterval);

	// Chrome storage 변경 감지 개선
	if (chrome.storage && chrome.storage.onChanged) {
		chrome.storage.onChanged.addListener(async (changes, namespace) => {
			try {
				if (namespace === 'sync' && changes.siteSettings) {
					// 현재 진행 중인 초기화가 있다면 완료될 때까지 대기
					if (state.initializationQueue) {
						await state.initializationQueue;
					}
					await applySiteSettings();
				}
			} catch (error) {
				console.error('Error handling storage change:', error);
			}
		});
	} else {
		console.warn('chrome.storage.onChanged is not available. Skipping listener setup.');
	}

	// 실행
	initWithRetry().catch(console.error);
})();
