/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      screens: {
        tablet: '900px',
      },
      colors: {
        ink: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
        brand: {
          50: '#eefaf6',
          100: '#d6f2e7',
          200: '#afe4cf',
          300: '#7ed1b1',
          400: '#4ebc94',
          500: '#24a27a',
          600: '#1c8665',
          700: '#196a52',
          800: '#185443',
          900: '#17463a',
        },
        coral: {
          500: '#ef6f6c',
        },
        sun: {
          500: '#d89a3d',
        },
        fog: {
          50: '#f5f7fb',
        },
      },
      boxShadow: {
        lift: '0 10px 30px rgba(15, 23, 42, 0.12)',
      },
    },
  },
  plugins: [],
}
