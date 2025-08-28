// index.js  (patched)
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import zlib from "zlib";
import NodeCache from "node-cache";
import { URL } from "url";

const app = express();
const cache = new NodeCache({ stdTTL: 60 * 60 });

const PROXY_PREFIX = "/cookieclicker";
const ORTEIL = "https://orteil.dashnet.org";

const ALLOWED_HOSTS = new Set([
  "orteil.dashnet.org",
  "dashnet.org",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
]);

function isCloudflareChallengeStatus(status, bodyStr) {
  if (!status) return false;
  if (status === 503 || status === 429) return true;
  if (!bodyStr) return false;
  const s = bodyStr.toLowerCase();
  return s.includes("__cf_chl_rt_tk") ||
         s.includes("cf_chl_") ||
         s.includes("cf-browser-verification") ||
         s.includes("ddos protection") ||
         s.includes("checking your browser before accessing");
}

function rewriteText(bodyStr, proxyBase = PROXY_PREFIX) {
  let s = bodyStr;
  s = s.replace(/https?:\/\/orteil\.dashnet\.org\/cookieclicker/g, proxyBase);
  s = s.replace(/https?:\/\/orteil\.dashnet\.org/g, proxyBase);
  s = s.replace(/https?:\/\/dashnet\.org/g, proxyBase);

  // rewrite common CDNs to /fetch
  s = s.replace(/https?:\/\/(ajax\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)(\/[^\s"'<>]*)/g, (m) => {
    return `/fetch?url=${encodeURIComponent(m)}`;
  });

  // strip SRI attributes
  s = s.replace(/\sintegrity="[^"]*"/g, "");
  s = s.replace(/\scrossorigin="[^"]*"/g, "");

  // inject a tiny script to prevent direct-location navigation from JS
  const safeScript = `
  <script>
    // Prevent scripts from sending the user off to the original domain by rewriting assignments
    (function(){
      const PROXY = "${PROXY_PREFIX}";
      const ORIG = "https://orteil.dashnet.org";
      // Override location setters
      const setLocation = (dest) => {
        try {
          if (typeof dest === "string" && dest.includes("orteil.dashnet.org")) {
            dest = dest.replace(/https?:\\/\\/orteil\\.dashnet\\.org/g, PROXY);
          }
        } catch(e){}
        return dest;
      };
      const origAssign = window.location.assign;
      const origReplace = window.location.replace;
      Object.defineProperty(window.location, "assign", {
        configurable: true,
        value: function(u){ return origAssign.call(this, setLocation(u)); }
      });
      Object.defineProperty(window.location, "replace", {
        configurable: true,
        value: function(u){ return origReplace.call(this, setLocation(u)); }
      });
      const origOpen = window.open;
      window.open = function(u, n, opts){ return origOpen.call(this, setLocation(u), n, opts); };
    })();
  </script>
  `;

  // Try placing the script before </head> if HTML
  if (s.includes("</head>")) s = s.replace(/<\/head>/i, safeScript + "</head>");
  return s;
}

app.use(
  PROXY_PREFIX,
  createProxyMiddleware({
    target: ORTEIL,
    changeOrigin: true,
    secure: true,
    ws: true,
    selfHandleResponse: true,
    onProxyReq(proxyReq, req, res) {
      proxyReq.setHeader("User-Agent", req.get("User-Agent") || "Mozilla/5.0");
      proxyReq.setHeader("Referer", ORTEIL + "/");
      proxyReq.setHeader("Host", "orteil.dashnet.org");
    },
    async onProxyRes(proxyRes, req, res) {
      try {
        // collect raw chunks
        const chunks = [];
        for await (const chunk of proxyRes) chunks.push(chunk);
        let buffer = Buffer.concat(chunks || []);
        const contentEncoding = (proxyRes.headers["content-encoding"] || "").toLowerCase();
        const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();

        // decompress if needed
        let decoded = buffer;
        try {
          if (contentEncoding === "gzip") decoded = zlib.gunzipSync(buffer);
          else if (contentEncoding === "deflate") decoded = zlib.inflateSync(buffer);
          else if (contentEncoding === "br") decoded = zlib.brotliDecompressSync(buffer);
        } catch (e) {
          // decompression may fail for binary content - keep original buffer
          decoded = buffer;
        }

        const decodedStr = decoded.toString("utf8");

        // Detect cloudflare challenge — if it looks like one, forward raw (so client runs CF JS)
        if (isCloudflareChallengeStatus(proxyRes.statusCode, decodedStr)) {
          // Copy headers (including set-cookie) so browser can solve challenge
          Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
            // keep set-cookie so browser receives cookies
            res.setHeader(k, v);
          });
          res.statusCode = proxyRes.statusCode || 200;
          // Send raw (re-encode if original was compressed)
          if (contentEncoding === "gzip") {
            res.setHeader("content-encoding", "gzip");
            res.end(buffer);
          } else if (contentEncoding === "br") {
            res.setHeader("content-encoding", "br");
            res.end(buffer);
          } else {
            res.end(decoded);
          }
          return;
        }

        // Not a challenge: handle rewrites.
        // If text-like: rewriteJS/HTML/CSS
        if (contentType.includes("text/html") || contentType.includes("javascript") || contentType.includes("css") || contentType.includes("application/json") || contentType.includes("text/plain")) {
          const rewritten = rewriteText(decodedStr, PROXY_PREFIX);

          // re-encode if needed
          let outBuffer = Buffer.from(rewritten, "utf8");
          if (contentEncoding === "gzip") outBuffer = zlib.gzipSync(outBuffer);
          else if (contentEncoding === "deflate") outBuffer = zlib.deflateSync(outBuffer);
          else if (contentEncoding === "br") outBuffer = zlib.brotliCompressSync(outBuffer);

          // copy through headers but ensure content-length and encoding are correct
          Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
            const lk = k.toLowerCase();
            if (lk === "content-length") return;
            if (lk === "content-security-policy" || lk === "x-frame-options") return;
            // keep set-cookie so CF cookies can be set
            res.setHeader(k, v);
          });
          res.setHeader("content-length", outBuffer.length);
          if (proxyRes.headers["content-encoding"]) res.setHeader("content-encoding", proxyRes.headers["content-encoding"]);
          res.statusCode = proxyRes.statusCode || 200;
          res.end(outBuffer);
          return;
        }

        // Binary / other: stream raw (images, audio, etc.)
        Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
          if (k.toLowerCase() === "content-length") return;
          res.setHeader(k, v);
        });
        res.statusCode = proxyRes.statusCode || 200;
        res.end(buffer);
      } catch (err) {
        console.error("proxy onProxyRes error", err);
        // fallback: pipe original stream (if possible)
        proxyRes.pipe(res);
      }
    },
    pathRewrite: {
      [`^${PROXY_PREFIX}`]: "/cookieclicker",
    },
  })
);

// keep your /fetch endpoint (no change here in this snippet)
app.get("/fetch", async (req, res) => {
  // previous implementation...
  res.status(501).send("fetch not implemented in snippet - use existing implementation");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on ${PORT}`);
});
