// index.js
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { request as undiciRequest } from "undici";
import zlib from "zlib";
import NodeCache from "node-cache";
import { URL } from "url";

const app = express();
const cache = new NodeCache({ stdTTL: 60 * 60 }); // cache 1 hour for static assets

const PROXY_PREFIX = "/cookieclicker";
const ORTEIL = "https://orteil.dashnet.org";

// Allowlist of hostnames your proxy will fetch for the game.
// Add any hosts you see in devtools (fonts, cdn, analytics if you want).
const ALLOWED_HOSTS = new Set([
  "orteil.dashnet.org",
  "dashnet.org",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  // add more trusted hosts if required
]);

/**
 * Helper: safe fetch from backend using undici.
 * Returns { statusCode, headers, bodyBuffer }.
 */
async function backendFetch(url, opts = {}) {
  // simple cache key
  const ck = `fetch:${url}`;
  if (!opts.noCache) {
    const cached = cache.get(ck);
    if (cached) return cached;
  }

  const res = await undiciRequest(url, {
    method: opts.method || "GET",
    headers: opts.headers || {},
    body: opts.body || undefined,
    throwOnError: true,
    maxRedirections: 5,
  });

  const { statusCode, headers } = res;
  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  const bodyBuffer = Buffer.concat(chunks);

  const out = { statusCode, headers, bodyBuffer };
  if (!opts.noCache && (headers["content-type"] || "").includes("image") || (headers["cache-control"] || "").includes("max-age")) {
    cache.set(ck, out);
  }
  return out;
}

/**
 * Rewrite HTML to force absolute URLs through proxy and remove SRI / CSP headers that block injection.
 */
function rewriteHtml(body, proxyBase = PROXY_PREFIX) {
  let s = body;

  // rewrite absolute references to the main host
  s = s.replace(/https?:\/\/orteil\.dashnet\.org\/cookieclicker/g, proxyBase);
  s = s.replace(/https?:\/\/orteil\.dashnet\.org/g, proxyBase);

  // rewrite other allowed hosts to go via /fetch?url=<encoded>
  // e.g., https://fonts.gstatic.com/... -> /fetch?url=https%3A%2F%2Ffonts.gstatic.com%2F...
  s = s.replace(/https?:\/\/(ajax\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)(\/[^\s"'<>]*)/g, (m) => {
    const encoded = encodeURIComponent(m);
    return `/fetch?url=${encoded}`;
  });

  // strip integrity attributes to allow modified scripts to load from proxy
  s = s.replace(/\sintegrity="[^"]*"/g, "");
  s = s.replace(/\scrossorigin="[^"]*"/g, "");

  // fix src/href that start with // (protocol-relative)
  s = s.replace(/src=["']\/\/(.*?)["']/g, (m, g1) => {
    const url = `https://${g1}`;
    return `src="/fetch?url=${encodeURIComponent(url)}"`;
  });
  s = s.replace(/href=["']\/\/(.*?)["']/g, (m, g1) => {
    const url = `https://${g1}`;
    return `href="/fetch?url=${encodeURIComponent(url)}"`;
  });

  // optional: inject a small banner/script to ensure all in-page AJAX also goes via proxy prefix
  const injection = `
  <!-- proxied by your Railway proxy -->
  <script>
    // rewrite fetch/XHR targets in-page (best-effort)
    (function(){
      const base = "${PROXY_PREFIX}";
      // patch fetch
      const origFetch = window.fetch;
      window.fetch = function(input, init){
        try {
          const url = (typeof input === "string") ? input : input.url;
          if (url && url.includes("orteil.dashnet.org")) {
            const newUrl = url.replace(/https?:\\/\\/orteil\\.dashnet\\.org/g, base);
            return origFetch.call(this, newUrl, init);
          }
        } catch(e){}
        return origFetch.call(this, input, init);
      };
    })();
  </script>
  `;

  // inject before </head>
  s = s.replace(/<\/head>/i, injection + "</head>");

  return s;
}

/**
 * Main cookieclicker proxy: uses createProxyMiddleware to handle ws and pass-thru, but selfHandleResponse to rewrite HTML.
 */
app.use(
  PROXY_PREFIX,
  createProxyMiddleware({
    target: ORTEIL,
    changeOrigin: true,
    secure: true,
    ws: true,
    selfHandleResponse: true,
    onProxyReq(proxyReq, req, res) {
      // Make the request appear like a normal browser
      proxyReq.setHeader("User-Agent", req.get("User-Agent") || "Mozilla/5.0");
      proxyReq.setHeader("Referer", ORTEIL + "/");
      // host header: set to original so server serves same content
      proxyReq.setHeader("Host", "orteil.dashnet.org");
    },
    async onProxyRes(proxyRes, req, res) {
      // rewrite Location headers for redirects
      if (proxyRes.headers && proxyRes.headers.location) {
        proxyRes.headers.location = proxyRes.headers.location.replace(/https?:\/\/orteil\.dashnet\.org/g, PROXY_PREFIX);
      }

      // remove blocking headers
      if (proxyRes.headers) {
        delete proxyRes.headers["content-security-policy"];
        delete proxyRes.headers["x-frame-options"];
        delete proxyRes.headers["x-xss-protection"];
      }

      const ctype = (proxyRes.headers["content-type"] || "").toLowerCase();
      const isHtml = ctype.includes("text/html");

      // For non-html: stream through but copy headers (images, js, css)
      if (!isHtml) {
        Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
          if (k.toLowerCase() === "content-length") return;
          res.setHeader(k, v);
        });
        res.statusCode = proxyRes.statusCode || 200;
        proxyRes.pipe(res);
        return;
      }

      // collect body
      const chunks = [];
      proxyRes.on("data", (c) => chunks.push(c));
      proxyRes.on("end", async () => {
        try {
          let buffer = Buffer.concat(chunks);
          const enc = (proxyRes.headers["content-encoding"] || "").toLowerCase();

          if (enc === "gzip") buffer = zlib.gunzipSync(buffer);
          else if (enc === "deflate") buffer = zlib.inflateSync(buffer);
          else if (enc === "br") buffer = zlib.brotliDecompressSync(buffer);

          let body = buffer.toString("utf8");

          // rewrite html
          body = rewriteHtml(body, PROXY_PREFIX);

          // re-encode as needed
          let out = Buffer.from(body, "utf8");
          if (enc === "gzip") out = zlib.gzipSync(out);
          else if (enc === "deflate") out = zlib.deflateSync(out);
          else if (enc === "br") out = zlib.brotliCompressSync(out);

          // copy headers except content-length/csp
          Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
            const lk = k.toLowerCase();
            if (lk === "content-length" || lk === "content-security-policy" || lk === "x-frame-options") return;
            res.setHeader(k, v);
          });

          res.setHeader("content-length", out.length);
          if (proxyRes.headers["content-encoding"]) res.setHeader("content-encoding", proxyRes.headers["content-encoding"]);
          res.statusCode = proxyRes.statusCode || 200;
          res.end(out);
        } catch (err) {
          console.error("HTML rewrite error", err);
          proxyRes.pipe(res);
        }
      });
    },
    pathRewrite: {
      // keep /cookieclicker -> /cookieclicker at target
      [`^${PROXY_PREFIX}`]: "/cookieclicker",
    },
  })
);

/**
 * Generic fetch endpoint: /fetch?url=<encodedUrl>
 * This lets us proxy fonts/CDN/etc which are not on orteil host.
 * Only allowed for ALLOWED_HOSTS.
 */
app.get("/fetch", async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send("missing url");
  const url = decodeURIComponent(raw);
  try {
    const parsed = new URL(url);
    if (!ALLOWED_HOSTS.has(parsed.hostname)) return res.status(403).send("host not allowed");

    const { statusCode, headers, bodyBuffer } = await backendFetch(url, { noCache: false });

    // remove problematic headers
    const outHeaders = { ...headers };
    delete outHeaders["content-security-policy"];
    delete outHeaders["x-frame-options"];
    delete outHeaders["set-cookie"]; // we don't want to forward origin cookies
    Object.entries(outHeaders).forEach(([k, v]) => res.setHeader(k, v));

    res.status(statusCode).send(bodyBuffer);
  } catch (err) {
    console.error("fetch error", err);
    res.status(502).send("bad gateway");
  }
});

// Root landing
app.get("/", (req, res) => {
  res.send(`<h1>Cookie Clicker Proxy</h1>
    <p><a href="${PROXY_PREFIX}/">Play Cookie Clicker (via proxy)</a></p>
    <p>Note: This proxy only fetches from allowed hosts.</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on ${PORT}`);
});
