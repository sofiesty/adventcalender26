import { defineConfig } from "vite";
import { resolve } from "node:path";

// The dev server serves the whole project folder. Make sure it never hands out
// the plaintext door content / puzzles in secret/.
const blockSecrets = {
  name: "block-secrets",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = decodeURIComponent((req.url || "").split("?")[0]).toLowerCase();
      if (url.includes("/secret")) {
        res.statusCode = 403;
        return res.end("Nope ♥");
      }
      next();
    });
  },
};

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the site from https://sofiesty.github.io/adventcalender26/
  base: command === "build" ? "/adventcalender26/" : "/",
  plugins: [blockSecrets],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        puzzle: resolve(import.meta.dirname, "puzzle.html"),
      },
    },
  },
}));
