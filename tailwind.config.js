/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // v2.0 facelift (Nov 2026): the mycandidatepage.com palette — the
        // Bluejack candidate-product family shares one look. Red is the accent,
        // ink is the dark chrome (top bar, primary buttons), navy is the deep
        // hero-tile blue, wash is the page ground.
        brand: {
          red:     '#C0392B',   // accent — buttons, countdowns, live dots
          'red-light': '#D4483A',
          'red-dark':  '#A93226',
          'red-bright': '#D91E36',
          'red-wash':  '#FBEDEB',
          navy:    '#0E1A3A',   // hero tiles, login ground
          'navy-light': '#1B2A45',
          'navy-mid':   '#122038',
          ink:     '#11161C',   // body text, primary dark buttons
          'ink-deep': '#0B0F14', // top bar
          mute:    '#5B636C',
          faint:   '#9099A1',
          white:   '#FFFFFF',
          gray:    '#F7F8FA',   // page wash
          'gray-mid':   '#E5E7EB',
          'text-muted': '#5B636C',
        }
      },
      // Elevation ladder from mycandidatepage.com — hairline ring + soft drop.
      boxShadow: {
        e1: '0 0 0 .5px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.06)',
        e2: '0 0 0 .5px rgba(0,0,0,.05), 0 1px 3px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.05)',
        e3: '0 0 0 .5px rgba(0,0,0,.05), 0 2px 6px rgba(0,0,0,.06), 0 10px 24px rgba(0,0,0,.08)',
        e4: '0 0 0 .5px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.07), 0 18px 40px rgba(0,0,0,.11)',
        e5: '0 0 0 .5px rgba(0,0,0,.06), 0 8px 20px rgba(0,0,0,.1), 0 28px 56px rgba(0,0,0,.18)',
      },
      borderRadius: {
        tile: '20px',
      },
      letterSpacing: {
        display: '-0.035em',
      },
      // ── Typography (v2.0) ────────────────────────────────────────────────
      // DM Sans first, app-wide — the mycandidatepage.com face. Headings run at
      // weight 800 with tight tracking (tracking-display). Loaded in index.html
      // next to Inter, which stays as the first fallback.
      fontFamily: {
        sans: ['DM Sans', 'Inter', 'system-ui', 'sans-serif'],
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
