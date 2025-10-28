export async function retryWithBackoff(fn, maxRetries = 4, baseMs = 300) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;
      const wait = Math.pow(2, attempt) * baseMs + Math.floor(Math.random() * 200);
      console.warn(`Retry #${attempt} after ${wait}ms — ${err.code || err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
