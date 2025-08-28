// index.js
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();

app.use(
  "/cookieclicker",
  createProxyMiddleware({
    target: "https://orteil.dashnet.org",
    changeOrigin: true,
    secure: false,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36",
      Referer: "https://orteil.dashnet.org/",
    },
    pathRewrite: {
      "^/cookieclicker": "/cookieclicker",
    },
    onProxyRes(proxyRes) {
      // allow loading assets from your Railway proxy
      delete proxyRes.headers["content-security-policy"];
      delete proxyRes.headers["x-frame-options"];
    },
  })
);

app.get("/", (req, res) => {
  res.send(`<h1>Cookie Clicker Proxy</h1>
  <p><a href="/cookieclicker">Play Cookie Clicker</a></p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy running on ${PORT}`);
});
