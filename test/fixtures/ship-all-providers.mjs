// A module loader hook for tests: loads src/ai/provider-registry.js with every provider switched on (shipped: true),
// so a test can check today's code against the day every provider ships. Production code has no switch for this.
// Register it before the registry is first imported: `register("./fixtures/ship-all-providers.mjs", import.meta.url)`.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.replace(/\\/g, "/").endsWith("/src/ai/provider-registry.js")) return result;
  const source = Buffer.from(result.source).toString("utf8");
  const shipped = source.replace(/shipped: false,/g, "shipped: true,");
  if (shipped === source) throw new Error("ship-all-providers: found no unshipped provider to switch on");
  return { ...result, source: shipped };
}
