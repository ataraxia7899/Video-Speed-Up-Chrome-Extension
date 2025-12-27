/**
 * Video Speed Controller - 공통 유틸리티
 * 상수 정의 및 공용 함수를 제공합니다.
 */

// 전역 상수 정의
const VSC_CONSTANTS = {
	// 캐시 관련
	CACHE_TTL: 5000, // 5초

	// 재시도 관련
	MAX_RETRIES: 3,
	RETRY_DELAY: 1000,
	MAX_RECOVERY_ATTEMPTS: 3,
	RECOVERY_DELAY: 500,

	// 타임아웃 관련
	CONNECTION_TIMEOUT: 5000,
	MESSAGE_TIMEOUT: 2000,
	URL_UPDATE_DELAY: 500,

	// 속도 관련
	MIN_SPEED: 0.1,
	MAX_SPEED: 16,
	DEFAULT_SPEED: 1.0,

	// YouTube 관련
	YOUTUBE_RETRY_INTERVAL: 50,
	YOUTUBE_MAX_RETRIES: 20,
	YOUTUBE_MUTATION_DEBOUNCE: 150,
	YOUTUBE_SPA_LOAD_TIMEOUT: 2000,

	// 검사 간격
	STATUS_CHECK_INTERVAL: 5000, // 5초
	MIN_REINJECT_INTERVAL: 1000,
};

/**
 * 스토리지 캐시 클래스
 * Chrome Storage API 호출을 캐싱하여 성능 향상
 */
class StorageCacheManager {
	constructor() {
		this.cache = new Map();
		this.timestamps = new Map();
		this.pendingRequests = new Map();
		this.TTL = VSC_CONSTANTS.CACHE_TTL;
	}

	/**
	 * 캐시에서 값 가져오기
	 * @param {string} key - 스토리지 키
	 * @returns {Promise<any>} 저장된 값
	 */
	async get(key) {
		const now = Date.now();

		// 캐시 히트 확인
		if (this.cache.has(key)) {
			const timestamp = this.timestamps.get(key);
			if (now - timestamp < this.TTL) {
				return this.cache.get(key);
			}
			// TTL 만료된 캐시 삭제
			this.cache.delete(key);
			this.timestamps.delete(key);
		}

		// 진행 중인 요청이 있다면 해당 Promise 반환
		if (this.pendingRequests.has(key)) {
			return this.pendingRequests.get(key);
		}

		// 새로운 요청 생성
		const promise = new Promise((resolve) => {
			chrome.storage.sync.get(key, (result) => {
				const value = result[key];
				this.cache.set(key, value);
				this.timestamps.set(key, now);
				this.pendingRequests.delete(key);
				resolve(value);
			});
		});

		this.pendingRequests.set(key, promise);
		return promise;
	}

	/**
	 * 캐시에 값 저장
	 * @param {string} key - 스토리지 키
	 * @param {any} value - 저장할 값
	 * @returns {Promise<void>}
	 */
	async set(key, value) {
		const now = Date.now();

		this.cache.set(key, value);
		this.timestamps.set(key, now);

		return new Promise((resolve) => {
			chrome.storage.sync.set({ [key]: value }, resolve);
		});
	}

	/**
	 * 특정 키의 캐시 삭제
	 * @param {string} key - 스토리지 키
	 */
	clear(key) {
		this.cache.delete(key);
		this.timestamps.delete(key);
		this.pendingRequests.delete(key);
	}

	/**
	 * 전체 캐시 삭제
	 */
	clearAll() {
		this.cache.clear();
		this.timestamps.clear();
		this.pendingRequests.clear();
	}
}

/**
 * 속도 유효성 검사
 * @param {number} speed - 검사할 속도 값
 * @returns {boolean} 유효 여부
 */
function isValidSpeed(speed) {
	const parsed = parseFloat(speed);
	return (
		!isNaN(parsed) &&
		parsed >= VSC_CONSTANTS.MIN_SPEED &&
		parsed <= VSC_CONSTANTS.MAX_SPEED
	);
}

/**
 * URL 패턴 매칭
 * @param {string} pattern - URL 패턴
 * @param {string} url - 검사할 URL
 * @returns {boolean} 매칭 여부
 */
function matchUrlPattern(pattern, url) {
	try {
		const regexPattern = pattern
			.replace(/\./g, '\\.')
			.replace(/\*/g, '.*')
			.replace(/\//g, '\\/');
		return new RegExp(regexPattern).test(url);
	} catch {
		return false;
	}
}

/**
 * Debounce 함수
 * @param {Function} func - 실행할 함수
 * @param {number} wait - 대기 시간 (ms)
 * @returns {Function} Debounced 함수
 */
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

/**
 * Throttle 함수
 * @param {Function} func - 실행할 함수
 * @param {number} limit - 제한 시간 (ms)
 * @returns {Function} Throttled 함수
 */
function throttle(func, limit) {
	let inThrottle;
	return function executedFunction(...args) {
		if (!inThrottle) {
			func(...args);
			inThrottle = true;
			setTimeout(() => (inThrottle = false), limit);
		}
	};
}

// 전역으로 노출
if (typeof window !== 'undefined') {
	window.VSC_CONSTANTS = VSC_CONSTANTS;
	window.StorageCacheManager = StorageCacheManager;
	window.isValidSpeed = isValidSpeed;
	window.matchUrlPattern = matchUrlPattern;
	window.debounce = debounce;
	window.throttle = throttle;
}
