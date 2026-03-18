import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { getWatchlist, addTickers, removeTicker, saveWatchlist, type WatchlistEntry } from "../lib/cosmos.js";

const CAP_LIST = "capitulation";

async function capitulationWatchlistHandler(req: HttpRequest, _ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    if (req.method === "GET") {
      const wl = await getWatchlist(CAP_LIST);
      return { jsonBody: wl };
    }

    if (req.method === "POST") {
      const body = (await req.json()) as { tickers?: WatchlistEntry[]; replace?: boolean };
      if (!body.tickers || !Array.isArray(body.tickers)) {
        return { status: 400, jsonBody: { error: "tickers array required" } };
      }

      let wl;
      if (body.replace) {
        wl = await saveWatchlist(body.tickers, CAP_LIST);
      } else {
        wl = await addTickers(body.tickers, CAP_LIST);
      }
      return { jsonBody: wl };
    }

    if (req.method === "DELETE") {
      const ticker = req.query.get("ticker");
      if (!ticker) {
        return { status: 400, jsonBody: { error: "ticker query param required" } };
      }
      const wl = await removeTicker(ticker, CAP_LIST);
      return { jsonBody: wl };
    }

    return { status: 405, jsonBody: { error: "Method not allowed" } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { status: 500, jsonBody: { error: message } };
  }
}

app.http("capitulationWatchlist", {
  methods: ["GET", "POST", "DELETE"],
  authLevel: "anonymous",
  route: "capitulation-watchlist",
  handler: capitulationWatchlistHandler,
});
