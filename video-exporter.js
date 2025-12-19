export class VideoExporter {
    constructor(playerElement) {
        this.player = playerElement;
        this.ffmpeg = null;
        this.fps = 10;
    }

    async init(statusCallback) {
        if (this.ffmpeg) return;
        statusCallback("Initializing FFmpeg (Multi-threaded)...");
        
        const { createFFmpeg } = FFmpeg;
        this.ffmpeg = createFFmpeg({
            log: true,
            corePath: new URL('./ffmpeg-core.js', import.meta.url).href
        });

        try {
            await this.ffmpeg.load();
        } catch (error) {
            console.error("FFmpeg Init Error:", error);
            throw new Error("FFmpeg failed to load. Check COOP/COEP headers.");
        }
    }

    async captureAndEncode(statusCallback) {
        // duration is now in seconds
        const totalDuration = this.player.duration;
        const totalFrames = Math.floor(totalDuration * this.fps);

        for (let i = 0; i < totalFrames; i++) {
            statusCallback(`Capturing Frame ${i + 1} / ${totalFrames}`);
            
            // Setting currentTime in seconds to match the new component API
            this.player.currentTime = i / this.fps;
            
            // Rendering delay
            await new Promise(r => setTimeout(r, 150)); 

            const captureTarget = this.player.shadowRoot.querySelector('#video-container');
            const canvas = await html2canvas(captureTarget, { 
                useCORS: true, 
                allowTaint: true,
                logging: false,
                scale: 1 
            });
            
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
            const buffer = await blob.arrayBuffer();
            this.ffmpeg.FS('writeFile', `frame_${String(i + 1).padStart(4, '0')}.jpg`, new Uint8Array(buffer));
        }

        statusCallback("Encoding MP4...");
        await this.ffmpeg.run(
            '-framerate', String(this.fps),
            '-i', 'frame_%04d.jpg',
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'medium', 
            'output.mp4'
        );

        const data = this.ffmpeg.FS('readFile', 'output.mp4');
        const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));

        // FS Cleanup
        for (let i = 0; i < totalFrames; i++) {
            try { this.ffmpeg.FS('unlink', `frame_${String(i + 1).padStart(4, '0')}.jpg`); } catch(e) {}
        }
        try { this.ffmpeg.FS('unlink', 'output.mp4'); } catch(e) {}
        
        return url;
    }
}