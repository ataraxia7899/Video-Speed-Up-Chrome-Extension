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

	// 초기화 및 실행
	function init() {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', () => initialize());
		} else {
			initialize();
		}
	}

	// 통합된 초기화 함수
	async function initialize() {
		if (state.initialized || state.initializationInProgress) {
			return state.initialized;
		}

		if (state.retryCount >= state.MAX_RETRIES) {
			return false;
		}

		state.initializationInProgress = true;

		try {
			// 컨텍스트 유효성 검사
			if (!checkExtensionContext()) {
				throw new Error('Extension context invalidated');
			}

			// DOM 준비 대기
			if (document.readyState === 'loading') {
				await new Promise((resolve) =>
					document.addEventListener('DOMContentLoaded', resolve, { once: true })
				);
			}

			// 기능 초기화
			await injectStyles();
			setupEventListeners();
			initializeMessageListener();
			installKeyHandler();
			checkAndSetAutoSpeed();
			initializeObserver();

			state.initialized = true;
			state.initializationInProgress = false;
			return true;
		} catch (error) {
			console.error('Initialization error:', error); // utils.log 대신 console.error 사용
			state.retryCount++;
			state.initializationInProgress = false;

			// 컨텍스트가 무효화된 경우 재시도
			if (error.message.includes('Extension context invalidated')) {
				cleanupResources();
				const delay = state.RETRY_DELAY * state.retryCount;
				setTimeout(() => initialize(), delay);
				return false;
			}

			throw error;
		}
	}

	// 리소스 정리 함수
	function cleanupResources() {
		state.cleanup.forEach((cleanup) => cleanup());
		state.cleanup.clear();

		if (state.speedPopup) {
			state.speedPopup.remove();
			state.speedPopup = null;
		}

		if (state.autoSpeedObserver) {
			state.autoSpeedObserver.disconnect();
			state.autoSpeedObserver = null;
		}

		// 이벤트 리스너 정리
		cleanupEventListeners();
	}

	// 이벤트 리스너 정리
	function cleanupEventListeners() {
		// 기존 메시지 리스너 제거
		if (chrome?.runtime?.onMessage?.hasListeners()) {
			chrome.runtime.onMessage.removeListener(messageHandler);
		}

		// 키보드 이벤트 리스너 제거
		window.removeEventListener('keydown', handleKeyDown);
	}

	// 비디오 요소 찾기 함수
	function findVideoElements() {
		const videos = Array.from(document.getElementsByTagName('video'));
		utils.log('Videos found:', videos.length);
		return videos;
	}

	// 비디오 속도 설정 함수
	function setVideoSpeed(speed) {
		utils.log('setVideoSpeed called with:', speed);
		if (!utils.isValidSpeed(speed)) {
			return {
				success: false,
				speed: state.currentSpeed,
				error: 'Invalid speed',
			};
		}

		const videos = findVideoElements();
		if (videos.length === 0) {
			return {
				success: false,
				speed: state.currentSpeed,
				error: 'No videos found',
			};
		}

		try {
			const validSpeed = Math.min(Math.max(parseFloat(speed), 0.1), 16);
			videos.forEach((video) => {
				video.setAttribute('user-modified-speed', validSpeed.toString());
				video.playbackRate = validSpeed;
			});
			state.currentSpeed = validSpeed;

			utils.log('Speed set successfully:', validSpeed);
			return { success: true, speed: validSpeed };
		} catch (error) {
			utils.log('Error setting video speed:', error);
			return {
				success: false,
				speed: state.currentSpeed,
				error: error.message,
			};
		}
	}

	// 메시지 리스너 초기화 함수
	function initializeMessageListener() {
		try {
			// chrome.runtime이 존재하는지, 그리고 onMessage 속성이 있는지 확인
			if (
				typeof chrome === 'undefined' ||
				!chrome.runtime ||
				!chrome.runtime.onMessage
			) {
				utils.log('Chrome runtime API not available');
				setTimeout(initializeMessageListener, 1000);
				return;
			}

			// 기존 리스너 제거
			if (
				chrome.runtime.onMessage.hasListeners &&
				chrome.runtime.onMessage.hasListeners()
			) {
				chrome.runtime.onMessage.removeListener(messageHandler);
			}

			// 새 리스너 등록
			chrome.runtime.onMessage.addListener(messageHandler);
			utils.log('Message listener initialized successfully');
		} catch (error) {
			utils.log('Error initializing message listener:', error);
			setTimeout(initializeMessageListener, 1000);
		}
	}

	// 메시지 핸들러 함수
	function messageHandler(request, sender, sendResponse) {
		utils.log('Message received:', request);

		try {
			switch (request.action) {
				case 'setSpeed': {
					utils.log('Setting video speed to:', request.speed);
					const result = setVideoSpeed(request.speed);
					utils.log('Set speed result:', result);
					sendResponse(result);
					break;
				}
				case 'getSpeed': {
					const videos = findVideoElements();
					const speed =
						videos.length > 0 ? videos[0].playbackRate : state.currentSpeed;
					utils.log('Current speed:', speed);
					sendResponse({ success: true, speed });
					break;
				}
				case 'openSpeedPopup':
					handleSpeedPopup();
					sendResponse({ success: true });
					break;
				case 'ping':
					// 단순히 content script가 로드되었는지 확인하기 위한 ping
					sendResponse({ success: true });
					break;
				default:
					sendResponse({ success: false, error: 'Unknown action' });
			}
		} catch (error) {
			utils.log('Error in message handler:', error);
			sendResponse({
				success: false,
				speed: state.currentSpeed,
				error: error.message,
			});
		}
		return true;
	}

	// handleSpeedPopup 함수
	function handleSpeedPopup() {
		utils.log('Attempting to show popup');
		try {
			if (!document.body) {
				utils.log('Document body not ready');
				return;
			}

			// 이미 팝업이 존재하는 경우 중복 생성 방지
			const existingPopup = document.querySelector('.speed-popup');
			if (existingPopup) {
				utils.log('Popup already exists');
				return;
			}

			// 새 팝업 생성
			const popup = createSpeedPopup();
			document.body.appendChild(popup);
			state.speedPopup = popup;

			// 현재 비디오 속도
			const videos = findVideoElements();
			const speed = videos.length > 0 ? videos[0].playbackRate : 1.0;

			popup.style.display = 'block';
			const input = popup.querySelector('input');
			if (input) {
				input.value = speed;
				input.select();
				input.focus();
			}
			utils.log('Popup shown successfully');
		} catch (error) {
			utils.log('Error showing popup:', error);
		}
	}

	// 팝업 스타일 생성
	function injectStyles() {
		try {
			// 이미 스타일이 있는지 확인
			if (document.getElementById('speed-controller-style')) {
				return;
			}

			const style = document.createElement('style');
			style.id = 'speed-controller-style';
			style.textContent = `
                .speed-popup {
                    position: fixed;
                    top: 20px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 15px 25px;
                    border-radius: 8px;
                    z-index: 999999;
                    display: none;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    backdrop-filter: blur(5px);
                    animation: slideDown 0.3s ease-out;
                }
                .speed-popup input {
                    width: 80px;
                    padding: 8px 12px;
                    border: none;
                    border-radius: 4px;
                    background: rgba(255, 255, 255, 0.2);
                    color: white;
                    text-align: center;
                    font-size: 16px;
                }
                .speed-popup input:focus {
                    outline: none;
                    background: rgba(255, 255, 255, 0.3);
                }
                .speed-popup button {
                    background: rgba(255, 255, 255, 0.2);
                    border: none;
                    color: white;
                    padding: 8px 15px;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                    transition: background-color 0.2s;
                }
                .speed-popup button:hover {
                    background: rgba(255, 255, 255, 0.3);
                }
                .speed-popup span {
                    font-size: 16px;
                    white-space: nowrap;
                }
                @keyframes slideDown {
                    from {
                        transform: translate(-50%, -100%);
                        opacity: 0;
                    }
                    to {
                        transform: translate(-50%, 0);
                        opacity: 1;
                    }
                }
            `;

			// head 요소가 준비될 때까지 대기
			if (document.head) {
				document.head.appendChild(style);
			} else {
				const waitForHead = setInterval(() => {
					if (document.head) {
						document.head.appendChild(style);
						clearInterval(waitForHead);
					}
				}, 10);

				// 10초 후에도 안되면 중단
				setTimeout(() => clearInterval(waitForHead), 10000);
			}
		} catch (error) {
			utils.log('Error injecting styles:', error);
		}
	}

	function createSpeedPopup() {
		const popup = document.createElement('div');
		popup.className = 'speed-popup';
		popup.innerHTML = `
            <span>${chrome.i18n.getMessage('currentSpeed')}</span>
            <input type="number" step="0.1" min="0.1" max="16" value="1.0">
            <button>${chrome.i18n.getMessage('apply')}</button>
        `;

		const input = popup.querySelector('input');
		const button = popup.querySelector('button');

		// 이벤트 핸들러
		const applySpeed = () => {
			const speed = parseFloat(input.value);
			if (utils.isValidSpeed(speed)) {
				setVideoSpeed(speed);
				removePopup();
			}
		};

		const removePopup = () => {
			document.removeEventListener('click', handleOutsideClick);
			popup.remove();
			state.speedPopup = null;
		};

		const handleOutsideClick = (e) => {
			if (!popup.contains(e.target)) {
				removePopup();
			}
		};

		button.onclick = applySpeed;

		// Enter 키 이벤트 처리
		input.onkeydown = (e) => {
			if (e.key === 'Enter' || e.key === 'NumpadEnter') {
				e.preventDefault();
				applySpeed();
			} else if (e.key === 'Escape') {
				removePopup();
			}
			e.stopPropagation();
		};

		// 팝업 외부 클릭 시 닫기
		document.addEventListener('click', handleOutsideClick);

		return popup;
	}

	// 키보드 이벤트 핸들러
	function handleKeyDown(e) {
		// 이벤트 버블링 방지를 위해 가장 먼저 체크
		if (document.querySelector('.speed-popup')) {
			return;
		}

		// 이미 팝업이 표시중이거나 입력 필드인 경우 무시
		if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
			return;
		}

		const isPeriodKey = e.key === '.' || e.code === 'Period';

		if (e.ctrlKey && isPeriodKey) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation(); // 이벤트 전파 완전 중지
			handleSpeedPopup();
		}
	}

	// 키보드 이벤트 리스너 설정
	function installKeyHandler() {
		if (state.keyHandlerInstalled) {
			return;
		}

		// 이벤트 캡처 단계에서 처리하여 다른 핸들러보다 먼저 실행
		window.addEventListener('keydown', handleKeyDown, {
			capture: true,
			passive: false,
		});

		state.keyHandlerInstalled = true;
		state.cleanup.add(() => {
			window.removeEventListener('keydown', handleKeyDown, { capture: true });
			state.keyHandlerInstalled = false;
		});
	}

	// URL 변경 감지 함수 수정
	function handleUrlChange(newUrl) {
		const now = Date.now();
		if (
			state.currentUrl === newUrl ||
			now - state.lastEventTime < state.throttleDelay
		)
			return;
		state.lastEventTime = now;

		try {
			if (!chrome?.runtime?.id) {
				throw new Error('Extension context invalidated');
			}

			state.currentUrl = newUrl;
			state.pageInitialized = false;
			state.initializedVideos = new Set();
			state.currentSpeed = 1.0; // 속도 초기화

			// 기존 비디오의 user-modified-speed 속성 제거
			document.querySelectorAll('video').forEach((video) => {
				video.removeAttribute('user-modified-speed');
			});

			utils.log('URL changed, reinitializing...', newUrl);

			// 지연된 초기화
			setTimeout(() => {
				if (chrome?.runtime?.id) {
					initialize();
				}
			}, 500);
		} catch (error) {
			console.error('Error in URL change handler:', error);
			resetState();
		}
	}

	// 상태 초기화 함수 수정
	function resetState() {
		try {
			// 기본 상태로 초기화
			state.initialized = false;
			state.initializationInProgress = false;
			state.retryCount = 0;
			state.pageInitialized = false;
			state.currentSpeed = 1.0;

			// Set 객체 재생성
			state.initializedVideos = new Set();

			// 모든 비디오의 user-modified-speed 속성 제거
			const videos = document.querySelectorAll('video');
			videos.forEach((video) => {
				try {
					video.removeAttribute('user-modified-speed');
				} catch (error) {
					utils.log('Error removing attribute from video:', error);
				}
			});

			// 리소스 정리
			cleanupResources();
			utils.log('State reset completed');
		} catch (error) {
			utils.log('Error in resetState:', error);
		}
	}

	// setupEventListeners 함수 수정
	function setupEventListeners() {
		if (state.eventListenersInitialized) return;

		try {
			// URL 변경 감지
			const urlObserver = new MutationObserver(
				debounce(() => {
					const currentUrl = window.location.href;
					if (state.currentUrl !== currentUrl) {
						handleUrlChange(currentUrl);
					}
				}, 250)
			);

			urlObserver.observe(document.body, {
				subtree: true,
				childList: true,
			});

			state.cleanup.add(() => urlObserver.disconnect());

			// Chrome 이벤트 리스너
			if (checkExtensionContext()) {
				const errorHandler = () => {
					if (chrome.runtime.lastError) {
						utils.log('Runtime error detected, reinitializing...');
						state.initialized = false;
						state.retryCount = 0;
						initialize();
					}
					return true;
				};

				chrome.runtime.onMessage.addListener(errorHandler);
				chrome.storage.onChanged.addListener((changes, namespace) => {
					if (namespace === 'sync' && changes.siteSettings) {
						utils.log('Site settings changed, updating...');
						requestAnimationFrame(() => checkAndSetAutoSpeed());
					}
				});

				state.cleanup.add(() => {
					chrome.runtime.onMessage.removeListener(errorHandler);
				});
			}

			state.eventListenersInitialized = true;
		} catch (error) {
			console.error('Error in setupEventListeners:', error);
		}
	}

	// DOM 변경 감지 초기화 함수 수정
	function initializeObserver() {
		if (state.autoSpeedObserver) {
			return;
		}

		try {
			let observerTimeout = null;
			state.autoSpeedObserver = new MutationObserver((mutations) => {
				if (observerTimeout) {
					clearTimeout(observerTimeout);
				}

				observerTimeout = setTimeout(() => {
					try {
						if (!chrome?.runtime?.id) return;

						const videoAdded = mutations.some((mutation) =>
							Array.from(mutation.addedNodes).some(
								(node) => node.nodeName === 'VIDEO'
							)
						);

						if (videoAdded) {
							if (!state.initializedVideos) {
								state.initializedVideos = new Set();
							}
							checkAndSetAutoSpeed();
						}
					} catch (error) {
						utils.log('Observer error:', error);
						if (error.message.includes('Extension context invalidated')) {
							resetState();
							setTimeout(() => initialize(), 1000);
						}
					}
				}, 100);
			});

			state.autoSpeedObserver.observe(document.body, {
				childList: true,
				subtree: true,
			});

			state.cleanup.add(() => {
				if (observerTimeout) {
					clearTimeout(observerTimeout);
				}
				if (state.autoSpeedObserver) {
					state.autoSpeedObserver.disconnect();
					state.autoSpeedObserver = null;
				}
			});
		} catch (error) {
			utils.log('Observer initialization error:', error);
		}
	}

	// 비디오 속도 설정 함수 수정
	function applySpeedToVideo(video, speed) {
		if (!video || !utils.isValidSpeed(speed)) return;

		try {
			if (!state.initializedVideos) {
				state.initializedVideos = new Set();
			}

			if (!state.initializedVideos.has(video)) {
				// 초기 속도 설정
				video.playbackRate = speed;
				state.initializedVideos.add(video);
				video.removeAttribute('user-modified-speed'); // 이전 수정 상태 제거

				// play 이벤트에서 속도 재설정 (한 번만)
				video.addEventListener(
					'play',
					() => {
						if (!video.hasAttribute('user-modified-speed')) {
							video.playbackRate = speed;
						}
					},
					{ once: true }
				);

				utils.log(`Successfully initialized video with speed: ${speed}`);
			}
		} catch (error) {
			utils.log('Error applying speed to video:', error);
		}
	}

	// 페이지 로드 시 자동 속도 설정
	function checkAndSetAutoSpeed() {
		if (!checkExtensionContext()) {
			utils.log('Extension context invalid, skipping auto speed setup');
			return;
		}

		try {
			chrome.storage.sync.get(['siteSettings'], (result) => {
				if (!result.siteSettings) {
					utils.log('No site settings found');
					return;
				}

				const currentUrl = window.location.href;
				utils.log('Checking auto speed for URL:', currentUrl);

				let matchedSpeed = null;
				let matchedPattern = null;

				// URL 패턴 확인 및 일치하는 속도 찾기
				Object.entries(result.siteSettings).forEach(([pattern, speed]) => {
					try {
						const regexPattern = pattern.replace(/\*/g, '.*');
						if (currentUrl.match(new RegExp(regexPattern))) {
							matchedSpeed = parseFloat(speed);
							matchedPattern = pattern;
						}
					} catch (error) {
						utils.log('Error matching URL pattern:', error);
					}
				});

				// 일치하는 패턴이 없으면 종료
				if (matchedSpeed === null) {
					utils.log('No matching pattern found for current URL');
					state.pageInitialized = true;
					return;
				}

				utils.log(
					`Found matching pattern: ${matchedPattern} with initial speed: ${matchedSpeed}x`
				);

				// 현재 존재하는 비디오 중 사용자가 수정하지 않은 비디오에만 적용
				document.querySelectorAll('video').forEach((video) => {
					if (
						!state.initializedVideos.has(video) &&
						!video.hasAttribute('user-modified-speed')
					) {
						applySpeedToVideo(video, matchedSpeed);
					}
				});

				state.pageInitialized = true;

				// 새로운 비디오 요소 감지
				if (!state.videoObserver) {
					state.videoObserver = new MutationObserver((mutations) => {
						mutations.forEach((mutation) => {
							mutation.addedNodes.forEach((node) => {
								if (node.nodeName === 'VIDEO') {
									// 약간의 지연을 주어 비디오 요소가 완전히 초기화되도록 함
									setTimeout(() => {
										applySpeedToVideo(node, matchedSpeed);
									}, 100);
								}
							});
						});
					});

					state.videoObserver.observe(document.body, {
						childList: true,
						subtree: true,
					});
				}

				// 기존 비디오에도 적용
				requestAnimationFrame(() => {
					document.querySelectorAll('video').forEach((video) => {
						if (!state.initializedVideos.has(video)) {
							applySpeedToVideo(video, matchedSpeed);
						}
					});
				});
			});
		} catch (error) {
			utils.log('Error in checkAndSetAutoSpeed:', error);
		}
	}

	// 컨텍스트 유효성 검사 함수 수정
	function checkExtensionContext() {
		try {
			// chrome.runtime.id가 존재하면 확장 프로그램이 활성 상태
			return Boolean(chrome?.runtime?.id);
		} catch (error) {
			utils.log('Extension context check failed:', error);
			return false;
		}
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

	// 실행
	init();
})();
