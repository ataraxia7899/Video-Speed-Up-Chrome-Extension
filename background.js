(() => {
	const BackgroundController = {
		DEBUG: false,
		injectionTracker: new Map(),
		retryConfig: {
			MAX_RETRIES: 3,
			RETRY_DELAY: 1000,
			retryCount: new Map(),
			MAX_RECOVERY_ATTEMPTS: 3,
			RECOVERY_DELAY: 500,
		},
		urlTracker: new Map(),
		urlUpdateDelay: 500,
		recoveryConfig: {
			MAX_ATTEMPTS: 5,
			BASE_DELAY: 200,
			MAX_DELAY: 2000,
			TIMEOUT: 1000,
		},
		activeTabsRegistry: new Map(),
		navigationConfig: {
			YOUTUBE_PATTERNS: ['*://www.youtube.com/*', '*://youtube.com/*'],
			NAV_TIMEOUT: 2000,
			INIT_RETRY_DELAY: 500,
		},
		navigationStates: new Map(),
		pendingNavigations: new Map(),
		contextRecoveryConfig: {
			RECOVERY_MAX_ATTEMPTS: 3,
			RECOVERY_DELAY_BASE: 100,
			RECOVERY_DELAY_MAX: 2000,
			RECOVERY_TIMEOUT: 5000,
		},
		youtubeConfig: {
			URL_PATTERNS: ['*://www.youtube.com/*'],
			MIN_REINJECT_INTERVAL: 1000,
			NAVIGATION_DEBOUNCE: 150,
			SPA_LOAD_TIMEOUT: 2000,
		},
		pageStates: new Map(),
		recoveryTimeouts: new Map(),
		injectionQueue: new Map(),
		injectionLocks: new Map(),
		contextValidationConfig: {
			VALIDATION_INTERVAL: 1000,
			MAX_RETRIES: 3,
			RETRY_DELAY: 500,
			CONNECTION_TIMEOUT: 2000,
		},
		ports: new Map(),
		portStates: new Map(),
		debugMode: false,
		errorTracking: {
			lastError: 0,
			errorCount: 0,
			errorThreshold: 5000,
			maxErrorsInThreshold: 3,
		},
		// 상수 정의
		CONSTANTS: {
			CACHE_TTL: 5000,
			MAX_RETRIES: 3,
			RETRY_DELAY: 1000,
			CONNECTION_TIMEOUT: 5000,
			MESSAGE_TIMEOUT: 2000,
			STATUS_CHECK_INTERVAL: 5000,
		},
		storageCache: {
			cache: new Map(),
			timestamps: new Map(),
			TTL: 5000,
			pendingRequests: new Map(),
		},
	};

	// 전역 상태 관리 객체에 추가
	const injectionStates = new Map(); // tabId -> { isInjecting: boolean, isInjected: boolean }

	// Injection Lock 관리 함수
	async function acquireInjectionLock(tabId) {
		const lock = BackgroundController.injectionLocks.get(tabId);
		if (lock) {
			await lock;
		}
		let releaseLock;
		const newLock = new Promise(resolve => { releaseLock = resolve; });
		BackgroundController.injectionLocks.set(tabId, newLock);
		BackgroundController.injectionTracker.set(tabId, releaseLock);
		return true;
	}

	function releaseInjectionLock(tabId) {
		const release = BackgroundController.injectionTracker.get(tabId);
		if (release) {
			release();
			BackgroundController.injectionLocks.delete(tabId);
			BackgroundController.injectionTracker.delete(tabId);
		}
	}

	// 스토리지 캐시 관리 함수들
	const StorageCache = {
		async get(key) {
			const cache = BackgroundController.storageCache;
			const now = Date.now();

			// 캐시 히트 확인
			if (cache.cache.has(key)) {
				const timestamp = cache.timestamps.get(key);
				if (now - timestamp < cache.TTL) {
					return cache.cache.get(key);
				}
				// TTL 만료된 캐시 삭제
				cache.cache.delete(key);
				cache.timestamps.delete(key);
			}

			// 진행 중인 요청이 있다면 해당 Promise 반환
			if (cache.pendingRequests.has(key)) {
				return cache.pendingRequests.get(key);
			}

			// 새로운 요청 생성
			const promise = new Promise((resolve) => {
				chrome.storage.sync.get(key, (result) => {
					const value = result[key];
					cache.cache.set(key, value);
					cache.timestamps.set(key, now);
					cache.pendingRequests.delete(key);
					resolve(value);
				});
			});

			cache.pendingRequests.set(key, promise);
			return promise;
		},

		async set(key, value) {
			const cache = BackgroundController.storageCache;
			const now = Date.now();

			cache.cache.set(key, value);
			cache.timestamps.set(key, now);

			return new Promise((resolve) => {
				chrome.storage.sync.set({ [key]: value }, resolve);
			});
		},

		clear(key) {
			const cache = BackgroundController.storageCache;
			cache.cache.delete(key);
			cache.timestamps.delete(key);
			cache.pendingRequests.delete(key);
		},

		clearAll() {
			const cache = BackgroundController.storageCache;
			cache.cache.clear();
			cache.timestamps.clear();
			cache.pendingRequests.clear();
		},
	};

	// 기존 tabSpeedStates에 TTL 추가 - BackgroundController.CONSTANTS 사용
	const tabSpeedStates = {
		speeds: new Map(),
		timestamps: new Map(),
		TTL: BackgroundController.CONSTANTS.CACHE_TTL,

		set(tabId, speed) {
			this.speeds.set(tabId, speed);
			this.timestamps.set(tabId, Date.now());
		},

		get(tabId) {
			const timestamp = this.timestamps.get(tabId);
			if (timestamp && Date.now() - timestamp < this.TTL) {
				return this.speeds.get(tabId);
			}
			this.speeds.delete(tabId);
			this.timestamps.delete(tabId);
			return null;
		},

		clear(tabId) {
			this.speeds.delete(tabId);
			this.timestamps.delete(tabId);
		},
	};

	function log(...args) {
		if (BackgroundController.DEBUG) {
			// console.log('[Background]', new Date().toISOString(), ...args);
		}
	}

	// 오류 로깅 최적화
	function throttledLog(type, message, error = null) {
		if (!BackgroundController.debugMode && type === 'debug') {
			return;
		}

		const now = Date.now();
		const tracking = BackgroundController.errorTracking;

		if (now - tracking.lastError > tracking.errorThreshold) {
			tracking.errorCount = 0;
		}

		if (tracking.errorCount < tracking.maxErrorsInThreshold) {
			const timestamp = new Date().toISOString();
			if (error) {
				console[type](`[${timestamp}] ${message}`, error);
			} else {
				console[type](`[${timestamp}] ${message}`);
			}
			if (type === 'error') {
				tracking.errorCount++;
			}
		}

		if (type === 'error') {
			tracking.lastError = now;
		}
	}

	// 탭 등록 및 추적 함수 추가
	function registerTab(tabId) {
		if (!BackgroundController.activeTabsRegistry.has(tabId)) {
			BackgroundController.activeTabsRegistry.set(tabId, {
				initialized: false,
				recoveryAttempts: 0,
				lastRecoveryTime: 0,
			});
		}
	}

	// 탭 상태 초기화 함수 개선
	async function initializeTab(tabId) {
		const tabInfo = BackgroundController.activeTabsRegistry.get(tabId);
		if (!tabInfo) {
			registerTab(tabId);
		}

		try {
			await injectContentScript(tabId);
			const valid = await verifyTabContext(tabId);
			if (!valid) {
				log('컨텍스트 무효화 감지, 자동 복구 시도', tabId);
				await reinjectContentScript(tabId);
			}
			BackgroundController.activeTabsRegistry.get(tabId).initialized = true;
		} catch (error) {
			log(`Tab ${tabId} initialization failed:`, error);
			throw error;
		}
	}

	// Content Script 주입 큐 관리
	async function queueContentScriptInjection(tabId) {
		const queue = BackgroundController.injectionQueue;
		
		// 이미 큐에 있으면 스킵
		if (queue.has(tabId)) {
			return;
		}
		
		queue.set(tabId, true);
		
		try {
			await injectContentScript(tabId);
		} finally {
			queue.delete(tabId);
		}
	}

	// Content Script 주입 함수 개선
	async function injectContentScript(tabId, url) {
		if (!(await acquireInjectionLock(tabId))) {
			log('주입 락 획득 실패, 중복 주입 방지', tabId);
			return;
		}
		try {
			return await safeInjectContentScript(tabId, url);
		} finally {
			releaseInjectionLock(tabId);
		}
	}

	// 안전 주입 함수
	async function safeInjectContentScript(tabId, url) {
		const state = injectionStates.get(tabId) || {
			isInjecting: false,
			isInjected: false,
		};
		if (state.isInjecting || state.isInjected) {
			log('이미 주입 중이거나 완료됨', tabId);
			return;
		}
		state.isInjecting = true;
		injectionStates.set(tabId, state);
		try {
			await chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js'],
			});
			state.isInjected = true;
			log('Content Script 주입 성공', tabId);
		} catch (error) {
			// Chrome 웹 스토어 등 보호된 페이지에서는 에러 무시
			const ignoredPatterns = ['cannot be scripted', 'extensions gallery', 'chrome://'];
			const isIgnored = ignoredPatterns.some(p => error.message?.toLowerCase().includes(p.toLowerCase()));
			if (!isIgnored) {
				throttledLog('error', 'Content Script 주입 실패', error);
			}
		} finally {
			state.isInjecting = false;
			injectionStates.set(tabId, state);
		}
	}

	async function reinjectContentScript(tabId) {
		if (!(await acquireInjectionLock(tabId))) {
			log('재주입 락 획득 실패, 중복 방지', tabId);
			return;
		}
		try {
			const tab = await chrome.tabs.get(tabId);
			return await safeInjectContentScript(tabId, tab.url);
		} finally {
			releaseInjectionLock(tabId);
		}
	}

	// 탭 컨텍스트 검증 함수 추가
	async function verifyTabContext(tabId) {
		try {
			const response = await sendMessageWithRetry(tabId, { action: 'ping' }, 0);
			return response?.success === true;
		} catch (e) {
			// log('verifyTabContext: 컨텍스트 무효화 감지, 자동 복구 시도', tabId);
			// await reinjectContentScript(tabId);
			// return false;
		}
	}

	// 메시지 전송 재시도 로직 개선
	async function sendMessageWithRetry(tabId, message, attempt = 0) {
		const config = BackgroundController.contextRecoveryConfig;
		const maxAttempts = config.RECOVERY_MAX_ATTEMPTS;

		while (attempt < maxAttempts) {
			try {
				return await Promise.race([
					new Promise((resolve, reject) => {
						chrome.tabs.sendMessage(tabId, message, (response) => {
							if (chrome.runtime.lastError) {
								reject(new Error(chrome.runtime.lastError.message));
								return;
							}
							resolve(response);
						});
					}),
					new Promise((_, reject) =>
						setTimeout(
							() => reject(new Error('Message timeout')),
							config.RECOVERY_TIMEOUT
						)
					),
				]);
			} catch (error) {
				console.warn(`Message retry attempt ${attempt + 1} failed:`, error);

				if (attempt < maxAttempts - 1) {
					const delay = Math.min(
						config.RECOVERY_DELAY_BASE * Math.pow(2, attempt),
						config.RECOVERY_DELAY_MAX
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					attempt++;
				} else {
					throw error;
				}
			}
		}
	}

	// YouTube URL 검사 함수 개선
	function isYouTubeUrl(url) {
		return BackgroundController.youtubeConfig.URL_PATTERNS.some((pattern) => {
			const regex = new RegExp(pattern.replace(/\*/g, '.*'));
			return regex.test(url);
		});
	}

	// YouTube 네비게이션 핸들러 개선
	async function handleYouTubeNavigation(details) {
		const { tabId, url, frameId } = details;

		if (frameId !== 0 || !isYouTubeUrl(url)) return;

		try {
			await queueContentScriptInjection(tabId);
		} catch (error) {
			console.error('YouTube navigation handler error:', error);
		}
	}

	// 탭 상태 초기화 함수 개선
	function resetTabState(tabId) {
		const pageState = BackgroundController.pageStates.get(tabId);
		if (pageState?.recoveryTimeout) {
			clearTimeout(pageState.recoveryTimeout);
		}

		BackgroundController.pageStates.delete(tabId);
		BackgroundController.injectionQueue.delete(tabId);
		BackgroundController.injectionLocks.delete(tabId);
		BackgroundController.recoveryTimeouts.delete(tabId);
		BackgroundController.injectionTracker.delete(tabId);
		BackgroundController.urlTracker.delete(tabId);
		BackgroundController.activeTabsRegistry.delete(tabId);
		BackgroundController.navigationStates.delete(tabId);
		BackgroundController.ports.delete(tabId);
		BackgroundController.portStates.delete(tabId);
	}

	// 포트 연결 관리 개선 - BackgroundController.ports 사용
	const portReconnectTimeouts = new Map();

	chrome.runtime.onConnect.addListener((port) => {
		if (port.name === 'videoSpeedController') {
			const tabId = port.sender?.tab?.id;
			if (tabId) {
				if (portReconnectTimeouts.has(tabId)) {
					clearTimeout(portReconnectTimeouts.get(tabId));
					portReconnectTimeouts.delete(tabId);
				}

				// BackgroundController.ports 사용
				BackgroundController.ports.set(tabId, port);

				port.onMessage.addListener((msg) => {
					if (msg.action === 'ping') {
						port.postMessage({ success: true });
					}
				});

				port.onDisconnect.addListener(() => {
					BackgroundController.ports.delete(tabId);

					const timeout = setTimeout(() => {
						tryReconnect(tabId);
						portReconnectTimeouts.delete(tabId);
					}, 1000);

					portReconnectTimeouts.set(tabId, timeout);
				});
			}
		}
	});

	// 탭 정리 함수 개선
	function cleanupTab(tabId) {
		if (portReconnectTimeouts.has(tabId)) {
			clearTimeout(portReconnectTimeouts.get(tabId));
			portReconnectTimeouts.delete(tabId);
		}

		if (BackgroundController.ports.has(tabId)) {
			try {
				BackgroundController.ports.get(tabId).disconnect();
			} catch (e) {
				throttledLog('debug', 'Port disconnect during cleanup', e);
			}
			BackgroundController.ports.delete(tabId);
		}

		resetTabState(tabId);

		// 탭 관련 캐시 정리
		tabSpeedStates.clear(tabId);
		StorageCache.clear(`tab_${tabId}_speed`);
	}

	// 탭 제거 핸들러 개선
	chrome.tabs.onRemoved.addListener((tabId) => {
		injectionStates.delete(tabId);
		cleanupTab(tabId);
	});

	// 탭 업데이트 핸들러 개선
	chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		if (changeInfo.status === 'complete') {
			const valid = await verifyTabContext(tabId);
			if (!valid) {
				// log('onUpdated: 컨텍스트 무효화 감지, 자동 복구 시도', tabId);
				await reinjectContentScript(tabId);
			}
		}
	});

	// 웹 네비게이션 이벤트 리스너 개선
	if (chrome.webNavigation) {
		const handleNavigation = async (details) => {
			const { tabId, url, frameId } = details;

			if (frameId !== 0) return;

			try {
				cleanupTab(tabId);
				await new Promise((resolve) => setTimeout(resolve, 500));
				await safeInjectContentScript(tabId, url);
			} catch (error) {
				// throttledLog('error', 'Navigation handler error:', error);
			}
		};

		chrome.webNavigation.onCommitted.addListener(handleNavigation);
		chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);
	}

	// 메시지 핸들러
	chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
		const handleMessage = async () => {
			const tabId = sender.tab?.id;

			switch (request.action) {
				case 'reloadContentScript':
					if (tabId) {
						try {
							await chrome.scripting.executeScript({
								target: { tabId },
								files: ['content.js'],
							});
							await applyTabSpeed(tabId);
							return { success: true };
						} catch (error) {
							console.error('Content script reload failed:', error);
							return { success: false, error: error.message };
						}
					}
					break;

				case 'setSpeed':
					if (tabId && typeof request.speed === 'number') {
						await saveTabSpeed(tabId, request.speed);
						return { success: true };
					}
					break;

				case 'getSpeed':
					if (tabId) {
						const speed = await loadTabSpeed(tabId);
						return { success: true, speed: speed || 1.0 };
					}
					break;

				case 'ping':
					return { success: true };
			}

			return { success: false };
		};

		handleMessage().then(sendResponse);
		return true;
	});

	// 컨텍스트 복구 함수
	async function tryReconnect(tabId) {
		if (!(await acquireInjectionLock(tabId))) {
			// log('tryReconnect: 락 획득 실패, 중복 방지', tabId);
			return;
		}
		try {
			await reinjectContentScript(tabId);
		} finally {
			releaseInjectionLock(tabId);
		}
	}

	// 확장 프로그램 설치/업데이트 핸들러 개선
	chrome.runtime.onInstalled.addListener(async (details) => {
		// log('Extension event:', details.reason);

		if (details.reason === 'install') {
			const defaultSettings = {
				speedPopupShortcut: 'Ctrl + .',
				siteSettings: {},
				version: chrome.runtime.getManifest().version,
			};

			chrome.storage.sync.set(defaultSettings, () => {
				// log('Default settings initialized');
			});
		} else if (details.reason === 'update') {
			chrome.storage.sync.get(null, (data) => {
				const updatedData = {
					...data,
					version: chrome.runtime.getManifest().version,
				};
				chrome.storage.sync.set(updatedData, () => {
					log(
						'Settings preserved after update. Version updated to:',
						chrome.runtime.getManifest().version
					);
				});
			});
		}

		try {
			const tabs = await chrome.tabs.query({
				url: ['http://*/*', 'https://*/*'],
			});

			for (const tab of tabs) {
				if (tab.id) {
					cleanupTab(tab.id);
					await new Promise((resolve) => setTimeout(resolve, 100));
					await injectContentScript(tab.id, tab.url);
				}
			}
		} catch (error) {
			// throttledLog('error', 'Error reinjecting content scripts:', error);
		}

		// 캐시 초기화
		StorageCache.clearAll();
	});

	// 단축키 명령어 처리 개선
	chrome.commands.onCommand.addListener(async (command) => {
		if (command !== 'toggle-speed-input') return;

		try {
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});

			if (
				!tab?.id ||
				!tab.url ||
				tab.url.startsWith('chrome://') ||
				tab.url.startsWith('edge://')
			) {
				return;
			}

			let retryCount = 0;
			const maxRetries = 3;
			const retryDelay = 100;

			const sendToggleMessage = async () => {
				try {
					const scriptInjected = await validateContentScript(tab.id);

					if (!scriptInjected) {
						await injectContentScript(tab.id, tab.url);
						await new Promise((resolve) => setTimeout(resolve, 100));
					}

					return await chrome.tabs.sendMessage(tab.id, {
						action: 'toggleSpeedInput',
					});
				} catch (error) {
					if (retryCount < maxRetries) {
						retryCount++;
						await new Promise((resolve) =>
							setTimeout(resolve, retryDelay * retryCount)
						);
						return sendToggleMessage();
					}
					throw error;
				}
			};

			await sendToggleMessage();
		} catch (error) {
			throttledLog('error', '단축키 처리 오류:', error);
		}
	});

	async function validateContentScript(tabId) {
		try {
			await chrome.tabs.sendMessage(tabId, { action: 'ping' });
			return true;
		} catch {
			return false;
		}
	}

	// Add context validation functions
	async function validateExtensionContext(tabId) {
		try {
			const port = BackgroundController.ports.get(tabId);
			if (!port) {
				return false;
			}

			const response = await sendMessageWithTimeout(
				tabId,
				{ action: 'ping' },
				BackgroundController.contextValidationConfig.CONNECTION_TIMEOUT
			);

			return response?.success === true;
		} catch {
			return false;
		}
	}

	// Add timeout wrapper for messages
	async function sendMessageWithTimeout(tabId, message, timeout) {
		return Promise.race([
			new Promise((resolve, reject) => {
				chrome.tabs.sendMessage(tabId, message, (response) => {
					if (chrome.runtime.lastError) {
						reject(chrome.runtime.lastError);
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

	// 탭별 배속 저장 함수 업데이트
	async function saveTabSpeed(tabId, speed) {
		if (!tabId || typeof speed !== 'number') return;

		tabSpeedStates.set(tabId, speed);
		await StorageCache.set(`tab_${tabId}_speed`, {
			speed,
			timestamp: Date.now(),
		});
	}

	// 탭별 배속 로드 함수 업데이트
	async function loadTabSpeed(tabId) {
		if (!tabId) return null;

		try {
			// 먼저 메모리 캐시 확인
			const cachedSpeed = tabSpeedStates.get(tabId);
			if (cachedSpeed !== null) {
				return cachedSpeed;
			}

			// 스토리지 캐시 확인
			const savedData = await StorageCache.get(`tab_${tabId}_speed`);
			if (savedData && typeof savedData.speed === 'number') {
				tabSpeedStates.set(tabId, savedData.speed);
				return savedData.speed;
			}
		} catch (error) {
			console.error('Error loading tab speed:', error);
		}
		return null;
	}

	// content.js 주입 후 배속 적용
	async function applyTabSpeed(tabId) {
		const speed = await loadTabSpeed(tabId);
		if (speed) {
			try {
				await chrome.tabs.sendMessage(tabId, {
					action: 'setSpeed',
					speed: speed,
				});
			} catch (error) {
				console.error('Error applying tab speed:', error);
			}
		}
	}

// 단축키 명령 리스너
chrome.commands.onCommand.addListener((command) => {
	console.log('[Background] Command received:', command);
	if (command === 'toggle-speed-input') {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			console.log('[Background] Active tab:', tabs[0]?.id, tabs[0]?.url);
			if (tabs[0]?.id) {
				chrome.tabs.sendMessage(tabs[0].id, { action: 'toggleSpeedPopup' })
					.then(() => console.log('[Background] Message sent successfully'))
					.catch(err => console.log('[Background] Message failed:', err));
			}
		});
	}
});
})();
