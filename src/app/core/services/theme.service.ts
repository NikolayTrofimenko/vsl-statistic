import { Injectable, signal, computed, effect } from '@angular/core';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'vslstat.theme';

/**
 * Owns the app colour theme. Persists the user's choice in localStorage and
 * toggles the `.dark` class on <html>. Supports an explicit light/dark choice
 * or following the OS ("system"). Applied synchronously on construction (and
 * mirrored by an inline script in index.html) so there is no flash.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode = signal<ThemeMode>(readStoredMode());

  private readonly systemDark = signal<boolean>(prefersDark());

  /** The actually-applied scheme after resolving "system". */
  readonly isDark = computed(() =>
    this.mode() === 'system' ? this.systemDark() : this.mode() === 'dark',
  );

  constructor() {
    // React to OS theme changes only while in "system" mode.
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    mq?.addEventListener?.('change', (e) => this.systemDark.set(e.matches));

    // Keep <html> class and storage in sync with the resolved scheme.
    effect(() => {
      const dark = this.isDark();
      document.documentElement.classList.toggle('dark', dark);
    });

    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, this.mode());
      } catch {
        /* storage unavailable — ignore */
      }
    });
  }

  set(mode: ThemeMode): void {
    this.mode.set(mode);
  }

  toggle(): void {
    this.mode.set(this.isDark() ? 'light' : 'dark');
  }
}

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  // Dark by default: the identity is built on graphite, the panel is watched
  // for hours at a time, and the tracker it sits next to is dark too. Light
  // stays one click away.
  return 'dark';
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
}
