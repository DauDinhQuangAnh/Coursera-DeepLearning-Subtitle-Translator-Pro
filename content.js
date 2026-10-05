/**
 * Coursera & DeepLearning Subtitle Translator Pro
 * High-accuracy sentence grouping, non-blocking batch translation,
 * silky-smooth playback sync, and responsive bilingual overlay.
 */

(function () {
    'use strict';

    // Prevent double initialization in the same window
    if (window.__courseraTranslatorInitialized) {
        return;
    }
    window.__courseraTranslatorInitialized = true;

    // --- GLOBAL STATE ---
    const state = {
        isTranslating: false,
        isFetching: false,
        progress: 0,
        currentSite: null,
        videoElement: null,
        videoContainer: null,
        currentVideoSrc: '',
        currentUrl: window.location.href,
        rawCues: [],
        sentences: [],
        activeSentenceIndex: -1,
        rafId: null,
        settings: {
            lang: 'vi',
            mode: 'bilingual',
            fontSize: 'medium',
            autoTranslate: true,
            showFloatingBtn: true
        }
    };

    // In-memory cache for translations: Map<"lang:text", "translatedText">
    const translationCache = new Map();

    // DOM Elements
    let overlayContainer = null;
    let floatingButton = null;
    let nativeCaptionsStyleTag = null;

    // --- INITIALIZATION ---
    async function init() {
        state.currentSite = detectSite();
        await loadSettings();
        injectCustomStyles();
        setupMessageListeners();
        setupNavigationWatcher();
        lookForVideo();
    }

    function detectSite() {
        const url = window.location.href;
        if (url.includes('coursera.org')) return 'coursera';
        if (url.includes('deeplearning.ai')) return 'deeplearning';
        return null;
    }

    async function loadSettings() {
        try {
            const saved = await chrome.storage.sync.get({
                lang: 'vi',
                mode: 'bilingual',
                fontSize: 'medium',
                autoTranslate: true,
                showFloatingBtn: true
            });
            state.settings = { ...state.settings, ...saved };
        } catch (e) {
            console.warn('[Translator] Failed to load settings from storage:', e);
        }
    }

    // --- MESSAGING ---
    function setupMessageListeners() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'getStatus') {
                sendResponse({
                    isTranslating: state.isTranslating,
                    isFetching: state.isFetching,
                    hasVideo: !!state.videoElement,
                    totalSentences: state.sentences.length,
                    currentSite: state.currentSite,
                    targetLang: state.settings.lang,
                    mode: state.settings.mode
                });
                return true;
            }

            if (request.action === 'toggleTranslate') {
                if (request.settings) {
                    state.settings = { ...state.settings, ...request.settings };
                }
                toggleTranslation();
                sendResponse({
                    isTranslating: state.isTranslating,
                    totalSentences: state.sentences.length
                });
                return true;
            }

            if (request.action === 'reloadTranslate') {
                if (request.settings) {
                    state.settings = { ...state.settings, ...request.settings };
                }
                startTranslation(true);
                sendResponse({
                    isTranslating: state.isTranslating,
                    totalSentences: state.sentences.length
                });
                return true;
            }

            if (request.action === 'updateSettings') {
                if (request.settings) {
                    state.settings = { ...state.settings, ...request.settings };
                    applySettingsToUI();
                }
                sendResponse({ success: true });
                return true;
            }

            if (request.action === 'changeLanguage') {
                if (request.lang && request.lang !== state.settings.lang) {
                    state.settings.lang = request.lang;
                    if (state.isTranslating) {
                        startTranslation(true);
                    }
                }
                sendResponse({ success: true });
                return true;
            }

            if (request.action === 'resetPosition') {
                if (overlayContainer) {
                    resetSubtitlePosition(overlayContainer);
                    chrome.storage.local.remove('ct_custom_pos');
                }
                sendResponse({ success: true });
                return true;
            }

            // Legacy method compatibility
            if (request.method === 'translate') {
                if (request.lang) state.settings.lang = request.lang;
                startTranslation(false);
                sendResponse({ method: 'translate', status: 'success' });
                return true;
            }
        });
    }

    // --- VIDEO & PLAYER DISCOVERY ---
    function lookForVideo() {
        const video = findVideoElement();
        if (video && video !== state.videoElement) {
            attachToVideo(video);
        }
    }

    function findVideoElement() {
        return document.querySelector('video');
    }

    function findVideoContainer(video) {
        if (!video) return null;
        if (state.currentSite === 'coursera') {
            return video.closest('#video-player-row') ||
                video.closest('.rc-VideoPlayer') ||
                video.closest('.video-player-container') ||
                video.parentElement;
        } else if (state.currentSite === 'deeplearning') {
            return video.closest('div[data-media-provider]') ||
                video.closest('.vds-media-player') ||
                video.parentElement;
        }
        return video.parentElement;
    }

    function attachToVideo(video) {
        console.log('[Translator] Found video element, attaching...');
        state.videoElement = video;
        state.currentVideoSrc = video.currentSrc || video.src || '';
        state.videoContainer = findVideoContainer(video);

        // Ensure container is relative for absolute positioning of overlay
        if (state.videoContainer && getComputedStyle(state.videoContainer).position === 'static') {
            state.videoContainer.style.position = 'relative';
        }

        // Create UI elements
        createSubtitleOverlay();
        createFloatingButton();

        // Listen for video events
        video.removeEventListener('timeupdate', onTimeUpdate);
        video.addEventListener('timeupdate', onTimeUpdate);
        video.removeEventListener('play', onVideoPlay);
        video.addEventListener('play', onVideoPlay);
        video.removeEventListener('pause', onVideoPause);
        video.addEventListener('pause', onVideoPause);

        // Auto translate if enabled
        if (state.settings.autoTranslate) {
            startTranslation(false);
        }
    }

    function setupNavigationWatcher() {
        // Watch for SPA url changes and video element changes
        setInterval(() => {
            const currentUrl = window.location.href;
            const currentVideo = findVideoElement();
            const currentSrc = currentVideo ? (currentVideo.currentSrc || currentVideo.src || '') : '';

            if (currentUrl !== state.currentUrl || currentVideo !== state.videoElement || (currentSrc && currentSrc !== state.currentVideoSrc)) {
                state.currentUrl = currentUrl;
                state.currentVideoSrc = currentSrc;
                state.currentSite = detectSite();
                console.log('[Translator] Navigation or video change detected.');

                // Reset session data
                state.rawCues = [];
                state.sentences = [];
                state.activeSentenceIndex = -1;

                if (currentVideo) {
                    attachToVideo(currentVideo);
                }
            }
        }, 800);

        // Also observe DOM additions
        const bodyObserver = new MutationObserver(() => {
            if (!state.videoElement || !document.contains(state.videoElement)) {
                lookForVideo();
            } else if (state.videoContainer && !state.videoContainer.querySelector('#ct-subtitle-overlay')) {
                createSubtitleOverlay();
            }
        });

        bodyObserver.observe(document.body, { childList: true, subtree: true });

        // Fullscreen changes
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    }

    function handleFullscreenChange() {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const targetContainer = fsEl || state.videoContainer;

        if (targetContainer && overlayContainer) {
            if (!targetContainer.contains(overlayContainer)) {
                targetContainer.appendChild(overlayContainer);
            }
        }
        if (targetContainer && floatingButton) {
            if (!targetContainer.contains(floatingButton)) {
                targetContainer.appendChild(floatingButton);
            }
        }
    }

    // --- SUBTITLE EXTRACTION ---
    async function extractSubtitlesWithRetry(maxRetries = 8, delayMs = 400) {
        for (let i = 0; i < maxRetries; i++) {
            const cues = await extractSubtitles();
            if (cues && cues.length > 0) {
                return cues;
            }
            await sleep(delayMs);
        }
        return [];
    }

    async function extractSubtitles() {
        if (!state.videoElement) return [];

        // Strategy 1: HTML5 Video TextTracks (Async with polling - pure English from media stream)
        const trackCues = await extractFromTextTracks();
        if (trackCues.length > 0) {
            console.log(`[Translator] Extracted ${trackCues.length} original cues from video.textTracks`);
            return trackCues;
        }

        // Strategy 2: DOM <track> tags (and WebVTT direct fetch)
        const domTrackCues = await extractFromTrackElements();
        if (domTrackCues.length > 0) {
            console.log(`[Translator] Extracted ${domTrackCues.length} original cues from <track> element`);
            return domTrackCues;
        }

        // Strategy 3: Deeplearning.ai transcript panel fallback
        if (state.currentSite === 'deeplearning') {
            const dlCues = await extractFromDeeplearningTranscript();
            if (dlCues.length > 0) {
                console.log(`[Translator] Extracted ${dlCues.length} cues from DeepLearning transcript`);
                return dlCues;
            }
        }

        // Strategy 4: Coursera transcript DOM fallback (with React fiber un-translated text extraction)
        if (state.currentSite === 'coursera') {
            const csCues = extractFromCourseraTranscript();
            if (csCues.length > 0) {
                console.log(`[Translator] Extracted ${csCues.length} cues from Coursera transcript DOM`);
                return csCues;
            }
        }

        return [];
    }

    async function extractFromTextTracks() {
        const video = state.videoElement;
        if (!video) return [];

        // Check video.textTracks (HTML5 media internal tracks - immune to page translation!)
        const textTracks = Array.from(video.textTracks || []);
        if (textTracks.length === 0) return [];

        console.log('[Translator] Scanning textTracks:', textTracks.map(t => `${t.language || 'no-lang'} (${t.label || 'no-label'}) [mode:${t.mode}]`));

        // 1. Specifically look for English track
        let targetTrack = textTracks.find(tr => {
            const lang = (tr.language || '').toLowerCase();
            const label = (tr.label || '').toLowerCase();
            return lang.startsWith('en') || label.includes('english');
        });

        // 2. If no explicit English label, pick any track that is not Vietnamese
        if (!targetTrack && textTracks.length > 0) {
            targetTrack = textTracks.find(tr => {
                const lang = (tr.language || '').toLowerCase();
                return !lang.startsWith('vi');
            }) || textTracks[0];
        }

        if (!targetTrack) return [];

        // Activate mode hidden so browser downloads/parses the WebVTT cues
        if (targetTrack.mode === 'disabled') {
            targetTrack.mode = 'hidden';
        }

        // Poll up to 2.5 seconds for targetTrack.cues to populate
        for (let attempt = 0; attempt < 12; attempt++) {
            if (targetTrack.cues && targetTrack.cues.length > 0) {
                const cues = [];
                for (let i = 0; i < targetTrack.cues.length; i++) {
                    const c = targetTrack.cues[i];
                    const cleanText = (c.text || '').replace(/<[^>]+>/g, '').trim();
                    if (cleanText) {
                        cues.push({
                            startTime: c.startTime,
                            endTime: c.endTime,
                            text: cleanText
                        });
                    }
                }
                if (cues.length > 0) {
                    return cues;
                }
            }
            await sleep(200);
        }
        return [];
    }

    async function extractFromTrackElements() {
        const trackEls = Array.from(state.videoElement.querySelectorAll('track'))
            .concat(Array.from(document.querySelectorAll('track')));

        if (!trackEls.length) return [];

        let chosenTrack = null;
        for (const tr of trackEls) {
            const srclang = (tr.srclang || '').toLowerCase();
            const label = (tr.label || '').toLowerCase();
            if (srclang.startsWith('en') || label.includes('english')) {
                chosenTrack = tr;
                break;
            }
        }
        if (!chosenTrack) chosenTrack = trackEls[0];

        // Check if cues are already populated on HTMLTrackElement.track
        if (chosenTrack.track && chosenTrack.track.cues && chosenTrack.track.cues.length > 0) {
            const cues = [];
            for (let i = 0; i < chosenTrack.track.cues.length; i++) {
                const c = chosenTrack.track.cues[i];
                const cleanText = (c.text || '').replace(/<[^>]+>/g, '').trim();
                if (cleanText) {
                    cues.push({ startTime: c.startTime, endTime: c.endTime, text: cleanText });
                }
            }
            return cues;
        }

        // Direct fetch of track.src (WebVTT) as bulletproof fallback
        if (chosenTrack.src) {
            try {
                const resp = await fetch(chosenTrack.src);
                if (resp.ok) {
                    const vttText = await resp.text();
                    const cues = parseVTT(vttText);
                    if (cues.length > 0) return cues;
                }
            } catch (err) {
                console.warn('[Translator] Failed to fetch track.src directly:', err);
            }
        }

        return [];
    }

    function parseTimestamp(timeStr) {
        if (!timeStr) return 0;
        const parts = timeStr.trim().split(':');
        if (parts.length === 3) {
            const [h, m, s] = parts;
            return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
        } else if (parts.length === 2) {
            const [m, s] = parts;
            return parseFloat(m) * 60 + parseFloat(s);
        }
        return parseFloat(timeStr) || 0;
    }

    function parseVTT(vttText) {
        const cues = [];
        const lines = vttText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i].trim();
            if (line.includes('-->')) {
                const [startStr, endStr] = line.split('-->').map(s => s.trim().split(' ')[0]);
                const startTime = parseTimestamp(startStr);
                const endTime = parseTimestamp(endStr);
                let textLines = [];
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    const clean = lines[i].replace(/<[^>]+>/g, '').trim();
                    if (clean) textLines.push(clean);
                    i++;
                }
                const text = textLines.join(' ');
                if (text && endTime > startTime) {
                    cues.push({ startTime, endTime, text });
                }
            } else {
                i++;
            }
        }
        return cues;
    }

    async function extractFromDeeplearningTranscript() {
        // Check if transcript button needs to be clicked
        let transcriptContainer = document.querySelector('div[data-part="transcript"]');
        let paragraphs = document.querySelectorAll('p.text-neutral');

        if (!paragraphs.length) {
            const transcriptBtn = document.querySelector('button.vds-button[aria-label*="transcript" i]');
            if (transcriptBtn) {
                transcriptBtn.click();
                await sleep(800);
                paragraphs = document.querySelectorAll('p.text-neutral');
            }
        }

        if (!paragraphs.length) return [];

        const rawData = [];
        paragraphs.forEach(p => {
            const timeEl = p.querySelector('span.link-primary') || p.querySelector('span:first-child');
            const textEl = p.querySelector('span:not(.link-primary)') || p.querySelector('span:last-child');
            if (timeEl && textEl) {
                const timeSec = parseTimestamp(timeEl.innerText);
                const text = textEl.innerText.trim();
                if (text) rawData.push({ startTime: timeSec, text });
            }
        });

        // Compute endTime for each paragraph
        const cues = [];
        for (let i = 0; i < rawData.length; i++) {
            const cur = rawData[i];
            const next = rawData[i + 1];
            const endTime = next ? next.startTime : cur.startTime + 5;
            cues.push({
                startTime: cur.startTime,
                endTime: Math.max(endTime, cur.startTime + 1),
                text: cur.text
            });
        }
        return cues;
    }

    function extractFromCourseraTranscript() {
        const transcriptContainer = document.querySelector('.rc-Transcript') || document.querySelector('.rc-TranscriptHighlight');
        if (!transcriptContainer) return [];

        const phrases = transcriptContainer.querySelectorAll('.rc-Phrase');
        if (!phrases.length) return [];

        const cues = [];
        phrases.forEach(phrase => {
            let text = '';
            // Extract untouched original text from React fiber/props if DOM was modified by browser translate
            for (const key in phrase) {
                if (key.startsWith('__reactProps') || key.startsWith('__reactFiber')) {
                    const props = phrase[key];
                    if (props && typeof props.children === 'string') {
                        text = props.children.trim();
                        break;
                    } else if (props && props.memoizedProps && typeof props.memoizedProps.children === 'string') {
                        text = props.memoizedProps.children.trim();
                        break;
                    }
                }
            }
            if (!text) {
                text = phrase.innerText.trim();
            }

            const timeAttr = phrase.getAttribute('data-timestamp') || phrase.getAttribute('data-time');
            if (text) {
                const startTime = timeAttr ? parseTimestamp(timeAttr) : 0;
                cues.push({ startTime, endTime: startTime + 3, text });
            }
        });
        return cues;
    }

    // --- SENTENCE GROUPING (KEY ACCURACY UPGRADE) ---
    function groupCuesIntoSentences(cues) {
        if (!cues || cues.length === 0) return [];

        const sentences = [];
        let current = {
            id: 0,
            startTime: cues[0].startTime,
            endTime: cues[0].endTime,
            text: '',
            cues: [],
            translatedText: ''
        };

        for (let i = 0; i < cues.length; i++) {
            const cue = cues[i];
            if (current.cues.length === 0) {
                current.startTime = cue.startTime;
            }
            current.endTime = cue.endTime;
            current.text = (current.text + ' ' + cue.text).trim();
            current.cues.push(cue);

            const isLast = (i === cues.length - 1);
            const endsWithSentenceMark = /[.!?]['"]?$/.test(current.text.trim());
            const gapToNext = (!isLast) ? (cues[i + 1].startTime - cue.endTime) : 0;
            const wordCount = current.text.split(/\s+/).length;

            // Natural sentence boundary heuristics:
            // 1. Punctuation mark (. ! ?)
            // 2. Pause between speech > 1.2s
            // 3. Sentence has reached 16+ words and cue ends with comma/semicolon
            // 4. Overly long segment safeguard (25+ words)
            // 5. Last cue
            if (
                endsWithSentenceMark ||
                isLast ||
                gapToNext > 1.2 ||
                (wordCount >= 16 && /[,;]$/.test(cue.text.trim())) ||
                wordCount >= 25
            ) {
                current.id = sentences.length;
                sentences.push({ ...current });
                current = {
                    id: 0,
                    startTime: 0,
                    endTime: 0,
                    text: '',
                    cues: [],
                    translatedText: ''
                };
            }
        }
        return sentences;
    }

    // --- BATCH TRANSLATION ENGINE ---
    async function translateSentencesBatch(sentences, targetLang) {
        state.isFetching = true;
        updateFloatingButtonState('loading', 'Đang dịch...');

        const BATCH_SIZE = 20;
        const total = sentences.length;
        let completed = 0;

        // Group into batches
        for (let b = 0; b < total; b += BATCH_SIZE) {
            const batch = sentences.slice(b, b + BATCH_SIZE);
            const uncachedIndices = [];
            const uncachedTexts = [];

            // Check cache first
            batch.forEach((sentence, idx) => {
                const cacheKey = `${targetLang}:${sentence.text.toLowerCase().trim()}`;
                if (translationCache.has(cacheKey)) {
                    sentence.translatedText = translationCache.get(cacheKey);
                } else {
                    uncachedIndices.push(idx);
                    uncachedTexts.push(sentence.text);
                }
            });

            // If we have items needing translation
            if (uncachedTexts.length > 0) {
                try {
                    const translatedBatch = await fetchGoogleTranslationBatch(uncachedTexts, targetLang);
                    uncachedIndices.forEach((origIdx, i) => {
                        const sentence = batch[origIdx];
                        const trans = translatedBatch[i] || sentence.text;
                        sentence.translatedText = trans;

                        // Save to cache
                        const cacheKey = `${targetLang}:${sentence.text.toLowerCase().trim()}`;
                        translationCache.set(cacheKey, trans);
                    });
                } catch (err) {
                    console.error('[Translator] Batch translation failed:', err);
                    // Fallback to original text on error
                    uncachedIndices.forEach((origIdx) => {
                        const sentence = batch[origIdx];
                        if (!sentence.translatedText) {
                            sentence.translatedText = sentence.text;
                        }
                    });
                }
            }

            completed += batch.length;
            state.progress = Math.round((completed / total) * 100);
            updateFloatingButtonState('loading', `Đang dịch ${state.progress}%`);

            // Small breathing gap between batches to avoid network congestion
            if (b + BATCH_SIZE < total) {
                await sleep(50);
            }
        }

        state.isFetching = false;
        updateFloatingButtonState('active', 'Song ngữ: BẬT');
        console.log(`[Translator] Completed translating ${total} sentences to ${targetLang}`);
    }

    // Google Translate API with index preservation and fallback
    async function fetchGoogleTranslationBatch(textArray, targetLang, attempt = 1) {
        // Tag each item: [0] Sentence 1\n[1] Sentence 2...
        const taggedQuery = textArray.map((text, idx) => `[${idx}] ${text}`).join('\n');
        const url = `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=${targetLang}&dt=t`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                body: new URLSearchParams({ q: taggedQuery })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            // data[0] is array of [[translatedPart, originalPart], ...]
            const segments = data[0] || [];
            let fullTranslated = '';
            for (let i = 0; i < segments.length; i++) {
                if (segments[i] && segments[i][0]) {
                    fullTranslated += segments[i][0];
                }
            }

            // Extract using index tags: [0] ... [1] ...
            const results = new Array(textArray.length);
            const regex = /\[(\d+)\]\s*([^\[]+)/g;
            let match;
            let matchedCount = 0;

            while ((match = regex.exec(fullTranslated)) !== null) {
                const idx = parseInt(match[1], 10);
                if (idx >= 0 && idx < textArray.length) {
                    results[idx] = match[2].trim();
                    matchedCount++;
                }
            }

            // Fallback if index regex failed on some entries
            if (matchedCount < textArray.length) {
                const lines = fullTranslated.split('\n').filter(l => l.trim().length > 0);
                for (let i = 0; i < textArray.length; i++) {
                    if (!results[i]) {
                        if (lines[i]) {
                            // Strip any leftover tags
                            results[i] = lines[i].replace(/^\[\d+\]\s*/, '').trim();
                        } else {
                            results[i] = textArray[i]; // Fallback to original
                        }
                    }
                }
            }

            return results;
        } catch (error) {
            if (attempt < 2) {
                console.warn(`[Translator] Retry attempt ${attempt + 1} after error:`, error);
                await sleep(500);
                return fetchGoogleTranslationBatch(textArray, targetLang, attempt + 1);
            }
            throw error;
        }
    }

    // --- MAIN TRANSLATION CONTROLLER ---
    async function startTranslation(forceReload = false) {
        if (!state.videoElement) {
            lookForVideo();
            if (!state.videoElement) {
                console.warn('[Translator] No video found to translate.');
                return;
            }
        }

        // Hide native player captions
        hideNativeCaptions(true);

        // If cues already extracted and not forcing reload
        if (!forceReload && state.sentences.length > 0) {
            state.isTranslating = true;
            showOverlay(true);
            updateFloatingButtonState('active', 'Song ngữ: BẬT');
            return;
        }

        updateFloatingButtonState('loading', 'Đang tải phụ đề...');
        const cues = await extractSubtitlesWithRetry();

        if (!cues || cues.length === 0) {
            console.warn('[Translator] No subtitles could be extracted.');
            updateFloatingButtonState('inactive', 'Không tìm thấy phụ đề');
            return;
        }

        state.rawCues = cues;
        state.sentences = groupCuesIntoSentences(cues);
        state.isTranslating = true;
        showOverlay(true);

        // Start playback sync loop
        startPlaybackSync();

        // Translate all sentences in background batches
        await translateSentencesBatch(state.sentences, state.settings.lang);
    }

    function toggleTranslation() {
        if (state.isTranslating) {
            state.isTranslating = false;
            showOverlay(false);
            hideNativeCaptions(false);
            updateFloatingButtonState('inactive', 'Dịch: TẮT');
        } else {
            startTranslation(false);
        }
    }

    // --- PLAYBACK SYNCHRONIZATION ---
    function startPlaybackSync() {
        if (state.rafId) {
            cancelAnimationFrame(state.rafId);
        }

        function syncLoop() {
            if (state.isTranslating && state.videoElement) {
                syncSubtitleDisplay(state.videoElement.currentTime);
            }
            if (state.videoElement && !state.videoElement.paused) {
                state.rafId = requestAnimationFrame(syncLoop);
            }
        }

        if (state.videoElement && !state.videoElement.paused) {
            state.rafId = requestAnimationFrame(syncLoop);
        }
    }

    function onVideoPlay() {
        if (state.isTranslating) {
            startPlaybackSync();
        }
    }

    function onVideoPause() {
        if (state.rafId) {
            cancelAnimationFrame(state.rafId);
            state.rafId = null;
        }
    }

    function onTimeUpdate() {
        if (state.isTranslating && state.videoElement) {
            syncSubtitleDisplay(state.videoElement.currentTime);
        }
    }

    function syncSubtitleDisplay(currentTime) {
        if (!overlayContainer || !state.sentences.length) return;

        const sentence = findSentenceAtTime(currentTime);

        if (sentence) {
            renderSubtitle(sentence.text, sentence.translatedText);
        } else {
            clearSubtitle();
        }
    }

    function findSentenceAtTime(time) {
        const sentences = state.sentences;
        const total = sentences.length;
        if (!total) return null;

        // Fast O(1) check: current active sentence index
        const curIdx = state.activeSentenceIndex;
        if (curIdx >= 0 && curIdx < total) {
            const cur = sentences[curIdx];
            if (time >= cur.startTime && time <= cur.endTime) {
                return cur;
            }
            // Check next sentence (natural progression)
            if (curIdx + 1 < total) {
                const next = sentences[curIdx + 1];
                if (time >= next.startTime && time <= next.endTime) {
                    state.activeSentenceIndex = curIdx + 1;
                    return next;
                }
            }
        }

        // Fast binary search for seeks or jumps
        let low = 0;
        let high = total - 1;

        while (low <= high) {
            const mid = (low + high) >> 1;
            const s = sentences[mid];
            if (time >= s.startTime && time <= s.endTime) {
                state.activeSentenceIndex = mid;
                return s;
            } else if (time < s.startTime) {
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        state.activeSentenceIndex = -1;
        return null;
    }

    // --- OVERLAY RENDERING ---
    function createSubtitleOverlay() {
        if (!state.videoContainer) return;

        let existing = state.videoContainer.querySelector('#ct-subtitle-overlay');
        if (existing) {
            overlayContainer = existing;
            return;
        }

        overlayContainer = document.createElement('div');
        overlayContainer.id = 'ct-subtitle-overlay';
        overlayContainer.className = `ct-overlay ct-font-${state.settings.fontSize} ct-mode-${state.settings.mode} notranslate`;
        overlayContainer.setAttribute('translate', 'no');

        const capsule = document.createElement('div');
        capsule.className = 'ct-capsule notranslate';
        capsule.setAttribute('translate', 'no');
        capsule.title = 'Kéo để di chuyển vị trí • Nhấp đúp để đặt lại';

        const dragHandle = document.createElement('div');
        dragHandle.className = 'ct-drag-handle';
        dragHandle.innerHTML = '<span></span><span></span><span></span>';

        const originalTextEl = document.createElement('div');
        originalTextEl.className = 'ct-original-text notranslate';
        originalTextEl.setAttribute('translate', 'no');

        const translatedTextEl = document.createElement('div');
        translatedTextEl.className = 'ct-translated-text notranslate';
        translatedTextEl.setAttribute('translate', 'no');

        capsule.appendChild(dragHandle);
        capsule.appendChild(originalTextEl);
        capsule.appendChild(translatedTextEl);
        overlayContainer.appendChild(capsule);

        state.videoContainer.appendChild(overlayContainer);
        showOverlay(state.isTranslating);

        // Make draggable & restore user's custom position
        makeDraggable(overlayContainer, capsule, state.videoContainer);
        restoreSubtitlePosition(overlayContainer, state.videoContainer);
    }

    // --- DRAGGABLE SUBTITLE CAPABILITY (CENTER-ANCHORED TO PREVENT JUMPING) ---
    function makeDraggable(element, handle, container) {
        if (!element || !handle || !container) return;

        let isDragging = false;
        let startX = 0, startY = 0;
        let initialCenterX = 0, initialCenterY = 0;
        let hasMoved = false;

        handle.addEventListener('mousedown', onMouseDown);
        handle.addEventListener('touchstart', onTouchStart, { passive: false });

        function onMouseDown(e) {
            if (e.button !== 0) return; // Only primary left-click
            startDrag(e.clientX, e.clientY);
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        }

        function onTouchStart(e) {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            startDrag(touch.clientX, touch.clientY);
            document.addEventListener('touchmove', onTouchMove, { passive: false });
            document.addEventListener('touchend', onTouchEnd);
        }

        function startDrag(clientX, clientY) {
            isDragging = true;
            hasMoved = false;
            startX = clientX;
            startY = clientY;

            const rect = element.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();

            // Anchor by the exact CENTER of the subtitle capsule
            initialCenterX = (rect.left + rect.width / 2) - containerRect.left;
            initialCenterY = (rect.top + rect.height / 2) - containerRect.top;

            element.style.bottom = 'auto';
            element.style.left = `${initialCenterX}px`;
            element.style.top = `${initialCenterY}px`;
            element.style.transform = 'translate(-50%, -50%)';
            handle.classList.add('ct-dragging');
        }

        function onMouseMove(e) {
            if (!isDragging) return;
            moveDrag(e.clientX, e.clientY);
        }

        function onTouchMove(e) {
            if (!isDragging || e.touches.length !== 1) return;
            moveDrag(e.touches[0].clientX, e.touches[0].clientY);
            e.preventDefault();
        }

        function moveDrag(clientX, clientY) {
            const dx = clientX - startX;
            const dy = clientY - startY;

            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                hasMoved = true;
            }

            const containerRect = container.getBoundingClientRect();
            const elemRect = element.getBoundingClientRect();
            const halfW = elemRect.width / 2;
            const halfH = elemRect.height / 2;

            let newCenterX = initialCenterX + dx;
            let newCenterY = initialCenterY + dy;

            // Clamp center point so capsule stays fully within video player boundaries
            newCenterX = Math.max(halfW, Math.min(newCenterX, containerRect.width - halfW));
            newCenterY = Math.max(halfH, Math.min(newCenterY, containerRect.height - halfH));

            element.style.left = `${newCenterX}px`;
            element.style.top = `${newCenterY}px`;
            element.style.transform = 'translate(-50%, -50%)';
        }

        function onMouseUp() {
            endDrag();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }

        function onTouchEnd() {
            endDrag();
            document.removeEventListener('touchmove', onTouchMove);
            document.removeEventListener('touchend', onTouchEnd);
        }

        async function endDrag() {
            if (!isDragging) return;
            isDragging = false;
            handle.classList.remove('ct-dragging');

            if (hasMoved) {
                const containerRect = container.getBoundingClientRect();
                const elemRect = element.getBoundingClientRect();

                if (containerRect.width > 0 && containerRect.height > 0) {
                    const currentCenterX = (elemRect.left + elemRect.width / 2) - containerRect.left;
                    const currentCenterY = (elemRect.top + elemRect.height / 2) - containerRect.top;

                    const centerRatioX = currentCenterX / containerRect.width;
                    const centerRatioY = currentCenterY / containerRect.height;
                    try {
                        await chrome.storage.local.set({ ct_custom_pos: { centerRatioX, centerRatioY } });
                    } catch (err) {}
                }
            }
        }

        // Double click to reset to default bottom center
        handle.addEventListener('dblclick', async (e) => {
            e.stopPropagation();
            e.preventDefault();
            resetSubtitlePosition(element);
            try {
                await chrome.storage.local.remove('ct_custom_pos');
            } catch (err) {}
        });
    }

    function resetSubtitlePosition(element) {
        if (!element) return;
        element.style.left = '50%';
        element.style.top = 'auto';
        element.style.bottom = '35px';
        element.style.transform = 'translateX(-50%)';
    }

    async function restoreSubtitlePosition(element, container) {
        if (!element || !container) return;
        try {
            const data = await chrome.storage.local.get('ct_custom_pos');
            const pos = data?.ct_custom_pos;
            if (pos && typeof pos.centerRatioX === 'number' && typeof pos.centerRatioY === 'number') {
                const containerRect = container.getBoundingClientRect();
                if (containerRect.width > 0 && containerRect.height > 0) {
                    const elemRect = element.getBoundingClientRect();
                    const halfW = elemRect.width / 2;
                    const halfH = elemRect.height / 2;

                    let posX = pos.centerRatioX * containerRect.width;
                    let posY = pos.centerRatioY * containerRect.height;

                    posX = Math.max(halfW, Math.min(posX, containerRect.width - halfW));
                    posY = Math.max(halfH, Math.min(posY, containerRect.height - halfH));

                    element.style.bottom = 'auto';
                    element.style.left = `${posX}px`;
                    element.style.top = `${posY}px`;
                    element.style.transform = 'translate(-50%, -50%)';
                }
            }
        } catch (err) {}
    }

    function renderSubtitle(origText, transText) {
        if (!overlayContainer) return;

        const origEl = overlayContainer.querySelector('.ct-original-text');
        const transEl = overlayContainer.querySelector('.ct-translated-text');
        const capsule = overlayContainer.querySelector('.ct-capsule');

        if (!origEl || !transEl) return;

        const targetOrig = origText || '';
        const targetTrans = transText || (state.isFetching ? '⏳ Đang dịch...' : targetOrig);

        // Avoid layout repaints if text did not change
        if (origEl.textContent !== targetOrig) {
            origEl.textContent = targetOrig;
        }
        if (transEl.textContent !== targetTrans) {
            transEl.textContent = targetTrans;
        }

        if (capsule && capsule.style.display !== 'inline-block') {
            capsule.style.display = 'inline-block';
        }
    }

    function clearSubtitle() {
        if (!overlayContainer) return;
        const capsule = overlayContainer.querySelector('.ct-capsule');
        if (capsule) {
            capsule.style.display = 'none';
        }
    }

    function showOverlay(visible) {
        if (overlayContainer) {
            overlayContainer.style.display = visible ? 'flex' : 'none';
        }
    }

    function applySettingsToUI() {
        if (overlayContainer) {
            overlayContainer.className = `ct-overlay ct-font-${state.settings.fontSize} ct-mode-${state.settings.mode}`;
        }
        if (floatingButton) {
            floatingButton.style.display = state.settings.showFloatingBtn ? 'flex' : 'none';
        }
    }

    // --- FLOATING CONTROL BUTTON ---
    function createFloatingButton() {
        if (!state.videoContainer) return;

        let existing = state.videoContainer.querySelector('#ct-floating-btn');
        if (existing) {
            floatingButton = existing;
            return;
        }

        floatingButton = document.createElement('div');
        floatingButton.id = 'ct-floating-btn';
        floatingButton.className = 'ct-floating-btn';
        floatingButton.title = 'Coursera Translator Pro - Click để Bật/Tắt';

        const icon = document.createElement('span');
        icon.className = 'ct-btn-icon';
        icon.textContent = '🌐';

        const label = document.createElement('span');
        label.className = 'ct-btn-label';
        label.textContent = state.isTranslating ? 'Song ngữ: BẬT' : 'Dịch';

        floatingButton.appendChild(icon);
        floatingButton.appendChild(label);

        floatingButton.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            toggleTranslation();
        });

        state.videoContainer.appendChild(floatingButton);
        floatingButton.style.display = state.settings.showFloatingBtn ? 'flex' : 'none';
    }

    function updateFloatingButtonState(status, text) {
        if (!floatingButton) return;

        floatingButton.className = `ct-floating-btn ct-btn-${status}`;
        const label = floatingButton.querySelector('.ct-btn-label');
        if (label && text) {
            label.textContent = text;
        }
    }

    // --- NATIVE CAPTION SUPPRESSION ---
    function hideNativeCaptions(shouldHide) {
        if (shouldHide) {
            if (!nativeCaptionsStyleTag) {
                nativeCaptionsStyleTag = document.createElement('style');
                nativeCaptionsStyleTag.id = 'ct-native-captions-hide';
                nativeCaptionsStyleTag.textContent = `
                    .vds-captions,
                    .vjs-text-track-display,
                    .rc-TranscriptHighlight,
                    .c-video-subtitle {
                        display: none !important;
                        opacity: 0 !important;
                    }
                `;
                document.head.appendChild(nativeCaptionsStyleTag);
            }
            // Set track modes to hidden on video
            if (state.videoElement && state.videoElement.textTracks) {
                for (let i = 0; i < state.videoElement.textTracks.length; i++) {
                    state.videoElement.textTracks[i].mode = 'hidden';
                }
            }
        } else {
            if (nativeCaptionsStyleTag) {
                nativeCaptionsStyleTag.remove();
                nativeCaptionsStyleTag = null;
            }
        }
    }

    // --- INJECT CUSTOM STYLES ---
    function injectCustomStyles() {
        if (document.getElementById('ct-injected-styles')) return;

        const style = document.createElement('style');
        style.id = 'ct-injected-styles';
        style.textContent = `
            /* Subtitle Overlay Container */
            .ct-overlay {
                position: absolute;
                bottom: 35px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 2147483647;
                max-width: 88%;
                width: auto;
                pointer-events: none;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                text-align: center;
                transition: opacity 0.2s ease;
                user-select: none;
            }

            .ct-capsule {
                display: none;
                background: rgba(15, 23, 42, 0.92);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                padding: 7px 20px 9px 20px;
                border-radius: 10px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
                min-width: 320px;
                max-width: 100%;
                min-height: 48px;
                box-sizing: border-box;
                pointer-events: auto;
                cursor: grab;
                position: relative;
                transition: border-color 0.2s ease, box-shadow 0.2s ease;
            }

            .ct-capsule:hover {
                border-color: rgba(96, 165, 250, 0.6);
                box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55), 0 0 10px rgba(59, 130, 246, 0.3);
            }

            .ct-capsule.ct-dragging {
                cursor: grabbing !important;
                border-color: #3b82f6 !important;
                box-shadow: 0 8px 30px rgba(0, 0, 0, 0.65), 0 0 15px rgba(59, 130, 246, 0.5) !important;
                opacity: 0.95;
            }

            /* Drag Handle Indicator */
            .ct-drag-handle {
                display: flex;
                justify-content: center;
                align-items: center;
                gap: 4px;
                padding-bottom: 3px;
                margin-bottom: 2px;
                cursor: grab;
                opacity: 0.35;
                transition: opacity 0.2s ease;
            }

            .ct-capsule:hover .ct-drag-handle {
                opacity: 0.9;
            }

            .ct-drag-handle span {
                width: 14px;
                height: 2px;
                background: #94a3b8;
                border-radius: 2px;
            }

            .ct-original-text {
                color: #cbd5e1;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                line-height: 1.35;
                margin-bottom: 4px;
                font-weight: 400;
                text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
            }

            .ct-translated-text {
                color: #ffffff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                line-height: 1.4;
                font-weight: 600;
                text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9);
            }

            /* Modes */
            .ct-mode-translated_only .ct-original-text {
                display: none !important;
            }

            .ct-mode-original_only .ct-translated-text {
                display: none !important;
            }

            /* Font Sizes */
            .ct-font-small .ct-original-text { font-size: 13px; }
            .ct-font-small .ct-translated-text { font-size: 15px; }

            .ct-font-medium .ct-original-text { font-size: 15px; }
            .ct-font-medium .ct-translated-text { font-size: 18px; }

            .ct-font-large .ct-original-text { font-size: 18px; }
            .ct-font-large .ct-translated-text { font-size: 22px; }

            /* Floating Button */
            .ct-floating-btn {
                position: absolute;
                top: 16px;
                right: 16px;
                z-index: 2147483646;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 12px;
                border-radius: 20px;
                background: rgba(15, 23, 42, 0.78);
                backdrop-filter: blur(8px);
                -webkit-backdrop-filter: blur(8px);
                border: 1px solid rgba(255, 255, 255, 0.15);
                color: white;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                user-select: none;
                pointer-events: auto;
                transition: all 0.25s ease;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            }

            .ct-floating-btn:hover {
                background: rgba(15, 23, 42, 0.95);
                transform: scale(1.04);
                border-color: rgba(255, 255, 255, 0.3);
            }

            .ct-btn-icon {
                font-size: 14px;
            }

            .ct-btn-active {
                background: rgba(16, 185, 129, 0.88);
                border-color: rgba(16, 185, 129, 0.5);
            }
            .ct-btn-active:hover {
                background: rgba(16, 185, 129, 1);
            }

            .ct-btn-loading {
                background: rgba(245, 158, 11, 0.85);
                border-color: rgba(245, 158, 11, 0.4);
            }

            .ct-btn-inactive {
                background: rgba(15, 23, 42, 0.65);
                opacity: 0.85;
            }
        `;
        document.head.appendChild(style);
    }

    // --- UTILITIES ---
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Start extension
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();