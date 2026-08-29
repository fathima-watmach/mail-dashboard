export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        // Sourced directly from the Watmach logo (frontend/src/assets/watmach-logo.png)
        navy: {
          DEFAULT: "#0b1634",
          light:   "#16224a",
          muted:   "#1f2c54",
          border:  "#2a3768",
        },
        brand: {
          DEFAULT: "#0b1634",  // logo navy — primary interactive color across the app
          hover:   "#16224a",
          light:   "#eef1f7",  // pale navy-tinted white, for subtle highlights on white surfaces
          muted:   "#2c419e",  // logo's secondary accent blue — used sparingly
        },
      },
    },
  },
  plugins: [],
};
