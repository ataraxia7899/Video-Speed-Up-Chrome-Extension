/**
 * Video Speed Controller - Popup Module
 * 인페이지 속도 제어 팝업 담당
 */

(function() {
	// 메인 모듈 확인
	if (!window.VSC) {
		console.error('[VSC Popup] Main module not loaded');
		return;
	}

	const state = VSC.state;

	// 팝업 표시 디바운스
	let lastPopupToggle = 0;
	const POPUP_DEBOUNCE_MS = 200;

	// 팝업 생성 함수
	function createSpeedInputPopup() {
		const popup = document.createElement('div');
		popup.id = 'speed-input-popup';

		const style = document.createElement('style');
		style.textContent = `
			#speed-input-popup {
				position: fixed;
				top: 50%;
				left: 50%;
				transform: translate(-50%, -50%);
				background: #ffffff;
				padding: 20px;
				border-radius: 12px;
				box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
				z-index: 2147483647;
				display: flex;
				flex-direction: column;
				gap: 16px;
				font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
				min-width: 200px;
				max-width: 200px;
				transition: all 0.3s ease;
				animation: fadeInScale 0.2s ease-out;
				border: 1px solid rgba(0, 0, 0, 0.1);
			}
			.popup-title {
				font-size: 18px;
				font-weight: 600;
				text-align: center;
				margin: 0;
				padding: 0;
				color: #1a1a1a;
			}
			.input-container {
				display: flex;
				flex-direction: column;
				gap: 8px;
			}
			.speed-input {
				width: 120px;
				padding: 12px;
				font-size: 20px;
				text-align: center;
				border: 2px solid #e2e8f0;
				border-radius: 8px;
				outline: none;
				transition: all 0.2s ease;
				margin: 0 auto;
				display: block;
				background: #ffffff;
				color: #1a1a1a;
				-moz-appearance: textfield;
				appearance: textfield;
			}
			.speed-input::-webkit-outer-spin-button,
			.speed-input::-webkit-inner-spin-button {
				-webkit-appearance: none;
				margin: 0;
			}
			.speed-input:focus {
				border-color: #3b82f6;
				box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
			}
			.info-container {
				display: flex;
				align-items: center;
				justify-content: center;
				background: #f8fafc;
				border-radius: 6px;
				padding: 8px;
			}
			.shortcut-info {
				color: #64748b;
				font-size: 13px;
				text-align: center;
			}
			.shortcut-key {
				background: #e2e8f0;
				padding: 2px 6px;
				border-radius: 4px;
				font-weight: 500;
				color: #475569;
			}
			@keyframes fadeInScale {
				from {
					opacity: 0;
					transform: translate(-50%, -50%) scale(0.95);
				}
				to {
					opacity: 1;
					transform: translate(-50%, -50%) scale(1);
				}
			}
			#speed-input-popup.dark-mode {
				background: #1a1d21;
				color: #e4e6eb;
				border-color: rgba(255, 255, 255, 0.1);
			}
			#speed-input-popup.dark-mode .popup-title {
				color: #e4e6eb;
			}
			#speed-input-popup.dark-mode .speed-input {
				background: #2d2d2d;
				border-color: #40444b;
				color: #e4e6eb;
			}
			#speed-input-popup.dark-mode .info-container {
				background: #2c2f33;
			}
			#speed-input-popup.dark-mode .shortcut-info {
				color: #b9bbbe;
			}
			#speed-input-popup.dark-mode .shortcut-key {
				background: #40444b;
				color: #e4e6eb;
			}
		`;
		document.head.appendChild(style);

		const title = document.createElement('div');
		title.className = 'popup-title';
		title.textContent = chrome.i18n?.getMessage?.('speedSettingTitle') || '재생 속도 설정';

		const inputContainer = document.createElement('div');
		inputContainer.className = 'input-container';

		const input = document.createElement('input');
		input.type = 'number';
		input.className = 'speed-input';
		input.min = '0.1';
		input.max = '16';
		input.step = '0.1';
		input.value = document.querySelector('video')?.playbackRate || '1.0';

		const infoContainer = document.createElement('div');
		infoContainer.className = 'info-container';

		const shortcutInfo = document.createElement('div');
		shortcutInfo.className = 'shortcut-info';
		const applyText = chrome.i18n?.getMessage?.('shortcutApply') || '적용';
		const cancelText = chrome.i18n?.getMessage?.('shortcutCancel') || '취소';
		shortcutInfo.innerHTML = `<span class="shortcut-key">Enter</span> ${applyText} | <span class="shortcut-key">ESC</span> ${cancelText}`;

		infoContainer.appendChild(shortcutInfo);
		inputContainer.appendChild(input);

		popup.appendChild(title);
		popup.appendChild(inputContainer);
		popup.appendChild(infoContainer);

		return { popup, input };
	}

	// 팝업 표시 함수
	function showSpeedInputPopup() {
		const now = Date.now();
		if (now - lastPopupToggle < POPUP_DEBOUNCE_MS) {
			return;
		}
		lastPopupToggle = now;

		try {
			const existingPopup = document.getElementById('speed-input-popup');
			if (existingPopup) {
				existingPopup.remove();
				return;
			}

			const { popup, input } = createSpeedInputPopup();

			chrome.storage.sync.get(['darkMode'], (result) => {
				if (result.darkMode === true) {
					popup.classList.add('dark-mode');
				}
			});

			const container = document.fullscreenElement || document.webkitFullscreenElement || document.body;
			container.appendChild(popup);

			requestAnimationFrame(() => {
				input.focus();
				input.select();
			});

			const handleKeyDown = async (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					const speed = parseFloat(input.value);
					if (!isNaN(speed) && speed >= 0.1 && speed <= 16) {
						state.manualOverride = true;
						state.pendingSpeedUpdate = speed;
						state.currentSpeed = speed;
						
						const videos = document.getElementsByTagName('video');
						for (const video of videos) {
							video.playbackRate = speed;
						}
						
						chrome.runtime.sendMessage({ action: 'setSpeed', speed: speed }).catch(() => {});
						popup.remove();
					}
				} else if (e.key === 'Escape') {
					e.preventDefault();
					popup.remove();
				}
				e.stopPropagation();
			};

			input.addEventListener('keydown', handleKeyDown);

			const handleOutsideClick = (e) => {
				if (!popup.contains(e.target)) {
					popup.remove();
					document.removeEventListener('click', handleOutsideClick);
				}
			};

			setTimeout(() => {
				document.addEventListener('click', handleOutsideClick);
			}, 100);

			state.cleanup.add(() => {
				popup.remove();
				document.removeEventListener('click', handleOutsideClick);
			});
		} catch {
			// 팝업 표시 오류 무시
		}
	}

	// 전역 함수 등록
	window.showSpeedInputPopup = showSpeedInputPopup;
	window.createSpeedInputPopup = createSpeedInputPopup;
})();
