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
        
        // FIX 1: specific handler for the single large chunk
        recorder.ondataavailable = e => { 
            if (e.data.size > 0) audioChunks.push(e.data); 
        };

        const frameInterval = 1000 / this.fps;
        let lastCaptureTime = 0;

        const renderPromise = this._processRenderQueue(statusCallback);

        // 3. Start Playback
        this.player.currentTime = 0;
        
        // FIX 2: No 'timeslice' argument. 
        // This ensures the browser calculates correct headers/duration 
        // and provides one clean blob on stop.
        recorder.start(); 
        
        this.player.play();

        return new Promise((resolve, reject) => {
            
            const collectorLoop = (timestamp) => {
                if (this.player.currentTime >= totalDuration || (this.player.paused && this.player.currentTime > 0)) {
                    recorder.stop();
                    this._captureFinished = true;
                    return;
                }

                if (timestamp - lastCaptureTime >= frameInterval) {
                    lastCaptureTime = timestamp;

                    const iframe = this.player.shadowRoot.querySelector('#scene-renderer');
                    const doc = iframe.contentDocument;

                    if (doc) {
                        const clone = doc.body.cloneNode(true);
                        const styleTags = Array.from(doc.querySelectorAll('style, link[rel="stylesheet"]'))
                            .map(el => el.outerHTML)
                            .join('');

                        this._renderQueue.push({
                            id: this._frameCount,
                            node: clone,
                            styles: styleTags,
                            htmlSignature: clone.innerHTML
                        });

                        this._frameCount++;
                    }
                }
                requestAnimationFrame(collectorLoop);
            };

            recorder.onstop = async () => {
                try {
                    statusCallback("Playback finished. Waiting for renderer...");
                    await renderPromise;
                    
                    // FIX 3: Verify we actually captured audio
                    console.log(`Audio Capture Complete: ${audioChunks.length} chunks`);
                    
                    const result = await this._finalize(audioChunks, statusCallback);
                    resolve(result);
                } catch (err) { reject(err); }
            };

            requestAnimationFrame(collectorLoop);
        });
    }
async _finalize(audioChunks, statusCallback) {
        // 1. Save Audio File
        statusCallback("Preparing Assets...");
        const totalAudioSize = audioChunks.reduce((acc, chunk) => acc + chunk.size, 0);
        if (totalAudioSize === 0) console.warn("Warning: Audio size is 0 bytes");

        const audioBlob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
        const audioBuffer = new Uint8Array(await audioBlob.arrayBuffer());
        await this.ffmpeg.writeFile('input_audio.webm', audioBuffer);

        // --- PHASE 1: VIDEO ENCODE (Images -> MP4) ---
        statusCallback("Phase 1/2: Encoding Video...");
        
        await this.ffmpeg.exec([
            '-hide_banner',
            '-y',
            '-framerate', String(this.fps),
            '-i', 'f_%d.jpg',             // Input: Images
            
            // Video Settings
            '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '32',
            '-an',                        // No Audio in this pass
            '-frames:v', String(this._frameCount),
            'video_intermediate.mp4'
        ]);

        // --- CLEANUP: Free up memory for Phase 2 ---
        // We delete the images now that they are inside the mp4
        for (let i = 0; i < this._frameCount; i++) {
            try { await this.ffmpeg.deleteFile(`f_${i}.jpg`); } catch(e) {}
        }

        // --- PHASE 2: MERGE (Video + Audio -> Final) ---
        statusCallback("Phase 2/2: Merging Audio...");

        await this.ffmpeg.exec([
            '-hide_banner',
            '-y',
            '-i', 'video_intermediate.mp4', // Input 0: Clean Video
            '-i', 'input_audio.webm',       // Input 1: Audio
            
            '-map', '0:v',                  // Use Video from Input 0
            '-map', '1:a',                  // Use Audio from Input 1
            
            '-c:v', 'copy',                 // COPY video (Do not re-encode! Fast!)
            '-c:a', 'aac',                  // Encode Audio
            '-b:a', '128k',
            '-shortest',                    // Stop when video ends
            'output.mp4'
        ]);

        const data = await this.ffmpeg.readFile('output.mp4');
        return URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
    }
    
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
    
}