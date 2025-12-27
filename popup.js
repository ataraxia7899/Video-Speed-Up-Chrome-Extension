// 기본 상태 관리
let currentVideoSpeed = 1.0;

// utils 객체 정의
const utils = {
	// 무작동 로그 함수
	log: () => {}, // noop 함수로 대체
	isValidSpeed(speed) {
		const parsed = parseFloat(speed);
		return !isNaN(parsed) && parsed >= 0.1 && parsed <= 16;
	},
};

// 스토리지 캐시 시스템 - utils.js의 StorageCacheManager 사용
const StorageManager = new StorageCacheManager();

// 핵심 유틸리티 함수들
function updateSpeedDisplays(speed) {
	try {
		const speedValue = parseFloat(speed).toFixed(2);
		const currentSpeedEl = document.getElementById('current-speed');
		const speedInputEl = document.getElementById('speed-input');

		if (currentSpeedEl) {
			currentSpeedEl.textContent = speedValue;
			// 속도별 색상 클래스 적용
			applySpeedColorClass(currentSpeedEl, parseFloat(speed));
		}

		if (speedInputEl && !speedInputEl.matches(':focus')) {
			speedInputEl.value = speedValue;
		}

		// 현재 속도와 일치하는 프리셋 버튼 하이라이트
		updatePresetButtonHighlight(parseFloat(speed));
	} catch (error) {
		console.error('Error updating displays:', error);
	}
}

// 속도별 색상 클래스 적용
function applySpeedColorClass(element, speed) {
	element.classList.remove('speed-slow', 'speed-normal', 'speed-fast', 'speed-very-fast');
	
	if (speed < 1.0) {
		element.classList.add('speed-slow');
	} else if (speed === 1.0) {
		element.classList.add('speed-normal');
	} else if (speed <= 2.0) {
		element.classList.add('speed-fast');
	} else {
		element.classList.add('speed-very-fast');
	}
}

// 프리셋 버튼 하이라이트 업데이트
function updatePresetButtonHighlight(speed) {
	const presetButtons = document.querySelectorAll('.speed-btn[data-speed]');
	presetButtons.forEach(btn => {
		const btnSpeed = parseFloat(btn.dataset.speed);
		if (!isNaN(btnSpeed) && btnSpeed === speed) {
			btn.classList.add('active');
		} else {
			btn.classList.remove('active');
		}
	});
}

// 다크 모드 초기화 및 토글
function initializeDarkMode() {
	const toggle = document.getElementById('dark-mode-toggle');

	// chrome.storage.sync 사용
	chrome.storage.sync.get(['darkMode'], (result) => {
		const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		if (result.darkMode === true || (result.darkMode === undefined && prefersDark)) {
			document.body.classList.add('dark-mode');
		}
	});
	
	if (toggle) {
		toggle.addEventListener('click', () => {
			document.body.classList.toggle('dark-mode');
			const isDark = document.body.classList.contains('dark-mode');
			chrome.storage.sync.set({ darkMode: isDark });
		});
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

// 탭별 상태 관리를 위한 함수들
async function getTabSpeed(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'getCurrentSpeed' });
        return response?.speed || 1.0;
    } catch (error) {
        console.error('Error getting tab speed:', error);
        return 1.0;
    }
}

async function setTabSpeed(tabId, speed) {
    if (!utils.isValidSpeed(speed)) {
        return false;
    }

    try {
        const response = await chrome.tabs.sendMessage(tabId, {
            action: 'setSpeed',
            speed: parseFloat(speed)
        });
        return response?.success || false;
    } catch (error) {
        console.error('Error setting tab speed:', error);
        return false;
    }
}

// 사용자 설정 저장 함수 업데이트
async function saveUserPreferences(tabId, speed) {
    try {
        const currentSettings = {
            tabId,
            speed,
            timestamp: Date.now()
        };

        await chrome.storage.local.set({
            [`tab_${tabId}_speed`]: currentSettings
        });
    } catch (error) {
        console.error('Error saving preferences:', error);
    }
}

// 저장된 사용자 설정 불러오기 함수 업데이트
async function loadUserPreferences(tabId) {
    try {
        const result = await chrome.storage.local.get([`tab_${tabId}_speed`]);
        const preferences = result[`tab_${tabId}_speed`];

        if (preferences && preferences.speed) {
            updateSpeedDisplays(preferences.speed);
            await setTabSpeed(tabId, preferences.speed);
        }
    } catch (error) {
        console.error('Error loading preferences:', error);
    }
}

// setSpeed 함수 업데이트
async function setSpeed(speed) {
    if (!utils.isValidSpeed(speed)) {
        return;
    }

    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];

        if (!tab?.id || !tab.url?.startsWith('http')) {
            return;
        }

        const success = await setTabSpeed(tab.id, speed);
        if (success) {
            updateSpeedDisplays(speed);
            await saveUserPreferences(tab.id, speed);
        }
    } catch (error) {
        console.error('Error in setSpeed:', error);
    }
}

// getCurrentSpeed 함수 업데이트
async function getCurrentSpeed() {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];

        if (!tab?.id || !tab.url?.startsWith('http')) {
            return { speed: 1.0 };
        }

        const speed = await getTabSpeed(tab.id);
        updateSpeedDisplays(speed);
        return { speed };
    } catch (error) {
        console.error('Speed check error:', error);
        return { speed: 1.0 };
    }
}

// 초기화 함수 개선 - 버튼 동작 문제 해결
// DOMContentLoaded는 하단에서 통합 처리

async function initializeApp() {
	try {
		utils.log('Initializing app...');

        // 저장된 사용자 설정 로드
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            await loadUserPreferences(tab.id);
        }

		// 다크 모드 초기화
		initializeDarkMode();

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

		localizeHtmlPage();

		utils.log('App initialized successfully');
	} catch (error) {
		utils.log('Initialization error:', error);
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
		utils.log('Initializing buttons');

		// 프리셋 버튼 초기화
		const speedButtons = document.querySelectorAll('.speed-btn');
		speedButtons.forEach((button) => {
			button.addEventListener('click', function (e) {
				e.preventDefault();
				e.stopPropagation();
				const speedValue = button.dataset.speed;

				// 상대적 속도 변경 버튼 처리 (+1, -1, +0.25, -0.25)
				if (['+1', '-1', '+0.25', '-0.25'].includes(speedValue)) {
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
						case '+0.25':
							newSpeed = Math.min((newSpeed + 0.25).toFixed(2), 16);
							break;
						case '-0.25':
							newSpeed = Math.max((newSpeed - 0.25).toFixed(2), 0.1);
							break;
					}

					if (utils.isValidSpeed(newSpeed)) {
						utils.log('Relative speed button clicked:', newSpeed);
						setSpeed(newSpeed);
					}
				} else {
					// 일반 프리셋 버튼 처리
					const speed = parseFloat(speedValue);
					utils.log('Speed button clicked:', speed);
					if (utils.isValidSpeed(speed)) {
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
				if (utils.isValidSpeed(speed)) {
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
					if (utils.isValidSpeed(speed)) {
						setSpeed(speed);
						speedInput.blur();
					}
				}
			});

			// 포커스 잃었을 때 처리
			speedInput.addEventListener('blur', () => {
				clearTimeout(inputTimeout);
				const speed = parseFloat(speedInput.value);
				if (utils.isValidSpeed(speed)) {
					setSpeed(speed);
				}
			});
		}
		resolve();
	});
}

// 사이트별 설정 초기화
function initializeSiteSettings() {
	const addSiteButton = document.getElementById('add-site');
	const siteList = document.getElementById('site-list');

	if (!addSiteButton || !siteList) {
		console.error('Required elements not found');
		return;
	}

	// 사이트 추가 이벤트 리스너
	addSiteButton.addEventListener('click', handleAddSite);

	// 사이트 삭제 이벤트 리스너
	siteList.addEventListener('click', handleSiteListClick);

	// 초기 사이트 목록 로드
	loadSiteList();
}

// 사이트 추가 핸들러 함수
async function handleAddSite() {
    const pattern = document.getElementById('site-url')?.value.trim();
    const speed = parseFloat(document.getElementById('site-speed')?.value);

    if (!pattern) {
        alert(chrome.i18n.getMessage('urlRequired'));
        return;
    }

    if (!utils.isValidSpeed(speed)) {
        alert(chrome.i18n.getMessage('invalidSpeed'));
        return;
    }

    try {
        const siteSettings = await StorageManager.get('siteSettings') || {};
        siteSettings[pattern] = {
            speed: speed,
            enabled: true,
        };

        await StorageManager.set('siteSettings', siteSettings);
        
        loadSiteList();
        document.getElementById('site-url').value = '';
        document.getElementById('site-speed').value = '1.0';
    } catch (error) {
        console.error('Error adding site:', error);
    }
}

// 사이트 목록 클릭 이벤트 핸들러
async function handleSiteListClick(e) {
    const target = e.target;

    if (target.classList.contains('delete-site')) {
        const pattern = target.dataset.pattern;
        const siteItem = target.closest('.site-item');

        if (!pattern || !siteItem) return;

        siteItem.classList.remove('adding');
        siteItem.classList.add('removing');

        try {
            const siteSettings = await StorageManager.get('siteSettings') || {};
            delete siteSettings[pattern];
            await StorageManager.set('siteSettings', siteSettings);
            
            setTimeout(() => {
                loadSiteList();
            }, 300);
        } catch (error) {
            console.error('Error deleting site:', error);
            siteItem.classList.remove('removing');
        }
    }
}

// 사이트 목록 로드 함수
async function loadSiteList() {
    const siteList = document.getElementById('site-list');
    if (!siteList) return;

    try {
        const siteSettings = await StorageManager.get('siteSettings') || {};
        siteList.innerHTML = '';

        if (Object.keys(siteSettings).length > 0) {
            Object.entries(siteSettings).forEach(([pattern, setting], index) => {
                const speed = typeof setting === 'object' ? setting.speed : setting;
                const isEnabled = typeof setting === 'object' ? setting.enabled : true;

                const div = document.createElement('div');
                div.className = 'site-item adding';
                div.dataset.pattern = pattern;
                div.innerHTML = `
                    <div class="site-info">
                        <label class="toggle-switch">
                            <input type="checkbox" class="toggle-input" id="toggle-${index}" ${isEnabled ? 'checked' : ''}>
                            <span class="toggle-label"></span>
                        </label>
                        <span class="site-pattern">${pattern} (${speed}x)</span>
                    </div>
                    <button class="delete-site" data-pattern="${pattern}">${chrome.i18n.getMessage('delete')}</button>
                `;

                siteList.appendChild(div);

                // 토글 이벤트 리스너
                const toggleInput = div.querySelector(`#toggle-${index}`);
                toggleInput.addEventListener('change', (e) => {
                    const isChecked = e.target.checked;
                    updateSiteSettings(pattern, speed, isChecked);
                });

                setTimeout(() => {
                    div.style.animationDelay = `${index * 0.05}s`;
                }, 0);
            });
        } else {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'empty-message';
            emptyMessage.textContent = chrome.i18n.getMessage('noSites');
            emptyMessage.style.textAlign = 'center';
            emptyMessage.style.color = '#64748b';
            emptyMessage.style.padding = '10px';
            siteList.appendChild(emptyMessage);
        }
    } catch (error) {
        console.error('Error loading site list:', error);
    }
}

// 사이트 설정 업데이트 함수
async function updateSiteSettings(pattern, speed, enabled) {
    try {
        const siteSettings = await StorageManager.get('siteSettings') || {};
        siteSettings[pattern] = {
            speed: speed,
            enabled: enabled,
        };

        await StorageManager.set('siteSettings', siteSettings);

        // 토글 레이블 애니메이션
        const siteItem = document.querySelector(`.site-item[data-pattern="${pattern}"]`);
        if (siteItem) {
            const toggleLabel = siteItem.querySelector('.toggle-label');
            if (toggleLabel) {
                toggleLabel.classList.add('toggling');
                setTimeout(() => toggleLabel.classList.remove('toggling'), 300);
            }
        }
    } catch (error) {
        console.error('Error updating site settings:', error);
    }
}

async function saveShortcuts() {
	try {
		const speedPopupShortcut =
			document.getElementById('popup-shortcut')?.dataset.shortcut || 'Ctrl + .';

		await chrome.storage.sync.set({
			speedPopupShortcut,
		});

		utils.log('Settings saved:', { speedPopupShortcut });
	} catch (error) {
		utils.log('Error saving settings:', error);
	}
}

// loadSavedSettings 함수 업데이트
async function loadSavedSettings() {
    try {
        const settings = await StorageManager.get('settings');
        
        // 기본값 설정
        const defaults = {
            speedPopupShortcut: 'Ctrl + .',
        };

        // 설정이 없으면 기본값 저장
        if (!settings) {
            await StorageManager.set('settings', defaults);
            return defaults;
        }

        return settings;
    } catch (error) {
        utils.log('Error loading settings:', error);
        return null;
    }
}

// HTML 요소에 i18n 메시지 적용하는 함수 추가
function localizeHtmlPage() {
	// 일반 텍스트 요소
	const elements = document.querySelectorAll('[data-i18n]');
	elements.forEach((element) => {
		const key = element.getAttribute('data-i18n');
		element.textContent = chrome.i18n.getMessage(key);
	});

	// speed-input 라벨 설정
	const speedInput = document.querySelector('.speed-input');
	if (speedInput) {
		speedInput.dataset.label = chrome.i18n.getMessage('speedInput');
	}

	// placeholder 속성
	document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
		const message = chrome.i18n.getMessage(
			element.getAttribute('data-i18n-placeholder')
		);
		if (message) element.placeholder = message;
	});

	// aria-label 속성
	document.querySelectorAll('[data-i18n-aria]').forEach((element) => {
		const message = chrome.i18n.getMessage(
			element.getAttribute('data-i18n-aria')
		);
		if (message) element.setAttribute('aria-label', message);
	});
}

// localizeHtmlPage에서 범위 정보도 함께 처리됨

// 단축키 설정 초기화 함수 개선
async function initializeShortcuts() {
    try {
        const result = await chrome.storage.sync.get(['speedPopupShortcut']);
        document.querySelectorAll('.shortcut-list strong').forEach(el => {
            if (el.textContent.includes('Ctrl + .')) {
                el.textContent = result.speedPopupShortcut || 'Ctrl + .';
            }
        });
    } catch (error) {
        console.error('단축키 초기화 오류:', error);
    }
}

// DOM이 로드된 후 초기화 함수
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            await loadUserPreferences(tab.id);
            const speed = await getTabSpeed(tab.id);
            updateSpeedDisplays(speed);

            // 주기적으로 현재 탭의 속도 업데이트
            const updateInterval = setInterval(async () => {
                const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (currentTab?.id === tab.id) {
                    const currentSpeed = await getTabSpeed(tab.id);
                    updateSpeedDisplays(currentSpeed);
                } else {
                    clearInterval(updateInterval);
                }
            }, 500);
        }

        // 앱 초기화 및 단축키 설정 로드
        await initializeApp();
        await initializeShortcuts();

        // 팝업 닫힐 때 정리
        window.addEventListener('unload', () => {
            StorageManager.clearAll();
        });
    } catch (error) {
        console.error('초기화 오류:', error);
    }
});

// createSpeedInputPopup은 content.js에서 처리됨


