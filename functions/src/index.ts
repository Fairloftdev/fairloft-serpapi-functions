import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { setGlobalOptions } from "firebase-functions/v2";
import fetch from "node-fetch";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 120,
});

async function fetchGoogleShopping(query: string, apiKey: string) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", query);
  url.searchParams.set("gl", "ca");
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "50");
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("SerpAPI error");

  const data = await res.json();
  const items = data.shopping_results ?? [];
  const now = admin.firestore.Timestamp.now();

  return items
    .filter((it: any) => it.title && it.extracted_price && it.link)
    .map((it: any) => ({
      product_query: query,
      title_raw: it.title,
      price: Number(it.extracted_price),
      currency: "CAD",
      retailer: it.source || it.store || "Unknown",
      url: it.link,
      image_url: it.thumbnail ?? null,
      availability_text:
        `${it.delivery ?? ""} ${it.availability ?? ""}`.trim(),
      collected_at: now,
      source: "google_shopping",
    }));
}

export const scrapeGoogleShopping = onSchedule(
  {
    schedule: "every 6 hours",
    timeZone: "America/Toronto",
    secrets: ["SERPAPI_KEY"],
  },
  async () => {
    const apiKey = process.env.SERPAPI_KEY as string;
    if (!apiKey) throw new Error("Missing SerpAPI key");

    const queries = [
      "TaylorMade Qi10 LS Driver",
      "Ping G430 Max Driver",
      "Callaway Paradym Ai Smoke Driver"
    ];

    const batch = db.batch();
    const col = db.collection("offers");
    let total = 0;

    for (const q of queries) {
      const rows = await fetchGoogleShopping(q, apiKey);
      rows.forEach((r:any) => {
        batch.set(col.doc(), r);
        total++;
      });
    }

    if (total > 0) await batch.commit();
    console.log(`Saved ${total} offers`);
  }
);
