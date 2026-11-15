// WS16 task 10 (M10): virtual time for capture mode (DESIGN U6 "fixed frame step"). Installed by
// boot.ts before the first render, so the map and every module read the same frozen clock:
// performance.now() returns the capture time, and requestAnimationFrame callbacks receive it. Time
// moves only when the recorder steps a frame (setVirtualTime). Wall-clock motion (MapLibre fades and
// transitions, the station pulse, the thread dash flow) is thereby a function of the frame number,
// and two capture runs draw the same frames. Never installed outside ?capture=.
let installed = false
let vt = 0

export function installVirtualTime(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  vt = 0 // a fixed origin: anything periodic in the clock (the 3 s pulse) starts in the same phase every run
  const realRaf = window.requestAnimationFrame.bind(window)
  performance.now = () => vt
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => realRaf(() => cb(vt))
}

export function virtualTimeInstalled(): boolean {
  return installed
}

/** Set the capture clock (ms since the origin). */
export function setVirtualTime(ms: number): void {
  vt = ms
}

export function virtualTime(): number {
  return vt
}
