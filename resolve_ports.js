// 批量把港口名解析成 CMA 地点代码（用于新增区域）
// 用法：node resolve_ports.js name1 name2 ...   -> 结果写到 output/places_resolve.json
const fs = require('fs');
const path = require('path');
const { launch, getPage, QUOTE_URL } = require('./lib');

const NAMES = process.argv.slice(2);
if (!NAMES.length) {
  console.log('用法: node resolve_ports.js "BARCELONA" "VALENCIA" ...');
  process.exit(1);
}

(async () => {
  const ctx = await launch({ headless: false });
  const page = await getPage(ctx);
  await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const out = {};
  for (const n of NAMES) {
    let list = [];
    try {
      const r = await page.evaluate(async (q) => {
        const res = await fetch('/api/LaracisCodifiedPlaces/GetAllPlacesForSpotOnPricing?id=' + encodeURIComponent(q), {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        return { status: res.status, text: await res.text() };
      }, n);
      if (r.status !== 200) {
        out[n] = { error: 'HTTP ' + r.status };
        console.log(`${n}: HTTP ${r.status}`);
        continue;
      }
      list = JSON.parse(r.text);
    } catch (e) {
      out[n] = { error: e.message };
      console.log(`${n}: ERR ${e.message}`);
      continue;
    }
    // 只保留海港/城市，按名称相似度排序
    const up = n.toUpperCase();
    const scored = list.map((x) => {
      const nm = String(x.actualName || x.name || '').toUpperCase();
      let sc = 0;
      if (nm === up) sc = 100;
      else if (nm.startsWith(up)) sc = 70;
      else if (nm.includes(up)) sc = 40;
      if (/SEA|PORT/i.test(String(x.placeType || ''))) sc += 5;
      return { code: x.code, name: x.actualName || x.name, type: x.placeType, country: x.countryName, sc };
    }).sort((a, b) => b.sc - a.sc);
    out[n] = scored.slice(0, 6);
    console.log(`\n=== ${n} (${scored.length}) ===`);
    scored.slice(0, 6).forEach((x) => console.log(`  ${String(x.sc).padStart(3)}  ${x.code}  ${x.type}  ${x.country}  | ${x.name}`));
    await page.waitForTimeout(300);
  }

  const dir = path.join(__dirname, 'output');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'places_resolve.json');
  let merged = {};
  try { merged = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  Object.assign(merged, out);
  fs.writeFileSync(f, JSON.stringify(merged, null, 2), 'utf8');
  console.log('\n结果已写入: ' + f);
  await ctx.close();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
