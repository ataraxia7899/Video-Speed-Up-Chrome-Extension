/**
 * Video Speed Controller - Main Content Script
 * 상태 관리, 연결 관리, 초기화 담당
 */

// 중복 실행 방지
if (!window.__videoSpeedControllerLoaded) {
	window.__videoSpeedControllerLoaded = true;

	// 전역 상태 객체 (다른 모듈에서 접근 가능)
	window.VSC = {
		state: {
			contextValid: false,
			currentSpeed: 1.0,
			initialized: false,
			cleanup: new Set(),
			initializedVideos: new WeakSet(),
			lastUrl: window.location.href,
			pendingSpeedUpdate: null,
			videoObserver: null,
			documentObserver: null,
			autoSpeedApplied: false,
			manualOverride: false,
			retryAttempts: 0,
			maxRetries: 5,
			retryDelay: 1000,
			initializationQueue: Promise.resolve(),
			youtubeConfig: {
				RETRY_INTERVAL: typeof VSC_CONSTANTS !== 'undefined' ? VSC_CONSTANTS.YOUTUBE_RETRY_INTERVAL : 50,
				MAX_RETRIES: typeof VSC_CONSTANTS !== 'undefined' ? VSC_CONSTANTS.YOUTUBE_MAX_RETRIES : 20,
				MUTATION_DEBOUNCE: typeof VSC_CONSTANTS !== 'undefined' ? VSC_CONSTANTS.YOUTUBE_MUTATION_DEBOUNCE : 150,
				isYouTube: window.location.hostname.includes('youtube.com'),
				lastSpeedUpdate: 0,
				updateDelay: 100,
				retryCount: 0,
				isShortsPage: false,
				shortsObserver: null,
				lastShortsVideoId: null,
				defaultSpeed: typeof VSC_CONSTANTS !== 'undefined' ? VSC_CONSTANTS.DEFAULT_SPEED : 1.0,
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
		},

		reconnectionState: {
			isReconnecting: false,
			lastErrorTime: 0,
			errorCount: 0,
			errorThreshold: 5000,
			maxErrorsInThreshold: 3,
			recoveryMode: false,
		},

		regexCache: new Map(),

		// 오류 로깅 함수 (프로덕션에서는 비활성화)
		throttledError: function() {
			// noop
		},

		// URL 패턴 매칭 (캐싱)
		matchUrlPatternCached: function(pattern, url) {
			try {
				let regex = this.regexCache.get(pattern);
				if (!regex) {
					const regexPattern = pattern
						.replace(/\./g, '\\.')
						.replace(/\*/g, '.*')
						.replace(/\//g, '\\/');
					regex = new RegExp(regexPattern);
					this.regexCache.set(pattern, regex);
				}
				return regex.test(url);
			} catch {
				return false;
			}
		},

		// 초기화 큐 관리
		queueInitialization: function(fn) {
			this.state.initializationQueue = this.state.initializationQueue
				.then(fn)
				.catch(() => {});
			return this.state.initializationQueue;
		},

		// 연결 관리
		establishConnection: async function() {
			if (this.reconnectionState.isReconnecting) {
				return false;
			}

			try {
				if (this.state.portConnection) {
					try {
						this.state.portConnection.disconnect();
					} catch {
						// 포트 이미 연결 해제됨
					}
				}

				this.state.portConnection = chrome.runtime.connect({
					name: 'videoSpeedController',
				});

				this.state.portConnection.onDisconnect.addListener(async () => {
					this.state.contextValid = false;
					this.state.portConnection = null;

					if (!this.reconnectionState.recoveryMode) {
						await this.handleDisconnect();
					}
				});

				this.state.portConnection.postMessage({ action: 'ping' });
				this.state.contextValid = true;
				this.state.connectionConfig.reconnectAttempts = 0;

				this.reconnectionState.isReconnecting = false;
				this.reconnectionState.recoveryMode = false;
				return true;
			} catch (error) {
				this.throttledError('Connection establishment failed:', error);
				return false;
			}
		},

		// 연결 해제 처리
		handleDisconnect: async function() {
			if (this.reconnectionState.isReconnecting) {
				return;
			}

			const config = this.state.connectionConfig;
			const now = Date.now();

			if (
				now - config.lastReconnectTime < config.minReconnectInterval ||
				config.reconnectAttempts >= config.maxReconnectAttempts
			) {
				return;
			}

			this.reconnectionState.isReconnecting = true;
			config.reconnectAttempts++;
			config.lastReconnectTime = now;

			try {
				const delay = Math.min(
					config.reconnectDelay * Math.pow(1.5, config.reconnectAttempts - 1),
					config.maxReconnectDelay
				);

				await new Promise((resolve) => setTimeout(resolve, delay));

				const success = await this.establishConnection();
				if (success) {
					await this.applySiteSettings(true);
				}
			} catch (error) {
				this.throttledError('Reconnection attempt failed:', error);
			} finally {
				this.reconnectionState.isReconnecting = false;
			}
		},

		// 컨텍스트 복구
		attemptRecovery: async function(force = false) {
			if (this.reconnectionState.isReconnecting && !force) {
				return false;
			}

			const config = this.state.connectionConfig;
			if (!force && config.reconnectAttempts >= config.maxReconnectAttempts) {
				return false;
			}

			this.reconnectionState.recoveryMode = true;

			try {
				const connected = await this.establishConnection();
				if (!connected) {
					return false;
				}

				const valid = await this.validateContext();
				if (valid) {
					this.state.contextValid = true;
					config.reconnectAttempts = 0;
					this.reconnectionState.recoveryMode = false;
					return true;
				}

				return false;
			} catch (error) {
				this.throttledError('Recovery attempt failed:', error);
				this.reconnectionState.recoveryMode = false;
				return false;
			}
		},

		// 컨텍스트 검증
		validateContext: async function() {
			try {
				if (!this.state.portConnection) {
					await this.establishConnection();
				}

				const response = await this.sendMessageWithTimeout(
					{ action: 'ping' },
					this.state.connectionConfig.connectionTimeout
				);

				return response?.success === true;
			} catch {
				return false;
			}
		},

		// 메시지 전송 (타임아웃 포함)
		sendMessageWithTimeout: async function(message, timeout) {
			return Promise.race([
				new Promise((resolve, reject) => {
					try {
						chrome.runtime.sendMessage(message, (response) => {
							if (chrome.runtime.lastError) {
								chrome.runtime.sendMessage({ action: 'reconnect' });
								reject(chrome.runtime.lastError);
							} else {
								resolve(response);
							}
						});
					} catch (e) {
						chrome.runtime.sendMessage({ action: 'reconnect' });
						reject(e);
					}
				}),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Message timeout')), timeout)
				),
			]);
		},

		// 사이트별 설정 적용
		applySiteSettings: async function(force = false) {
			if (this.state.manualOverride) {
				return false;
			}

			if (!this.state.contextValid && !force) {
				this.state.contextValid = await this.attemptRecovery();
				if (!this.state.contextValid) return false;
			}

			try {
				const result = await chrome.storage.sync.get(['siteSettings']);
				const siteSettings = result.siteSettings || {};
				const currentUrl = window.location.href;

				if (!force && currentUrl === this.state.lastUrl && this.state.autoSpeedApplied) {
					return true;
				}

				this.state.lastUrl = currentUrl;
				let settingApplied = false;

				for (const [pattern, setting] of Object.entries(siteSettings)) {
					const speed = typeof setting === 'object' ? setting.speed : setting;
					const enabled = typeof setting === 'object' ? setting.enabled : true;

					if (enabled && this.matchUrlPatternCached(pattern, currentUrl)) {
						this.state.currentSpeed = speed;
						this.state.pendingSpeedUpdate = speed;

						const videos = document.getElementsByTagName('video');
						for (const video of videos) {
							video.playbackRate = speed;
						}

						settingApplied = true;
						break;
					}
				}

				this.state.autoSpeedApplied = settingApplied;
				return settingApplied;
			} catch {
				return false;
			}
		},

		// 재연결 시도
		tryReconnect: async function() {
			if (this.reconnectionState.isReconnecting) {
				return;
			}

			this.reconnectionState.isReconnecting = true;
			try {
				await chrome.runtime.sendMessage({ action: 'reloadContentScript' });
				await new Promise((resolve) => setTimeout(resolve, 500));
				await this.attemptRecovery(true);
			} catch (error) {
				this.throttledError('Reconnection failed:', error);
			} finally {
				this.reconnectionState.isReconnecting = false;
			}
		},

		// 빠른 초기화
		quickInit: async function() {
			if (this.state.manualOverride) {
				return;
			}

			const videos = document.getElementsByTagName('video');
			if (videos.length > 0) {
				chrome.storage.sync.get(['siteSettings'], (result) => {
					if (chrome.runtime.lastError) return;
					if (this.state.manualOverride) return;

					const siteSettings = result.siteSettings || {};
					const currentUrl = window.location.href;
					let matchFound = false;

					for (const [pattern, setting] of Object.entries(siteSettings)) {
						const speed = typeof setting === 'object' ? setting.speed : setting;
						const enabled = typeof setting === 'object' ? setting.enabled : true;

						if (enabled && this.matchUrlPatternCached(pattern, currentUrl)) {
							for (const video of videos) {
								video.playbackRate = speed;
							}
							this.state.currentSpeed = speed;
							this.state.autoSpeedApplied = true;
							matchFound = true;
							break;
						}
					}

					if (!matchFound) {
						this.state.autoSpeedApplied = false;
					}
				});
			}
		},
	};

	// 메시지 핸들러
	chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
		const handleMessage = async () => {
			try {
				switch (request.action) {
					case 'ping':
						return { success: true };

					case 'cleanup':
						VSC.state.cleanup.forEach((cleanup) => cleanup());
						return { success: true };

					case 'toggleSpeedInput':
					case 'showSpeedInput':
					case 'toggleSpeedPopup':
						if (!VSC.state.contextValid) {
							const recovered = await VSC.attemptRecovery(true);
							if (!recovered) {
								throw new Error('Failed to recover context');
							}
						}
						if (typeof showSpeedInputPopup === 'function') {
							showSpeedInputPopup();
						}
						return { success: true };

					case 'getCurrentSpeed':
						const video = document.querySelector('video');
						const speed = video ? video.playbackRate : VSC.state.currentSpeed;
						return { success: true, speed };

					case 'setSpeed':
						if (
							typeof request.speed === 'number' &&
							request.speed >= 0.1 &&
							request.speed <= 16
						) {
							VSC.state.manualOverride = true;
							VSC.state.pendingSpeedUpdate = request.speed;
							if (typeof applySpeedToAllVideos === 'function') {
								const success = await applySpeedToAllVideos(request.speed);
								return { success, speed: request.speed };
							}
							return { success: false, error: 'Function not available' };
						}
						return { success: false, error: 'Invalid speed value' };

					case 'initializeCheck':
						return { success: VSC.state.initialized };

					default:
						return { error: 'Unknown action' };
				}
			} catch (error) {
				return { error: error.message };
			}
		};

		handleMessage().then(sendResponse);
		return true;
	});
}
