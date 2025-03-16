(() => {
	const BackgroundController = {
		DEBUG: false, // 디버깅 모드 비활성화
		injectionTracker: new Map(),
	};

	function log(...args) {
		if (BackgroundController.DEBUG) {
			console.log('[Background]', new Date().toISOString(), ...args);
		}
	}

	// 탭 업데이트 핸들러 개선
	async function handleTabUpdate(tabId, changeInfo, tab) {
		// 유효하지 않은 탭이나 완료되지 않은 상태는 무시
		if (!tab?.id || changeInfo.status !== 'complete') return;

		// http로 시작하지 않는 URL은 무시 (chrome://, about:, file:// 등)
		if (!tab.url?.startsWith('http')) return;

		// 이미 주입된 탭은 무시
		if (BackgroundController.injectionTracker.get(tabId)) return;

		try {
			// 주입 상태 기록
			BackgroundController.injectionTracker.set(tabId, true);

			// content script 주입
			await chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js'],
			});

			log(`Script injected into tab ${tabId}`);

			// 5초 후 트래커에서 제거하여 재주입 가능하게 함
			setTimeout(() => {
				BackgroundController.injectionTracker.delete(tabId);
			}, 5000);
		} catch (error) {
			// 주입 실패 시 즉시 트래커에서 제거
			log('Script injection error:', error);
			BackgroundController.injectionTracker.delete(tabId);
		}
	}

	// 탭 업데이트 이벤트 리스너
	chrome.tabs.onUpdated.addListener(handleTabUpdate);

	// 탭 제거 이벤트 리스너
	chrome.tabs.onRemoved.addListener((tabId) => {
		BackgroundController.injectionTracker.delete(tabId);
	});

	// 명령어 핸들러 - commands 권한 확인 후 실행
	if (chrome.commands) {
		chrome.commands.onCommand.addListener(async (command) => {
			try {
				if (command === 'open-speed-popup') {
					const [tab] = await chrome.tabs.query({
						active: true,
						currentWindow: true,
					});

					if (!tab?.id) {
						throw new Error('No active tab found');
					}

					// 지원되지 않는 URL 체크 (chrome://, about:, file:// 등)
					if (!tab.url?.startsWith('http')) {
						log('Unsupported URL:', tab.url);
						return;
					}

					// 메시지 전송 전에 content script가 주입되었는지 확인
					try {
						await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
					} catch (error) {
						// content script가 없으면 주입
						log('Content script not found, injecting...');
						await chrome.scripting.executeScript({
							target: { tabId: tab.id },
							files: ['content.js'],
						});
						// 스크립트 로드 시간 확보
						await new Promise((resolve) => setTimeout(resolve, 100));
					}

					await chrome.tabs.sendMessage(tab.id, { action: 'openSpeedPopup' });
					log('Speed popup command sent successfully');
				}
			} catch (error) {
				log('Command error:', error);
			}
		});
	}

	// 확장 프로그램 설치/업데이트 시 처리
	chrome.runtime.onInstalled.addListener((details) => {
		log('Extension installed or updated:', details.reason);

		// 기본 설정값 초기화
		if (details.reason === 'install') {
			const defaultSettings = {
				shortcuts: {
					speedup: { keys: 'Ctrl + Shift + Up', value: 0.25 },
					speeddown: { keys: 'Ctrl + Shift + Down', value: 0.25 },
				},
				speedPopupShortcut: 'Ctrl + .',
				siteSettings: {},
			};

			chrome.storage.sync.set(defaultSettings, () => {
				log('Default settings initialized');
			});
		}
	});
})();
