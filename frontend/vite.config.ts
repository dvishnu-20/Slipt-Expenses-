import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "./",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        group: resolve(__dirname, "group.html"),
      },
    },
    outDir: "dist",
  },
});
