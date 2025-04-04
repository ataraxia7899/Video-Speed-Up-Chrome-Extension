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
	};

	function log(...args) {
		if (BackgroundController.DEBUG) {
			console.log('[Background]', new Date().toISOString(), ...args);
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
			await verifyTabContext(tabId);
			BackgroundController.activeTabsRegistry.get(tabId).initialized = true;
		} catch (error) {
			log(`Tab ${tabId} initialization failed:`, error);
			throw error;
		}
	}

	// Content Script 주입 함수 개선
	async function injectContentScript(tabId, url) {
		try {
			if (!url || url.startsWith('chrome://') || url.startsWith('edge://')) {
				return false;
			}

			try {
				await chrome.tabs.sendMessage(tabId, { action: 'cleanup' });
			} catch {}

			await new Promise(resolve => setTimeout(resolve, 50));

			await chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js']
			});

			const response = await new Promise((resolve) => {
				const checkScript = () => {
					chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
						if (chrome.runtime.lastError) {
							setTimeout(checkScript, 50);
						} else {
							resolve(response?.success);
						}
					});
				};
				checkScript();
				setTimeout(() => resolve(false), 2000);
			});

			return response === true;
		} catch (error) {
			throttledLog('error', `Failed to inject content script in tab ${tabId}:`, error);
			return false;
		}
	}

	// 인젝션 락 관리 함수
	async function acquireInjectionLock(tabId) {
		if (BackgroundController.injectionLocks.get(tabId)) {
			return false;
		}
		BackgroundController.injectionLocks.set(tabId, true);
		return true;
	}

	function releaseInjectionLock(tabId) {
		BackgroundController.injectionLocks.delete(tabId);
	}

	// Content Script 재주입 큐 관리
	async function queueContentScriptInjection(tabId) {
		const queue =
			BackgroundController.injectionQueue.get(tabId) || Promise.resolve();

		const newQueue = queue.then(async () => {
			if (!(await acquireInjectionLock(tabId))) {
				return;
			}

			try {
				await reinjectContentScript(tabId);
			} finally {
				releaseInjectionLock(tabId);
			}
		});

		BackgroundController.injectionQueue.set(tabId, newQueue);
		return newQueue;
	}

	// Content Script 재주입 최적화
	async function reinjectContentScript(tabId) {
		const pageState = BackgroundController.pageStates.get(tabId) || {
			injectionAttempts: 0,
			lastInjectionTime: 0,
			recoveryTimeout: null,
		};

		try {
			const now = Date.now();
			if (
				now - pageState.lastInjectionTime <
				BackgroundController.youtubeConfig.MIN_REINJECT_INTERVAL
			) {
				return;
			}

			if (pageState.recoveryTimeout) {
				clearTimeout(pageState.recoveryTimeout);
				pageState.recoveryTimeout = null;
			}

			await chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js'],
			});

			pageState.injectionAttempts = 0;
			pageState.lastInjectionTime = now;
			BackgroundController.pageStates.set(tabId, pageState);

			return true;
		} catch (error) {
			throttledLog(
				'error',
				`Content script injection failed for tab ${tabId}:`,
				error
			);

			pageState.injectionAttempts++;
			if (
				pageState.injectionAttempts <
				BackgroundController.recoveryConfig.MAX_ATTEMPTS
			) {
				const delay = Math.min(
					BackgroundController.recoveryConfig.BASE_DELAY *
						Math.pow(1.5, pageState.injectionAttempts),
					BackgroundController.recoveryConfig.MAX_DELAY
				);

				pageState.recoveryTimeout = setTimeout(() => {
					pageState.recoveryTimeout = null;
					queueContentScriptInjection(tabId).catch((error) =>
						throttledLog('error', 'Queued injection failed:', error)
					);
				}, delay);
			} else {
				resetTabState(tabId);
			}

			return false;
		}
	}

	// 탭 컨텍스트 검증 함수 추가
	async function verifyTabContext(tabId) {
		const response = await sendMessageWithRetry(tabId, { action: 'ping' }, 0);
		return response?.success === true;
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

	// 포트 연결 관리 개선
	let ports = new Map();
	let portReconnectTimeouts = new Map();

	chrome.runtime.onConnect.addListener((port) => {
		if (port.name === 'videoSpeedController') {
			const tabId = port.sender?.tab?.id;
			if (tabId) {
				if (portReconnectTimeouts.has(tabId)) {
					clearTimeout(portReconnectTimeouts.get(tabId));
					portReconnectTimeouts.delete(tabId);
				}

				ports.set(tabId, port);

				port.onMessage.addListener((msg) => {
					if (msg.action === 'ping') {
						port.postMessage({ success: true });
					}
				});

				port.onDisconnect.addListener(() => {
					ports.delete(tabId);

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

		if (ports.has(tabId)) {
			try {
				ports.get(tabId).disconnect();
			} catch {}
			ports.delete(tabId);
		}

		resetTabState(tabId);
	}

	// 탭 제거 핸들러 개선
	chrome.tabs.onRemoved.addListener((tabId) => {
		cleanupTab(tabId);
	});

	// 탭 업데이트 핸들러 개선
	chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
			return;
		}

		if (changeInfo.status === 'complete') {
			try {
				cleanupTab(tabId);
				await chrome.scripting.executeScript({
					target: { tabId },
					files: ['content.js'],
				});
			} catch (error) {
				throttledLog('error', 'Tab update handler error:', error);
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
				await new Promise(resolve => setTimeout(resolve, 500));
				await injectContentScript(tabId, url);
			} catch (error) {
				throttledLog('error', 'Navigation handler error:', error);
			}
		};

		chrome.webNavigation.onCommitted.addListener(handleNavigation);
		chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);
	}

	// 메시지 핸들러
	chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
		if (request.action === 'reloadContentScript') {
			const tabId = sender.tab?.id;
			if (tabId) {
				chrome.scripting.executeScript({
					target: { tabId },
					files: ['content.js']
				}).catch(error => {
					console.error('Content script reload failed:', error);
				});
			}
			sendResponse({ success: true });
			return true;
		}
		
		if (request.action === 'ping') {
			sendResponse({ success: true });
			return true;
		}
	});

	// 컨텍스트 복구 함수
	async function tryReconnect(tabId) {
		try {
			const tab = await chrome.tabs.get(tabId);
			if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
				return;
			}

			cleanupTab(tabId);

			await chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js']
			});
		} catch (error) {
			throttledLog('error', `Failed to reconnect to tab ${tabId}:`, error);
		}
	}

	// 확장 프로그램 설치/업데이트 핸들러 개선
	chrome.runtime.onInstalled.addListener(async (details) => {
		log('Extension event:', details.reason);

		if (details.reason === 'install') {
			const defaultSettings = {
				speedPopupShortcut: 'Ctrl + .',
				siteSettings: {},
				version: chrome.runtime.getManifest().version,
			};

			chrome.storage.sync.set(defaultSettings, () => {
				log('Default settings initialized');
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
				url: ['http://*/*', 'https://*/*']
			});

			for (const tab of tabs) {
				if (tab.id) {
					cleanupTab(tab.id);
					await new Promise(resolve => setTimeout(resolve, 100));
					await injectContentScript(tab.id, tab.url);
				}
			}
		} catch (error) {
			throttledLog('error', 'Error reinjecting content scripts:', error);
		}
	});

	// 단축키 명령어 처리 개선
	chrome.commands.onCommand.addListener(async (command) => {
		if (command !== 'toggle-speed-input') return;

		try {
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});

			if (!tab?.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
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
						await new Promise(resolve => setTimeout(resolve, 100));
					}

					return await chrome.tabs.sendMessage(tab.id, {
						action: 'toggleSpeedInput'
					});
				} catch (error) {
					if (retryCount < maxRetries) {
						retryCount++;
						await new Promise(resolve => setTimeout(resolve, retryDelay * retryCount));
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
})();
