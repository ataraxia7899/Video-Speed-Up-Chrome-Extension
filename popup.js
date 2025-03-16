// 기본 상태 관리
let currentVideoSpeed = 1.0;

// 디버깅 기능 비활성화
const DEBUG = false;

// 로그 함수 비활성화
/*
function log(...args) {
    if (DEBUG && console && console.log) {
        console.log('[Popup]', new Date().toISOString(), ...args);
    }
}
*/

// 핵심 유틸리티 함수들
function isValidSpeed(speed) {
	const parsed = parseFloat(speed);
	return !isNaN(parsed) && parsed >= 0.1 && parsed <= 16;
}

function updateSpeedDisplays(speed) {
	log('Updating speed displays:', speed);
	try {
		const speedValue = parseFloat(speed).toFixed(1);
		const currentSpeedEl = document.getElementById('current-speed');
		const speedInputEl = document.getElementById('speed-input');

		if (currentSpeedEl) {
			currentSpeedEl.textContent = speedValue;
		}

		// 사용자가 입력 중이 아닐 때만 input 값 업데이트
		if (speedInputEl && !speedInputEl.matches(':focus')) {
			speedInputEl.value = speedValue;
		}

		log('Speed display updated to:', speedValue);
	} catch (error) {
		log('Error updating displays:', error);
	}
}

// 메시지 전송 함수 개선
async function sendMessageToTab(tabId, message) {
	return new Promise((resolve, reject) => {
		try {
			chrome.tabs.sendMessage(tabId, message, (response) => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message));
					return;
				}
				resolve(response);
			});
		} catch (error) {
			reject(error);
		}
	});
}

// setSpeed 함수 개선
async function setSpeed(speed) {
	log('Setting speed:', speed);
	if (!isValidSpeed(speed)) {
		log('Invalid speed value:', speed);
		return;
	}

	try {
		const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
		const tab = tabs[0];

		if (!tab?.id) {
			throw new Error('No active tab found');
		}

		// 지원되지 않는 URL 체크 (chrome://, about:, file:// 등)
		if (!tab.url?.startsWith('http')) {
			log('Unsupported URL:', tab.url);
			return;
		}

		try {
			const response = await sendMessageToTab(tab.id, {
				action: 'setSpeed',
				speed: parseFloat(speed),
			});

			if (response?.success) {
				updateSpeedDisplays(response.speed);
				currentVideoSpeed = response.speed;
				log('Speed update successful:', response.speed);
			} else if (response?.error) {
				log('Error from content script:', response.error);
			}
		} catch (error) {
			log('Error sending message, attempting to reinject content script...');

			try {
				await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					files: ['content.js'],
				});

				// 스크립트 로드 시간 확보
				await new Promise((resolve) => setTimeout(resolve, 100));

				const response = await sendMessageToTab(tab.id, {
					action: 'setSpeed',
					speed: parseFloat(speed),
				});

				if (response?.success) {
					updateSpeedDisplays(response.speed);
					currentVideoSpeed = response.speed;
					log('Speed update successful after reinjection:', response.speed);
				} else if (response?.error) {
					log('Error from content script after reinjection:', response.error);
				}
			} catch (reinjectError) {
				log('Failed to reinject content script:', reinjectError);
			}
		}
	} catch (error) {
		log('Error setting speed:', error);
		updateSpeedDisplays(currentVideoSpeed);
	}
}

// 현재 속도 가져오기 함수 개선
async function getCurrentSpeed() {
	try {
		const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
		const tab = tabs[0];

		if (
			!tab?.id ||
			!tab.url ||
			tab.url.startsWith('chrome://') ||
			tab.url.startsWith('edge://') ||
			tab.url.startsWith('file://')
		) {
			log('Invalid or unsupported page:', tab?.url);
			return { speed: currentVideoSpeed };
		}

		try {
			const response = await sendMessageToTab(tab.id, { action: 'getSpeed' });

			if (response?.speed !== undefined) {
				updateSpeedDisplays(response.speed);
				currentVideoSpeed = response.speed;
				return response;
			}

			return { speed: currentVideoSpeed };
		} catch (error) {
			log('Error getting speed, attempting to reinject content script...');

			try {
				await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					files: ['content.js'],
				});

				// 스크립트 로드 시간 확보
				await new Promise((resolve) => setTimeout(resolve, 100));

				const response = await sendMessageToTab(tab.id, { action: 'getSpeed' });

				if (response?.speed !== undefined) {
					updateSpeedDisplays(response.speed);
					currentVideoSpeed = response.speed;
					return response;
				}
			} catch (reinjectError) {
				log('Failed to reinject content script:', reinjectError);
			}

			return { speed: currentVideoSpeed };
		}
	} catch (error) {
		log('Speed check error:', error.message);
		return { speed: currentVideoSpeed };
	}
}

// 초기화 함수 개선 - 버튼 동작 문제 해결
window.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
	try {
		log('Initializing app...');

		// 애니메이션 효과 추가
		addAnimationEffects();

		// 버튼 초기화를 별도 함수로 분리
		await initializeButtons();

		// 현재 속도 로드
		await getCurrentSpeed();

		// 저장된 설정 로드
		await loadSavedSettings();

		// 사이트별 설정 초기화
		initializeSiteSettings();

		log('App initialized successfully');
	} catch (error) {
		log('Initialization error:', error);
	}
}

// 애니메이션 효과 추가 함수
function addAnimationEffects() {
	// 카드 요소에 애니메이션 효과 추가
	const cards = document.querySelectorAll('.card');
	cards.forEach((card, index) => {
		card.style.animationDelay = `${index * 0.1}s`;
	});

	// 버튼에 리플 효과 추가
	const buttons = document.querySelectorAll('button');
	buttons.forEach((button) => {
		button.addEventListener('click', function (e) {
			// 리플 효과 요소 생성
			const ripple = document.createElement('span');
			ripple.classList.add('ripple-effect');

			// 버튼 내에서 클릭 위치 계산
			const rect = button.getBoundingClientRect();
			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;

			// 리플 효과 위치 설정
			ripple.style.left = `${x}px`;
			ripple.style.top = `${y}px`;

			// 버튼에 리플 효과 추가
			button.appendChild(ripple);

			// 애니메이션 완료 후 리플 효과 제거
			setTimeout(() => {
				ripple.remove();
			}, 600);
		});
	});

	// 입력 필드에 포커스 효과 추가
	const inputs = document.querySelectorAll('input');
	inputs.forEach((input) => {
		input.addEventListener('focus', function () {
			this.parentElement.classList.add('input-focused');
		});

		input.addEventListener('blur', function () {
			this.parentElement.classList.remove('input-focused');
		});
	});
}

// 속도 입력 필드 초기화 - 성능 개선
function initializeButtons() {
    return new Promise((resolve) => {
        const speedButtons = document.querySelectorAll('.speed-btn');
        const speedInput = document.getElementById('speed-input');
        let inputTimeout;

        // 프리셋 버튼 이벤트 위임
        document.addEventListener('click', (e) => {
            const button = e.target.closest('.speed-btn');
            if (!button) return;

            e.preventDefault();
            e.stopPropagation();
            const speedValue = button.dataset.speed;
            handleSpeedButtonClick(speedValue);
        });

        if (speedInput) {
            // 입력값 변경 시 처리 - 디바운스 적용
            speedInput.addEventListener('input', 
                debounce((e) => {
                    const speed = parseFloat(e.target.value);
                    if (isValidSpeed(speed)) {
                        setSpeed(speed);
                    }
                }, 300)
            );

            // ...existing code...
        }
        resolve();
    });
}

// 사이트별 설정 초기화
function initializeSiteSettings() {
    const addSiteButton = document.getElementById('add-site');
    const siteList = document.getElementById('site-list');

    if (addSiteButton) {
        addSiteButton.addEventListener('click', 
            debounce(() => {
                handleAddSite();
            }, 300)
        );
    }

    if (siteList) {
        // 이벤트 위임으로 변경
        siteList.addEventListener('click', (e) => {
            const deleteButton = e.target.closest('.delete-site');
            if (!deleteButton) return;

            const pattern = deleteButton.dataset.pattern;
            const siteItem = deleteButton.closest('.site-item');
            handleDeleteSite(pattern, siteItem);
        });
    }

    loadSiteList();
}

// 디바운스 함수 추가
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function initializeButtons() {
	return new Promise((resolve) => {
		log('Initializing buttons');

		// 프리셋 버튼 초기화
		const speedButtons = document.querySelectorAll('.speed-btn');
		speedButtons.forEach((button) => {
			button.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				const speedValue = button.dataset.speed;

				// 상대적 속도 변경 버튼 처리 (+1, -1, +0.1, -0.1)
				if (['+1', '-1', '+0.1', '-0.1'].includes(speedValue)) {
					const currentSpeed = parseFloat(
						document.getElementById('current-speed').textContent
					);
					let newSpeed = currentSpeed;

					switch (speedValue) {
						case '+1':
							newSpeed = Math.min(newSpeed + 1, 16);
							break;
						case '-1':
							newSpeed = Math.max(newSpeed - 1, 0.1);
							break;
						case '+0.1':
							newSpeed = Math.min(newSpeed + 0.1, 16);
							break;
						case '-0.1':
							newSpeed = Math.max(newSpeed - 0.1, 0.1);
							break;
					}

					// 소수점 첫째자리까지 반올림
					newSpeed = Math.round(newSpeed * 10) / 10;

					if (isValidSpeed(newSpeed)) {
						log('Relative speed button clicked:', newSpeed);
						setSpeed(newSpeed);
					}
				} else {
					// 일반 프리셋 버튼 처리
					const speed = parseFloat(speedValue);
					log('Speed button clicked:', speed);
					if (isValidSpeed(speed)) {
						setSpeed(speed);
					}
				}
			});
		});

		// 속도 입력 필드 초기화 - 개선된 버전
		const speedInput = document.getElementById('speed-input');
		if (speedInput) {
			let inputTimeout;

			// 입력값 변경 시 처리
			speedInput.addEventListener('input', (e) => {
				clearTimeout(inputTimeout);
				const speed = parseFloat(e.target.value);
				if (isValidSpeed(speed)) {
					inputTimeout = setTimeout(() => {
						setSpeed(speed);
					}, 300); // 300ms 디바운스
				}
			});

			// Enter 키 처리
			speedInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					clearTimeout(inputTimeout);
					const speed = parseFloat(speedInput.value);
					if (isValidSpeed(speed)) {
						setSpeed(speed);
						speedInput.blur();
					}
				}
			});

			// 포커스 잃었을 때 처리
			speedInput.addEventListener('blur', () => {
				clearTimeout(inputTimeout);
				const speed = parseFloat(speedInput.value);
				if (isValidSpeed(speed)) {
					setSpeed(speed);
				}
			});
		}
		resolve();
	});
}

// 사이트별 설정 초기화
function initializeSiteSettings() {
	// 사이트 추가
	const addSiteButton = document.getElementById('add-site');
	if (addSiteButton) {
		addSiteButton.addEventListener('click', () => {
			const pattern = document.getElementById('site-url').value.trim();
			const speed = parseFloat(document.getElementById('site-speed').value);

			if (!pattern) {
				alert('URL 패턴을 입력해주세요.');
				return;
			}

			if (!isValidSpeed(speed)) {
				alert('유효한 속도를 입력해주세요 (0.1 ~ 16).');
				return;
			}

			chrome.storage.sync.get(['siteSettings'], (result) => {
				const siteSettings = result.siteSettings || {};
				siteSettings[pattern] = speed;
				chrome.storage.sync.set({ siteSettings }, () => {
					loadSiteList();
					document.getElementById('site-url').value = '';
					document.getElementById('site-speed').value = '1.0';
				});
			});
		});
	}

	// 사이트 삭제
	const siteList = document.getElementById('site-list');
	if (siteList) {
		siteList.addEventListener('click', (e) => {
			if (e.target.classList.contains('delete-site')) {
				const pattern = e.target.dataset.pattern;
				const siteItem = e.target.closest('.site-item');

				// 삭제 애니메이션 적용
				siteItem.classList.remove('adding');
				siteItem.classList.add('removing');

				// 애니메이션 완료 후 실제 삭제
				setTimeout(() => {
					chrome.storage.sync.get(['siteSettings'], (result) => {
						const siteSettings = result.siteSettings || {};
						delete siteSettings[pattern];
						chrome.storage.sync.set({ siteSettings }, loadSiteList);
					});
				}, 300);
			}
		});
	}

	// 사이트 목록 로드
	loadSiteList();
}

// 사이트 목록 로드
function loadSiteList() {
	const siteList = document.getElementById('site-list');
	if (!siteList) return;

	chrome.storage.sync.get(['siteSettings'], (result) => {
		siteList.innerHTML = '';

		if (result.siteSettings && Object.keys(result.siteSettings).length > 0) {
			Object.entries(result.siteSettings).forEach(([pattern, speed], index) => {
				const div = document.createElement('div');
				div.className = 'site-item adding';
				div.innerHTML = `
                    <span>${pattern} (${speed}x)</span>
                    <button class="delete-site" data-pattern="${pattern}">삭제</button>
                `;
				siteList.appendChild(div);

				// 순차적으로 애니메이션 적용
				setTimeout(() => {
					div.style.animationDelay = `${index * 0.05}s`;
				}, 0);
			});
		} else {
			// 저장된 사이트가 없는 경우 메시지 표시
			const emptyMessage = document.createElement('div');
			emptyMessage.className = 'empty-message';
			emptyMessage.textContent = '저장된 사이트가 없습니다.';
			emptyMessage.style.textAlign = 'center';
			emptyMessage.style.color = '#64748b';
			emptyMessage.style.padding = '10px';
			siteList.appendChild(emptyMessage);
		}
	});
}

async function saveShortcuts() {
	try {
		const shortcuts = {
			speedup: {
				keys:
					document.getElementById('speedup-shortcut')?.dataset.shortcut ||
					'Ctrl + Shift + Up',
				value: parseFloat(
					document.getElementById('speedup-value')?.value || 0.25
				),
			},
			speeddown: {
				keys:
					document.getElementById('speeddown-shortcut')?.dataset.shortcut ||
					'Ctrl + Shift + Down',
				value: parseFloat(
					document.getElementById('speeddown-value')?.value || 0.25
				),
			},
		};

		const speedPopupShortcut =
			document.getElementById('popup-shortcut')?.dataset.shortcut || 'Ctrl + .';

		await chrome.storage.sync.set({
			shortcuts,
			speedPopupShortcut,
		});

		log('Shortcuts saved:', { shortcuts, speedPopupShortcut });
	} catch (error) {
		log('Error saving shortcuts:', error);
	}
}

async function loadSavedSettings() {
	try {
		const result = await new Promise((resolve) => {
			chrome.storage.sync.get(['shortcuts', 'speedPopupShortcut'], resolve);
		});

		// 기본값 설정
		const defaults = {
			shortcuts: {
				speedup: { keys: 'Ctrl + Shift + Up', value: 0.25 },
				speeddown: { keys: 'Ctrl + Shift + Down', value: 0.25 },
			},
			speedPopupShortcut: 'Ctrl + .',
		};

		const settings = {
			shortcuts: result.shortcuts || defaults.shortcuts,
			speedPopupShortcut:
				result.speedPopupShortcut || defaults.speedPopupShortcut,
		};

		// 단축키 입력 필드 업데이트
		updateShortcutInputs(settings);

		log('Settings loaded:', settings);
	} catch (error) {
		log('Error loading settings:', error);
	}
}

function updateShortcutInputs(settings) {
	const { shortcuts, speedPopupShortcut } = settings;

	// 속도 증가/감소 단축키
	if (shortcuts.speedup) {
		const input = document.getElementById('speedup-shortcut');
		const value = document.getElementById('speedup-value');
		if (input && value) {
			input.value = shortcuts.speedup.keys;
			input.dataset.shortcut = shortcuts.speedup.keys;
			value.value = shortcuts.speedup.value;
		}
	}

	if (shortcuts.speeddown) {
		const input = document.getElementById('speeddown-shortcut');
		const value = document.getElementById('speeddown-value');
		if (input && value) {
			input.value = shortcuts.speeddown.keys;
			input.dataset.shortcut = shortcuts.speeddown.keys;
			value.value = shortcuts.speeddown.value;
		}
	}

	// 팝업 단축키
	if (speedPopupShortcut) {
		const input = document.getElementById('popup-shortcut');
		if (input) {
			input.value = speedPopupShortcut;
			input.dataset.shortcut = speedPopupShortcut;
		}
	}
}
