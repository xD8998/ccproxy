// index.js
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();

// Proxy everything under /cookieclicker
app.use(
  "/cookieclicker",
  createProxyMiddleware({
    target: "https://orteil.dashnet.org", // original Cookie Clicker site
    changeOrigin: true,
    pathRewrite: {
      "^/cookieclicker": "/cookieclicker", // keeps the original path
    },
    onProxyRes(proxyRes, req, res) {
      // Optional: modify headers for CORS or cache
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  })
);

// Root route
app.get("/", (req, res) => {
  res.send(`
    <h1>Cookie Clicker Proxy</h1>
    <p>Visit <a href="/cookieclicker">/cookieclicker</a> to play!</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
