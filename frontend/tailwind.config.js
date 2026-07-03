export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: "#0D1A3A",
          light:   "#162347",
          muted:   "#1E2D52",
          border:  "#253566",
        },
        brand: {
          DEFAULT: "#3B5CE8",
          hover:   "#2E4DD4",
          light:   "#EEF1FD",
          muted:   "#7B95F0",
        },
      },
    },
  },
  plugins: [],
};
