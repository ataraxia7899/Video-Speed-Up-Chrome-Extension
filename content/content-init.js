/**
 * Video Speed Controller - Initialization Module
 * 모든 모듈을 초기화하고 연결
 */

(function() {
	// 메인 모듈 확인
	if (!window.VSC) {
		console.error('[VSC Init] Main module not loaded');
		return;
	}

	const state = VSC.state;

	// 초기화 함수
	async function initialize() {
		try {
			if (!state.initialized) {
				await VSC.establishConnection();

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
				} catch {
					// 속도 로드 실패 무시
				}

				// 관찰자 설정
				if (typeof observeVideoElements === 'function') {
					observeVideoElements();
				}
				if (typeof observeUrlChanges === 'function') {
					observeUrlChanges();
				}

				if (state.youtubeConfig.isYouTube && typeof initYouTubeShortsObserver === 'function') {
					initYouTubeShortsObserver();
				}

				// 현재 비디오 요소들 초기화
				const videos = document.getElementsByTagName('video');
				for (const video of videos) {
					if (typeof initializeVideo === 'function') {
						await initializeVideo(video);
					}
				}

				state.initialized = true;
			}
			return true;
		} catch {
			state.initialized = false;
			return false;
		}
	}

	// 주기적 상태 검사
	const checkInterval = typeof VSC_CONSTANTS !== 'undefined' ? VSC_CONSTANTS.STATUS_CHECK_INTERVAL : 5000;

	setInterval(async () => {
		if (VSC.reconnectionState.isReconnecting) return;

		if (!state.contextValid) {
			await VSC.attemptRecovery();
		}
	}, checkInterval);

	// 페이지 언로드 시 정리
	window.addEventListener('beforeunload', () => {
		state.cleanup.forEach((cleanup) => {
			try {
				cleanup();
			} catch {
				// 정리 오류 무시
			}
		});
		state.cleanup.clear();
	});

	// 탭 가시성 변경 시 컨텍스트 검증
	let contextValidationTimeout;
	const contextValidationHandler = () => {
		if (contextValidationTimeout) {
			clearTimeout(contextValidationTimeout);
		}
		contextValidationTimeout = setTimeout(async () => {
			await VSC.validateContext();
		}, 500);
	};

	document.addEventListener(
		'visibilitychange',
		() => {
			if (document.visibilityState === 'visible') {
				if (contextValidationTimeout) {
					clearTimeout(contextValidationTimeout);
				}
				contextValidationHandler();
			}
		},
		{ passive: true }
	);

	// 빠른 초기화 실행
	VSC.quickInit();

	// 초기화 실행
	initialize().catch(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		VSC.tryReconnect().catch(() => {});
	});
})();
