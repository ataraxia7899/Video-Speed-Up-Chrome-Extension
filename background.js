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
	};

	function log(...args) {
		if (BackgroundController.DEBUG) {
			console.log('[Background]', new Date().toISOString(), ...args);
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
	async function injectContentScript(tabId) {
		try {
			await chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js'],
			});
			return true;
		} catch (error) {
			log(`Failed to inject content script in tab ${tabId}:`, error);
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

	// Content Script 재주입 함수 개선
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

			// 이전 복구 타임아웃 취소
			if (pageState.recoveryTimeout) {
				clearTimeout(pageState.recoveryTimeout);
				pageState.recoveryTimeout = null;
			}

			// Content script 정리
			await chrome.scripting.executeScript({
				target: { tabId },
				function: () => {
					window.dispatchEvent(new Event('content-script-cleanup'));
				},
			});

			// 잠시 대기하여 정리 완료 보장
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Content script 주입
			await chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js'],
			});

			// 초기화 확인
			const response = await new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error('Initialization timeout')),
					5000
				);

				chrome.tabs.sendMessage(
					tabId,
					{ action: 'initializeCheck' },
					(response) => {
						clearTimeout(timeout);
						if (chrome.runtime.lastError) {
							reject(new Error(chrome.runtime.lastError.message));
							return;
						}
						resolve(response);
					}
				);
			});

			if (!response?.success) {
				throw new Error('Content script initialization failed');
			}

			// 성공적인 주입 후 상태 초기화
			pageState.injectionAttempts = 0;
			pageState.lastInjectionTime = now;
			BackgroundController.pageStates.set(tabId, pageState);

			return true;
		} catch (error) {
			console.error(`Content script injection failed for tab ${tabId}:`, error);

			pageState.injectionAttempts++;
			if (
				pageState.injectionAttempts <
				BackgroundController.recoveryConfig.MAX_ATTEMPTS
			) {
				const delay = Math.min(
					BackgroundController.recoveryConfig.BASE_DELAY *
						Math.pow(2, pageState.injectionAttempts),
					BackgroundController.recoveryConfig.MAX_DELAY
				);

				// 재시도 스케줄링
				pageState.recoveryTimeout = setTimeout(() => {
					pageState.recoveryTimeout = null;
					queueContentScriptInjection(tabId).catch(console.error);
				}, delay);
			} else {
				resetTabState(tabId);
			}

			throw error;
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
	}

	// 탭 업데이트 핸들러 개선
	chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		if (!tab?.id || !tab.url?.startsWith('http')) return;

		try {
			if (changeInfo.status === 'loading') {
				resetTabState(tabId);
			} else if (changeInfo.status === 'complete') {
				if (isYouTubeUrl(tab.url)) {
					await queueContentScriptInjection(tabId);
				}
			}
		} catch (error) {
			console.error('Tab update error:', error);
			resetTabState(tabId);
		}
	});

	// 탭 제거 핸들러
	chrome.tabs.onRemoved.addListener((tabId) => {
		resetTabState(tabId);
	});

	// 웹 네비게이션 이벤트 리스너
	chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
		if (isYouTubeUrl(details.url)) {
			handleYouTubeNavigation(details).catch(console.error);
		}
	});

	chrome.webNavigation.onCompleted.addListener((details) => {
		if (isYouTubeUrl(details.url)) {
			handleYouTubeNavigation(details).catch(console.error);
		}
	});

	// 메시지 리스너 개선
	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (!sender.tab?.id) {
			sendResponse({ error: 'Invalid sender' });
			return true;
		}

		const processMessage = async () => {
			try {
				switch (message.action) {
					case 'ping':
						return { success: true };

					case 'requestReinjection':
						await queueContentScriptInjection(sender.tab.id);
						return { success: true };

					default:
						return { error: 'Unknown action' };
				}
			} catch (error) {
				console.error('Message handler error:', error);
				return { error: error.message };
			}
		};

		processMessage().then(sendResponse);
		return true;
	});

	// 명령어 핸들러
	if (chrome.commands) {
		chrome.commands.onCommand.addListener(async (command) => {
			try {
				if (command === 'open-speed-popup') {
					const [tab] = await chrome.tabs.query({
						active: true,
						currentWindow: true,
					});

					if (!tab?.id || !tab.url?.startsWith('http')) {
						log('Invalid tab or unsupported URL');
						return;
					}

					await sendMessageWithRetry(tab.id, { action: 'openSpeedPopup' });
					log('Speed popup command processed');
				}
			} catch (error) {
				log('Command error:', error);
			}
		});
	}

	// 확장 프로그램 설치/업데이트 핸들러 개선
	chrome.runtime.onInstalled.addListener((details) => {
		log('Extension event:', details.reason);

		if (details.reason === 'install' || details.reason === 'update') {
			const defaultSettings = {
				speedPopupShortcut: 'Ctrl + .',
				siteSettings: {},
			};

			chrome.storage.sync.set(defaultSettings, () => {
				log('Default settings initialized');
			});

			// 활성 탭에서 콘텐츠 스크립트 재초기화
			chrome.tabs.query({ active: true }, (tabs) => {
				tabs.forEach((tab) => {
					if (tab.url?.startsWith('http')) {
						reinjectContentScript(tab.id).catch(console.error);
					}
				});
			});
		}
	});
})();
