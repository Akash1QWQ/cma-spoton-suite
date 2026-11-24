// 非洲后段费用：厦门→POD（基本港） vs 厦门→FPOD（内陆点），同船同航次相减
// 用法：node inland.js [--only "Beira|Durban"] [--limit 5]
const fs = require('fs');
const path = require('path');
const { launch, getPage, QUOTE_URL, dismissSessionModal, isCaptcha } = require('./lib');

const OUT = path.join(__dirname, 'output');
const LANES = path.join(__dirname, 'inland_lanes.csv');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = arg('only', '');
const LIMIT = Number(arg('limit', 0)) || 0;

// ---------- 重量映射（毛重减 5 吨；20′ ≤24 吨按 18,000，40′ ≤28 吨按 23,000）----------
function netWeight20(gw) {
  const g = Number(gw) || 0;
  if (!g) return 18000;
  if (g <= 24) return 18000;
  return (g - 5) * 1000;
}
function netWeight40(gw) {
  const g = Number(gw) || 0;
  if (!g) return 23000;
  if (g <= 28) return 23000;
  return (g - 5) * 1000;
}
// Mode → DeliveryHaulage
function haulageOf(mode) {
  const m = String(mode || '').toLowerCase();
  if (/door/.test(m)) return 'Door';
  if (/ramp/.test(m)) return 'Ramp';
  if (/rail/.test(m)) return 'Ramp';
  if (/truck/.test(m)) return 'Door';
  return 'Ramp';
}

function readLanes() {
  const raw = fs.readFileSync(LANES, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(',').map((h) => h.trim());
  return lines.map((ln) => {
    const cells = ln.match(/("([^"]|"")*"|[^,]+)/g) || [];
    const o = {};
    head.forEach((h, i) => { o[h] = (cells[i] || '').replace(/^"|"$/g, '').replace(/""/g, '"').trim(); });
    return o;
  });
}

// 最近一次「非洲」报价数据
function latestAfrica() {
  const files = fs.readdirSync(OUT)
    .filter((f) => /^CMA价格_非洲_.*\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error('还没有非洲报价数据，先跑一次「更新价格 · 非洲」');
  const j = JSON.parse(fs.readFileSync(path.join(OUT, files[0].f), 'utf8').replace(/^\uFEFF/, ''));
  const byName = new Map();
  for (const r of (j.results || [])) {
    const k = String(r['目的港'] || '').trim().toLowerCase();
    if (k) byName.set(k, r);
  }
  return { file: files[0].f, at: files[0].t, byName };
}

const d10 = (s) => String(s || '').slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;

(async () => {
  let lanes = readLanes();
  if (ONLY) {
    const keys = ONLY.split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
    lanes = lanes.filter((l) => keys.some((k) => (l.POD + ' ' + l.FPOD).toLowerCase().includes(k)));
  }
  if (LIMIT) lanes = lanes.slice(0, LIMIT);
  if (!lanes.length) throw new Error('线路表为空');

  const africa = latestAfrica();
  console.log(`线路 ${lanes.length} 条 · 基准报价 ${africa.file}`);

  const ctx = await launch({ headless: false });
  const page = await getPage(ctx);
  const timer = setInterval(() => { if (!page.isClosed()) dismissSessionModal(page).catch(() => {}); }, 8000);
  if (timer.unref) timer.unref();
  const api = async (m, u, b) => {
    const run = page.evaluate(async ({ m, u, b }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(u, { method: m, credentials: 'include', signal: ctrl.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: '', err: String(e.message || e) };
      } finally {
        clearTimeout(t);
      }
    }, { m, u, b });
    const timeout = new Promise((r) => setTimeout(() => r({ status: 0, text: '', err: 'timeout' }), 25000));
    return Promise.race([run, timeout]);
  };

  // ---------- 查询缓存（同一天内复用，避免重复请求）----------
  const CACHE_FILE = path.join(OUT, '.inland_cache.json');
  let cache = { day: '', search: {}, totals: {} };
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c && c.day === new Date().toISOString().slice(0, 10)) cache = c;
  } catch (_) {}
  const saveCache = () => {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8'); } catch (_) {}
  };
  const slimRoute = (h) => ({
    VesselName: h.VesselName, Voyage: h.Voyage, DepartureDate: h.DepartureDate,
    OfferId: h.OfferId,
    Equipments: (h.Equipments || []).map((e) => ({ EquipmentSizeType: e.EquipmentSizeType, OceanFreightRate: e.OceanFreightRate })),
  });

  const out = [];
  try {
    await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    await dismissSessionModal(page);

    let pr = await api('GET', '/apigw/commercial/spoton/bff/v1/requestquotationpartners');
    if (pr.status !== 200) {
      console.log('');
      console.log('==========================================================');
      console.log('  登录态已失效（HTTP ' + pr.status + '），需要重新登录 CMA CGM。');
      console.log('  请在弹出的浏览器窗口里登录，登录完不用关窗口，程序会自己继续。');
      console.log('  最多等 20 分钟。');
      console.log('==========================================================');
      const deadline = Date.now() + 20 * 60 * 1000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(3000);
        if (page.isClosed()) throw new Error('浏览器窗口被关闭');
        await dismissSessionModal(page).catch(() => {});
        pr = await api('GET', '/apigw/commercial/spoton/bff/v1/requestquotationpartners');
        if (await isCaptcha(page)) console.log('  ... 窗口里出现了人机验证，请拖动滑块完成验证');
        if (pr.status === 200 && !(await isCaptcha(page))) {
          console.log('登录成功，继续计算后段费用 ...');
          await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(3000);
          break;
        }
      }
      if (pr.status !== 200) throw new Error('等待登录超时（' + pr.status + '）');
    }
    const partners = JSON.parse(pr.text).map((p) => p.Code);
    const today = new Date().toISOString().slice(0, 10);

    // 地点查码（带缓存）
    const placeCache = new Map();
    const placeCode = async (name) => {
      const k = name.toLowerCase();
      if (placeCache.has(k)) return placeCache.get(k);
      const r = await api('GET', '/api/LaracisCodifiedPlaces/GetAllPlacesForSpotOnPricing?id=' + encodeURIComponent(name));
      let arr = [];
      try { arr = JSON.parse(r.text); } catch (_) {}
      const first = arr.find((p) => /rampdoor|inland/i.test(p.placeType || '')) || arr[0];
      const code = first ? first.code : '';
      placeCache.set(k, code);
      return code;
    };

    const searchRaw = async (pod, fpd, haulage, w20, w40) => {
      const body = {
        Pol: 'CNXMN', Pod: pod,
        Equipments: [
          { EquipmentSizeType: '20ST', NumberOfContainers: 1, WeightPerContainer: w20 },
          { EquipmentSizeType: '40HC', NumberOfContainers: 1, WeightPerContainer: w40 },
        ],
        EquipmentType: 'ST', CommodityCode: 'FAK',
        Soc: false, Hazardous: false, EmptyContainer: false, FlexiTank: false,
        SimulationDate: today, Poo: null,
        Fpd: fpd || null, ReceiptHaulage: null, DeliveryHaulage: haulage || null,
        Nor: false, IsBestOfferNearByPortSelected: false, Language: 'zh',
        CustomerType: null, FmcEligible: false, PartnerCodes: partners,
      };
      const r = await api('POST', '/apigw/commercial/spoton/bff/v1/getbestoffer', body);
      if (r.status !== 200) return [];
      try { return JSON.parse(r.text).QuoteLineAndRoutingHeaders || []; } catch (_) { return []; }
    };

    const search = async (pod, fpd, haulage, w20, w40) => {
      const k = [pod, fpd || '', haulage || '', w20, w40].join('|');
      if (cache.search[k]) return cache.search[k];
      const routes = await searchRaw(pod, fpd, haulage, w20, w40);
      if (routes.length) {
        cache.search[k] = routes.map(slimRoute);
        saveCache();
      }
      return routes;
    };

    const totalsRaw = async (offerId) => {
      const r = await api('GET', '/apigw/commercial/spoton/bff/v1/allocationandchargedetails/' + offerId);
      let j = {};
      try { j = JSON.parse(r.text); } catch (_) {}
      const res = {};
      res.__chg = !!j.ChargeDetailNotExist;
      try { const al=(j.AllocationDetail&&j.AllocationDetail.AllocationDetails)||[]; res.__eq = al.map(a=>a.EquipmentSizeType+':ex='+(a.WeightExceeded?'1':'0')+',max='+a.MaxAllowedWeight+',alloc='+(a.Allocation?'1':'0')).join(' '); } catch(e) {}
      // 记录这条航线允许的最大重量（超重时接口不给费用明细）
      try {
        const al = (j.AllocationDetail && j.AllocationDetail.AllocationDetails) || [];
        for (const a of al) {
          if (a && a.EquipmentSizeType && typeof a.MaxAllowedWeight === 'number') {
            res.__max = res.__max || {};
            res.__max[a.EquipmentSizeType] = a.MaxAllowedWeight;
          }
        }
      } catch (_) {}
      const isCny = (c) => /^CNY$/i.test(String(c || ''));
      const isOver = (c) => /overweight|超重/i.test(String(c.ChargeName || '') + ' ' + String(c.ChargeCode || ''));
      for (const it of (j.CargoChargeDetails || [])) {
        const et = it.EquipmentSizeType;
        const ocean = (it.OceanFreight || {}).Rate;
        const bl = j.BlChargeDetail || {};
        let blAdd = 0;
        for (const g of ['FreightChargeDetails', 'PrepaidChargeDetails']) {
          for (const c of (bl[g] || [])) if (!isCny(c.CurrencyCode) && typeof c.ConvertedRate === 'number') blAdd += c.ConvertedRate;
        }
        let add = 0;
        for (const g of ['FreightChargeDetails', 'PrepaidChargeDetails']) {
          for (const c of (it[g] || [])) {
            // 只累加「有科目名的外币明细」：人民币项、超重费、以及没有科目名的汇总行都不计入
            if (!String(c.ChargeName || '').trim()) continue;
            if (isCny(c.CurrencyCode) || isOver(c)) continue;
            if (typeof c.ConvertedRate === 'number') add += c.ConvertedRate;
          }
        }
        // 进口时支付（CollectChargeDetails）不计入，和报价表一致
        const price = typeof ocean === 'number' ? Math.round((ocean + add + blAdd) * 100) / 100 : null;
        res[et] = { total: price, ocean: typeof ocean === 'number' ? ocean : null, price };
      }
      return res;
    };

    const totals = async (offerId) => {
      if (cache.totals[offerId]) return cache.totals[offerId];
      const t = await totalsRaw(offerId);
      if (t['20ST'] || t['40HC']) {
        cache.totals[offerId] = t;
        saveCache();
      }
      return t;
    };

    const keyOf = (h) => `${h.VesselName}|${h.Voyage}`;
    let i = 0;
    for (const lane of lanes) {
      i += 1;
      const podName = lane.POD, fpodName = lane.FPOD;
      const base = africa.byName.get(podName.toLowerCase());
      const row = {
        POD: podName, FPOD: fpodName, Mode: lane.Mode,
        MaxGW20: lane['Max GW (20\') tons'] || lane.MaxGW20 || '',
        MaxGW40: lane['Max GW (40\') tons'] || lane.MaxGW40 || '',
        '后段20ST': '无报价', '后段40HC': '无报价', '基准船名/航次': '', '备注': '',
      };
      if (!base) { row['备注'] = 'POD 无报价'; out.push(row); console.log(`[${i}/${lanes.length}] ${podName}→${fpodName} 跳过：POD 无报价`); continue; }

      const podCode = base['港口代码'];
      const w20 = netWeight20(row.MaxGW20), w40 = netWeight40(row.MaxGW40);
      const haulage = haulageOf(lane.Mode);
      const wantVessel = base['船名'], wantVoyage = base['航次'];
      row['基准船名/航次'] = `${wantVessel} / ${wantVoyage}`;

      try {
        const fpod = await placeCode(fpodName);
        if (!fpod) { row['备注'] = '内陆点未找到'; out.push(row); console.log(`[${i}/${lanes.length}] ${podName}→${fpodName} 内陆点未找到`); continue; }

        console.log(`[${i}/${lanes.length}] ${podName}→${fpodName} ${lane.Mode} ${w20}/${w40} 查询中…`);
        const aRoutes = await search(podCode, null, null, w20, w40);
        const bRoutes = await search(podCode, fpod, haulage, w20, w40);
        console.log(`      基本港 ${aRoutes.length} 条 / 内陆 ${bRoutes.length} 条`);
        const want = `${wantVessel}|${wantVoyage}`;
        const aSorted = [...aRoutes].sort((x, y) => (keyOf(x) === want ? -1 : 0) - (keyOf(y) === want ? -1 : 0));
        const bSorted = [...bRoutes].sort((x, y) => (keyOf(x) === want ? -1 : 0) - (keyOf(y) === want ? -1 : 0));

        if (!aSorted.length) { row['备注'] = '基本港无报价'; out.push(row); console.log(`[${i}/${lanes.length}] ${podName} 基本港无报价`); continue; }
        if (!bSorted.length) { row['备注'] = '内陆点无报价'; out.push(row); console.log(`[${i}/${lanes.length}] ${podName}→${fpodName} 内陆点无报价`); continue; }

        // 逐条配对找「两边都有费用明细」的同一条船（优先基准船期）
        // 逐条船配对：谁的明细全就用谁的，20ST 和 40HC 可以来自不同的船，但必须「同一船前后段成对」
        const pair = {};   // et -> { av, bv, key }
        let aHit = null, bHit = null, ta = {}, tb = {};
        const seenMax = {};
        for (const b of bSorted.slice(0, 12)) {
          const a = aSorted.find((h) => keyOf(h) === keyOf(b));
          if (!a) continue;
          const t1 = await totals(a.OfferId);
          const t2 = await totals(b.OfferId);
          if (process.env.LOGPAIR) console.log('PAIR ' + keyOf(b) + ' | A:' + (t1.__chg?'noCharge':'ok') + ' ' + (t1.__eq||'') + ' | B:' + (t2.__chg?'noCharge':'ok') + ' ' + (t2.__eq||''));
          for (const et of ['20ST', '40HC']) {
            const m = (t2.__max && t2.__max[et]) || (t1.__max && t1.__max[et]);
            if (typeof m === 'number' && m > 0 && (!seenMax[et] || m > seenMax[et])) seenMax[et] = m;
            if (pair[et]) continue;
            if (t1[et] && t1[et].price != null && t2[et] && t2[et].price != null) {
              pair[et] = { av: t1[et].price, bv: t2[et].price, key: keyOf(b) };
            }
          }
          if (pair['20ST'] && pair['40HC']) { aHit = a; bHit = b; ta = t1; tb = t2; break; }
          if (!aHit) { aHit = a; bHit = b; ta = t1; tb = t2; }
        }
        // 全都因为「超过允许重量」被拒 → 降到该航线允许的重量再查一次
        const emptyPair = !pair['20ST'] && !pair['40HC'];
        if (emptyPair && Object.keys(seenMax).length) {
          const w2 = Math.min(w20, seenMax['20ST'] || w20);
          const w4 = Math.min(w40, seenMax['40HC'] || w40);
          if (w2 < w20 || w4 < w40) {
            console.log(`      超过允许重量，改按 ${w2}/${w4} KGM 重查`);
            const a2 = await search(podCode, null, null, w2, w4);
            const b2 = await search(podCode, fpod, haulage, w2, w4);
            for (const b of [...b2].slice(0, 12)) {
              const a = a2.find((h) => keyOf(h) === keyOf(b));
              if (!a) continue;
              const t1 = await totals(a.OfferId);
              const t2 = await totals(b.OfferId);
              for (const et of ['20ST', '40HC']) {
                if (pair[et]) continue;
                if (t1[et] && t1[et].price != null && t2[et] && t2[et].price != null) {
                  pair[et] = { av: t1[et].price, bv: t2[et].price, key: keyOf(b) };
                  row['备注'] = `按 ${et === '20ST' ? w2 : w4} KGM 计`;
                }
              }
              if (pair['20ST'] && pair['40HC']) break;
            }
            if (!aHit && (pair['20ST'] || pair['40HC'])) { aHit = a2[0] || a; bHit = b; }
          }
        }

        // 没有「同一条船且两边都有费用明细」的组合 → 不硬凑，直接标无同航次
        if (!aHit) {
          row['备注'] = '无同航次报价';
          out.push(row);
          console.log('[' + i + '/' + lanes.length + '] ' + podName + '→' + fpodName + ' 无同航次报价');
          continue;
        }
        const oceanOf = (h, et) => {
          const e = (h.Equipments || []).find((x) => x.EquipmentSizeType === et);
          return e && typeof e.OceanFreightRate === 'number' ? e.OceanFreightRate : null;
        };
        let usedOceanOnly = false;
        for (const [et, col] of [['20ST', '后段20ST'], ['40HC', '后段40HC']]) {
          const pv = pair[et];
          const av = pv ? pv.av : null;
          const bv = pv ? pv.bv : null;
          if (av == null || bv == null) usedOceanOnly = true;
          if (av != null && bv != null) {
            const diff = r2(bv - av);
            if (diff < 0) {
              row[col] = '无报价';
              if (!row['备注']) row['备注'] = '差价异常（负数），已忽略';
            } else {
              row[col] = diff;
            }
          }
        }
        if (usedOceanOnly && !row['备注']) row['备注'] = '无费用明细（按海运费）';
        
        console.log(`[${i}/${lanes.length}] ${podName}→${fpodName} ${lane.Mode} ${w20}/${w40} → ${row['后段20ST'] || '—'} / ${row['后段40HC'] || '—'}  ${row['备注'] || ''}`);
      } catch (e) {
        row['备注'] = '查询出错：' + String(e.message || e).slice(0, 40);
        console.log(`[${i}/${lanes.length}] ${podName}→${fpodName} 出错：${e.message}`);
      }
      out.push(row);
    }
  } finally {
    clearInterval(timer);
    try { await page.close({ runBeforeUnload: false }); } catch (_) {}
    try { await ctx.close(); } catch (_) {}
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const jsonFile = path.join(OUT, `非洲后段_${stamp}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({ generated: new Date().toISOString(), baseFile: africa.file, rows: out }, null, 2), 'utf8');
  const head = ['POD', 'FPOD', 'Mode', 'MaxGW20', 'MaxGW40', '后段20ST', '后段40HC', '基准船名/航次', '备注'];
  const csv = [head.join(',')].concat(out.map((r) => head.map((h) => `"${String(r[h] == null ? '' : r[h]).replace(/"/g, '""')}"`).join(','))).join('\r\n');
  fs.writeFileSync(path.join(OUT, `非洲后段_${stamp}.csv`), '\uFEFF' + csv + '\r\n', 'utf8');
  const ok = out.filter((r) => r['后段20ST'] || r['后段40HC']).length;
  console.log(`\n完成：${ok}/${out.length} 条算出后段费用`);
  console.log('结果: ' + jsonFile);
  console.log('CSV : ' + path.join(OUT, `非洲后段_${stamp}.csv`));
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
