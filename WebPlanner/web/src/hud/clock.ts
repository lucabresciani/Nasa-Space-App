// Playback clock (F18): EVA minutes driven by real time × speed (speeds from config/hud.yaml,
// default 60×, D13). 1× is real time: one real second advances the EVA by one second.
// The implementation moved to web/src/state/clock.ts (WS15 A3: the state lives in signals so the
// mission state can share one clock); this path stays for the HUD, the spike and the tests.
export { PlaybackClock, ClockDriver } from '../state/clock'
