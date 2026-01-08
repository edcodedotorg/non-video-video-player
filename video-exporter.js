import { FFmpeg } from './node_modules/@ffmpeg/ffmpeg/dist/esm/index.js';
import { toBlobURL, fetchFile } from './node_modules/@ffmpeg/util/dist/esm/index.js';

export class VideoExporter {
    constructor(playerElement) {
        this.player = playerElement;
        this.ffmpeg = new FFmpeg();
        this.fps = 10;
        this._isLoaded = false;
        
        // Queues for processing
        this._renderQueue = []; 
        this._isRendering = false;
        this._captureFinished = false;

        this.ffmpeg.on('log', ({ message }) => {
            window.dispatchEvent(new CustomEvent('ffmpeg-log', { detail: message }));
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
        this._renderQueue = [];
        this._captureFinished = false;
        this._frameCount = 0; // The frame we are collecting
        let processedCount = 0; // The frame we have finished rendering

        // 1. Audio Hijack Setup (Real-time required)
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

        // 2. Start the Render Worker (Async Loop)
        // This runs in parallel to the playback
        const renderPromise = this._processRenderQueue(statusCallback);

        // 3. Start Playback
        this.player.currentTime = 0;
        recorder.start(100); // Small chunk size for safety
        this.player.play();

        return new Promise((resolve, reject) => {
            
            // --- LOOP A: The "Collector" (Sync with Video) ---
            // Its only job is to grab DOM snapshots. It must be fast.
            const collectorLoop = (timestamp) => {
                // Stop condition
                if (this.player.currentTime >= totalDuration || (this.player.paused && this.player.currentTime > 0)) {
                    recorder.stop();
                    this._captureFinished = true; // Tell render loop we are done collecting
                    return;
                }

                // Check if it's time for a frame (every 100ms)
                if (timestamp - lastCaptureTime >= frameInterval) {
                    lastCaptureTime = timestamp;

                    // Grab the DOM state NOW
                    const iframeBody = this.player.shadowRoot.querySelector('#scene-renderer').contentDocument.body;
                    
                    // Clone deeply. This captures the state of text/styles at this exact moment.
                    const clone = iframeBody.cloneNode(true);
                    
                    // Push to queue for the "Processor" to handle later
                    this._renderQueue.push({
                        id: this._frameCount,
                        node: clone,
                        htmlSignature: clone.innerHTML // Capture text state for comparison
                    });

                    this._frameCount++;
                }

                requestAnimationFrame(collectorLoop);
            };

            recorder.onstop = async () => {
                try {
                    statusCallback("Playback finished. Waiting for renderer to catch up...");
                    
                    // Wait for the render loop to finish the queue
                    await renderPromise; 

                    const result = await this._finalize(audioChunks, statusCallback);
                    resolve(result);
                } catch (err) { reject(err); }
            };

            requestAnimationFrame(collectorLoop);
        });
    }

    // --- LOOP B: The "Processor" (Async / Catch-up) ---
    // --- LOOP B: The "Processor" (Async / Catch-up) ---
   // --- LOOP B: The "Processor" ---
    async _processRenderQueue(statusCallback) {
        let lastSignature = null;
        let lastBuffer = null;
        let processedIndex = 0;

        while (!this._captureFinished || this._renderQueue.length > 0) {
            
            if (this._renderQueue.length > 0) {
                const job = this._renderQueue.shift(); 
                
                try {
                    // OPTIMIZATION: Check for Identical Content
                    if (lastBuffer && job.htmlSignature === lastSignature) {
                        await this.ffmpeg.writeFile(`f_${job.id}.jpg`, new Uint8Array(lastBuffer));
                    } 
                    else {
                        const container = document.createElement('div');
                        container.style.position = 'fixed';
                        container.style.left = '-9999px';
                        container.style.top = '0';
                        container.style.width = '1280px'; 
                        container.style.height = '720px';
                        
                        // Append content
                        container.appendChild(job.node);
                        document.body.appendChild(container);

                        // --- FIX: Wait for Images to Load ---
                        const images = Array.from(container.querySelectorAll('img'));
                        if (images.length > 0) {
                            await Promise.all(images.map(img => {
                                if (img.complete) return Promise.resolve();
                                return new Promise(resolve => {
                                    img.onload = resolve;
                                    img.onerror = resolve; // Continue even if one fails
                                });
                            }));
                        }
                        // ------------------------------------

                        const canvas = await html2canvas(container, { 
                            useCORS: true,
                            allowTaint: true,
                            logging: false,
                            scale: 1, 
                            width: 1280,
                            height: 720,
                            backgroundColor: '#ffffff' // Ensure white background for transparency
                        });

                        document.body.removeChild(container);

                        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
                        const buffer = new Uint8Array(await blob.arrayBuffer());

                        lastBuffer = buffer;
                        lastSignature = job.htmlSignature;

                        await this.ffmpeg.writeFile(`f_${job.id}.jpg`, new Uint8Array(buffer));
                    }

                    processedIndex++;
                    if (processedIndex % 5 === 0) {
                        statusCallback(`Processing: ${processedIndex} / ${this._frameCount} frames`);
                    }

                } catch (e) {
                    console.error("Render Error:", e);
                }
            } else {
                await new Promise(r => setTimeout(r, 50));
            }
        }
        statusCallback("Rendering Complete.");
    }
    async _finalize(audioChunks, statusCallback) {
        statusCallback("Encoding Video ONLY (Debug Mode)...");

        // DEBUG: Commented out Audio Write
        /*
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
        const audioBuffer = new Uint8Array(await audioBlob.arrayBuffer());
        await this.ffmpeg.writeFile('input_audio.webm', audioBuffer);
        */

        // 2. Encode
        await this.ffmpeg.exec([
            '-hide_banner',
            '-y',
            '-threads', '1',
            '-err_detect', 'ignore_err',
            '-framerate', String(this.fps),
            '-i', 'f_%d.jpg',
            // '-i', 'input_audio.webm', // REMOVED Audio Input
            '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '32',
            // '-c:a', 'aac',            // REMOVED Audio Codec
            // '-b:a', '128k',           // REMOVED Audio Bitrate
            '-fps_mode', 'cfr',
            '-frames:v', String(this._frameCount), 
            // '-movflags', '+faststart', 
            // '-shortest',              // REMOVED (No longer applicable with 1 stream)
            'output.mp4'
        ]);

        const data = await this.ffmpeg.readFile('output.mp4');
        return URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    }
}