import { FFmpeg } from './node_modules/@ffmpeg/ffmpeg/dist/esm/index.js';
import { toBlobURL, fetchFile } from './node_modules/@ffmpeg/util/dist/esm/index.js';

export class VideoExporter {
    constructor(playerElement) {
        this.player = playerElement;
        this.ffmpeg = new FFmpeg();
        this.fps = 10;
        this._isLoaded = false;
        this._frameCount = 0; // Track frames for VFS naming

        this.ffmpeg.on('log', ({ message }) => {
            window.dispatchEvent(new CustomEvent('ffmpeg-log', { detail: message }));
        });

        // Track internal encoding progress
        this.ffmpeg.on('progress', ({ progress }) => {
            const percent = Math.round(progress * 100);
            window.dispatchEvent(new CustomEvent('ffmpeg-progress', { detail: percent }));
        });
    }

    async init(statusCallback) {
        if (this._isLoaded) return;
        statusCallback("Initializing FFmpeg...");
        const baseURL = `${window.location.origin}/node_modules/@ffmpeg/core-mt/dist/esm/`;
        try {
            await this.ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
                workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
            });
            this._isLoaded = true;
            statusCallback("FFmpeg Ready.");
        } catch (e) {
            statusCallback("Init Failed: " + e.message);
        }
    }

    async captureAndEncode(statusCallback) {
        const totalDuration = this.player.duration;
        this._frameCount = 0;

        // 1. Audio Hijack Setup
        if (!this.audioCtx) {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.dest = this.audioCtx.createMediaStreamDestination();
            this.player.shadowRoot.querySelectorAll('audio').forEach(audio => {
                const source = this.audioCtx.createMediaElementSource(audio);
                source.connect(this.dest);
                source.connect(this.audioCtx.destination);
            });
        }
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

        const audioChunks = [];
        const recorder = new MediaRecorder(this.dest.stream, { mimeType: 'audio/webm;codecs=opus' });
        recorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };

        const frameInterval = 1000 / this.fps;
        let lastCaptureTime = 0;

        this.player.currentTime = 0;
        recorder.start(200);
        this.player.play();

        return new Promise((resolve, reject) => {
            const captureLoop = async (timestamp) => {
                if (this.player.currentTime >= totalDuration || this.player.paused) {
                    recorder.stop();
                    return;
                }

                if (timestamp - lastCaptureTime >= frameInterval) {
                    lastCaptureTime = timestamp;

                    const iframeBody = this.player.shadowRoot.querySelector('#scene-renderer').contentDocument.body;
                    const clone = iframeBody.cloneNode(true);
                    const container = document.createElement('div');
                    container.style.position = 'fixed';
                    container.style.left = '-9999px';
                    container.appendChild(clone);
                    document.body.appendChild(container);

                    try {
                        const canvas = await html2canvas(clone, {
                            useCORS: true,
                            allowTaint: true,
                            logging: false,
                            scale: 0.75 
                        });

                        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.7));
                        const buffer = new Uint8Array(await blob.arrayBuffer());

                        await this.ffmpeg.writeFile(`f_${this._frameCount}.jpg`, buffer);
                        this._frameCount++;

                        statusCallback(`Capturing: ${Math.round((this.player.currentTime / totalDuration) * 100)}%`);
                    } catch (e) {
                        console.warn("Capture failed:", e);
                    } finally {
                        document.body.removeChild(container);
                    }
                }
                requestAnimationFrame(captureLoop);
            };

            recorder.onstop = async () => {
                try {
                    // FIX: Pass statusCallback to _finalize here
                    const result = await this._finalize(audioChunks, statusCallback);
                    resolve(result);
                } catch (err) { reject(err); }
            };

            requestAnimationFrame(captureLoop);
        });
    }

    async _finalize(audioChunks, statusCallback) {
        statusCallback("DIAGNOSTIC: Encoding Video ONLY (Bypassing Audio)...");

        // We completely ignore audioChunks here to isolate the problem
        
        await this.ffmpeg.exec([
            '-hide_banner',
            '-y',
            '-threads', '1',               // Stable single-thread
            '-err_detect', 'ignore_err',   // Ignore JPEG EOI errors
            '-framerate', String(this.fps),
            '-i', 'f_%d.jpg',
            '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '32',
            '-fps_mode', 'cfr',            // Modern constant frame rate
            '-frames:v', String(this._frameCount), // Explicit stop point
            '-movflags', '+faststart',
            'output.mp4'
        ]);

        const data = await this.ffmpeg.readFile('output.mp4');
        return URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    }
}