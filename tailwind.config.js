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
    },
  },
  plugins: [],
}
