chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "FIND_GOODREADS") return false;

  findGoodreadsData(msg.isbn, msg.title, msg.author)
    .then((data) => sendResponse(data ?? { url: null }))
    .catch(() => sendResponse({ url: null }));

  return true; // keep message channel open for async response
});

async function findGoodreadsData(isbn, title, author) {
  const query = isbn || buildTitleQuery(title, author);
  const searchUrl = `https://www.goodreads.com/search?q=${encodeURIComponent(query)}&search_type=books`;

  const res = await fetch(searchUrl, {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!res.ok) throw new Error(`Goodreads search failed: ${res.status}`);

  const html = await res.text();
  const url = parseFirstBookUrl(html);
  if (!url) return null;

  // Fetch the actual book page to get rating data
  try {
    const bookRes = await fetch(url, {
      headers: { "Accept-Language": "en-US,en;q=0.9" },
    });
    if (bookRes.ok) {
      const bookHtml = await bookRes.text();
      const { rating, ratingCount } = parseRatingInfo(bookHtml);
      return { url, rating, ratingCount };
    }
  } catch {}

  return { url, rating: null, ratingCount: null };
}

function buildTitleQuery(title, author) {
  if (author) return `${title} ${author}`;
  return title;
}

function parseFirstBookUrl(html) {
  const match = html.match(/href="(\/book\/show\/[^"]+)"/);
  if (!match) return null;
  const path = match[1].split("?")[0];
  return `https://www.goodreads.com${path}`;
}

function parseRatingInfo(html) {
  // JSON-LD schema is the most reliable source
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldMatch) {
    try {
      const data = JSON.parse(ldMatch[1]);
      if (data.aggregateRating) {
        return {
          rating: parseFloat(data.aggregateRating.ratingValue),
          ratingCount: parseInt(data.aggregateRating.ratingCount, 10),
        };
      }
    } catch {}
  }

  // Fallback: scrape visible HTML
  const ratingMatch = html.match(/class="RatingStatistics__rating[^"]*"[^>]*>\s*([0-9.]+)/);
  const countMatch = html.match(/([\d,]+)\s+ratings/);
  return {
    rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
    ratingCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : null,
  };
}
