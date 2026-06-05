/**
 * FinViz Elite API client — ported from Market Metrics Python backend.
 * Fetches CSV exports from elite.finviz.com with auth and retry on 429.
 */

import https from "https";
import { IncomingMessage } from "http";

const ELITE_BASE = "https://elite.finviz.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function getApiKey(): string | null {
  const key = (process.env.FINVIZ_API_KEY ?? "").trim();
  return key || null;
}

export function isEliteConfigured(): boolean {
  return !!getApiKey();
}

function addAuth(url: string): string {
  const key = getApiKey();
  if (!key) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}auth=${key}`;
}

function fetchUrl(url: string, timeout = 60_000, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: { "User-Agent": USER_AGENT },
        rejectUnauthorized: false,
        timeout,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;

        // Follow redirects. Finviz now 301-redirects /export.ashx → /export;
        // the Location carries the auth token, so just chase it. A redirect to
        // the login page still means auth failure.
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume(); // drain the socket
          if (/login/i.test(location)) {
            reject(new Error("Redirected to login"));
            return;
          }
          if (redirects <= 0) {
            reject(new Error("Too many redirects"));
            return;
          }
          resolve(fetchUrl(new URL(location, url).href, timeout, redirects - 1));
          return;
        }

        if (status === 429) {
          res.resume();
          reject(new Error("429"));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

function parseCsv(text: string): Record<string, string>[] {
  const clean = text.trim().replace(/^\ufeff/, "");
  if (clean.startsWith("<") || /login/i.test(clean.slice(0, 500))) {
    return [];
  }
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    // Normalize "ticker" → "Ticker"
    if (row["ticker"] && !row["Ticker"]) {
      row["Ticker"] = row["ticker"];
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchExportFromUrl(
  url: string,
  caller = "",
): Promise<Record<string, string>[]> {
  if (!isEliteConfigured()) return [];
  const fullUrl = addAuth(url);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await fetchUrl(fullUrl);
      return parseCsv(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "429") {
        const wait = Math.pow(2, attempt) * 15_000;
        console.warn(`[${caller || "FinViz"}] 429 rate limit, waiting ${wait / 1000}s (attempt ${attempt + 1})`);
        await sleep(wait);
        continue;
      }
      console.warn(`[${caller || "FinViz"}] fetch failed: ${msg}`);
      return [];
    }
  }
  console.warn(`[${caller || "FinViz"}] failed after 4 retries (429)`);
  return [];
}
