import styles from './json-video-styles.js';

export class JsonVideo extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        
        this._videoData = null;
        this._processedScenes = [];
        this._totalDurationMs = 0;
        this._currentTimeMs = 0;
        this._isPlaying = false;
        this._currentSceneIndex = -1;
        this._lastTimestamp = 0;
        this._animationFrameId = null;
        this._showCaptions = true;

        this._mainAudio = new Audio();
        this._sceneAudio = new Audio();
        this._mainAudioPausedByScene = false;
        this._mainAudioResumeTime = 0;

        this._setupDOM();
    }

    _setupDOM() {
        const styleElement = document.createElement('style');
        styleElement.textContent = styles;
        const container = document.createElement('div');
        container.id = 'video-container';
        container.innerHTML = `
            <iframe id="scene-renderer" src="about:blank" scrolling="no"></iframe>
            <div id="closed-caption-overlay" class="hidden"><span class="cc-text"></span></div>
        `;
        this.shadowRoot.appendChild(styleElement);
        this.shadowRoot.appendChild(container);
        this.renderer = this.shadowRoot.querySelector('#scene-renderer');
        this.ccOverlay = this.shadowRoot.querySelector('#closed-caption-overlay');
        this.ccText = this.shadowRoot.querySelector('.cc-text');
    }

    // Standard Properties
    get src() { return this.getAttribute('src'); }
    set src(val) { this.setAttribute('src', val); }
    get currentTime() { return this._currentTimeMs; }
    set currentTime(ms) { this.seekTo(ms); }
    get duration() { return this._totalDurationMs; }
    get paused() { return !this._isPlaying; }

    /**
     * load() follows the native video element pattern.
     * It uses the current 'src' attribute to decide what to process.
     */
    async load() {
        const source = this.src;
        if (!source) return;

        this.pause();
        let data = null;

        try {
            // Check for Data URI to avoid fetch/CSP issues
            if (source.startsWith('data:application/json')) {
                const base64Match = source.match(/data:application\/json;base64,(.*)/);
                if (base64Match) {
                    data = JSON.parse(atob(base64Match[1]));
                } else {
                    const commaIndex = source.indexOf(',');
                    data = JSON.parse(decodeURIComponent(source.substring(commaIndex + 1)));
                }
            } else {
                // Remote fetch
                const response = await fetch(source);
                data = await response.json();
            }

            this._processLoadedData(data);
        } catch (e) {
            console.error("JsonVideo load error:", e);
            this.dispatchEvent(new CustomEvent('error', { detail: e }));
        }
    }

    _processLoadedData(data) {
        this._videoData = data;
        this._calculateDurations();
        
        if (data.audio) {
            this._mainAudio.src = data.audio;
            this._mainAudio.load();
        } else {
            this._mainAudio.removeAttribute('src');
        }

        this.seekTo(0);
        this.dispatchEvent(new Event('loadedmetadata'));
    }

    play() {
        if (!this._videoData || this._isPlaying) return;
        this._isPlaying = true;
        this._lastTimestamp = performance.now();
        this._syncAudioOnStart();
        this._animationFrameId = requestAnimationFrame((ts) => this._tick(ts));
        this.dispatchEvent(new Event('play'));
    }

    pause() {
        this._isPlaying = false;
        if (this._animationFrameId) cancelAnimationFrame(this._animationFrameId);
        this._mainAudio.pause();
        this._sceneAudio.pause();
        this._mainAudioPausedByScene = false;
        this.dispatchEvent(new Event('pause'));
    }

    seekTo(ms) {
        this._currentTimeMs = Math.max(0, Math.min(ms, this._totalDurationMs));
        let idx = this._processedScenes.findIndex(s => this._currentTimeMs >= s.startTimeMs && this._currentTimeMs < s.endTimeMs);
        if (idx === -1 && this._currentTimeMs >= this._totalDurationMs) idx = this._processedScenes.length - 1;
        if (idx === -1) idx = 0;
        this._currentSceneIndex = idx;
        const scene = this._processedScenes[idx];
        
        if (this._mainAudio.src) {
            const seekSec = this._currentTimeMs / 1000;
            if (scene?.pauseBackground) {
                this._mainAudio.pause();
                this._mainAudioResumeTime = seekSec;
                this._mainAudioPausedByScene = true;
            } else {
                try { this._mainAudio.currentTime = seekSec; } catch(e) {}
                if (this._isPlaying) this._mainAudio.play().catch(() => {});
                this._mainAudioPausedByScene = false;
            }
        }
        this._renderCurrentScene();
        this.dispatchEvent(new Event('timeupdate'));
    }

    setCaptions(visible) {
        this._showCaptions = visible;
        this._renderCurrentScene();
    }

    _calculateDurations() {
        this._totalDurationMs = 0;
        this._processedScenes = this._videoData.scenes.map(scene => {
            let dur = (scene.duration === "auto" || !scene.duration)
                ? (scene.speech ? Math.max(2000, scene.speech.split(/\s+/).filter(w => w.length).length * 350) : 2000)
                : (parseFloat(scene.duration) * 1000);
            const start = this._totalDurationMs;
            this._totalDurationMs += dur;
            return { ...scene, startTimeMs: start, endTimeMs: this._totalDurationMs };
        });
    }

    _tick(ts) {
        if (!this._isPlaying) return;
        const delta = ts - this._lastTimestamp;
        this._lastTimestamp = ts;
        this._currentTimeMs += delta;

        if (this._currentTimeMs >= this._totalDurationMs) {
            this.pause(); this.seekTo(this._totalDurationMs);
            this.dispatchEvent(new Event('ended'));
            return;
        }

        const newIdx = this._processedScenes.findIndex(s => this._currentTimeMs < s.endTimeMs);
        if (newIdx !== this._currentSceneIndex) this._handleSceneTransition(newIdx);
        
        this.dispatchEvent(new Event('timeupdate'));
        this._animationFrameId = requestAnimationFrame((ts) => this._tick(ts));
    }

    _handleSceneTransition(newIdx) {
        const prev = this._processedScenes[this._currentSceneIndex];
        const next = this._processedScenes[newIdx];
        if (this._mainAudio.src) {
            if (prev?.pauseBackground && this._mainAudioPausedByScene) {
                this._mainAudio.currentTime = this._mainAudioResumeTime;
                this._mainAudio.play().catch(() => {});
                this._mainAudioPausedByScene = false;
            }
            if (next?.pauseBackground) {
                this._mainAudioResumeTime = this._mainAudio.currentTime;
                this._mainAudio.pause();
                this._mainAudioPausedByScene = true;
            }
        }
        this._currentSceneIndex = newIdx;
        this._renderCurrentScene();
    }

    _syncAudioOnStart() {
        const scene = this._processedScenes[this._currentSceneIndex];
        if (this._mainAudio.src) {
            if (scene?.pauseBackground) {
                this._mainAudioResumeTime = this._currentTimeMs / 1000;
                this._mainAudioPausedByScene = true;
            } else {
                this._mainAudio.currentTime = this._currentTimeMs / 1000;
                this._mainAudio.play().catch(() => {});
                this._mainAudioPausedByScene = false;
            }
        }
    }

    _renderCurrentScene() {
        const scene = this._processedScenes[this._currentSceneIndex];
        if (!scene) return;
        const doc = this.renderer.contentDocument;
        doc.open(); doc.write(scene.html || ''); doc.close();
        if (doc.body) { doc.body.style.margin = '0'; doc.body.style.overflow = 'hidden'; }
        this.ccText.textContent = scene.speech || "";
        this.ccOverlay.classList.toggle('hidden', !(this._showCaptions && scene.speech));
        const sceneTime = (this._currentTimeMs - scene.startTimeMs) / 1000;
        if (scene.audio) {
            if (this._sceneAudio.getAttribute('src') !== scene.audio) {
                this._sceneAudio.src = scene.audio; this._sceneAudio.load();
            }
            try { if (Math.abs(this._sceneAudio.currentTime - sceneTime) > 0.2) this._sceneAudio.currentTime = Math.max(0, sceneTime); } catch(e) {}
            if (this._isPlaying) this._sceneAudio.play().catch(() => {});
        } else { this._sceneAudio.pause(); }
    }
}
customElements.define('json-video', JsonVideo);