/**
 * A short two-note chime for notification pop-ups, made with Web Audio (no sound file).
 * Browsers only allow sound after the person has clicked or typed on the page, so the audio
 * context is unlocked on the first interaction; before that the chime is skipped silently.
 */
let ctx: AudioContext | null = null;
let unlockBound = false;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Call once on mount: the first click or key press unlocks sound for the rest of the visit. */
export function bindChimeUnlock() {
  if (unlockBound || typeof window === "undefined") return;
  unlockBound = true;
  const unlock = () => {
    const c = context();
    if (c && c.state === "suspended") c.resume().catch(() => {});
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

export function playChime() {
  const c = context();
  if (!c || c.state !== "running") return;
  const start = c.currentTime + 0.01;
  [
    { f: 880, t: 0 },
    { f: 1318.5, t: 0.14 },
  ].forEach(({ f, t }) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, start + t);
    gain.gain.exponentialRampToValueAtTime(0.18, start + t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + t + 0.38);
    osc.connect(gain).connect(c.destination);
    osc.start(start + t);
    osc.stop(start + t + 0.4);
  });
}

const SOUND_KEY = "crm.notificationSound";
let soundThisVisit: boolean | null = null; // fallback when browser storage is unavailable

export function soundEnabled(): boolean {
  if (soundThisVisit !== null) return soundThisVisit;
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  soundThisVisit = on;
  try {
    window.localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* private window: the choice lasts until the page is reloaded */
  }
}

// ── Live settings for components (no hydration mismatch: the server assumes the defaults) ──
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function subscribeAlertSettings(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function toggleSound() {
  setSoundEnabled(!soundEnabled());
  emit();
}

export type DesktopAlertState = "unsupported" | "default" | "granted" | "denied";
export function desktopAlertState(): DesktopAlertState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission as DesktopAlertState;
}
export async function requestDesktopAlerts() {
  if (desktopAlertState() !== "default") return;
  try {
    await window.Notification.requestPermission();
  } finally {
    emit();
  }
}
