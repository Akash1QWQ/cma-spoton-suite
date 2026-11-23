// 查地点候选：node lookup.js "Bata" "Praia" ...
const { launch, getPage, QUOTE_URL } = require('./lib');

(async () => {
  const names = process.argv.slice(2);
  const ctx = await launch({ headless: false });
  const page = await getPage(ctx);
  await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  for (const n of names) {
    const r = await page.evaluate(async (q) => {
      const res = await fetch('/api/LaracisCodifiedPlaces/GetAllPlacesForSpotOnPricing?id=' + encodeURIComponent(q), {
        headers: { Accept: 'application/json' }, credentials: 'include',
      });
      return { status: res.status, text: await res.text() };
    }, n);
    let list = [];
    try { list = JSON.parse(r.text); } catch (_) {}
    console.log(`\n=== ${n} (${Array.isArray(list) ? list.length : 'x'}) ===`);
    for (const x of (Array.isArray(list) ? list : [])) {
      console.log(`  ${x.code}  ${x.placeType}  ${x.countryName}  | ${x.actualName || x.name}`);
    }
  }
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
