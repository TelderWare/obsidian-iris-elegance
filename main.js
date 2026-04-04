'use strict';

const { Plugin, PluginSettingTab, Setting, Menu, SuggestModal, MarkdownView, ItemView, Notice, setIcon, getIconIds, getIcon } = require('obsidian');
const child_process = require('child_process');
const nodePath = require('path');
const electron = require('electron');

const VIEW_TYPE_WEB = 'elegance-web-view';


function formatTime(s) {
    if (!s || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
}

class EleganceWebView extends ItemView {
    constructor(leaf, url, plugin) {
        super(leaf);
        this._url = url;
        this._plugin = plugin;
        this._title = null;
        this._sourceFilePath = null;
        this._isDragging = false;
        this._lastDuration = 0;
        this._syncInterval = null;
    }
    getViewType() { return VIEW_TYPE_WEB; }
    getDisplayText() { return this._title || 'Video'; }
    getIcon() { return 'tv-minimal-play'; }

    setTitle(title) {
        this._title = title || null;
        if (this.nicknameInput) this.nicknameInput.value = this._title || '';
        this.leaf.updateHeader();
    }

    getState() {
        const state = super.getState();
        state.url = this._url || '';
        if (this._title) state.title = this._title;
        if (this._sourceFilePath) state.sourceFilePath = this._sourceFilePath;
        return state;
    }

    async setState(state, result) {
        await super.setState(state, result);
        if (state.url && !this._url) {
            this._url = state.url;
            if (this.wv) this.loadUrl(this._url);
        }
        if (state.title) this._title = state.title;
        if (state.sourceFilePath) this._sourceFilePath = state.sourceFilePath;
    }

    async onOpen() {
        // Loading overlay — shown immediately
        this.loadingEl = this.contentEl.createEl('div', {
            cls: 'elegance-video-loading',
        });
        const loadingIcon = this.loadingEl.createEl('div', {
            cls: 'elegance-video-loading-icon',
        });
        setIcon(loadingIcon, 'tv-minimal-play');
        this.loadingStatus = this.loadingEl.createEl('div', {
            cls: 'elegance-video-loading-status',
        });

        // Wrapper (hidden until ready)
        const wrapper = this.contentEl.createEl('div', {
            cls: 'elegance-video-wrapper elegance-video-hidden',
        });

        // Nickname widget — hover-expand icon + input at top-right
        // Placed on contentEl (not wrapper) so it renders above the webview's native surface
        this.nicknameWrap = this.contentEl.createEl('div', {
            cls: 'elegance-nickname-wrap',
        });
        const nicknameIcon = this.nicknameWrap.createEl('button', {
            cls: 'elegance-nickname-icon clickable-icon',
            attr: { 'aria-label': 'Set nickname' },
        });
        setIcon(nicknameIcon, 'pencil');
        this.nicknameInput = this.nicknameWrap.createEl('input', {
            cls: 'elegance-nickname-input',
            type: 'text',
            placeholder: 'Nickname…',
        });
        if (this._title) this.nicknameInput.value = this._title;

        const commitNickname = async () => {
            const value = this.nicknameInput.value.trim();
            if (value === (this._title || '')) return;
            this.setTitle(value || null);
            if (!this._sourceFilePath || !this._plugin) return;
            const file = this._plugin.app.vault.getAbstractFileByPath(this._sourceFilePath);
            if (!file) return;
            const prop = this._plugin.settings.titleProperty;
            if (!prop) return;
            await this._plugin.app.fileManager.processFrontMatter(file, (fm) => {
                if (value) { fm[prop] = value; } else { delete fm[prop]; }
            });
        };

        this.nicknameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.nicknameInput.blur(); }
            if (e.key === 'Escape') {
                this.nicknameInput.value = this._title || '';
                this.nicknameInput.blur();
            }
        });
        this.nicknameInput.addEventListener('blur', () => commitNickname());

        this.nicknameWrap.addEventListener('mouseenter', () => {
            this.nicknameWrap.classList.add('is-expanded');
        });
        this.nicknameWrap.addEventListener('mouseleave', () => {
            if (document.activeElement !== this.nicknameInput) {
                this.nicknameWrap.classList.remove('is-expanded');
            }
        });
        nicknameIcon.addEventListener('click', () => {
            this.nicknameWrap.classList.add('is-expanded');
            this.nicknameInput.focus();
            this.nicknameInput.select();
        });
        this.nicknameInput.addEventListener('blur', () => {
            this.nicknameWrap.classList.remove('is-expanded');
        });

        // Inner box — holds webview + controls, gets centered in wrapper
        this.innerBox = wrapper.createEl('div', {
            cls: 'elegance-video-inner',
        });

        // Single webview — loads the Echo360 page, then gets cleaned up via CSS
        this.wv = this.innerBox.createEl('webview', {
            attr: { partition: 'persist:elegance-echo360' },
        });

        // Control bar
        this.controlBar = this.innerBox.createEl('div', {
            cls: 'elegance-video-controls',
        });

        // Keyboard shortcuts — document-level, scoped to when this leaf is active
        this._onKeydown = (e) => {
            if (this.app.workspace.activeLeaf !== this.leaf) return;
            if (this.nicknameInput && document.activeElement === this.nicknameInput) return;
            if (e.key === ' ') { e.preventDefault(); this.execVideo('togglePlayPause'); }
            if (e.key === 'ArrowLeft') { e.preventDefault(); this._skip(-10); }
            if (e.key === 'ArrowRight') { e.preventDefault(); this._skip(10); }
        };
        document.addEventListener('keydown', this._onKeydown);

        // If url was provided at construction, start loading
        if (this._url) this.loadUrl(this._url);
    }

    _debugLog(msg) {
        const fs = require('fs');
        const logPath = nodePath.join(
            this.app.vault.adapter.basePath,
            this.app.vault.configDir, 'plugins', 'elegance', 'debug.log'
        );
        const line = new Date().toISOString() + ' ' + msg + '\n';
        fs.appendFileSync(logPath, line);
    }

    setLoadingStatus(text) {
        if (this.loadingStatus) this.loadingStatus.textContent = text;
    }

    showRetryButton(onClick) {
        if (this._retryBtn) this._retryBtn.remove();
        this._retryBtn = this.loadingEl.createEl('button', {
            cls: 'elegance-video-loading-retry',
            text: 'Retry',
        });
        this._retryBtn.addEventListener('click', () => {
            this._retryBtn.remove();
            this._retryBtn = null;
            onClick();
        });
    }

    hideRetryButton() {
        if (this._retryBtn) { this._retryBtn.remove(); this._retryBtn = null; }
    }

    showLoading() {
        if (this.loadingEl) this.loadingEl.style.display = '';
        const wrapper = this.contentEl.querySelector('.elegance-video-wrapper');
        if (wrapper) wrapper.classList.add('elegance-video-hidden');
    }

    loadUrl(url) {
        this._url = url;
        this._readyRetries = 0;
        this._debugLog('loadUrl: ' + url);

        this.wv.setAttribute('src', url);
        this.wv.addEventListener('dom-ready', () => {
            const wvUrl = this.wv.getURL();
            this._debugLog('dom-ready: ' + wvUrl);
            if (!wvUrl || wvUrl === 'about:blank') return;

            // Detect login redirect — cookies were expired
            const lower = wvUrl.toLowerCase();
            if (lower.includes('/login') || lower.includes('/auth') || lower.includes('/signin')) {
                this._debugLog('login redirect detected: ' + wvUrl);
                if (this.onLoginRequired) {
                    this.onLoginRequired();
                    return;
                }
            }

            this.waitForVideos();
        });
    }

    async waitForVideos() {
        try {
            const videoCount = await this.wv.executeJavaScript(
                `document.querySelectorAll('video').length`
            );
            this._debugLog('waitForVideos attempt ' + (this._readyRetries + 1)
                + ' | videos: ' + videoCount);

            if (videoCount > 0) {
                // Videos exist — run JS cleanup + inject persistent CSS
                await this.wv.executeJavaScript(`(function(){
                    var videos = Array.from(document.querySelectorAll('video'));

                    // Mark all video ancestors with elegance-keep
                    videos.forEach(function(v) {
                        var el = v.parentElement;
                        while (el && el !== document.body) {
                            el.classList.add('elegance-keep');
                            el = el.parentElement;
                        }
                    });

                    // Find active streams
                    var active = videos.filter(function(v){ return v.videoWidth > 0 && v.readyState >= 2; });
                    var target = active.length > 0 ? active : videos;

                    // If only one stream active, hide the other
                    if (videos.length >= 2 && active.length === 1) {
                        for (var vi = 0; vi < videos.length; vi++) {
                            if (active.indexOf(videos[vi]) >= 0) continue;
                            var c = videos[vi].parentElement;
                            while (c && c !== document.body) {
                                var sibs = c.parentElement ? c.parentElement.children : [];
                                if (sibs.length >= 2) { c.style.display = 'none'; break; }
                                c = c.parentElement;
                            }
                        }
                    }

                    // Expand ancestors to fill all available space
                    for (var ti = 0; ti < target.length; ti++) {
                        var el = target[ti].parentElement;
                        while (el && el !== document.body) {
                            el.style.cssText += 'width:100%!important;max-width:100%!important;'
                                + 'height:100%!important;margin:0!important;padding:0!important;'
                                + 'background:transparent!important;position:relative!important;';
                            el = el.parentElement;
                        }
                        target[ti].style.cssText = 'width:100%!important;height:100%!important;display:block!important;object-fit:contain!important;';
                    }

                    // Side by side if both active
                    if (target.length >= 2) {
                        var p = target[0].parentElement;
                        while (p && p !== document.body) {
                            if (p.contains(target[1])) {
                                p.style.display = 'flex';
                                p.style.flexDirection = 'row';
                                for (var ci = 0; ci < p.children.length; ci++) {
                                    if (p.children[ci].querySelector('video') || p.children[ci].tagName === 'VIDEO') {
                                        p.children[ci].style.flex = '1';
                                        p.children[ci].style.minWidth = '0';
                                    }
                                }
                                break;
                            }
                            p = p.parentElement;
                        }
                    }

                    // Centering wrapper
                    var cage = document.getElementById('elegance-cage');
                    if (!cage) {
                        cage = document.createElement('div');
                        cage.id = 'elegance-cage';
                        cage.classList.add('elegance-keep');
                        while (document.body.firstChild) cage.appendChild(document.body.firstChild);
                        document.body.appendChild(cage);
                    }
                    cage.style.cssText = 'width:100%!important;height:100%!important;background:transparent!important;';

                    document.body.style.cssText = 'margin:0!important;padding:0!important;'
                        + 'overflow:hidden!important;background:transparent!important;'
                        + 'width:100%!important;height:100vh!important;';
                })()`);

                // Persistent CSS — hides UI chrome but keeps elements in DOM so SPA controls still work
                await this.wv.insertCSS(`
                    #elegance-cage > *:not(.elegance-keep):not(style):not(script):not(:has(video)):not(:has(canvas)) {
                        visibility: hidden !important; position: absolute !important; pointer-events: none !important;
                        width: 0 !important; height: 0 !important; overflow: hidden !important;
                    }
                    .elegance-keep > *:not(.elegance-keep):not(video):not(canvas):not(style):not(script):not(:has(video)):not(:has(canvas)) {
                        visibility: hidden !important; position: absolute !important; pointer-events: none !important;
                        width: 0 !important; height: 0 !important; overflow: hidden !important;
                    }
                    body > *:not(#elegance-cage):not(style):not(script) {
                        visibility: hidden !important; position: absolute !important; pointer-events: none !important;
                        width: 0 !important; height: 0 !important; overflow: hidden !important;
                    }
                `);

                // Always start from the beginning
                await this.wv.executeJavaScript(`(function(){
                    var vids = Array.from(document.querySelectorAll('video'));
                    vids.forEach(function(v){ v.currentTime = 0; });
                })()`);

                if (!this._controlsBuilt) {
                    this.buildControlBar();
                    this._controlsBuilt = true;
                }
                this.startStateSync();
                this.reveal();
                return;
            }
        } catch (err) {
            this._debugLog('waitForVideos error: ' + err.message);
        }

        this._readyRetries++;
        if (this._readyRetries < 20) {
            setTimeout(() => this.waitForVideos(), 500);
        } else {
            this._debugLog('gave up waiting for videos');
            new Notice('Elegance: no video found on page', 8000);
        }
    }

    reveal() {
        if (this.loadingEl) {
            this.loadingEl.remove();
            this.loadingEl = null;
        }
        const wrapper = this.contentEl.querySelector('.elegance-video-wrapper');
        if (wrapper) wrapper.classList.remove('elegance-video-hidden');
    }

    buildControlBar() {
        const bar = this.controlBar;
        bar.empty();

        // Play / Pause
        this.playPauseBtn = bar.createEl('span', { cls: 'elegance-ctrl-btn', attr: { 'aria-label': 'Play / Pause' } });
        setIcon(this.playPauseBtn, 'play');
        this.playPauseBtn.addEventListener('click', () => this.execVideo('togglePlayPause'));

        // Skip back 10s
        const skipBack = bar.createEl('span', { cls: 'elegance-ctrl-btn', attr: { 'aria-label': 'Back 10s' } });
        setIcon(skipBack, 'skip-back');
        skipBack.addEventListener('click', () => this._skip(-10));

        // Skip forward 10s
        const skipFwd = bar.createEl('span', { cls: 'elegance-ctrl-btn', attr: { 'aria-label': 'Forward 10s' } });
        setIcon(skipFwd, 'skip-forward');
        skipFwd.addEventListener('click', () => this._skip(10));

        // Seek bar
        this.seekWrap = bar.createEl('div', { cls: 'elegance-seek-wrap' });
        this.seekBar = this.seekWrap.createEl('input', {
            cls: 'elegance-ctrl-seek',
            attr: { type: 'range', min: '0', max: '1000', value: '0', step: '1' },
        });
        this.seekBar.addEventListener('mousedown', () => { this._isDragging = true; });
        this.seekBar.addEventListener('input', () => {
            if (this._isDragging && this._lastDuration) {
                const t = (this.seekBar.value / 1000) * this._lastDuration;
                this.timeDisplay.textContent = formatTime(t) + ' / ' + formatTime(this._lastDuration);
            }
        });
        this.seekBar.addEventListener('change', () => {
            this._isDragging = false;
            if (this._lastDuration) {
                const seekTo = (this.seekBar.value / 1000) * this._lastDuration;
                this.execVideo('seek', seekTo);
            }
        });

        // Time display
        this.timeDisplay = bar.createEl('span', {
            cls: 'elegance-ctrl-time',
            text: '0:00 / 0:00',
        });

        // Speed — click opens menu
        this.speedBtn = bar.createEl('span', {
            cls: 'elegance-ctrl-btn elegance-ctrl-speed',
            text: '1x',
            attr: { 'aria-label': 'Playback speed' },
        });
        this.speedBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
            for (const s of speeds) {
                menu.addItem((item) => {
                    item.setTitle(s + 'x');
                    item.onClick(() => this.execVideo('setSpeed', s).then(() => {
                        this.speedBtn.textContent = s + 'x';
                    }));
                });
            }
            menu.showAtMouseEvent(e);
        });

    }

    async execVideo(action, value) {
        // Helper: find the active video (visible, with dimensions), fallback to first
        const findV = `function findV(){
            var vids = Array.from(document.querySelectorAll('video'));
            var active = vids.filter(function(v){ return v.videoWidth > 0 && v.offsetParent !== null; });
            return active.length > 0 ? active[0] : vids[0] || null;
        }`;
        const commands = {
            togglePlayPause: `(function(){
                // Strategy 1: click native Echo360 play/pause button
                var btns = document.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                    var label = (btns[i].getAttribute('aria-label') || '').toLowerCase();
                    if (label === 'play' || label === 'pause') {
                        btns[i].click();
                        ${findV}
                        var v = findV();
                        return v ? (v.paused ? 'paused' : 'playing') : 'clicked';
                    }
                }
                // Strategy 2: spacebar keydown on document
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true
                }));
                ${findV}
                var v = findV();
                return v ? (v.paused ? 'paused' : 'playing') : 'spacebar';
            })()`,
            skip: `(function(){
                ${findV}
                var v = findV();
                if (!v) return null;
                v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + (${value})));
                return v.currentTime;
            })()`,
            setSpeed: `new Promise(function(resolve){
                var btn = document.getElementById('playback-speed-menu-menu-toggle-btn');
                if (!btn) { resolve(null); return; }
                btn.click();
                setTimeout(function(){
                    var target = ${value};
                    var targetStr = target + 'x';
                    var items = document.querySelectorAll('#playback-speed-menu li[role="menuitemradio"]');
                    var found = false;
                    for (var i = 0; i < items.length; i++) {
                        if (items[i].textContent.indexOf(targetStr) >= 0) {
                            items[i].click(); found = true; break;
                        }
                    }
                    if (!found) btn.click();
                    resolve(found ? target : null);
                }, 300);
            })`,
            seek: `(function(){
                var vids = document.querySelectorAll('video');
                if (!vids.length) return null;
                vids.forEach(function(v){ v.currentTime = ${value}; });
                return vids[0].currentTime;
            })()`,
            getState: `(function(){
                ${findV}
                var v = findV();
                if (!v) return null;
                return {
                    paused: v.paused,
                    muted: v.muted,
                    speed: v.playbackRate,
                    currentTime: v.currentTime,
                    duration: v.duration
                };
            })()`,
        };
        const code = commands[action];
        if (!code) return null;
        try {
            return await this.wv.executeJavaScript(code, true);
        } catch {
            return null;
        }
    }

    startStateSync() {
        this._ratioApplied = false;
        this._syncInterval = setInterval(async () => {
            const state = await this.execVideo('getState');
            if (!state) return;
            this.updateIcons(state);
            if (!this._ratioApplied) {
                this._ratioApplied = await this._applyAspectRatio();
            }
        }, 1000);
    }

    async _applyAspectRatio() {
        try {
            const ratio = await this.wv.executeJavaScript(`(function(){
                var v = document.querySelector('video');
                if (!v || !v.videoWidth || !v.videoHeight) return 0;
                return v.videoWidth / v.videoHeight;
            })()`);
            if (ratio > 0) {
                this.wv.style.aspectRatio = String(ratio);
                // Switch inner box from flex-fill to shrink-wrap
                this.innerBox.style.flex = '0 0 auto';
                return true;
            }
        } catch {}
        return false;
    }

    _skip(seconds) {
        if (!this._lastDuration) return;
        const cur = (this.seekBar.value / 1000) * this._lastDuration;
        const seekTo = Math.max(0, Math.min(this._lastDuration, cur + seconds));
        this.seekBar.value = (seekTo / this._lastDuration) * 1000;
        this.timeDisplay.textContent = formatTime(seekTo) + ' / ' + formatTime(this._lastDuration);
        this.execVideo('seek', seekTo);
    }

    updateIcons(state) {
        setIcon(this.playPauseBtn, state.paused ? 'play' : 'pause');
        this.speedBtn.textContent = state.speed + 'x';

        if (!this._isDragging && state.duration) {
            this._lastDuration = state.duration;
            this.seekBar.value = (state.currentTime / state.duration) * 1000;
            this.timeDisplay.textContent = formatTime(state.currentTime) + ' / ' + formatTime(state.duration);
        }
    }

    async onClose() {
        if (this._syncInterval) {
            clearInterval(this._syncInterval);
            this._syncInterval = null;
        }
        if (this._onKeydown) {
            document.removeEventListener('keydown', this._onKeydown);
            this._onKeydown = null;
        }
    }
}

/* ================================================================
   Frontmatter action icons — config
   ================================================================ */

const FM_ACTIONS = [
    { key: 'download', cls: 'elegance-fm-download', label: 'Open download link' },
    { key: 'video',    cls: 'elegance-fm-video',    label: 'Open video link' },
    { key: 'slides',   cls: 'elegance-fm-slides',   label: 'Open slideshow' },
    { key: 'last-reviewed', cls: 'elegance-fm-last-reviewed', label: 'Mark as reviewed now', alwaysShow: true },
    { key: 'cement-embeds', cls: 'elegance-fm-cement-embeds', label: 'Cement embeds' },
];

/* ================================================================
   Plugin
   ================================================================ */

const DEFAULT_SETTINGS = {
    hiddenProperties: [],
    propertyIcons: {},
    titleProperty: 'displayTitle',
    hiddenFolders: [],
    folderDisplayNames: {},
    betterEmbeds: true,
    collapseProperties: true,
    reviewFolders: ['Lectures', 'Glossary'],
};

class ElegancePlugin extends Plugin {
    async onload() {
        /* ---------- Web view ---------- */
        this.registerView(VIEW_TYPE_WEB, (leaf) => new EleganceWebView(leaf, this._pendingUrl, this));

        /* ---------- Settings ---------- */
        await this.loadSettings();

        /* ---------- Frontmatter ---------- */
        document.body.classList.add('elegance-fm-active');
        if (this.settings.collapseProperties) {
            document.body.classList.add('elegance-props-collapsing');
            document.body.classList.add('elegance-props-collapsed');
        }
        this.app.workspace.onLayoutReady(() => {
            this.updateActionIcons();
            this.markHiddenProperties();
            this.applyPropertyIcons();
            this.updateAllDisplayTitles();
            this.withExplorerPaused(() => this.updateExplorerFolders());
            this.setupExplorerObserver();
            this.setupPropertyIconObserver();
            setTimeout(() => this.collapseAllProperties(), 200);

            // Re-attach login handlers to restored video views
            this.app.workspace.getLeavesOfType(VIEW_TYPE_WEB).forEach(leaf => {
                const view = leaf.view;
                if (view._url && view._url.includes('echo360')) {
                    view.onLoginRequired = async () => {
                        this._echo360Authenticated = false;
                        view.showLoading();
                        const onProgress = (msg) => view.setLoadingStatus?.(msg);
                        try {
                            await this.echo360Login(onProgress);
                            onProgress('Loading video...');
                            view.loadUrl(view._url);
                        } catch (err) {
                            onProgress('Login failed — ' + err.message);
                        }
                    };
                }
            });
        });

        // Keep Echo360 session alive with periodic pings (every 10 min)
        this._keepAliveInterval = setInterval(() => this._echo360KeepAlive(), 10 * 60 * 1000);

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.settings.collapseProperties) {
                    document.body.classList.add('elegance-props-collapsing');
                }
                if (this.settings.titleProperty) {
                    document.body.classList.add('elegance-title-swapping');
                }
                this.updateActionIcons();
                this.markHiddenProperties();
                this.applyPropertyIcons();
                this.updateAllDisplayTitles();
                if (this.settings.titleProperty) {
                    requestAnimationFrame(() => {
                        this.updateAllDisplayTitles();
                        document.body.classList.remove('elegance-title-swapping');
                    });
                }
                setTimeout(() => {
                    this.collapseAllProperties();
                }, 50);
            })
        );
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                this.updateActionIcons();
                this.markHiddenProperties();
                this.applyPropertyIcons();
                this.updateDisplayTitleForFile(file);
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                this.handleRename(file, oldPath);
            })
        );
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                clearTimeout(this.displayTitleTimeout);
                this.displayTitleTimeout = setTimeout(() => {
                    this.updateAllDisplayTitles();
                    this.markHiddenProperties();
                    this.applyPropertyIcons();
                    // If explorer observer isn't set up yet (panel opened after startup), try now
                    if (!this.explorerObserver) {
                        this.setupExplorerObserver();
                    }
                    // Fallback: update folders on layout-change in case observer misses expand/collapse
                    this.withExplorerPaused(() => this.updateExplorerFolders());
                }, 100);
            })
        );

        /* ---------- Hidden Properties ---------- */
        this.addCommand({
            id: 'toggle-hidden-properties',
            name: 'Toggle hidden properties',
            callback: () => {
                document.body.classList.toggle('elegance-show-hidden');
            }
        });

        /* ---------- Better Embeds ---------- */
        if (this.settings.betterEmbeds) {
            this.processedEmbeds = new WeakSet();
            this.embedProcessTimeout = null;

            this.setupEmbedObserver();

            this.app.workspace.onLayoutReady(() => {
                setTimeout(() => this.processAllVisibleEmbeds(), 300);
            });

            this.registerEvent(
                this.app.workspace.on('active-leaf-change', () => {
                    setTimeout(() => this.processAllVisibleEmbeds(), 200);
                })
            );

            this.registerEvent(
                this.app.workspace.on('layout-change', () => {
                    clearTimeout(this.embedProcessTimeout);
                    this.embedProcessTimeout = setTimeout(() => this.processAllVisibleEmbeds(), 150);
                })
            );
        }

        /* ---------- Property icon context menu ---------- */
        // Use capture phase so we intercept before Obsidian's handler creates its menu,
        // then monkey-patch Menu.showAtMouseEvent to inject our items into that menu.
        const iconContextHandler = (e) => {
            const iconEl = e.target.closest('.metadata-property-icon');
            if (!iconEl) return;
            const propEl = iconEl.closest('.metadata-property');
            if (!propEl) return;
            const key = propEl.getAttribute('data-property-key');
            if (!key) return;

            const plugin = this;
            let injected = false;
            const origShow = Menu.prototype.showAtMouseEvent;

            Menu.prototype.showAtMouseEvent = function(event) {
                injected = true;
                Menu.prototype.showAtMouseEvent = origShow;
                this.addSeparator();
                plugin._addIconMenuItems(this, key);
                origShow.call(this, event);
            };

            // Safety: restore patch if Obsidian doesn't create a menu this tick
            setTimeout(() => {
                Menu.prototype.showAtMouseEvent = origShow;
                if (!injected) {
                    // No Obsidian menu was created — show our own
                    e.preventDefault();
                    const menu = new Menu();
                    plugin._addIconMenuItems(menu, key);
                    menu.showAtMouseEvent(e);
                }
            }, 0);
        };
        document.addEventListener('contextmenu', iconContextHandler, true);
        this.register(() => document.removeEventListener('contextmenu', iconContextHandler, true));

        /* ---------- Settings ---------- */
        this.addSettingTab(new EleganceSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        /* Echo360 keep-alive cleanup */
        if (this._keepAliveInterval) {
            clearInterval(this._keepAliveInterval);
            this._keepAliveInterval = null;
        }

        /* Frontmatter cleanup */
        document.body.classList.remove('elegance-fm-active');
        document.body.classList.remove('elegance-show-hidden');
        document.body.classList.remove('elegance-props-collapsing');
        document.body.classList.remove('elegance-props-collapsed');
        document.body.classList.remove('elegance-title-swapping');
        document.querySelectorAll('.elegance-fm-action').forEach(el => el.remove());
        document.querySelectorAll('.elegance-prop-hidden').forEach(el => {
            el.classList.remove('elegance-prop-hidden');
        });
        document.querySelectorAll('.metadata-property-icon[data-elegance-original-icon]').forEach(el => {
            el.innerHTML = el.getAttribute('data-elegance-original-icon');
            el.removeAttribute('data-elegance-original-icon');
            el.removeAttribute('data-elegance-icon');
        });

        /* Display title cleanup — restore original titles */
        this.restoreAllDisplayTitles();
        this.restoreExplorerFolders();

        /* Embed cleanup */
        document.querySelectorAll('.elegance-embed-title').forEach(el => el.remove());
        document.querySelectorAll('.elegance-embed-nav-btn').forEach(el => el.remove());
        document.querySelectorAll('.elegance-embed-seamless').forEach(el => {
            el.style.borderLeft = '';
            el.style.marginLeft = '';
            el.style.paddingLeft = '';
            el.style.borderLeftColor = '';
            el.classList.remove('elegance-embed-seamless');
        });
    }

    /* ============================================================
       Frontmatter — action icons
       ============================================================ */

    updateActionIcons() {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        if (!leaves.length) { this.clearActionIcons(); return; }

        for (const leaf of leaves) {
            const view = leaf.view;
            const file = view?.file;
            if (!file) continue;

            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const heading = view.containerEl.querySelector('.metadata-properties-heading');
            if (!heading) continue;

            // Match action icon color to the native properties title
            const titleEl = heading.querySelector('.metadata-properties-title');
            const titleColor = titleEl ? getComputedStyle(titleEl).color : null;

            for (const action of FM_ACTIONS) {
                const url = frontmatter?.[action.key];
                const resolved = action.key === 'video' ? this.resolveVideoUrl(url, file)
                               : action.key === 'slides' ? this.resolveSlidesPath(url, file)
                               : url;
                const videoFile = action.key === 'video' ? this.resolveVideoFile(url, file) : null;
                const existing = heading.querySelector(`.${action.cls}`);
                let shouldShow = action.alwaysShow || (resolved && typeof resolved === 'string' && resolved.trim());
                if (action.key === 'last-reviewed') {
                    const folders = this.settings.reviewFolders;
                    shouldShow = folders.length === 0 || folders.some(f => file.path.startsWith(f + '/'));
                }
                if (action.key === 'cement-embeds') {
                    const mode = view.getMode?.() ?? view.currentMode?.type;
                    const cache = this.app.metadataCache.getFileCache(file);
                    shouldShow = mode === 'source' && (cache?.embeds?.some(e => {
                        const dest = this.app.metadataCache.getFirstLinkpathDest(e.link.split('#')[0], file.path);
                        return dest && dest.extension === 'md';
                    }) ?? false);
                }

                if (shouldShow) {
                    if (existing) {
                        if (resolved && typeof resolved === 'string') existing._eleganceUrl = resolved.trim();
                        existing._eleganceFile = file;
                        if (videoFile) existing._eleganceVideoFile = videoFile;
                        if (titleColor) existing.style.color = titleColor;
                    } else {
                        const icon = document.createElement('span');
                        icon.className = `elegance-fm-action ${action.cls}`;
                        icon.setAttribute('aria-label', action.label);
                        if (resolved && typeof resolved === 'string') icon._eleganceUrl = resolved.trim();
                        icon._eleganceFile = file;
                        if (videoFile) icon._eleganceVideoFile = videoFile;
                        if (titleColor) icon.style.color = titleColor;
                        icon.addEventListener('click', (evt) => {
                            evt.stopPropagation();
                            evt.preventDefault();
                            if (action.key === 'video') {
                                this.openWebView(icon._eleganceUrl, icon._eleganceVideoFile || icon._eleganceFile);
                            } else if (action.key === 'slides') {
                                this.openSlideshow(icon._eleganceUrl, icon._eleganceFile);
                            } else if (action.key === 'last-reviewed') {
                                this.setLastReviewed(icon._eleganceFile);
                            } else if (action.key === 'cement-embeds') {
                                this.cementAllEmbeds(icon._eleganceFile);
                            } else {
                                window.open(icon._eleganceUrl, '_blank');
                            }
                        });
                        heading.appendChild(icon);
                    }
                } else if (existing) {
                    existing.remove();
                }
            }
        }
    }

    clearActionIcons() {
        document.querySelectorAll('.elegance-fm-action').forEach(el => el.remove());
    }

    resolveVideoUrl(raw, sourceFile) {
        if (!raw || typeof raw !== 'string') return raw;
        const m = raw.trim().match(/^\[\[([^\]]+)\]\]$/);
        if (!m) return raw;
        const linkPath = m[1].split('#')[0].split('|')[0];
        const target = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
        if (!target) return raw;
        const fm = this.app.metadataCache.getFileCache(target)?.frontmatter;
        return fm?.video && typeof fm.video === 'string' ? fm.video.trim() : raw;
    }

    /** Return the file whose frontmatter actually holds the video URL. */
    resolveVideoFile(raw, sourceFile) {
        if (!raw || typeof raw !== 'string') return sourceFile;
        const m = raw.trim().match(/^\[\[([^\]]+)\]\]$/);
        if (!m) return sourceFile;
        const linkPath = m[1].split('#')[0].split('|')[0];
        return this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path) || sourceFile;
    }

    /**
     * Resolve a slides property to a vault path.
     * Supports:
     *   - Plain vault path:  "Lectures/slides.pdf"
     *   - Direct wiki-link to a file:  "[[Lectures/slides.pdf]]"
     *   - Indirect wiki-link to a note whose own `slides` property holds the
     *     real path (mirrors how video handles Echo360 indirection).
     */
    resolveSlidesPath(raw, sourceFile) {
        if (!raw || typeof raw !== 'string') return raw;
        const m = raw.trim().match(/^\[\[([^\]]+)\]\]$/);
        if (!m) return raw.trim();
        const linkPath = m[1].split('#')[0].split('|')[0];
        const target = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
        if (!target) return raw;
        // If the target is already a PDF/PPTX, use it directly
        if (/\.(pdf|pptx)$/i.test(target.path)) return target.path;
        // Otherwise treat it as an intermediary note — read its `slides` frontmatter
        const fm = this.app.metadataCache.getFileCache(target)?.frontmatter;
        if (fm?.slides && typeof fm.slides === 'string') {
            return this.resolveSlidesPath(fm.slides, target);
        }
        return target.path;
    }

    /** Open a PDF in the pptx-viewer slideshow view. */
    async openSlideshow(vaultPath, sourceFile) {
        if (!vaultPath) return;
        const file = this.app.vault.getAbstractFileByPath(vaultPath);
        if (!file) {
            new Notice(`Slideshow not found: ${vaultPath}`);
            return;
        }
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({
            type: 'pdf-slideshow',
            state: { file: file.path },
        });
    }

    async setLastReviewed(file) {
        if (!file) return;
        const now = window.moment().format('YYYY-MM-DDTHH:mm');
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm['last-reviewed'] = now;
        });
    }

    async openWebView(url, sourceFile) {
        const fs = require('fs');
        const logPath = nodePath.join(
            this.app.vault.adapter.basePath,
            this.app.vault.configDir, 'plugins', 'elegance', 'debug.log'
        );
        const log = (msg) => fs.appendFileSync(logPath, new Date().toISOString() + ' ' + msg + '\n');

        log('openWebView called: ' + url);

        // Open the leaf immediately so the loading icon is visible
        this._pendingUrl = null;
        const leaf = this.app.workspace.getLeaf('split', 'vertical');
        await leaf.setViewState({ type: VIEW_TYPE_WEB, active: true });
        this.app.workspace.revealLeaf(leaf);

        const view = leaf.view;
        log('view type: ' + (view?.getViewType?.() || 'unknown') + ' hasLoadUrl: ' + !!view?.loadUrl);

        // Apply display title from source note
        if (sourceFile && view) {
            view._sourceFilePath = sourceFile.path;
            const title = this.getDisplayTitle(sourceFile);
            if (title) view.setTitle(title);
        }

        const doLogin = async () => {
            const onProgress = (msg) => view.setLoadingStatus?.(msg);
            view.hideRetryButton();
            try {
                await this.echo360Login(onProgress);
                log('login succeeded');
                onProgress('Loading video...');
            } catch (err) {
                log('login failed: ' + err.message);
                onProgress('Login failed — ' + err.message);
                view.showRetryButton(() => {
                    view.setLoadingStatus?.('');
                    doLogin().then((ok) => {
                        if (!ok) return;
                        log('retry: calling view.loadUrl...');
                        view.loadUrl(url);
                    });
                });
                return false;
            }
            return true;
        };

        if (url.includes('echo360')) {
            // Check cookie status — skip login, preemptively refresh, or do full login
            const cookieStatus = await this._echo360CookieStatus();
            log('echo360 cookie status: ' + cookieStatus);

            if (cookieStatus === 'valid') {
                log('skipping login — cookies valid');
                view.setLoadingStatus?.('Loading video...');
            } else if (cookieStatus === 'expiring-soon') {
                log('cookies expiring soon — preemptive refresh');
                view.setLoadingStatus?.('Refreshing session...');
                const ok = await doLogin();
                if (!ok) return;
            } else {
                log('starting login...');
                const ok = await doLogin();
                if (!ok) return;
            }

            // If the webview gets redirected to a login page, re-authenticate
            view.onLoginRequired = async () => {
                log('login redirect detected — re-authenticating');
                this._echo360Authenticated = false;
                view.showLoading();
                const ok = await doLogin();
                if (!ok) return;
                log('re-auth done, reloading...');
                view.loadUrl(url);
            };
        }

        // Now load the actual URL
        log('calling view.loadUrl...');
        view.loadUrl(url);
    }

    /**
     * Returns 'valid', 'expiring-soon', or 'none'.
     * 'expiring-soon' means at least one cookie expires within 15 minutes.
     */
    async _echo360CookieStatus() {
        const ses = electron.remote
            ? electron.remote.session.fromPartition('persist:elegance-echo360')
            : electron.session?.fromPartition('persist:elegance-echo360');
        if (!ses) return 'none';
        try {
            const cookies = await ses.cookies.get({ domain: 'echo360.org.uk' });
            if (cookies.length === 0) return 'none';
            const now = Date.now() / 1000;
            const soonSec = 15 * 60; // 15 minutes
            const expiring = cookies.some(c =>
                c.expirationDate && (c.expirationDate - now) < soonSec
            );
            return expiring ? 'expiring-soon' : 'valid';
        } catch {
            return 'none';
        }
    }

    async _echo360KeepAlive() {
        if (!this._echo360Authenticated) return;
        const ses = electron.remote
            ? electron.remote.session.fromPartition('persist:elegance-echo360')
            : electron.session?.fromPartition('persist:elegance-echo360');
        if (!ses) return;
        try {
            const cookies = await ses.cookies.get({ domain: 'echo360.org.uk' });
            if (cookies.length === 0) return;
            // Fire a lightweight request using the session's cookies to keep alive
            const { net } = electron.remote || electron;
            const req = net.request({
                method: 'HEAD',
                url: 'https://echo360.org.uk',
                partition: 'persist:elegance-echo360',
            });
            req.on('error', () => {}); // swallow errors silently
            req.end();
        } catch {}
    }

    async echo360Login(onProgress) {
        onProgress?.('Reading credentials...');

        // Read credentials from Iris's settings
        const irisDataPath = nodePath.join(
            this.app.vault.adapter.basePath,
            this.app.vault.configDir, 'plugins', 'iris', 'data.json'
        );
        let irisData;
        try {
            const raw = require('fs').readFileSync(irisDataPath, 'utf8');
            irisData = JSON.parse(raw);
        } catch {
            throw new Error('Could not read Iris settings — is the Iris plugin installed?');
        }

        const email = irisData.echo360?.email;
        const password = irisData.echo360?.password;
        if (!email || !password) {
            throw new Error('No Echo360 credentials found in Iris settings.');
        }

        const scriptPath = nodePath.join(
            this.app.vault.adapter.basePath,
            this.manifest.dir, 'echo360_login.py'
        );

        onProgress?.('Launching browser...');

        const result = await this.execPythonStreaming(scriptPath, [], onProgress,
            JSON.stringify({ email, password }));

        if (!result || result.status !== 'success' || !result.cookies) {
            throw new Error(result?.message || 'Login returned unexpected response');
        }

        onProgress?.('Injecting session...');

        // Inject cookies into the webview partition
        const ses = electron.remote
            ? electron.remote.session.fromPartition('persist:elegance-echo360')
            : electron.session?.fromPartition('persist:elegance-echo360');

        if (ses) {
            for (const c of result.cookies) {
                const cookie = {
                    url: `https://${c.domain.replace(/^\./, '')}`,
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || '/',
                    secure: c.secure ?? true,
                    httpOnly: c.httpOnly ?? false,
                };
                // Preserve expiry so we can detect soon-to-expire cookies
                if (c.expiry) cookie.expirationDate = c.expiry;
                await ses.cookies.set(cookie);
            }
        }

        this._echo360Authenticated = true;
    }

    execPythonStreaming(scriptPath, args, onProgress, stdinData) {
        return new Promise((resolve, reject) => {
            const proc = child_process.spawn('python', [scriptPath, ...args], {
                windowsHide: true,
            });
            if (stdinData) {
                proc.stdin.write(stdinData);
                proc.stdin.end();
            }
            let buffer = '';
            let finalResult = null;

            proc.stdout.on('data', (d) => {
                buffer += d.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line in buffer
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const msg = JSON.parse(line);
                        if (msg.status === 'progress') {
                            onProgress?.(msg.message);
                        } else if (msg.status === 'success' || msg.status === 'error') {
                            finalResult = msg;
                        }
                    } catch {}
                }
            });

            proc.on('close', () => {
                // Process any remaining data in buffer
                if (buffer.trim()) {
                    try {
                        const msg = JSON.parse(buffer);
                        if (msg.status === 'success' || msg.status === 'error') {
                            finalResult = msg;
                        }
                    } catch {}
                }
                resolve(finalResult);
            });
            proc.on('error', (err) => { reject(err); });
        });
    }

    /** Add "Change icon" / "Reset icon" items to a Menu for the given property key */
    _addIconMenuItems(menu, key) {
        menu.addItem(item => {
            item.setTitle('Change icon')
                .setIcon('pencil')
                .onClick(() => new IconPickerModal(this.app, this, key).open());
        });
        const lowerKey = key.toLowerCase();
        if (this.settings.propertyIcons[lowerKey]) {
            menu.addItem(item => {
                item.setTitle('Reset icon')
                    .setIcon('rotate-ccw')
                    .onClick(async () => {
                        delete this.settings.propertyIcons[lowerKey];
                        await this.saveSettings();
                        this.applyPropertyIcons();
                    });
            });
        }

        const isHidden = this.settings.hiddenProperties
            .some(p => p.toLowerCase() === lowerKey);
        menu.addItem(item => {
            if (isHidden) {
                item.setTitle('Unhide property')
                    .setIcon('eye')
                    .onClick(async () => {
                        this.settings.hiddenProperties = this.settings.hiddenProperties
                            .filter(p => p.toLowerCase() !== lowerKey);
                        await this.saveSettings();
                        this.markHiddenProperties();
                    });
            } else {
                item.setTitle('Hide property')
                    .setIcon('eye-off')
                    .onClick(async () => {
                        this.settings.hiddenProperties.push(lowerKey);
                        await this.saveSettings();
                        this.markHiddenProperties();
                    });
            }
        });
    }

    /* ============================================================
       Collapse Properties — auto-collapse on note open
       ============================================================ */

    collapseAllProperties() {
        if (!this.settings.collapseProperties) {
            document.body.classList.remove('elegance-props-collapsing');
            return;
        }
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const container = leaf.view?.containerEl?.querySelector('.metadata-container');
            if (container && !container.classList.contains('is-collapsed')) {
                const heading = container.querySelector('.metadata-properties-heading');
                if (heading) heading.click();
            }
        });
        document.body.classList.remove('elegance-props-collapsing');
    }

    /* ============================================================
       Hidden Properties
       ============================================================ */

    markHiddenProperties() {
        const hidden = this.settings.hiddenProperties;
        const hiddenSet = hidden?.length
            ? new Set(hidden.map(p => p.toLowerCase()))
            : null;

        document.querySelectorAll('.metadata-property').forEach(el => {
            const key = el.getAttribute('data-property-key');
            if (hiddenSet && key && hiddenSet.has(key.toLowerCase())) {
                el.classList.add('elegance-prop-hidden');
            } else {
                el.classList.remove('elegance-prop-hidden');
            }
        });
    }

    /* ============================================================
       Property Icons — custom Lucide icons per property
       ============================================================ */

    setupPropertyIconObserver() {
        if (this._propIconObserver) this._propIconObserver.disconnect();

        this._propIconPaused = false;
        this._propIconTimer = null;

        this._propIconObserver = new MutationObserver(() => {
            if (this._propIconPaused) return;
            clearTimeout(this._propIconTimer);
            this._propIconTimer = setTimeout(() => this.applyPropertyIcons(), 80);
        });

        // Observe all workspace leaves so we catch metadata panels in any pane
        const container = document.querySelector('.workspace');
        if (container) {
            this._propIconObserver.observe(container, {
                childList: true,
                subtree: true,
            });
        }

        this.register(() => this._propIconObserver?.disconnect());
    }

    applyPropertyIcons() {
        // Pause observer so our own setIcon() calls don't re-trigger it.
        // MutationObserver callbacks are microtasks, so they fire before the
        // setTimeout macrotask that unpauses — guaranteeing our mutations are
        // ignored while external (Obsidian) mutations after we finish are not.
        this._propIconPaused = true;

        const icons = this.settings.propertyIcons;
        const lookup = {};
        if (icons) {
            for (const [key, icon] of Object.entries(icons)) {
                lookup[key.toLowerCase()] = icon;
            }
        }

        document.querySelectorAll('.metadata-property').forEach(el => {
            const key = el.getAttribute('data-property-key');
            if (!key) return;

            const iconName = lookup[key.toLowerCase()];
            const iconEl = el.querySelector('.metadata-property-icon');
            if (!iconEl) return;

            if (iconName) {
                if (!iconEl.hasAttribute('data-elegance-original-icon')) {
                    iconEl.setAttribute('data-elegance-original-icon', iconEl.innerHTML);
                }
                // Always re-apply — Obsidian can overwrite the SVG children
                // without clearing our data attribute
                setIcon(iconEl, iconName);
                iconEl.setAttribute('data-elegance-icon', iconName);
            } else {
                const original = iconEl.getAttribute('data-elegance-original-icon');
                if (original) {
                    iconEl.innerHTML = original;
                    iconEl.removeAttribute('data-elegance-original-icon');
                    iconEl.removeAttribute('data-elegance-icon');
                }
            }
        });

        // Unpause after our mutation observer callbacks have been delivered
        setTimeout(() => { this._propIconPaused = false; }, 0);
    }

    /* ============================================================
       Display Title — frontmatter-driven title override
       ============================================================ */

    getDisplayTitle(file) {
        if (!file) return null;
        const prop = this.settings.titleProperty;
        if (!prop) return null;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        return fm?.[prop] ?? null;
    }

    updateAllDisplayTitles() {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            this.updateLeafDisplayTitle(leaf);
        });
        this.updateVideoTitles();
        this.withExplorerPaused(() => {
            this.updateExplorerTitles();
        });
    }

    updateDisplayTitleForFile(file) {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            if (leaf.view?.file?.path === file.path) {
                this.updateLeafDisplayTitle(leaf);
            }
        });
        this.updateVideoTitlesForFile(file);
        this.withExplorerPaused(() => {
            this.updateExplorerTitles();
        });
    }

    updateVideoTitles() {
        this.app.workspace.getLeavesOfType(VIEW_TYPE_WEB).forEach(leaf => {
            const view = leaf.view;
            if (!view?._sourceFilePath) return;
            const file = this.app.vault.getAbstractFileByPath(view._sourceFilePath);
            const title = this.getDisplayTitle(file);
            view.setTitle(title);
        });
    }

    updateVideoTitlesForFile(file) {
        this.app.workspace.getLeavesOfType(VIEW_TYPE_WEB).forEach(leaf => {
            const view = leaf.view;
            if (view?._sourceFilePath !== file.path) return;
            const title = this.getDisplayTitle(file);
            view.setTitle(title);
        });
    }

    updateLeafDisplayTitle(leaf) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || !view.file) return;

        const title = this.getDisplayTitle(view.file);
        const originalName = view.file.basename;

        // Inline title — skip if the user is actively editing it
        const inlineTitleEl = view.containerEl.querySelector('.inline-title');
        if (inlineTitleEl && !inlineTitleEl.matches(':focus')) {
            const target = title || originalName;
            if (inlineTitleEl.textContent !== target) {
                inlineTitleEl.textContent = target;
            }
        }

        // Tab title
        const tabTitleEl = leaf.tabHeaderInnerTitleEl;
        if (tabTitleEl) {
            const target = title || originalName;
            if (tabTitleEl.textContent !== target) {
                tabTitleEl.textContent = target;
            }
        }
    }

    updateExplorerTitles() {
        const prop = this.settings.titleProperty;
        if (!prop) return;

        document.querySelectorAll('.nav-file-title').forEach(el => {
            const path = el.getAttribute('data-path');
            if (!path) return;

            const file = this.app.vault.getAbstractFileByPath(path);
            if (!file) return;

            const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
            const displayTitle = fm?.[prop];
            const contentEl = el.querySelector('.nav-file-title-content');
            if (!contentEl) return;

            if (displayTitle) {
                if (!contentEl.hasAttribute('data-elegance-original')) {
                    contentEl.setAttribute('data-elegance-original', contentEl.textContent);
                }
                if (contentEl.textContent !== displayTitle) {
                    contentEl.textContent = displayTitle;
                }
            } else {
                const original = contentEl.getAttribute('data-elegance-original');
                if (original && contentEl.textContent !== original) {
                    contentEl.textContent = original;
                }
                contentEl.removeAttribute('data-elegance-original');
            }
        });
    }

    setupExplorerObserver() {
        const explorerEl = document.querySelector('.nav-files-container');
        if (!explorerEl) return;
        if (this.explorerObserver) this.explorerObserver.disconnect();

        // Immediately apply folder hiding/renaming to avoid flash of original names
        this.hideExplorerFolders();
        this.renameExplorerFolders();

        this._explorerPaused = false;
        this._explorerRafPending = false;

        this.explorerObserver = new MutationObserver(() => {
            if (this._explorerPaused) return;
            if (!this._explorerRafPending) {
                this._explorerRafPending = true;
                requestAnimationFrame(() => {
                    this._explorerRafPending = false;
                    this.withExplorerPaused(() => {
                        this.updateExplorerTitles();
                        this.updateExplorerFolders();
                    });
                });
            }
        });

        this.explorerObserver.observe(explorerEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'data-path'],
        });

        this.register(() => this.explorerObserver?.disconnect());
    }

    /** Run fn while the explorer observer is paused to avoid feedback loops */
    withExplorerPaused(fn) {
        this._explorerPaused = true;
        try { fn(); } finally { this._explorerPaused = false; }
    }

    /* ============================================================
       Explorer Folders — hiding and display names
       ============================================================ */

    updateExplorerFolders() {
        this.hideExplorerFolders();
        this.renameExplorerFolders();
    }

    hideExplorerFolders() {
        const hidden = this.settings.hiddenFolders;
        const hiddenSet = hidden?.length
            ? new Set(hidden.map(f => f.toLowerCase()))
            : null;

        document.querySelectorAll('.nav-folder').forEach(el => {
            const titleEl = el.querySelector(':scope > .nav-folder-title');
            if (!titleEl) return;
            const path = titleEl.getAttribute('data-path');
            if (!path) return;

            // Match on the folder's own name (last segment of path)
            const name = path.split('/').pop().toLowerCase();
            if (hiddenSet && hiddenSet.has(name)) {
                el.classList.add('elegance-folder-hidden');
            } else {
                el.classList.remove('elegance-folder-hidden');
            }
        });
    }

    /** Strip common prefixes from folder names (number ranges, module codes) */
    cleanFolderName(name) {
        let cleaned = name;
        // Strip leading number range: "1-10, " or "5, "
        cleaned = cleaned.replace(/^\d+(-\d+)?,\s*/, '');
        // Strip leading module code: "LF111 " or "CH171 "
        cleaned = cleaned.replace(/^[A-Z]{2,}\d{3,}\s+/, '');
        return cleaned;
    }

    renameExplorerFolders() {
        const map = this.settings.folderDisplayNames;
        // Build a lowercase lookup for case-insensitive matching
        const lookup = {};
        if (map) {
            for (const [path, name] of Object.entries(map)) {
                lookup[path.toLowerCase()] = name;
            }
        }

        document.querySelectorAll('.nav-folder-title').forEach(el => {
            const path = el.getAttribute('data-path');
            if (!path) return;
            const contentEl = el.querySelector('.nav-folder-title-content');
            if (!contentEl) return;

            // Explicit override takes priority
            let displayName = lookup[path.toLowerCase()];

            // Fall back to auto-cleaned name
            if (!displayName) {
                const folderName = path.split('/').pop();
                const cleaned = this.cleanFolderName(folderName);
                if (cleaned !== folderName) displayName = cleaned;
            }

            if (displayName) {
                if (!contentEl.hasAttribute('data-elegance-original')) {
                    contentEl.setAttribute('data-elegance-original', contentEl.textContent);
                }
                if (contentEl.textContent !== displayName) {
                    contentEl.textContent = displayName;
                }
            } else {
                const original = contentEl.getAttribute('data-elegance-original');
                if (original && contentEl.textContent !== original) {
                    contentEl.textContent = original;
                }
                contentEl.removeAttribute('data-elegance-original');
            }
        });
    }

    restoreExplorerFolders() {
        document.querySelectorAll('.elegance-folder-hidden').forEach(el => {
            el.classList.remove('elegance-folder-hidden');
        });
        document.querySelectorAll('.nav-folder-title-content[data-elegance-original]').forEach(el => {
            el.textContent = el.getAttribute('data-elegance-original');
            el.removeAttribute('data-elegance-original');
        });
    }

    restoreAllDisplayTitles() {
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            const view = leaf.view;
            if (!(view instanceof MarkdownView) || !view.file) return;
            const name = view.file.basename;

            const inlineTitleEl = view.containerEl.querySelector('.inline-title');
            if (inlineTitleEl && inlineTitleEl.textContent !== name) {
                inlineTitleEl.textContent = name;
            }

            const tabTitleEl = leaf.tabHeaderInnerTitleEl;
            if (tabTitleEl && tabTitleEl.textContent !== name) {
                tabTitleEl.textContent = name;
            }
        });

        // Restore explorer titles
        document.querySelectorAll('.nav-file-title-content[data-elegance-original]').forEach(el => {
            el.textContent = el.getAttribute('data-elegance-original');
            el.removeAttribute('data-elegance-original');
        });
    }

    /* ============================================================
       Rename handling — refresh stale original-name attributes
       ============================================================ */

    handleRename(file, oldPath) {
        // Refresh explorer file titles — update stored original name for renamed items
        document.querySelectorAll('.nav-file-title-content[data-elegance-original]').forEach(el => {
            const titleEl = el.closest('.nav-file-title');
            if (titleEl?.getAttribute('data-path') === file.path) {
                el.setAttribute('data-elegance-original', file.basename || file.name);
            }
        });

        // Refresh explorer folder titles
        document.querySelectorAll('.nav-folder-title-content[data-elegance-original]').forEach(el => {
            const titleEl = el.closest('.nav-folder-title');
            if (titleEl?.getAttribute('data-path') === file.path) {
                el.setAttribute('data-elegance-original', file.name);
            }
        });

        // Re-run display title updates for the renamed file
        this.updateDisplayTitleForFile(file);
    }

    /* ============================================================
       Better Embeds — seamless note embedding
       ============================================================ */

    setupEmbedObserver() {
        const workspaceEl = this.app.workspace.containerEl;

        this.embedObserver = new MutationObserver((mutations) => {
            let shouldProcess = false;

            for (const mutation of mutations) {
                if (mutation.type === 'attributes' &&
                    mutation.target.classList &&
                    mutation.target.classList.contains('markdown-embed') &&
                    mutation.target.classList.contains('is-loaded')) {
                    shouldProcess = true;
                    break;
                }

                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if ((node.classList && node.classList.contains('markdown-embed')) ||
                                (node.querySelector && node.querySelector('.markdown-embed.is-loaded'))) {
                                shouldProcess = true;
                                break;
                            }
                        }
                    }
                    if (shouldProcess) break;
                }
            }

            if (shouldProcess) {
                clearTimeout(this.embedProcessTimeout);
                this.embedProcessTimeout = setTimeout(() => this.processAllVisibleEmbeds(), 50);
            }
        });

        this.embedObserver.observe(workspaceEl, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });

        this.register(() => this.embedObserver.disconnect());
    }

    processAllVisibleEmbeds() {
        const embeds = document.querySelectorAll('.markdown-embed.is-loaded');
        for (const embed of embeds) {
            if (!this.processedEmbeds.has(embed)) {
                if (embed.closest('.hover-popover')) continue;
                this.processEmbed(embed);
                this.processedEmbeds.add(embed);
            }
        }
    }

    processEmbed(embed) {
        const content = embed.querySelector(':scope > .markdown-embed-content');
        if (!content) return;

        const contextLevel = this.findContextHeadingLevel(embed);
        const titleLevel = Math.min(contextLevel + 1, 6);

        // Replace the title with a proper heading
        const titleEl = embed.querySelector(':scope > .markdown-embed-title');
        const titleText = titleEl ? titleEl.textContent.trim() : '';

        if (titleText) {
            const heading = document.createElement('h' + titleLevel);
            heading.textContent = titleText;
            heading.className = 'elegance-embed-title';
            titleEl.after(heading);
        }

        // Shift content headings so they're sub-headings of the title
        const allHeadings = content.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const ownHeadings = [];
        for (const h of allHeadings) {
            if (h.closest('.markdown-embed') === embed) {
                ownHeadings.push(h);
            }
        }

        if (ownHeadings.length > 0) {
            let minLevel = 6;
            for (const h of ownHeadings) {
                const level = parseInt(h.tagName[1]);
                if (level < minLevel) minLevel = level;
            }

            const targetTopLevel = titleText ? titleLevel + 1 : titleLevel;
            const shift = targetTopLevel - minLevel;

            if (shift > 0) {
                for (const h of ownHeadings) {
                    const oldLevel = parseInt(h.tagName[1]);
                    const newLevel = Math.min(oldLevel + shift, 6);
                    if (newLevel !== oldLevel) {
                        const newH = document.createElement('h' + newLevel);
                        for (const attr of h.attributes) {
                            newH.setAttribute(attr.name, attr.value);
                        }
                        newH.innerHTML = h.innerHTML;
                        h.replaceWith(newH);
                    }
                }
            }
        }

        // Add navigate-to-note button
        const src = embed.getAttribute('src') ||
                    embed.closest('.internal-embed')?.getAttribute('src') || '';
        if (src) {
            const btn = document.createElement('span');
            btn.className = 'elegance-embed-nav-btn';
            btn.setAttribute('aria-label', 'Open note');
            setIcon(btn, 'maximize-2');
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const file = this.app.metadataCache.getFirstLinkpathDest(src.split('#')[0], '');
                if (file) {
                    this.app.workspace.openLinkText(file.path, '', false);
                }
            });
            embed.prepend(btn);

            // Add transclude-snapshot button (to the left of nav button)
            const snapBtn = document.createElement('span');
            snapBtn.className = 'elegance-embed-snap-btn';
            snapBtn.setAttribute('aria-label', 'Replace embed with content');
            setIcon(snapBtn, 'anchor');
            snapBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const linkPath = src.split('#')[0];
                const subpath = src.includes('#') ? src.split('#').slice(1).join('#') : '';
                const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
                if (!file) {
                    new Notice('Cannot resolve embedded file.');
                    return;
                }

                // Find the leaf containing this embed via DOM
                const leafEl = embed.closest('.workspace-leaf');
                const leaves = this.app.workspace.getLeavesOfType('markdown');
                const leaf = leaves.find(l => l.containerEl === leafEl);
                if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.view.editor) {
                    new Notice('No active editor found.');
                    return;
                }
                const editor = leaf.view.editor;
                const sourceContent = editor.getValue();

                // Find the ![[src]] syntax in the source (with optional |display text)
                const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const embedRegex = new RegExp('!\\[\\[' + escapedSrc + '(\\|[^\\]]*)?\\]\\]');
                const match = sourceContent.match(embedRegex);
                if (!match) {
                    new Notice('Could not find embed syntax in source.');
                    return;
                }

                // Read the embedded file
                let embeddedContent;
                try {
                    embeddedContent = await this.app.vault.cachedRead(file);
                } catch (err) {
                    new Notice('Could not read embedded file.');
                    return;
                }

                // Strip frontmatter
                embeddedContent = embeddedContent.replace(/^---\n[\s\S]*?\n---\n?/, '');

                // Extract section if #heading is present
                if (subpath) {
                    embeddedContent = this.extractSection(embeddedContent, subpath);
                    if (!embeddedContent) {
                        new Notice('Could not find section "' + subpath + '" in file.');
                        return;
                    }
                }

                // Determine heading context and build title + shifted content
                const contextLevel = this.findContextHeadingLevel(embed);
                const titleLevel = Math.min(contextLevel + 1, 6);
                const titleText = subpath || file.basename;
                const titleLine = '#'.repeat(titleLevel) + ' ' + titleText;

                // Shift all headings in the content so they sit below the title
                const targetTopLevel = titleLevel + 1;
                const contentLines = embeddedContent.split('\n');
                let minLevel = 7;
                for (const line of contentLines) {
                    const m = line.match(/^(#{1,6})\s/);
                    if (m && m[1].length < minLevel) minLevel = m[1].length;
                }
                const shift = minLevel < 7 ? targetTopLevel - minLevel : 0;
                if (shift > 0) {
                    for (let i = 0; i < contentLines.length; i++) {
                        contentLines[i] = contentLines[i].replace(/^(#{1,6})(\s)/, (_, hashes, sp) => {
                            const newLevel = Math.min(hashes.length + shift, 6);
                            return '#'.repeat(newLevel) + sp;
                        });
                    }
                }

                const finalContent = titleLine + '\n' + contentLines.join('\n');

                // Replace the embed syntax with the content, preserving scroll
                const matchIndex = sourceContent.indexOf(match[0]);
                const from = editor.offsetToPos(matchIndex);
                const to = editor.offsetToPos(matchIndex + match[0].length);
                const scrollInfo = editor.getScrollInfo();
                editor.replaceRange(finalContent.trimEnd(), from, to);
                // Defer scroll restoration so it runs after Obsidian's live-preview re-render
                requestAnimationFrame(() => editor.scrollTo(scrollInfo.left, scrollInfo.top));

                new Notice('Embed replaced with content snapshot.');
            });
            embed.prepend(snapBtn);

            // Add delete-embed button (rightmost)
            const delBtn = document.createElement('span');
            delBtn.className = 'elegance-embed-del-btn';
            delBtn.setAttribute('aria-label', 'Delete embed');
            setIcon(delBtn, 'trash-2');
            delBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const leafEl = embed.closest('.workspace-leaf');
                const leaves = this.app.workspace.getLeavesOfType('markdown');
                const leaf = leaves.find(l => l.containerEl === leafEl);
                if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.view.editor) {
                    new Notice('No active editor found.');
                    return;
                }
                const editor = leaf.view.editor;
                const sourceContent = editor.getValue();

                const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const embedRegex = new RegExp('!\\[\\[' + escapedSrc + '(\\|[^\\]]*)?\\]\\]');
                const match = sourceContent.match(embedRegex);
                if (!match) {
                    new Notice('Could not find embed syntax in source.');
                    return;
                }

                const matchIndex = sourceContent.indexOf(match[0]);
                const from = editor.offsetToPos(matchIndex);
                const to = editor.offsetToPos(matchIndex + match[0].length);
                const scrollInfo = editor.getScrollInfo();
                editor.replaceRange('', from, to);
                requestAnimationFrame(() => editor.scrollTo(scrollInfo.left, scrollInfo.top));

                new Notice('Embed deleted.');
            });
            embed.prepend(delBtn);
        }

        // Click-to-edit: track hover position, then open source at that exact caret
        if (src) {
            let hoverInfo = null;

            // Continuously track the character position under the mouse
            embed.addEventListener('mousemove', (e) => {
                const range = document.caretRangeFromPoint(e.clientX, e.clientY);
                if (!range || !range.startContainer || range.startContainer.nodeType !== 3) {
                    hoverInfo = null;
                    return;
                }
                const text = range.startContainer.textContent;
                const off = range.startOffset;
                // Grab up to 20 chars either side of the caret for a unique search key
                const start = Math.max(0, off - 20);
                const end = Math.min(text.length, off + 20);
                hoverInfo = {
                    searchText: text.substring(start, end),
                    caretInSearch: off - start,
                };
            });

            embed.addEventListener('click', (e) => {
                if (e.target.closest('.elegance-embed-nav-btn') || e.target.closest('.elegance-embed-snap-btn') || e.target.closest('.elegance-embed-del-btn')) return;
                if (e.target.closest('a')) return;

                const file = this.app.metadataCache.getFirstLinkpathDest(src.split('#')[0], '');
                if (!file) return;

                const snapHover = hoverInfo;
                const clickY = e.clientY;

                // Reuse an existing tab if the file is already open
                const existing = this.app.workspace.getLeavesOfType('markdown')
                    .find(l => l.view?.file?.path === file.path);
                const leaf = existing || this.app.workspace.getLeaf('tab');

                const positionCursor = () => {
                    if (!(leaf.view instanceof MarkdownView)) return;
                    const view = leaf.view;

                    // Switch to source/live-preview so the editor is available
                    const state = view.getState();
                    if (state.mode === 'preview') {
                        state.mode = 'source';
                        view.setState(state, { history: false });
                    }

                    if (!snapHover) return;
                    const editor = view.editor;
                    const content = editor.getValue();
                    const idx = content.indexOf(snapHover.searchText);
                    if (idx !== -1) {
                        const caretIdx = idx + snapHover.caretInSearch;
                        const pos = editor.offsetToPos(caretIdx);
                        editor.setCursor(pos);

                        // Scroll the caret line to the same screen-Y as the click
                        const cm = editor.cm;
                        if (cm) {
                            const rect = cm.coordsAtPos(cm.state.selection.main.head);
                            if (rect) {
                                const scrollEl = cm.scrollDOM;
                                const offsetInScroller = clickY - scrollEl.getBoundingClientRect().top;
                                scrollEl.scrollTop += rect.top - scrollEl.getBoundingClientRect().top - offsetInScroller;
                            }
                        } else {
                            editor.scrollIntoView({ from: pos, to: pos }, true);
                        }

                        // Flash-highlight the caret line
                        this.flashCaretLine(view);
                    }
                };

                if (existing) {
                    this.app.workspace.setActiveLeaf(leaf, { focus: true });
                    setTimeout(positionCursor, 50);
                } else {
                    leaf.openFile(file).then(() => {
                        this.app.workspace.setActiveLeaf(leaf, { focus: true });
                        positionCursor();
                    });
                }

                e.preventDefault();
                e.stopPropagation();
            });
        }

        embed.classList.add('elegance-embed-seamless');

        // Apply accent left bar — inline !important beats everything
        embed.style.setProperty('border-left', '1px solid color-mix(in srgb, var(--interactive-accent) 25%, transparent)', 'important');
        embed.style.setProperty('margin-left', '-4px', 'important');
        embed.style.setProperty('padding-left', '3px', 'important');
        embed.style.setProperty('transition', 'border-color 150ms ease');
        embed.addEventListener('mouseenter', () => {
            embed.style.setProperty('border-left-color', 'var(--interactive-accent)', 'important');
        });
        embed.addEventListener('mouseleave', () => {
            embed.style.setProperty('border-left-color', 'color-mix(in srgb, var(--interactive-accent) 25%, transparent)', 'important');
        });
    }

    flashCaretLine(view) {
        requestAnimationFrame(() => {
            const cm = view.editor?.cm;
            if (!cm) return;

            const coords = cm.coordsAtPos(cm.state.selection.main.head);
            if (!coords) return;

            const lineH = cm.defaultLineHeight || 22;
            const scroller = cm.scrollDOM.getBoundingClientRect();

            const caretX = ((coords.left - scroller.left) / scroller.width * 100).toFixed(1);

            const bar = document.createElement('div');
            bar.style.cssText =
                'position:fixed;pointer-events:none;z-index:9999;' +
                `left:${scroller.left}px;width:${scroller.width}px;` +
                `top:${coords.top}px;height:${lineH}px;` +
                `background:radial-gradient(25px 100% at ${caretX}% 50%, var(--interactive-accent) 0%, transparent 100%);`;
            document.body.appendChild(bar);

            bar.animate(
                [{ opacity: 0.25 }, { opacity: 0 }],
                { duration: 1200, easing: 'ease-out', fill: 'forwards' }
            ).onfinish = () => bar.remove();
        });
    }

    findContextHeadingLevel(embedEl) {
        const boundary = embedEl.closest('.markdown-embed-content') ||
                         embedEl.closest('.markdown-preview-sizer') ||
                         embedEl.closest('.cm-editor');

        let current = embedEl;

        while (current && current !== boundary) {
            let sibling = current.previousElementSibling;
            while (sibling) {
                const heading = this.findLastOwnHeading(sibling);
                if (heading) return parseInt(heading.tagName[1]);
                sibling = sibling.previousElementSibling;
            }
            current = current.parentElement;
        }

        if (boundary && boundary.classList.contains('markdown-embed-content')) {
            const parentEmbed = boundary.closest('.markdown-embed');
            if (parentEmbed) {
                const parentTitle = parentEmbed.querySelector(':scope > .elegance-embed-title');
                if (parentTitle) {
                    return parseInt(parentTitle.tagName[1]);
                }
            }
        }

        return 1;
    }

    findLastOwnHeading(el) {
        if (/^H[1-6]$/.test(el.tagName)) return el;

        const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (let i = headings.length - 1; i >= 0; i--) {
            const h = headings[i];
            const containingEmbed = h.closest('.markdown-embed');
            if (!containingEmbed || !el.contains(containingEmbed)) {
                return h;
            }
        }

        return null;
    }

    async cementAllEmbeds(file) {
        if (!file) return;

        const leaf = this.app.workspace.getLeavesOfType('markdown')
            .find(l => l.view?.file?.path === file.path);
        if (!leaf || !(leaf.view instanceof MarkdownView) || !leaf.view.editor) {
            new Notice('No active editor found.');
            return;
        }
        const editor = leaf.view.editor;
        let content = editor.getValue();

        // Match all embed syntax: ![[path#section|display]]
        const embedPattern = /!\[\[([^\]]+?)\]\]/g;
        const matches = [...content.matchAll(embedPattern)];
        if (!matches.length) {
            new Notice('No embeds found in this note.');
            return;
        }

        // Build all replacements first, then apply as a single transaction
        const changes = [];
        for (const match of matches) {
            const inner = match[1];
            const src = inner.split('|')[0];
            const linkPath = src.split('#')[0];
            const subpath = src.includes('#') ? src.split('#').slice(1).join('#') : '';

            const target = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
            if (!target || target.extension !== 'md') continue;

            let embeddedContent;
            try {
                embeddedContent = await this.app.vault.cachedRead(target);
            } catch { continue; }

            // Strip frontmatter
            embeddedContent = embeddedContent.replace(/^---\n[\s\S]*?\n---\n?/, '');

            // Extract section if #heading is present
            if (subpath) {
                embeddedContent = this.extractSection(embeddedContent, subpath);
                if (!embeddedContent) continue;
            }

            // Determine heading context from position in document
            const before = content.substring(0, match.index);
            const headingMatches = [...before.matchAll(/^(#{1,6})\s/gm)];
            const contextLevel = headingMatches.length ? headingMatches[headingMatches.length - 1][1].length : 0;
            const titleLevel = Math.min(contextLevel + 1, 6);
            const titleText = subpath || target.basename;
            const titleLine = '#'.repeat(titleLevel) + ' ' + titleText;

            // Shift headings in the content
            const contentLines = embeddedContent.split('\n');
            const targetTopLevel = titleLevel + 1;
            let minLevel = 7;
            for (const line of contentLines) {
                const m = line.match(/^(#{1,6})\s/);
                if (m && m[1].length < minLevel) minLevel = m[1].length;
            }
            const shift = minLevel < 7 ? targetTopLevel - minLevel : 0;
            if (shift > 0) {
                for (let j = 0; j < contentLines.length; j++) {
                    contentLines[j] = contentLines[j].replace(/^(#{1,6})(\s)/, (_, hashes, sp) => {
                        const newLevel = Math.min(hashes.length + shift, 6);
                        return '#'.repeat(newLevel) + sp;
                    });
                }
            }

            const finalContent = titleLine + '\n' + contentLines.join('\n').trimEnd();
            changes.push({ from: match.index, to: match.index + match[0].length, insert: finalContent });
        }

        if (!changes.length) {
            new Notice('No note embeds could be resolved.');
            return;
        }

        // Dispatch all changes as a single transaction so Ctrl+Z undoes them all at once
        const cm = editor.cm;
        const scrollInfo = editor.getScrollInfo();
        cm.dispatch({ changes });
        requestAnimationFrame(() => editor.scrollTo(scrollInfo.left, scrollInfo.top));

        new Notice(`Cemented ${changes.length} embed${changes.length > 1 ? 's' : ''}.`);
    }

    extractSection(markdown, headingText) {
        const lines = markdown.split('\n');
        let startLine = -1;
        let startLevel = 0;

        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
            if (m && m[2].trim() === headingText) {
                startLine = i;
                startLevel = m[1].length;
                break;
            }
        }

        if (startLine === -1) return null;

        let endLine = lines.length;
        for (let i = startLine + 1; i < lines.length; i++) {
            const m = lines[i].match(/^(#{1,6})\s+/);
            if (m && m[1].length <= startLevel) {
                endLine = i;
                break;
            }
        }

        return lines.slice(startLine, endLine).join('\n');
    }
}

/* ================================================================
   Icon picker modal
   ================================================================ */

class IconPickerModal extends SuggestModal {
    constructor(app, plugin, propertyKey) {
        super(app);
        this.plugin = plugin;
        this.propertyKey = propertyKey;
        this.allIcons = getIconIds();
        this.setPlaceholder('Search icons\u2026');
    }

    getSuggestions(query) {
        const q = query.toLowerCase();
        if (!q) return this.allIcons.slice(0, 100);
        return this.allIcons.filter(id => id.toLowerCase().includes(q));
    }

    renderSuggestion(iconId, el) {
        el.addClass('elegance-icon-suggestion');
        const svg = getIcon(iconId);
        if (svg) el.appendChild(svg);
        el.createSpan({ text: iconId });
    }

    async onChooseSuggestion(iconId) {
        this.plugin.settings.propertyIcons[this.propertyKey.toLowerCase()] = iconId;
        await this.plugin.saveSettings();
        this.plugin.applyPropertyIcons();
    }
}

/* ================================================================
   Settings tab
   ================================================================ */

class EleganceSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Collapse properties')
            .setDesc('Automatically collapse the frontmatter properties section when opening a note.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.collapseProperties)
                .onChange(async (value) => {
                    this.plugin.settings.collapseProperties = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Better embeds')
            .setDesc('Seamless note embedding with heading hierarchy, click-to-edit, and accent hover bar.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.betterEmbeds)
                .onChange(async (value) => {
                    this.plugin.settings.betterEmbeds = value;
                    await this.plugin.saveSettings();
                    // Reload plugin to apply
                    await this.plugin.app.plugins.disablePlugin('elegance');
                    await this.plugin.app.plugins.enablePlugin('elegance');
                }));

        /* ---------- Review folders ---------- */
        containerEl.createEl('h3', { text: 'Review folders' });
        containerEl.createEl('p', {
            text: 'The "Mark as reviewed" action only appears for notes inside these folders. Leave empty to show it everywhere.',
            cls: 'setting-item-description',
        });

        const reviewFolders = this.plugin.settings.reviewFolders;
        for (let i = 0; i < reviewFolders.length; i++) {
            const folder = reviewFolders[i];
            new Setting(containerEl)
                .setName(folder)
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Remove')
                    .onClick(async () => {
                        this.plugin.settings.reviewFolders.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.plugin.updateActionIcons();
                        this.display();
                    }));
        }

        let newReviewFolder = '';
        new Setting(containerEl)
            .setName('Add folder')
            .addText(text => text
                .setPlaceholder('Folder name')
                .onChange(v => { newReviewFolder = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    const name = newReviewFolder.trim();
                    if (name && !this.plugin.settings.reviewFolders.includes(name)) {
                        this.plugin.settings.reviewFolders.push(name);
                        await this.plugin.saveSettings();
                        this.plugin.updateActionIcons();
                        this.display();
                    }
                }));

        /* ---------- Property icons ---------- */
        containerEl.createEl('h3', { text: 'Property icons' });
        containerEl.createEl('p', {
            text: 'Override the default icon for a frontmatter property. Use any Lucide icon name (e.g. "calendar", "tag", "link", "flask-conical").',
            cls: 'setting-item-description',
        });

        const iconMap = this.plugin.settings.propertyIcons;
        for (const [prop, icon] of Object.entries(iconMap)) {
            const row = new Setting(containerEl)
                .setName(prop)
                .addText(text => text
                    .setValue(icon)
                    .setPlaceholder('Icon name')
                    .onChange(async (value) => {
                        if (value.trim()) {
                            this.plugin.settings.propertyIcons[prop] = value.trim();
                        } else {
                            delete this.plugin.settings.propertyIcons[prop];
                        }
                        await this.plugin.saveSettings();
                        this.plugin.applyPropertyIcons();
                        // Update preview
                        const preview = row.settingEl.querySelector('.elegance-icon-preview');
                        if (preview) setIcon(preview, value.trim() || 'help-circle');
                    }))
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Remove')
                    .onClick(async () => {
                        delete this.plugin.settings.propertyIcons[prop];
                        await this.plugin.saveSettings();
                        this.plugin.applyPropertyIcons();
                        this.display();
                    }));
            // Add icon preview
            const preview = row.settingEl.createSpan({ cls: 'elegance-icon-preview' });
            row.settingEl.querySelector('.setting-item-control').prepend(preview);
            setIcon(preview, icon);
        }

        let newIconProp = '';
        let newIconName = '';
        new Setting(containerEl)
            .setName('Add property icon')
            .addText(text => text
                .setPlaceholder('Property name')
                .onChange(v => { newIconProp = v; }))
            .addText(text => text
                .setPlaceholder('Icon name')
                .onChange(v => { newIconName = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    if (newIconProp.trim() && newIconName.trim()) {
                        this.plugin.settings.propertyIcons[newIconProp.trim().toLowerCase()] = newIconName.trim();
                        await this.plugin.saveSettings();
                        this.plugin.applyPropertyIcons();
                        this.display();
                    }
                }));

        /* ---------- Hidden properties ---------- */
        containerEl.createEl('h3', { text: 'Hidden properties' });
        containerEl.createEl('p', {
            text: 'Properties hidden from the frontmatter panel. Right-click a property icon to hide/unhide, or manage them here.',
            cls: 'setting-item-description',
        });

        const hiddenProps = this.plugin.settings.hiddenProperties;
        for (let i = 0; i < hiddenProps.length; i++) {
            const prop = hiddenProps[i];
            new Setting(containerEl)
                .setName(prop)
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Unhide')
                    .onClick(async () => {
                        this.plugin.settings.hiddenProperties.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.plugin.markHiddenProperties();
                        this.display();
                    }));
        }

        let newHiddenProp = '';
        new Setting(containerEl)
            .setName('Hide property')
            .addText(text => text
                .setPlaceholder('Property name')
                .onChange(v => { newHiddenProp = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    const name = newHiddenProp.trim().toLowerCase();
                    if (name && !this.plugin.settings.hiddenProperties.some(p => p.toLowerCase() === name)) {
                        this.plugin.settings.hiddenProperties.push(name);
                        await this.plugin.saveSettings();
                        this.plugin.markHiddenProperties();
                        this.display();
                    }
                }));

        /* ---------- Hidden folders ---------- */
        containerEl.createEl('h3', { text: 'Hidden folders' });

        const hiddenFolders = this.plugin.settings.hiddenFolders;
        for (let i = 0; i < hiddenFolders.length; i++) {
            const folder = hiddenFolders[i];
            new Setting(containerEl)
                .setName(folder)
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Unhide')
                    .onClick(async () => {
                        this.plugin.settings.hiddenFolders.splice(i, 1);
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.hideExplorerFolders());
                        this.display();
                    }));
        }

        let newHiddenFolder = '';
        new Setting(containerEl)
            .setName('Hide folder')
            .addText(text => text
                .setPlaceholder('Folder name')
                .onChange(v => { newHiddenFolder = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    const name = newHiddenFolder.trim();
                    if (name && !this.plugin.settings.hiddenFolders.includes(name)) {
                        this.plugin.settings.hiddenFolders.push(name);
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.hideExplorerFolders());
                        this.display();
                    }
                }));

        /* ---------- Folder display names ---------- */
        containerEl.createEl('h3', { text: 'Folder display names' });
        containerEl.createEl('p', {
            text: 'Number prefixes (e.g. "1-10, ") and module codes (e.g. "LF111 ") are stripped automatically. Add overrides below for custom names.',
            cls: 'setting-item-description',
        });

        const map = this.plugin.settings.folderDisplayNames;
        for (const [path, name] of Object.entries(map)) {
            new Setting(containerEl)
                .setName(path)
                .addText(text => text
                    .setValue(name)
                    .onChange(async (value) => {
                        if (value.trim()) {
                            this.plugin.settings.folderDisplayNames[path] = value.trim();
                        } else {
                            delete this.plugin.settings.folderDisplayNames[path];
                        }
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.renameExplorerFolders());
                    }))
                .addExtraButton(btn => btn
                    .setIcon('x')
                    .setTooltip('Remove override')
                    .onClick(async () => {
                        delete this.plugin.settings.folderDisplayNames[path];
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.renameExplorerFolders());
                        this.display();
                    }));
        }

        let newPath = '';
        let newName = '';
        new Setting(containerEl)
            .setName('Add override')
            .addText(text => text
                .setPlaceholder('Folder path')
                .onChange(v => { newPath = v; }))
            .addText(text => text
                .setPlaceholder('Display name')
                .onChange(v => { newName = v; }))
            .addButton(btn => btn
                .setButtonText('+')
                .onClick(async () => {
                    if (newPath.trim() && newName.trim()) {
                        this.plugin.settings.folderDisplayNames[newPath.trim()] = newName.trim();
                        await this.plugin.saveSettings();
                        this.plugin.withExplorerPaused(() => this.plugin.renameExplorerFolders());
                        this.display();
                    }
                }));
    }
}

module.exports = ElegancePlugin;
