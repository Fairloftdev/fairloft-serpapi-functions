import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import fetch from "node-fetch";

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300, // Increased timeout for manual runs
});

interface SerpApiResult {
  title?: string;
  extracted_price?: number;
  link?: string;
  source?: string;
  store?: string;
  thumbnail?: string;
  delivery?: string;
  availability?: string;
  product_id?: string;
  source_icon?: string;
  rating?: number;
  reviews?: number;
  extracted_old_price?: number;
  second_hand_condition?: string;
  snippet?: string;
  extensions?: string[];
}

interface Offer {
  price: number;
  currency: string;
  retailer: string;
  url: string;
  availability_text: string;
  source: string;
  source_icon: string | null;
  delivery: string | null;
  old_price: number | null;
  second_hand_condition: string | null;
}

interface GroupedProduct {
  product_id: string | null;
  title: string;
  image_url: string | null;
  rating: number | null;
  reviews: number | null;
  snippet: string | null;
  extensions: string[] | null;
  product_query: string;
  category: string | null;
  collected_at: admin.firestore.Timestamp;
  offers: Offer[];
  lowest_price: number;
}

function determineCategory(title: string, snippet: string | null): string | null {
  const text = `${title} ${snippet ?? ""}`.toLowerCase();

  if (text.includes("complete set") || text.includes("package set") || text.includes("box set")) return "Complete Sets";
  if (text.includes("bag")) return "Golf Bags"; // "stand bag", "cart bag"
  if (text.includes("push cart") || text.includes("pull cart") || text.includes("electric cart")) return "Carts";
  if (text.includes("driver")) return "Drivers";
  if (text.includes("fairway") || text.includes("wood") || text.includes("hybrid")) return "Woods";
  if (text.includes("wedge") || text.includes("sand") || text.includes("lob") || text.includes("gap")) return "Wedges";
  if (text.includes("putter")) return "Putters";
  if (text.includes("iron")) return "Irons";
  if (text.includes("rangefinder") || text.includes("gps") || text.includes("laser")) return "Rangefinders";
  if (text.includes("shirt") || text.includes("pant") || text.includes("shoe") || text.includes("hat") || text.includes("cap") || text.includes("glove") || text.includes("jacket")) return "Apparel";

  return null;
}

async function fetchGoogleShoppingPage(query: string, apiKey: string, start: number): Promise<SerpApiResult[]> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", query);
  url.searchParams.set("gl", "ca");
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "100");
  url.searchParams.set("start", start.toString());
  url.searchParams.set("api_key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`SerpAPI error: ${res.statusText}`);

  const data = (await res.json()) as { shopping_results?: SerpApiResult[] };
  return data.shopping_results ?? [];
}

async function fetchAndGroupGoogleShopping(query: string, apiKey: string): Promise<GroupedProduct[]> {
  // Fetch 2 pages of 100 results each
  const [page1, page2] = await Promise.all([
    fetchGoogleShoppingPage(query, apiKey, 0),
    fetchGoogleShoppingPage(query, apiKey, 100),
  ]);

  const allItems = [...page1, ...page2];
  const now = admin.firestore.Timestamp.now();
  const groupedMap = new Map<string, GroupedProduct>();
  const ungroupedItems: GroupedProduct[] = [];

  for (const it of allItems) {
    if (!it.title || !it.extracted_price || !it.link) continue;

    const offer: Offer = {
      price: Number(it.extracted_price),
      currency: "CAD",
      retailer: it.source || it.store || "Unknown",
      url: it.link,
      availability_text: `${it.delivery ?? ""} ${it.availability ?? ""}`.trim(),
      source: "google_shopping",
      source_icon: it.source_icon ?? null,
      delivery: it.delivery ?? null,
      old_price: it.extracted_old_price ? Number(it.extracted_old_price) : null,
      second_hand_condition: it.second_hand_condition ?? null,
    };

    const productData = {
      title: it.title,
      image_url: it.thumbnail ?? null,
      rating: it.rating ?? null,
      reviews: it.reviews ?? null,
      snippet: it.snippet ?? null,
      extensions: it.extensions ?? null,
      product_query: query,
      category: determineCategory(it.title, it.snippet ?? null),
      collected_at: now,
    };

    if (it.product_id) {
      if (groupedMap.has(it.product_id)) {
        const existing = groupedMap.get(it.product_id)!;
        existing.offers.push(offer);
        // Update lowest price
        if (offer.price < existing.lowest_price) {
          existing.lowest_price = offer.price;
        }
        // Prefer data that has more info if current is sparse (simple heuristic)
        if (!existing.rating && productData.rating) existing.rating = productData.rating;
        if (!existing.reviews && productData.reviews) existing.reviews = productData.reviews;
      } else {
        groupedMap.set(it.product_id, {
          product_id: it.product_id,
          ...productData,
          offers: [offer],
          lowest_price: offer.price,
        });
      }
    } else {
      // No product ID, treat as standalone
      ungroupedItems.push({
        product_id: null,
        ...productData,
        offers: [offer],
        lowest_price: offer.price,
      });
    }
  }

  return [...groupedMap.values(), ...ungroupedItems];
}

async function deleteCollection(db: admin.firestore.Firestore, collectionPath: string, batchSize: number) {
  const collectionRef = db.collection(collectionPath);
  const query = collectionRef.orderBy("__name__").limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(db, query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(db: admin.firestore.Firestore, query: admin.firestore.Query, resolve: (value?: unknown) => void) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    // When there are no documents left, we are done
    resolve();
    return;
  }

  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // Recurse on the next process tick, to avoid
  // exploding the stack.
  process.nextTick(() => {
    deleteQueryBatch(db, query, resolve);
  });
}

export const scrapeGoogleShopping = onRequest(
  {
    secrets: ["SERPAPI_KEY"],
  },
  async (req, res) => {
    const apiKey = process.env.SERPAPI_KEY as string;
    if (!apiKey) {
      console.error("Missing SERPAPI_KEY");
      res.status(500).send("Missing SERPAPI_KEY");
      return;
    }

    // Delete existing offers
    console.log("Deleting existing offers...");
    await deleteCollection(db, "offers", 400);
    console.log("Existing offers deleted.");

    const queries = ["golf"];

    const col = db.collection("offers");
    let totalProducts = 0;
    let totalOffers = 0;
    let batch = db.batch();
    let batchCount = 0;

    for (const q of queries) {
      try {
        const groupedProducts = await fetchAndGroupGoogleShopping(q, apiKey);
        for (const p of groupedProducts) {
          batch.set(col.doc(), p);
          batchCount++;
          totalProducts++;
          totalOffers += p.offers.length;

          if (batchCount >= 400) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }
      } catch (e) {
        console.error(`Failed to scrape query "${q}":`, e);
      }
    }

    if (batchCount > 0) await batch.commit();
    console.log(`Saved ${totalProducts} products with ${totalOffers} offers`);
    res.send(`Scraping complete. Saved ${totalProducts} products containing ${totalOffers} offers.`);
  }
);
