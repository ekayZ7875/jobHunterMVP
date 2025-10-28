import fetch from "node-fetch";

export async function isAllowedToCrawl(baseUrl, userAgent = "*") {
  try {
    const robotsUrl = new URL("/robots.txt", baseUrl).toString();
    const res = await fetch(robotsUrl, { timeout: 5000 });
    if (!res.ok) return true;
    const text = await res.text();
    const lines = text.split("\n").map((l) => l.trim());
    let currentUA = null;
    for (const line of lines) {
      if (!line) continue;
      if (line.toLowerCase().startsWith("user-agent")) {
        currentUA = line.split(":")[1].trim();
      } else if (line.toLowerCase().startsWith("disallow") && currentUA) {
        const path = line.split(":")[1].trim();
        if (path === "/") return false;
      }
    }
    return true;
  } catch (err) {
    console.warn("robots check failed:", err.message);
    return true;
  }
}
