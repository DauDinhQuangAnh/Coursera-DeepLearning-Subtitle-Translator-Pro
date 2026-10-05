document.addEventListener('DOMContentLoaded', async () => {
    const langSelect = document.getElementById('lang');
    const modeSelect = document.getElementById('mode');
    const fontSizeSelect = document.getElementById('fontSize');
    const autoTranslateCheck = document.getElementById('autoTranslate');
    const showFloatingBtnCheck = document.getElementById('showFloatingBtn');
    const toggleBtn = document.getElementById('toggleBtn');
    const toggleBtnText = document.getElementById('toggleBtnText');
    const reloadBtn = document.getElementById('reloadBtn');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const videoInfo = document.getElementById('videoInfo');

    let currentTab = null;

    // Load saved settings
    const defaultSettings = {
        lang: 'vi',
        mode: 'bilingual',
        fontSize: 'medium',
        autoTranslate: true,
        showFloatingBtn: true
    };

    const saved = await chrome.storage.sync.get(defaultSettings);
    langSelect.value = saved.lang || 'vi';
    modeSelect.value = saved.mode || 'bilingual';
    fontSizeSelect.value = saved.fontSize || 'medium';
    autoTranslateCheck.checked = saved.autoTranslate !== false;
    showFloatingBtnCheck.checked = saved.showFloatingBtn !== false;

    // Helper: get current settings
    function getCurrentSettings() {
        return {
            lang: langSelect.value,
            mode: modeSelect.value,
            fontSize: fontSizeSelect.value,
            autoTranslate: autoTranslateCheck.checked,
            showFloatingBtn: showFloatingBtnCheck.checked
        };
    }

    // Helper: save and notify content script
    async function saveAndBroadcastSettings() {
        const settings = getCurrentSettings();
        await chrome.storage.sync.set(settings);
        sendTabMessage({ action: 'updateSettings', settings });
    }

    // Listen to changes
    langSelect.addEventListener('change', () => {
        saveAndBroadcastSettings();
        // If translation is active, re-translate with new language
        sendTabMessage({ action: 'changeLanguage', lang: langSelect.value });
    });

    modeSelect.addEventListener('change', saveAndBroadcastSettings);
    fontSizeSelect.addEventListener('change', saveAndBroadcastSettings);
    autoTranslateCheck.addEventListener('change', saveAndBroadcastSettings);
    showFloatingBtnCheck.addEventListener('change', saveAndBroadcastSettings);

    // Get active tab
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        currentTab = tab;
        await checkTabStatus();
    } catch (e) {
        console.error('Error getting tab:', e);
        updateStatus('error', 'Lỗi kết nối tab');
    }

    // Safe send message with auto-injection
    async function sendTabMessage(message) {
        if (!currentTab || !currentTab.id) return null;
        try {
            return await chrome.tabs.sendMessage(currentTab.id, message);
        } catch (err) {
            if (err.message && err.message.includes('Receiving end does not exist')) {
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: currentTab.id },
                        files: ['content.js']
                    });
                    // Retry
                    return await chrome.tabs.sendMessage(currentTab.id, message);
                } catch (injErr) {
                    console.warn('Script injection failed:', injErr);
                    return null;
                }
            }
            console.warn('Message failed:', err);
            return null;
        }
    }

    // Update status badge UI
    function updateStatus(type, text) {
        statusBadge.className = 'status-pill';
        if (type === 'active') {
            statusBadge.classList.add('status-active');
        } else if (type === 'loading') {
            statusBadge.classList.add('status-loading');
        } else if (type === 'error') {
            statusBadge.classList.add('status-error');
        } else {
            statusBadge.classList.add('status-ready');
        }
        statusText.textContent = text;
    }

    // Query status from content script
    async function checkTabStatus() {
        if (!currentTab?.url) return;

        const isCoursera = currentTab.url.includes('coursera.org');
        const isDeeplearning = currentTab.url.includes('deeplearning.ai');

        if (!isCoursera && !isDeeplearning) {
            updateStatus('error', 'Không hỗ trợ trang này');
            toggleBtn.disabled = true;
            reloadBtn.disabled = true;
            videoInfo.textContent = 'Hãy mở video trên Coursera hoặc Deeplearning.ai để sử dụng.';
            videoInfo.classList.add('show');
            return;
        }

        updateStatus('loading', 'Đang quét video...');
        const response = await sendTabMessage({ action: 'getStatus' });

        if (!response) {
            updateStatus('ready', 'Chờ tải trang...');
            return;
        }

        const { isTranslating, isFetching, hasVideo, totalSentences, currentSite } = response;

        if (isFetching) {
            updateStatus('loading', 'Đang dịch phụ đề...');
        } else if (isTranslating) {
            updateStatus('active', 'Đang bật phụ đề');
            toggleBtn.classList.add('btn-active');
            toggleBtnText.textContent = 'Tắt dịch phụ đề';
        } else if (hasVideo) {
            updateStatus('ready', 'Video sẵn sàng');
            toggleBtn.classList.remove('btn-active');
            toggleBtnText.textContent = 'Bật dịch phụ đề';
        } else {
            updateStatus('ready', 'Đang chờ video...');
        }

        if (totalSentences > 0) {
            videoInfo.textContent = `🎯 Đã tải ${totalSentences} câu phụ đề (${currentSite || 'Video'})`;
            videoInfo.classList.add('show');
        }
    }

    // Button actions
    toggleBtn.addEventListener('click', async () => {
        toggleBtn.disabled = true;
        const res = await sendTabMessage({
            action: 'toggleTranslate',
            settings: getCurrentSettings()
        });
        toggleBtn.disabled = false;
        if (res) {
            if (res.isTranslating) {
                toggleBtn.classList.add('btn-active');
                toggleBtnText.textContent = 'Tắt dịch phụ đề';
                updateStatus('active', 'Đang bật phụ đề');
            } else {
                toggleBtn.classList.remove('btn-active');
                toggleBtnText.textContent = 'Bật dịch phụ đề';
                updateStatus('ready', 'Đã tắt dịch');
            }
            if (res.totalSentences) {
                videoInfo.textContent = `🎯 Đã tải ${res.totalSentences} câu phụ đề`;
                videoInfo.classList.add('show');
            }
        }
    });

    reloadBtn.addEventListener('click', async () => {
        updateStatus('loading', 'Đang tải lại & dịch...');
        const res = await sendTabMessage({
            action: 'reloadTranslate',
            settings: getCurrentSettings()
        });
        if (res?.isTranslating) {
            updateStatus('active', 'Đã dịch xong');
            toggleBtn.classList.add('btn-active');
            toggleBtnText.textContent = 'Tắt dịch phụ đề';
        } else {
            updateStatus('ready', 'Đã làm mới');
        }
    });

    const resetPosBtn = document.getElementById('resetPosBtn');
    if (resetPosBtn) {
        resetPosBtn.addEventListener('click', async () => {
            await sendTabMessage({ action: 'resetPosition' });
            updateStatus('ready', 'Đã đặt lại vị trí phụ đề');
        });
    }
});