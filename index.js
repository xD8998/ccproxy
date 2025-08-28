// index.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import zlib from "zlib";
import NodeCache from "node-cache";
import { request as undiciRequest } from "undici";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const cache = new NodeCache({ stdTTL: 60 * 60 }); // 1 hour cache for /fetch

const PROXY_PREFIX = "/cookieclicker";
const ORTEIL_BASE = "https://orteil.dashnet.org";
const ORTEIL_COOKIE_HOST = "orteil.dashnet.org";

// Serve mirrored static assets first (if present)
const STATIC_DIR = path.join(__dirname, "static_cookieclicker", "cookieclicker");
app.use(PROXY_PREFIX, express.static(STATIC_DIR, { index: "index.html" }));

// Allowed hosts for /fetch (fonts, CDN, etc.)
const ALLOWED_HOSTS = new Set([
  "orteil.dashnet.org",
  "dashnet.org",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com"
]);

async function backendFetch(url, opts = {}) {
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
    maxRedirections: 5
  });

  const { statusCode, headers } = res;
  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  const bodyBuffer = Buffer.concat(chunks);

  const out = { statusCode, headers, bodyBuffer };
  // basic cache decision
  if (!opts.noCache && ((headers["content-type"] || "").includes("image") || (headers["cache-control"] || "").includes("max-age"))) {
    cache.set(ck, out);
  }
  return out;
}

// Utility to rewrite textual responses so absolute origin URLs point to our proxy
function rewriteText(bodyStr) {
  let s = bodyStr;
  // rewrite origin absolute URLs -> proxy prefix
  s = s.replace(/https?:\/\/orteil\.dashnet\.org\/cookieclicker/g, PROXY_PREFIX);
  s = s.replace(/https?:\/\/orteil\.dashnet\.org/g, PROXY_PREFIX);
  s = s.replace(/https?:\/\/dashnet\.org/g, PROXY_PREFIX);

  // rewrite CDN urls to go through /fetch endpoint
  s = s.replace(/https?:\/\/(ajax\.googleapis\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)(\/[^\s"'<>]*)/g, (m) => {
    return `/fetch?url=${encodeURIComponent(m)}`;
  });

  // remove SRI attributes that would break local/script changes
  s = s.replace(/\sintegrity="[^"]*"/g, "");
  s = s.replace(/\scrossorigin="[^"]*"/g, "");

  // small injected script to block direct location() jumps to origin domain
  const safetyScript = `
  <script>
  (function(){
    const PROXY = "${PROXY_PREFIX}";
    const ORIG_HOST = "orteil.dashnet.org";
    // override simple location changes
    const origAssign = window.location.assign;
    const origReplace = window.location.replace;
    window.location.assign = function(u){ try { if(typeof u === 'string' && u.includes(ORIG_HOST)) u = u.replace(/https?:\\/\\/orteil\\.dashnet\\.org/g, PROXY); } catch(e){} return origAssign.call(this, u); };
    window.location.replace = function(u){ try { if(typeof u === 'string' && u.includes(ORIG_HOST)) u = u.replace(/https?:\\/\\/orteil\\.dashnet\\.org/g, PROXY); } catch(e){} return origReplace.call(this, u); };
    const origOpen = window.open;
    window.open = function(u, n, o){ try { if(typeof u === 'string' && u.includes(ORIG_HOST)) u = u.replace(/https?:\\/\\/orteil\\.dashnet\\.org/g, PROXY); } catch(e){} return origOpen.call(this, u, n, o); };
    // patch fetch to rewrite origin usage
    const origFetch = window.fetch;
    window.fetch = function(input, init){
      try {
        const url = (typeof input === 'string') ? input : input.url;
        if (url && url.includes(ORIG_HOST)) {
          const newUrl = url.replace(/https?:\\/\\/orteil\\.dashnet\\.org/g, PROXY);
          if (typeof input === 'string') input = newUrl;
          else input = new Request(newUrl, input);
        }
      } catch(e){}
      return origFetch.call(this, input, init);
    };
  })();
  </script>
  `;

  if (s.includes("</head>")) s = s.replace(/<\/head>/i, safetyScript + "</head>");
  return s;
}

// Fallback proxy: only used when resource not present in static mirror
app.use(PROXY_PREFIX, createProxyMiddleware({
  target: ORTEIL_BASE,
  changeOrigin: true,
  secure: true,
  ws: true,
  selfHandleResponse: true,
  onProxyReq(proxyReq, req) {
    // present as a normal browser
    proxyReq.setHeader("User-Agent", req.get("User-Agent") || "Mozilla/5.0");
    proxyReq.setHeader("Referer", ORTEIL_BASE + "/");
    proxyReq.setHeader("Host", ORTEIL_COOKIE_HOST);
    // If you implement CF solver, attach Cookie header here
    // proxyReq.setHeader("Cookie", someCfCookieString);
  },
  async onProxyRes(proxyRes, req, res) {
    try {
      const chunks = [];
      for await (const chunk of proxyRes) chunks.push(chunk);
      const buffer = Buffer.concat(chunks || []);
      const enc = (proxyRes.headers["content-encoding"] || "").toLowerCase();
      let decoded = buffer;

      try {
        if (enc === "gzip") decoded = zlib.gunzipSync(buffer);
        else if (enc === "deflate") decoded = zlib.inflateSync(buffer);
        else if (enc === "br") decoded = zlib.brotliDecompressSync(buffer);
      } catch (e) {
        decoded = buffer;
      }

      const ctype = (proxyRes.headers["content-type"] || "").toLowerCase();

      // If textual (html/js/css/json), rewrite it
      if (ctype.includes("text/html") || ctype.includes("javascript") || ctype.includes("css") || ctype.includes("application/json") || ctype.includes("text/plain")) {
        const bodyStr = decoded.toString("utf8");
        // If Cloudflare challenge exists, we want to forward original so browser can solve it.
        const lower = bodyStr.toLowerCase();
        const isCF = proxyRes.statusCode === 503 || lower.includes("__cf_chl_rt_tk") || lower.includes("cf-browser-verification") || lower.includes("checking your browser before accessing");

        if (isCF) {
          // forward original: include Set-Cookie so browser can store cookies for ORTEIL (but note cookies for origin won't be set for origin while on your domain)
          Object.entries(proxyRes.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
          res.statusCode = proxyRes.statusCode || 200;
          // send raw buffer (re-encoded)
          if (enc) res.setHeader("content-encoding", enc);
          return res.end(buffer);
        }

        // Normal text response - rewrite absolute urls to keep user on proxy
        const rewritten = rewriteText(bodyStr);

        let outBuf = Buffer.from(rewritten, "utf8");
        if (enc === "gzip") outBuf = zlib.gzipSync(outBuf);
        else if (enc === "deflate") outBuf = zlib.deflateSync(outBuf);
        else if (enc === "br") outBuf = zlib.brotliCompressSync(outBuf);

        // copy headers (exclude CSP/x-frame)
        Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
          const lk = k.toLowerCase();
          if (lk === "content-length" || lk === "content-security-policy" || lk === "x-frame-options") return;
          res.setHeader(k, v);
        });

        res.setHeader("content-length", outBuf.length);
        if (proxyRes.headers["content-encoding"]) res.setHeader("content-encoding", proxyRes.headers["content-encoding"]);
        res.statusCode = proxyRes.statusCode || 200;
        return res.end(outBuf);
      }

      // binary files -> send raw
      Object.entries(proxyRes.headers || {}).forEach(([k, v]) => {
        if (k.toLowerCase() === "content-length") return;
        res.setHeader(k, v);
      });
      res.statusCode = proxyRes.statusCode || 200;
      return res.end(buffer);
    } catch (err) {
      console.error("proxy onProxyRes error:", err);
      proxyRes.pipe(res);
    }
  },
  pathRewrite: {
    // /cookieclicker/<rest> -> /cookieclicker/<rest> at target
    [`^${PROXY_PREFIX}`]: "/cookieclicker"
  }
}));

// /fetch endpoint to proxy allowed external hosts (fonts, cdn, etc.)
app.get("/fetch", async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send("missing url");
  const url = decodeURIComponent(raw);
  try {
    const parsed = new URL(url);
    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      return res.status(403).send("host not allowed");
    }

    const { statusCode, headers, bodyBuffer } = await backendFetch(url, { noCache: false });
    // remove CSP/x-frame to prevent blocking
    const outHeaders = { ...headers };
    delete outHeaders["content-security-policy"];
    delete outHeaders["x-frame-options"];
    delete outHeaders["set-cookie"]; // avoid leaking origin cookies

    Object.entries(outHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.status(statusCode).send(bodyBuffer);
  } catch (err) {
    console.error("fetch error", err);
    res.status(502).send("bad gateway");
  }
});

// root landing
app.get("/", (req, res) => {
  res.send(`<h1>Cookie Clicker Proxy (mirror-first)</h1>
    <p><a href="${PROXY_PREFIX}/">Play Cookie Clicker (via proxy)</a></p>
    <p>Static files are served from <code>/static_cookieclicker/cookieclicker</code> when present.</p>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on port ${PORT}`);
});
