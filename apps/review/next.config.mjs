/** STATIC_DEMO=1 builds a static export (GitHub Pages) that reads recorded JSON instead of the API. */
const isStatic = process.env.STATIC_DEMO === "1";
const basePath = isStatic ? (process.env.PAGES_BASE_PATH ?? "") : "";

export default {
  reactStrictMode: true,
  devIndicators: false,
  ...(isStatic ? { output: "export", distDir: "out", basePath, images: { unoptimized: true } } : {}),
  env: {
    NEXT_PUBLIC_STATIC: isStatic ? "1" : "0",
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_API: process.env.NEXT_PUBLIC_API ?? "http://localhost:4000",
  },
};
