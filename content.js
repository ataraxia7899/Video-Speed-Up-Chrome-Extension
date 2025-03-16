// 단일 진입점으로 모든 코드를 IIFE로 감싸기
(() => {
	// 단일 상태 관리 객체
	const ExtensionController = {
		// 디버그 설정
		DEBUG: true,

		// 초기화 상태
		initialized: false,
		initializationInProgress: false,
		initPromise: null,

		// 재시도 관련
		retryCount: 0,
		MAX_RETRIES: 3,
		RETRY_DELAY: 1000,

		// 비디오 관련
		currentSpeed: 1.0,
		speedPopup: null,
		autoSpeedObserver: null,

		// 이벤트 관련
		eventListenersInitialized: false,
		keyHandlerInstalled: false,

		// 리소스 정리
		cleanup: new Set(),
	};

	function log(...args) {
		if (ExtensionController.DEBUG) {
			console.log('[Content]', new Date().toISOString(), ...args);
		}
	}

	// 컨텍스트 유효성 검사 함수
	function checkExtensionContext() {
		try {
			// 컨텍스트가 유효한지 확인
			chrome.runtime.getURL('');
			return true;
		} catch (error) {
			return false;
		}
	}

	// 통합된 초기화 함수
	async function initialize() {
		if (
			ExtensionController.initialized ||
			ExtensionController.initializationInProgress
		) {
			return ExtensionController.initialized;
		}

		if (ExtensionController.retryCount >= ExtensionController.MAX_RETRIES) {
			log('Max retry attempts reached');
			return false;
		}

		ExtensionController.initializationInProgress = true;

		try {
			log('Starting initialization...');

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

			ExtensionController.initialized = true;
			ExtensionController.initializationInProgress = false;
			log('Extension initialized successfully');
			return true;
		} catch (error) {
			log('Initialization error:', error);
			ExtensionController.retryCount++;
			ExtensionController.initializationInProgress = false;

			// 컨텍스트가 무효화된 경우 재시도
			if (error.message.includes('Extension context invalidated')) {
				cleanupResources();
				const delay =
					ExtensionController.RETRY_DELAY * ExtensionController.retryCount;
				setTimeout(() => initialize(), delay);
				return false;
			}

			throw error;
		}
	}

	// 리소스 정리 함수
	function cleanupResources() {
		ExtensionController.cleanup.forEach((cleanup) => cleanup());
		ExtensionController.cleanup.clear();

		if (ExtensionController.speedPopup) {
			ExtensionController.speedPopup.remove();
			ExtensionController.speedPopup = null;
		}

		if (ExtensionController.autoSpeedObserver) {
			ExtensionController.autoSpeedObserver.disconnect();
			ExtensionController.autoSpeedObserver = null;
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
		log('Videos found:', videos.length);
		return videos;
	}

	// 비디오 속도 설정 함수
	function setVideoSpeed(speed) {
		log('setVideoSpeed called with:', speed);
		if (!isValidSpeed(speed)) {
			return {
				success: false,
				speed: ExtensionController.currentSpeed,
				error: 'Invalid speed',
			};
		}

		const videos = findVideoElements();
		if (videos.length === 0) {
			return {
				success: false,
				speed: ExtensionController.currentSpeed,
				error: 'No videos found',
			};
		}

		try {
			const validSpeed = Math.min(Math.max(parseFloat(speed), 0.1), 16);
			videos.forEach((video) => (video.playbackRate = validSpeed));
			ExtensionController.currentSpeed = validSpeed;

			log('Speed set successfully:', validSpeed);
			return { success: true, speed: validSpeed };
		} catch (error) {
			log('Error setting video speed:', error);
			return {
				success: false,
				speed: ExtensionController.currentSpeed,
				error: error.message,
			};
		}
	}

	function isValidSpeed(speed) {
		const parsedSpeed = parseFloat(speed);
		return !isNaN(parsedSpeed) && parsedSpeed >= 0.1 && parsedSpeed <= 16;
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
				log('Chrome runtime API not available');
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
			log('Message listener initialized successfully');
		} catch (error) {
			log('Error initializing message listener:', error);
			setTimeout(initializeMessageListener, 1000);
		}
	}

	// 메시지 핸들러 함수
	function messageHandler(request, sender, sendResponse) {
		log('Message received:', request);

		try {
			switch (request.action) {
				case 'setSpeed': {
					log('Setting video speed to:', request.speed);
					const result = setVideoSpeed(request.speed);
					log('Set speed result:', result);
					sendResponse(result);
					break;
				}
				case 'getSpeed': {
					const videos = findVideoElements();
					const speed =
						videos.length > 0
							? videos[0].playbackRate
							: ExtensionController.currentSpeed;
					log('Current speed:', speed);
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
			log('Error in message handler:', error);
			sendResponse({
				success: false,
				speed: ExtensionController.currentSpeed,
				error: error.message,
			});
		}
		return true;
	}

	// handleSpeedPopup 함수
	function handleSpeedPopup() {
		log('Attempting to show popup');
		try {
			if (!document.body) {
				log('Document body not ready');
				return;
			}

			// 기존 팝업 제거
			if (ExtensionController.speedPopup) {
				ExtensionController.speedPopup.remove();
				ExtensionController.speedPopup = null;
			}

			// 새 팝업 생성
			ExtensionController.speedPopup = createSpeedPopup();
			document.body.appendChild(ExtensionController.speedPopup);

			// 현재 비디오 속도
			const videos = findVideoElements();
			const speed = videos.length > 0 ? videos[0].playbackRate : 1.0;

			ExtensionController.speedPopup.style.display = 'block';
			const input = ExtensionController.speedPopup.querySelector('input');
			if (input) {
				input.value = speed;
				input.select();
				input.focus();
			}
			log('Popup shown successfully');
		} catch (error) {
			log('Error showing popup:', error);
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
			log('Error injecting styles:', error);
		}
	}

	function createSpeedPopup() {
		const popup = document.createElement('div');
		popup.className = 'speed-popup';
		popup.innerHTML = `
            <span>재생 속도:</span>
            <input type="number" step="0.1" min="0.1" max="16" value="1.0">
            <button>적용</button>
        `;

		const input = popup.querySelector('input');
		const button = popup.querySelector('button');

		// 이벤트 핸들러
		const applySpeed = () => {
			const speed = parseFloat(input.value);
			if (isValidSpeed(speed)) {
				setVideoSpeed(speed);
				removePopup();
			}
		};

		const removePopup = () => {
			document.removeEventListener('click', handleOutsideClick);
			popup.remove();
			ExtensionController.speedPopup = null;
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
		// 이미 팝업이 표시중이거나 입력 필드인 경우 무시
		if (
			e.target.tagName === 'INPUT' ||
			e.target.tagName === 'TEXTAREA' ||
			(ExtensionController.speedPopup &&
				ExtensionController.speedPopup.contains(e.target))
		) {
			return;
		}

		const isPeriodKey = e.key === '.' || e.code === 'Period';

		if (e.ctrlKey && isPeriodKey) {
			e.preventDefault();
			e.stopPropagation();
			handleSpeedPopup();
		}
	}

	// 키보드 이벤트 리스너 설정
	function installKeyHandler() {
		if (ExtensionController.keyHandlerInstalled) {
			return;
		}

		window.addEventListener('keydown', handleKeyDown, true);
		ExtensionController.keyHandlerInstalled = true;
		ExtensionController.cleanup.add(() => {
			window.removeEventListener('keydown', handleKeyDown, true);
			ExtensionController.keyHandlerInstalled = false;
		});
	}

	// 이벤트 리스너 설정
	function setupEventListeners() {
		if (ExtensionController.eventListenersInitialized) {
			return;
		}

		// Chrome 런타임 오류 감지 및 처리
		if (chrome?.runtime?.onMessage) {
			const errorHandler = () => {
				if (chrome.runtime.lastError) {
					log('Runtime error detected, reinitializing...');
					ExtensionController.initialized = false;
					ExtensionController.retryCount = 0;
					initialize();
				}
				return true;
			};

			chrome.runtime.onMessage.addListener(errorHandler);
			ExtensionController.cleanup.add(() => {
				chrome.runtime.onMessage.removeListener(errorHandler);
			});
		}

		ExtensionController.eventListenersInitialized = true;
	}

	// DOM 변경 감지 초기화
	function initializeObserver() {
		if (ExtensionController.autoSpeedObserver) {
			return;
		}

		try {
			ExtensionController.autoSpeedObserver = new MutationObserver(
				(mutations) => {
					if (!checkExtensionContext()) return;

					const videoAdded = mutations.some((mutation) =>
						Array.from(mutation.addedNodes).some(
							(node) => node.nodeName === 'VIDEO'
						)
					);

					if (videoAdded) {
						setVideoSpeed(ExtensionController.currentSpeed);
					}
				}
			);

			ExtensionController.autoSpeedObserver.observe(document.body, {
				childList: true,
				subtree: true,
			});

			ExtensionController.cleanup.add(() => {
				if (ExtensionController.autoSpeedObserver) {
					ExtensionController.autoSpeedObserver.disconnect();
					ExtensionController.autoSpeedObserver = null;
				}
			});
		} catch (error) {
			log('Observer initialization error:', error);
		}
	}

	// 페이지 로드 시 자동 속도 설정
	function checkAndSetAutoSpeed() {
		chrome.storage.sync.get(['siteSettings'], (result) => {
			if (!result.siteSettings) return;

			const currentUrl = window.location.href;
			let matchedSpeed = null;

			// URL 패턴 확인 및 일치하는 속도 찾기
			Object.entries(result.siteSettings).forEach(([pattern, speed]) => {
				try {
					// *를 정규식으로 변환
					const regexPattern = pattern.replace(/\*/g, '.*');
					if (currentUrl.match(new RegExp(regexPattern))) {
						matchedSpeed = speed;
					}
				} catch (error) {
					log('Error matching URL pattern:', error);
				}
			});

			// 일치하는 패턴이 없으면 종료
			if (matchedSpeed === null) return;

			// 비디오 요소에 속도 적용 함수
			const applySpeedToVideos = () => {
				const videos = document.querySelectorAll('video');
				if (videos.length > 0) {
					videos.forEach((video) => {
						video.playbackRate = matchedSpeed;
					});
					log(`Applied auto speed ${matchedSpeed}x to ${videos.length} videos`);
					return true;
				}
				return false;
			};

			// 즉시 비디오 요소 찾기 시도
			if (applySpeedToVideos()) return;

			// 비디오 요소가 없으면 MutationObserver로 DOM 변화 감시
			const observer = new MutationObserver((mutations) => {
				if (applySpeedToVideos()) {
					observer.disconnect();
				}
			});

			// body 전체 변화 감시
			observer.observe(document.body, {
				childList: true,
				subtree: true,
			});

			// 30초 후에도 비디오를 찾지 못하면 observer 중지
			setTimeout(() => {
				observer.disconnect();
			}, 30000);
		});
	}

	// 초기 실행
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => initialize());
	} else {
		initialize();
	}
})();
