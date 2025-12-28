/**
 * Video Speed Controller - YouTube Module
 * YouTube 및 YouTube Shorts 전용 로직 담당
 */

(function() {
	// 메인 모듈 확인
	if (!window.VSC) {
		console.error('[VSC YouTube] Main module not loaded');
		return;
	}

	const state = VSC.state;

	// 뷰포트 내 요소 확인
	function isElementInViewport(element) {
		if (!element) return false;
		const rect = element.getBoundingClientRect();
		return (
			rect.top >= 0 &&
			rect.left >= 0 &&
			rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
			rect.right <= (window.innerWidth || document.documentElement.clientWidth)
		);
	}

	// YouTube Shorts 비디오 처리
	async function handleYouTubeShortsVideo(speed) {
		if (!state.youtubeConfig.isYouTube || !detectYouTubeShortsPage()) {
			return false;
		}

		const findActiveVideo = () => {
			const containers = document.querySelectorAll(
				[
					'ytd-reel-video-renderer[is-active]',
					'#shorts-container ytd-shorts-player-renderer',
					'[page-type="SHORTS"] ytd-shorts[is-active]',
				].join(',')
			);

			for (const container of containers) {
				const video = container.querySelector('video');
				if (video && isElementInViewport(container)) {
					return video;
				}
			}
			return null;
		};

		let retryCount = 0;
		const maxRetries = state.youtubeConfig.MAX_RETRIES;

		while (retryCount < maxRetries) {
			try {
				const video = findActiveVideo();
				if (!video) {
					await new Promise((resolve) =>
						setTimeout(resolve, state.youtubeConfig.RETRY_INTERVAL)
					);
					retryCount++;
					continue;
				}

				if (video.readyState < 3) {
					await new Promise((resolve, reject) => {
						const timeout = setTimeout(
							() => reject(new Error('Video load timeout')),
							5000
						);
						video.addEventListener(
							'canplay',
							() => {
								clearTimeout(timeout);
								resolve();
							},
							{ once: true }
						);
					});
				}

				video.playbackRate = speed;
				await new Promise((resolve) => setTimeout(resolve, 50));

				return video.playbackRate === speed;
			} catch (error) {
				retryCount++;
				await new Promise((resolve) =>
					setTimeout(
						resolve,
						state.youtubeConfig.RETRY_INTERVAL * Math.pow(1.5, retryCount)
					)
				);
			}
		}

		return false;
	}

	// YouTube 일반 비디오 처리
	async function handleYouTubeVideo(speed) {
		if (!state.youtubeConfig.isYouTube) return false;

		try {
			if (detectYouTubeShortsPage()) {
				return await handleYouTubeShortsSpecific(speed);
			}

			const video = document.querySelector('video');
			if (!video) return false;

			if (video.readyState < 3) {
				await new Promise((resolve, reject) => {
					const timeout = setTimeout(
						() => reject(new Error('Video load timeout')),
						5000
					);
					const onReady = () => {
						clearTimeout(timeout);
						resolve();
					};
					video.addEventListener('canplay', onReady, { once: true });
					video.addEventListener('loadeddata', onReady, { once: true });
				});
			}

			const handleRateChange = (e) => {
				e.stopPropagation();
				e.stopImmediatePropagation();
			};

			video.removeEventListener('ratechange', handleRateChange);
			video.addEventListener('ratechange', handleRateChange);

			try {
				if (window.yt?.player?.getPlayerByElement) {
					const player = window.yt.player.getPlayerByElement(video);
					if (player?.setPlaybackRate) {
						player.setPlaybackRate(speed);
					}
				}
			} catch {
				// YouTube API 사용 불가
			}

			video.playbackRate = speed;
			await new Promise((resolve) => setTimeout(resolve, 50));

			return video.playbackRate === speed;
		} catch {
			return false;
		}
	}

	// YouTube Shorts 전용 처리
	async function handleYouTubeShortsSpecific(speed) {
		try {
			const commentSection = document.querySelector(
				'#comments, ytd-comments, #comment-teaser'
			);
			if (commentSection?.getAttribute('loading') === 'true') {
				await new Promise((resolve) => setTimeout(resolve, 300));
			}

			const findActiveShortsVideo = () => {
				const selectors = [
					'ytd-reel-video-renderer[is-active] video',
					'#shorts-container video',
					'ytd-shorts[is-active] video',
					'.ytd-shorts video',
				];

				for (const selector of selectors) {
					const video = document.querySelector(selector);
					if (
						video &&
						isElementInViewport(
							video.closest('ytd-reel-video-renderer, ytd-shorts')
						)
					) {
						return video;
					}
				}
				return document.querySelector('video');
			};

			const video = findActiveShortsVideo();
			if (!video) return false;

			const handleShortsRateChange = (e) => {
				e.stopPropagation();
				e.stopImmediatePropagation();

				const commentElements = document.querySelectorAll(
					'#comments, ytd-comments, #comment-teaser'
				);
				commentElements.forEach((el) => {
					if (el.style) {
						el.style.pointerEvents = 'auto';
					}
				});
			};

			video.removeEventListener('ratechange', handleShortsRateChange);
			video.addEventListener('ratechange', handleShortsRateChange);

			video.playbackRate = speed;
			await new Promise((resolve) => setTimeout(resolve, 100));

			return video.playbackRate === speed;
		} catch {
			return false;
		}
	}

	// YouTube Shorts 네비게이션 감시
	function initYouTubeShortsObserver() {
		if (!state.youtubeConfig.isYouTube) return;

		const handleShortsNavigation = async () => {
			if (detectYouTubeShortsPage()) {
				state.youtubeConfig.isShortsPage = true;
				const videos = document.getElementsByTagName('video');
				for (const video of videos) {
					if (!state.initializedVideos.has(video)) {
						if (typeof initializeVideo === 'function') {
							await initializeVideo(video);
						}
					}
				}
				if (state.pendingSpeedUpdate !== null) {
					await handleYouTubeShortsVideo(state.pendingSpeedUpdate);
				}
			} else {
				state.youtubeConfig.isShortsPage = false;
			}
		};

		if (state.youtubeConfig.shortsObserver) {
			state.youtubeConfig.shortsObserver.disconnect();
		}

		state.youtubeConfig.shortsObserver = new MutationObserver(() => {
			const currentVideoId = window.location.pathname.split('/shorts/')[1]?.split('?')[0];
			if (currentVideoId !== state.youtubeConfig.lastShortsVideoId) {
				state.youtubeConfig.lastShortsVideoId = currentVideoId;
				handleShortsNavigation();
			}
		});

		state.youtubeConfig.shortsObserver.observe(document.body, {
			childList: true,
			subtree: true,
		});

		handleShortsNavigation();

		state.cleanup.add(() => {
			if (state.youtubeConfig.shortsObserver) {
				state.youtubeConfig.shortsObserver.disconnect();
				state.youtubeConfig.shortsObserver = null;
			}
		});
	}

	// 전역 함수 등록
	window.handleYouTubeShortsVideo = handleYouTubeShortsVideo;
	window.handleYouTubeVideo = handleYouTubeVideo;
	window.handleYouTubeShortsSpecific = handleYouTubeShortsSpecific;
	window.initYouTubeShortsObserver = initYouTubeShortsObserver;
	window.isElementInViewport = isElementInViewport;
})();
