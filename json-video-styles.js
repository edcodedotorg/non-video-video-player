const styles = `
:host {
    display: block;
    position: relative;
    background-color: #111827;
    overflow: hidden;
    width: 100%;
    aspect-ratio: 16 / 9;
    border: 4px solid #1f2937;
    border-radius: 0.5rem;
}
#video-container { width: 100%; height: 100%; position: relative; }
iframe { width: 100%; height: 100%; border: none; background-color: white; pointer-events: none; }
#closed-caption-overlay {
    position: absolute; inset-x: 0; bottom: 1rem; padding: 0 1rem;
    text-align: center; pointer-events: none; z-index: 10;
}
.cc-text {
    display: inline-block; background-color: rgba(0, 0, 0, 0.7);
    color: white; font-size: 1.125rem; padding: 0.25rem 0.75rem;
    border-radius: 0.25rem;
}
.hidden { display: none !important; }
`;
export default styles;