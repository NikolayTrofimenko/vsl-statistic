/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Onest', '"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        serif: ['"Playfair Display Variable"', '"Playfair Display"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Mono"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
  corePlugins: {
    // Disable Tailwind's preflight to avoid conflicts with Angular Material's
    // base styles (mat-typography, mat-app-background).
    preflight: false,
  },
};
