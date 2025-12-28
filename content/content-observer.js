/**
 * Video Speed Controller - Observer Module
 * 비디오 감지, 초기화, URL 변경 감시 담당
 */

(function() {
	// 메인 모듈 확인
	if (!window.VSC) {
		console.error('[VSC Observer] Main module not loaded');
		return;
	}

	const state = VSC.state;

	// 비디오 초기화 큐 관리
	const videoInitQueue = new Set();
	let processingQueue = false;

	// 비디오 초기화 함수
	async function initializeVideo(video) {
		if (!video || state.initializedVideos.has(video)) return;

		try {
			// 비디오가 감지되면 즉시 사이트 설정 확인 및 적용 (직접 storage 조회)
			// manualOverride가 아닐 때만 자동 설정 적용
			if (!state.manualOverride) {
				try {
					const result = await chrome.storage.sync.get(['siteSettings']);
					const siteSettings = result.siteSettings || {};
					const currentUrl = window.location.href;

					for (const [pattern, setting] of Object.entries(siteSettings)) {
						const speed = typeof setting === 'object' ? setting.speed : setting;
						const enabled = typeof setting === 'object' ? setting.enabled : true;
						
						if (enabled && VSC.matchUrlPatternCached(pattern, currentUrl)) {
							state.currentSpeed = speed;
							state.pendingSpeedUpdate = speed;
							state.autoSpeedApplied = true;
							video.playbackRate = speed;
							break;
						}
					}
				} catch {
					// storage 조회 실패 무시
				}
			}

			// 이벤트 리스너 등록 전에 현재 속도 적용
			if (state.pendingSpeedUpdate !== null) {
				video.playbackRate = state.pendingSpeedUpdate;
			} else if (state.currentSpeed !== 1.0) {
				video.playbackRate = state.currentSpeed;
			}

			// 현재 속도 적용 함수
			const applyCurrentSpeed = () => {
				const targetSpeed = state.pendingSpeedUpdate ?? state.currentSpeed;
				if (Math.abs(video.playbackRate - targetSpeed) > 0.01) {
					video.playbackRate = targetSpeed;
				}
			};

			// 무한 루프 방지 플래그
			let isRestoringSpeed = false;
			const handleRateChange = () => {
				if (isRestoringSpeed) return;

				const targetSpeed = state.pendingSpeedUpdate ?? state.currentSpeed;
				if (Math.abs(video.playbackRate - targetSpeed) > 0.01) {
					isRestoringSpeed = true;
					video.playbackRate = targetSpeed;
					requestAnimationFrame(() => {
						isRestoringSpeed = false;
					});
				}
			};

			// 이벤트 리스너 등록
			video.addEventListener('loadedmetadata', applyCurrentSpeed);
			video.addEventListener('loadstart', applyCurrentSpeed);
			video.addEventListener('canplay', applyCurrentSpeed);
			video.addEventListener('play', applyCurrentSpeed);
			video.addEventListener('ratechange', handleRateChange);

			// 현재 재생 가능한 상태면 바로 속도 적용
			if (video.readyState >= 1) {
				applyCurrentSpeed();
			}

			// 정리 함수 등록
			state.cleanup.add(() => {
				video.removeEventListener('loadedmetadata', applyCurrentSpeed);
				video.removeEventListener('loadstart', applyCurrentSpeed);
				video.removeEventListener('canplay', applyCurrentSpeed);
				video.removeEventListener('play', applyCurrentSpeed);
				video.removeEventListener('ratechange', handleRateChange);
				state.initializedVideos.delete(video);
			});

			state.initializedVideos.add(video);
		} catch (error) {
			// 초기화 오류 무시
		}
	}

	// 비디오 큐 추가
	function queueVideoInitialization(video) {
		videoInitQueue.add(video);

		if (!processingQueue) {
			processingQueue = true;
			requestAnimationFrame(processVideoQueue);
		}
	}

	// 비디오 큐 처리
	async function processVideoQueue() {
		try {
			const videos = Array.from(videoInitQueue);
			videoInitQueue.clear();

			for (const video of videos) {
				if (!state.initializedVideos.has(video)) {
					await initializeVideo(video);
				}
			}
		} catch {
			// 큐 처리 오류 무시
		} finally {
			processingQueue = false;

			if (videoInitQueue.size > 0) {
				requestAnimationFrame(processVideoQueue);
			}
		}
	}

	// 비디오 감지
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

				mutation.addedNodes.forEach(checkNode);

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

		state.videoObserver.observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['src', 'currentSrc'],
		});

		state.cleanup.add(() => {
			if (state.videoObserver) {
				state.videoObserver.disconnect();
				state.videoObserver = null;
			}
		});
	}

	// 비디오 속도 설정 함수
	async function setVideoSpeed(video, speed) {
		if (!video || typeof speed !== 'number' || speed < 0.1 || speed > 16)
			return false;

		try {
			let success = false;
			
			if (state.youtubeConfig.isYouTube) {
				if (typeof handleYouTubeShortsVideo === 'function' && detectYouTubeShortsPage()) {
					success = await handleYouTubeShortsVideo(speed);
				} else if (typeof handleYouTubeVideo === 'function') {
					success = await handleYouTubeVideo(speed);
				}
			} else {
				const applySpeed = () => {
					video.playbackRate = speed;
					return Math.abs(video.playbackRate - speed) < 0.01;
				};

				if (applySpeed()) {
					success = true;
				} else {
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
				await chrome.runtime.sendMessage({ action: 'setSpeed', speed: speed });
				return true;
			}

			return false;
		} catch {
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
				await chrome.runtime.sendMessage({
					action: 'setSpeed',
					speed: speed,
				});
				return true;
			}

			return false;
		} catch {
			return false;
		}
	}

	// URL 변경 감지
	function observeUrlChanges() {
		let lastUrl = window.location.href;

		const handleUrlChange = async () => {
			const currentUrl = window.location.href;
			if (currentUrl !== lastUrl) {
				lastUrl = currentUrl;
				state.lastUrl = currentUrl;
				state.autoSpeedApplied = false;

				if (!state.manualOverride) {
					await VSC.applySiteSettings(true);
				}
			}
		};

		// History API 오버라이드
		const originalPushState = history.pushState;
		const originalReplaceState = history.replaceState;

		history.pushState = function() {
			originalPushState.apply(this, arguments);
			handleUrlChange();
		};

		history.replaceState = function() {
			originalReplaceState.apply(this, arguments);
			handleUrlChange();
		};

		window.addEventListener('popstate', handleUrlChange);

		// 주기적 URL 확인
		if (state.youtubeConfig.isYouTube) {
			setInterval(handleUrlChange, 1000);
		}

		state.cleanup.add(() => {
			history.pushState = originalPushState;
			history.replaceState = originalReplaceState;
			window.removeEventListener('popstate', handleUrlChange);
		});
	}

	// 전역 함수 등록
	window.initializeVideo = initializeVideo;
	window.observeVideoElements = observeVideoElements;
	window.observeUrlChanges = observeUrlChanges;
	window.applySpeedToAllVideos = applySpeedToAllVideos;
	window.setVideoSpeed = setVideoSpeed;
	window.detectYouTubeShortsPage = function() {
		return window.location.pathname.includes('/shorts/');
	};
})();
