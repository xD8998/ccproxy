// index.js
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import zlib from "zlib";

const app = express();

const proxyPath = "/cookieclicker";
const targetHost = "https://orteil.dashnet.org";

app.use(
  proxyPath,
  createProxyMiddleware({
    target: targetHost,
    changeOrigin: true,
    secure: false,
    selfHandleResponse: true, // important: we will handle the response
    onProxyReq(proxyReq, req, res) {
      // Make the request look like a regular browser
      proxyReq.setHeader(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36"
      );
      proxyReq.setHeader("Referer", `${targetHost}/`);
    },
    onProxyRes: async (proxyRes, req, res) => {
      // If location header points to the original site, rewrite it to the proxy
      if (proxyRes.headers && proxyRes.headers.location) {
        proxyRes.headers.location = proxyRes.headers.location.replace(
          /https?:\/\/orteil\.dashnet\.org(\/?)/g,
          proxyPath + "$1"
        );
      }

      // Remove headers that would prevent framing / injection
      if (proxyRes.headers) {
        delete proxyRes.headers["content-security-policy"];
        delete proxyRes.headers["x-frame-options"];
      }

      const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();
      const isHtml = contentType.includes("text/html");

      // If not HTML, just pipe through (but copy headers)
      if (!isHtml) {
        Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
          if (k.toLowerCase() === "content-length") return;
          res.setHeader(k, v);
        });
        res.statusCode = proxyRes.statusCode || 200;
        proxyRes.pipe(res);
        return;
      }

      // Collect response body
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        try {
          let buffer = Buffer.concat(chunks);
          const encoding = (proxyRes.headers["content-encoding"] || "").toLowerCase();

          // Decompress if needed
          if (encoding === "gzip") buffer = zlib.gunzipSync(buffer);
          else if (encoding === "deflate") buffer = zlib.inflateSync(buffer);
          else if (encoding === "br" || encoding === "brotli") buffer = zlib.brotliDecompressSync(buffer);

          let body = buffer.toString("utf8");

          // Replace absolute references to the original host so clicks stay on your proxy.
          // This replaces common patterns like:
          // https://orteil.dashnet.org/cookieclicker/...  -> /cookieclicker/...
          // https://orteil.dashnet.org/...                 -> /cookieclicker/...
          body = body.replace(/https?:\/\/orteil\.dashnet\.org\/cookieclicker/g, proxyPath);
          body = body.replace(/https?:\/\/orteil\.dashnet\.org/g, proxyPath);

          // You can add other rewrites here (e.g., for web sockets, api endpoints, etc.)

          // Re-encode (compress) if original was compressed
          let outBuffer = Buffer.from(body, "utf8");
          if (encoding === "gzip") outBuffer = zlib.gzipSync(outBuffer);
          else if (encoding === "deflate") outBuffer = zlib.deflateSync(outBuffer);
          else if (encoding === "br" || encoding === "brotli") outBuffer = zlib.brotliCompressSync(outBuffer);

          // Copy headers from proxyRes (except content-length/csp/x-frame options which we handled)
          Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
            const lk = k.toLowerCase();
            if (lk === "content-length") return;
            if (lk === "content-security-policy" || lk === "x-frame-options") return;
            res.setHeader(k, v);
          });

          // Set correct content-length
          res.setHeader("content-length", outBuffer.length);
          // Preserve content-encoding if present
          if (proxyRes.headers["content-encoding"]) {
            res.setHeader("content-encoding", proxyRes.headers["content-encoding"]);
          } else {
            res.removeHeader("content-encoding");
          }

          res.statusCode = proxyRes.statusCode || 200;
          res.end(outBuffer);
        } catch (err) {
          console.error("Error processing proxy response:", err);
          // Fallback: pipe raw
          proxyRes.pipe(res);
        }
      });
    },
    pathRewrite: {
      // keep the /cookieclicker prefix on requests to the target
      // so /cookieclicker/<rest> -> /cookieclicker/<rest> at the target
      [`^${proxyPath}`]: "/cookieclicker",
    },
  })
);

app.get("/", (req, res) => {
  res.send(`<h1>Cookie Clicker Proxy</h1>
    <p><a href="${proxyPath}/">Play Cookie Clicker (via proxy)</a></p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on ${PORT}`);
});
