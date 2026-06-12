import { put, list, get } from "@vercel/blob";

// The portfolio lives as a single private blob. Reads and writes both go
// through this function, authenticated with the PORTFOLIO_KEY env var, so the
// blob token never reaches the browser.
const BLOB_PATH = "portfolio.json";

// The store's token is BLOB_READ_WRITE_TOKEN by default, but connecting a
// store with a custom env prefix names it <PREFIX>_READ_WRITE_TOKEN instead.
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const name = Object.keys(process.env).find((key) => key.endsWith("_READ_WRITE_TOKEN"));
  return name ? process.env[name] : "";
}

function isAuthorized(req) {
  const key = process.env.PORTFOLIO_KEY;
  const header = req.headers.authorization || "";
  return Boolean(key) && header === `Bearer ${key}`;
}

export default async function handler(req, res) {
  // Older store connections inject a static BLOB_READ_WRITE_TOKEN; newer ones
  // inject BLOB_STORE_ID and the SDK authenticates via Vercel's runtime
  // identity (OIDC) with no static token. Support both: pass the token only
  // when one exists, otherwise let the SDK resolve credentials itself.
  const token = blobToken();
  const blobOptions = token ? { token } : {};

  if (!token && !process.env.BLOB_STORE_ID && !process.env.VERCEL_OIDC_TOKEN) {
    res.status(503).json({
      error: "Blob store is not connected to this project yet.",
      hint: `Env vars visible to the function: ${Object.keys(process.env).filter((key) => key.includes("BLOB") || key.includes("TOKEN") || key === "PORTFOLIO_KEY").join(", ") || "none matching"}`,
    });
    return;
  }

  if (!process.env.PORTFOLIO_KEY) {
    res.status(503).json({ error: "PORTFOLIO_KEY environment variable is not set yet." });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (req.method === "GET") {
      // get() by pathname works with both auth models; fall back to resolving
      // the blob URL via list() for older SDK behaviors.
      let result = await get(BLOB_PATH, { access: "private", ...blobOptions }).catch(() => null);

      if (!result) {
        const { blobs } = await list({ prefix: BLOB_PATH, ...blobOptions });
        const blob = blobs.find((item) => item.pathname === BLOB_PATH);

        if (!blob) {
          res.status(404).json({ error: "No portfolio stored yet." });
          return;
        }

        result = await get(blob.url, { access: "private", ...blobOptions }).catch(() => null);
      }

      if (!result) {
        res.status(404).json({ error: "No portfolio stored yet." });
        return;
      }

      const payload = await new Response(result.stream).text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(payload);
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? null);
      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.holdings)) {
        res.status(400).json({ error: "Body must be a portfolio JSON export with a holdings array." });
        return;
      }

      await put(BLOB_PATH, JSON.stringify(parsed), {
        access: "private",
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: "application/json",
        ...blobOptions,
      });

      res.status(200).json({ ok: true, savedAt: new Date().toISOString() });
      return;
    }

    res.setHeader("Allow", "GET, PUT, POST");
    res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    res.status(500).json({ error: `Blob operation failed: ${error.message}` });
  }
}
