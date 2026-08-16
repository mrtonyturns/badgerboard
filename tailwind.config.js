/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          red:     '#8B0000',   // Dark red primary
          'red-light': '#A52A2A',
          'red-dark':  '#6B0000',
          navy:    '#0A1628',
          'navy-light': '#1B2A45',
          'navy-mid':   '#122038',
          white:   '#FFFFFF',
          gray:    '#F4F5F7',
          'gray-mid':   '#E5E7EB',
          'text-muted': '#6B7280',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      // ── z-index scale (v1.34.1) ──────────────────────────────────────────
      // One documented ladder for everything that floats:
      //   chrome 10 < sticky 20 < popover 25 < chat 30 < drawer 35
      //     < modal 40+ < toast 9999
      // The rationale, and the audit of what already occupies each band, lives
      // next to the `Z` export in src/components/Layout.jsx — these tokens are
      // the class-name half of the same scale (z-chat, z-drawer, z-popover…).
      // `modal` is the FLOOR of the modal band, not a value every modal uses:
      // existing dialogs span 40/41/50/60/70/80 and are deliberately not
      // renumbered — nothing below 40 may cover them.
      zIndex: {
        chrome:  '10',
        sticky:  '20',
        popover: '25',
        chat:    '30',
        drawer:  '35',
        modal:   '40',
        toast:   '9999',
      },
    },
  },
  plugins: [],
}
