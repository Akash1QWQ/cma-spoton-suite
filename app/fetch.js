// CMA CGM SpotOn 批量询价
// 要点：只从「有舱位」的航次里取价（页面显示"Spot舱位已满"的会自动排除）
//
//   node fetch.js                  用当天缓存，只补没查过的港口
//   node fetch.js --fresh 1        全部重查（更新价格）
//   node fetch.js --sort etd       取「最快离港」的可订航次（默认 --sort price 取最低价）
//   node fetch.js --only KRIBI     只查名字含 KRIBI 的（A|B|C 或 A,B）
//   node fetch.js --group 南非线    只查某个分组
//   node fetch.js --limit 5        只跑前 5 个港
//   node fetch.js --pol CNXMN      起运港
//   node fetch.js --withTotal 0    不算总价（不查费用明细）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { launch, getPage, QUOTE_URL, isLoginUrl, saveState, dismissSessionModal } = require('./lib');

// 登录过期时弹一个 Windows 提示框 + 把浏览器窗口调到最前，免得错过
function notifyLogin(page) {
  try { if (page) page.bringToFront().catch(() => {}); } catch (_) {}
  // 用 wscript 的 MsgBox：不需要编译 C#（某些环境下 Add-Type 会 Access denied），
  // 并且带 vbSystemModal + vbSetForeground，保证弹在最前面
  try {
    const lines = [
      'CMA CGM 需要重新登录。',
      '',
      '可能是登录过期，也可能是刚才请求太频繁被临时限制。',
      '',
      '点“确定”后，请在刚弹出的浏览器窗口里重新登录，',
      '登录完不用关窗口，程序会自动继续。',
    ];
    const vbs = [
      'Dim m',
      'm = "' + lines.map((t) => t.replace(/"/g, '""')).join('" & vbCrLf & vbCrLf & "') + '"',
      'MsgBox m, 48 + 4096 + 65536 + 0, "CMA 报价程序 - 需要重新登录"',
    ].join('\r\n');
    const f = path.join(__dirname, '.notify.vbs');
    fs.writeFileSync(f, '\uFEFF' + vbs, 'utf16le');
    const child = spawn('wscript.exe', [f], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false });
    child.unref();
  } catch (e) {
    try { console.log('[提示] 弹窗没弹出来：' + e.message); } catch (_) {}
  }

}

// ---------------- 参数 ----------------
// 界面里保存的设置（settings.json）作为默认值，命令行参数优先
let SETTINGS = {};
try { SETTINGS = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (_) {}

const argv = process.argv.slice(2);

// 调试用：只弹一次登录提示框，验证弹窗是否正常
if (argv.includes('--notifyTest')) {
  notifyLogin(null);
  setTimeout(() => process.exit(0), 3000);
  return;
}
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const OPT = {
  pol: arg('pol', SETTINGS.pol || 'CNXMN'),
  weight: Number(arg('weight', SETTINGS.weight || 25000)),
  limit: Number(arg('limit', 0)),
  only: arg('only', ''),
  group: arg('group', ''),
  equips: arg('equips', '20ST,40HC').split(',').filter(Boolean),
  delay: Number(arg('delay', 3500)),
  outDir: arg('out', 'output'),
  fresh: arg('fresh', '0') === '1',
  withTotal: arg('withTotal', '1') !== '0',
  sort: arg('sort', 'price'),   // price = 最低价, etd = 最快离港
  maxCheck: Number(arg('maxCheck', 15)),
  // 船期过滤：开船日 ≥ 今天 + N 天（默认 3 天，稳妥一点）
  minEtdDays: Number(arg('minEtdDays', SETTINGS.minEtdDays != null ? SETTINGS.minEtdDays : 3)),
  minEtd: arg('minEtd', ''),
  region: arg('region', ''),   // 只查某个区域：非洲 / 中南美
  inspectAll: arg('inspectAll', '0') === '1',   // 把所有航次舱位都核实一遍（一次性，之后全离线）
};

// 最早可接受的开船日
function isoAddDays(d, n) {
  const x = new Date(d.getTime() + n * 86400000 - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}
const MIN_ETD = OPT.minEtd || isoAddDays(new Date(), OPT.minEtdDays);
const etdOf = (l) => String(l.DepartureDate || '').slice(0, 10);
const etdOK = (l) => etdOf(l) >= MIN_ETD;

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, OPT.outDir);
const RAW_DIR = path.join(OUT_DIR, 'raw');
const CACHE_DIR = path.join(OUT_DIR, 'cache');
const PORTS_FILE = path.join(ROOT, 'ports.csv');

// ---------------- CSV ----------------
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCSV(file, headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '');
const sameDay = (iso) => new Date(iso).toDateString() === new Date().toDateString();
const rateOf = (line, type) => {
  const e = (line.Equipments || []).find((x) => x.EquipmentSizeType === type);
  return e && typeof e.OceanFreightRate === 'number' ? e.OceanFreightRate : null;
};

// ---------------- 缓存 ----------------
// 结构: { meta, offers, checked: {offerId: true/false}, fees: {offerId: {20ST:{all,foreign,items}, ...}} }
const FEE_VER = 3;   // 附加费口径版本：2 = 只算外币费用（人民币港杂不并入）
function cacheFile(code) { return path.join(CACHE_DIR, code + '.json'); }

function loadCache(code) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(code), 'utf8'));
    if (!c || !c.offers || !c.checked) return null;
    if (c.meta.pol !== OPT.pol) return null;
    if (c.meta.equips.join(',') !== OPT.equips.join(',')) return null;
    if (c.meta.weight !== OPT.weight) return null;
    if (!sameDay(c.meta.at)) return null;
    // 旧版缓存的附加费是「含人民币港杂」的口径，作废后重算
    if (c.meta.feeVersion !== FEE_VER) c.fees = {};
    return c;
  } catch (_) { return null; }
}

// 缓存里的选择结果是否仍然符合当前规则（开船日 >= MIN_ETD），是就不用再联网
// 在缓存里按当前规则挑：返回 {line} 或 {need: offerId}（这一班还没核实过舱位）
function selectPicks(cache) {
  const lines = ((cache.offers || {}).QuoteLineAndRoutingHeaders || []).filter((l) => (l.Equipments || []).length);
  const cands = lines.filter((l) => OPT.equips.every((e) => rateOf(l, e) != null) && etdOK(l));
  const byPrice = [...cands].sort((a, b) => (rateOf(a, '20ST') + rateOf(a, '40HC')) - (rateOf(b, '20ST') + rateOf(b, '40HC')));
  const dayOf = (x) => String(x.DepartureDate || '').slice(0, 10);
  const byEtd = [...cands].sort((a, b) => {
    const da = dayOf(a), db = dayOf(b);
    if (da !== db) return da < db ? -1 : 1;
    return (rateOf(a, '20ST') + rateOf(a, '40HC')) - (rateOf(b, '20ST') + rateOf(b, '40HC'));
  });
  const first = (list) => {
    for (const l of list) {
      const st = (cache.checked || {})[l.OfferId];
      if (st === true) return { line: l };
      if (st === false) continue;
      return { need: l.OfferId };
    }
    return {};
  };
  return { price: first(byPrice), etd: first(byEtd) };
}

function saveCache(code, data) {
  fs.writeFileSync(cacheFile(code), JSON.stringify({
    meta: { at: new Date().toISOString(), pol: OPT.pol, equips: OPT.equips, weight: OPT.weight, feeVersion: FEE_VER },
    ...data,
  }), 'utf8');
}

// ---------------- 生成结果行 ----------------
// 从接口原始返回里算附加费：
//   按柜的：只并「预付侧」费用（Charges payable as per freight + 出口时支付），且不含人民币港杂；
//   按票的：BL 那一栏（如 Advanced Manifest Declaration Fee 25 USD）也加进去，20GP/40HQ 各加一份。
// 规则随时可以改，因为 cache.charges 里存了原始明细，不用再联网
function feeFromRaw(j) {
  const fee = {};
  const isLocal = (code) => /^CNY$/i.test(String(code || ''));
  const r2 = (x) => Math.round(x * 100) / 100;

  // BL（按票）级别的外币费用
  let blAdd = 0;
  const bl = (j || {}).BlChargeDetail;
  if (bl) {
    for (const g of ['FreightChargeDetails', 'PrepaidChargeDetails', 'CollectChargeDetails']) {
      for (const c of (bl[g] || [])) {
        if (typeof c.ConvertedRate === 'number' && !isLocal(c.CurrencyCode)) blAdd += c.ConvertedRate;
      }
    }
  }
  blAdd = r2(blAdd);

  const isOverweight = (c) => /overweight|超重/i.test(String(c.ChargeName || '') + ' ' + String(c.ChargeCode || ''));
  for (const it of ((j || {}).CargoChargeDetails || [])) {
    let sAll = 0, sFreight = 0, sOver = 0, ok = true;
    const items = [];
    for (const g of ['PrepaidChargeDetails', 'CollectChargeDetails', 'FreightChargeDetails']) {
      for (const c of (it[g] || [])) {
        const v = c.ConvertedRate;
        const local = isLocal(c.CurrencyCode);
        const over = isOverweight(c);
        if (typeof v === 'number') {
          sAll += v;
          if (over) {
            // 重柜费单独一列，不并进运价
            sOver += v;
          } else if (!local && (g === 'FreightChargeDetails' || g === 'PrepaidChargeDetails')) {
            sFreight += v;
          }
        }
        items.push({ group: g, name: c.ChargeName, cur: c.CurrencyCode, rate: c.Rate, usd: v, local, overweight: over });
      }
    }
    // 一条费用明细都没有 → 当作「没有数据」，不能算成 0 元，否则会漏掉附加费
    fee[it.EquipmentSizeType] = ok && items.length
      ? { all: r2(sAll + blAdd), freight: r2(sFreight + blAdd), overweight: r2(sOver), bl: blAdd, items }
      : null;
  }
  return fee;
}

// 取某个航次的附加费：优先用存下来的原始明细重算，其次用旧缓存里的合计
function feeOf(cache, offerId) {
  const raw = (cache.charges || {})[offerId];
  if (raw) return feeFromRaw(raw);
  const f = (cache.fees || {})[offerId] || {};
  return f;
}

function hasFee(cache, offerId) {
  if ((cache.charges || {})[offerId]) return true;
  const f = (cache.fees || {})[offerId];
  return !!(f && f['20ST'] && typeof f['20ST'].freight === 'number');
}

function buildRecord(p, code, cache) {
  const offers = cache.offers || {};
  const lines = (offers.QuoteLineAndRoutingHeaders || []).filter((l) => (l.Equipments || []).length);
  const first = lines[0] || {};
  const rec = {
    '分组': p['分组'], '目的港': p['查询名'],
    '港口代码': code,
    '目的港全名': p['_fullName'] || first.PodName || '',
    '国家': p['_country'] || first.PodCountryName || '',
    '20GP': '', '40HQ': '', '海运费20GP': '', '海运费40HQ': '', '附加费20GP': '', '附加费40HQ': '',
    '重柜费20GP': '', '重柜费40HQ': '',
    '最快离港20GP': '', '最快离港40HQ': '', '最快离港船期': '',
    '预计开船': '', '航程天数': '', '中转港': '', '船名': '', '航次': '',
    '报价有效期起': '', '总航次数': '', '状态': '', '备注': '',
  };
  const details = [];
  rec['总航次数'] = lines.length;

  if (!lines.length) {
    rec['状态'] = '无报价';
    rec['备注'] = offers.NoOfferReason || 'SpotOn 未返回方案';
    return { rec, details };
  }

  const checked = cache.checked || {};

  // 每一班的价格（跟「价格汇总」同口径：海运费 + 附加费 + BL）
  // 已满的班次官网不给费用明细，就借用本港可订班次的附加费，保证整列口径一致
  const numFee = (x) => (x && typeof x === 'object' && typeof x.freight === 'number' ? x.freight : null);
  const numOv = (x) => (x && typeof x === 'object' && typeof x.overweight === 'number' && x.overweight > 0 ? x.overweight : null);
  const refFee = cache.pickedId ? feeOf(cache, cache.pickedId) : {};   // 本港参照附加费
  const priceOf = (l) => {
    const fee = feeOf(cache, l.OfferId);
    const r20 = rateOf(l, '20ST'), r40 = rateOf(l, '40HC');
    // 某柜型缺费用明细时依次回退：本航次 → 本港参照航次 → 另一柜型（BL 级费用两柜型相同）
    const f20 = numFee(fee['20ST']) ?? numFee(refFee['20ST']) ?? numFee(fee['40HC']) ?? numFee(refFee['40HC']);
    const f40 = numFee(fee['40HC']) ?? numFee(refFee['40HC']) ?? numFee(fee['20ST']) ?? numFee(refFee['20ST']);
    return {
      p20: r20 != null && f20 != null ? Math.round((r20 + f20) * 100) / 100 : r20,
      p40: r40 != null && f40 != null ? Math.round((r40 + f40) * 100) / 100 : r40,
      ov20: numOv(fee['20ST']) ?? numOv(refFee['20ST']),
    };
  };

  const byPrice = [...lines].sort((a, b) => (rateOf(a, '20ST') + rateOf(a, '40HC')) - (rateOf(b, '20ST') + rateOf(b, '40HC')));
  for (const l of byPrice) {
    const st = checked[l.OfferId];
    const pr = priceOf(l);
    details.push({
      '分组': p['分组'], '目的港': p['查询名'], '港口代码': code,
      '船名': l.VesselName, '航次': l.Voyage,
      '预计开船': fmtDate(l.DepartureDate), '预计到港': fmtDate(l.ArrivalDate),
      '航程天数': l.TransitTime,
      '中转港': (l.TranShipment || []).join(' / '),
      '20GP': pr.p20 ?? '', '40HQ': pr.p40 ?? '',
      '重柜费20GP': pr.ov20 ?? '',
      '舱位': st === true ? '可订' : st === false ? '已满' : '未核实',
      '船期': etdOK(l) ? '可用' : '太早',
      '有效期起': fmtDate(l.QuoteValidityFromDate),
      'OfferId': l.OfferId,
    });
  }

  const fillFrom = (line) => {
    const fee = feeOf(cache, line.OfferId);
    const r20 = rateOf(line, '20ST');
    const r40 = rateOf(line, '40HC');
    const num = (x) => (x && typeof x === 'object' && typeof x.freight === 'number' ? x.freight : null);
    const f20 = num(fee['20ST']) ?? num(refFee['20ST']) ?? num(fee['40HC']) ?? num(refFee['40HC']);
    const f40 = num(fee['40HC']) ?? num(refFee['40HC']) ?? num(fee['20ST']) ?? num(refFee['20ST']);
    const ov = (x) => (x && typeof x === 'object' && typeof x.overweight === 'number' && x.overweight > 0 ? x.overweight : null);
    const ov20 = ov(fee['20ST']);
    const ov40 = ov(fee['40HC']);
    return {
      r20, r40, f20, f40, ov20, ov40,
      t20: r20 != null && f20 != null ? Math.round((r20 + f20) * 100) / 100 : null,
      t40: r40 != null && f40 != null ? Math.round((r40 + f40) * 100) / 100 : null,
    };
  };

  // 主价格 = 开船最早的那班（同一天里取最低价）；这班没有就用全港最低价那班
  const pickedLowest = lines.find((l) => l.OfferId === cache.pickedId);
  const pickedEtd = lines.find((l) => l.OfferId === cache.pickedEtdId);
  const picked = pickedEtd || pickedLowest;

  if (!picked) {
    rec['状态'] = '无报价';
    const anyOk = lines.some(etdOK);
    rec['备注'] = anyOk
      ? `开船日在 ${MIN_ETD} 之后的可订航次没有（共 ${lines.length} 班，其余要么已满要么太早）`
      : `开船日都在 ${MIN_ETD} 之前（共 ${lines.length} 班），赶不上截关`;
    return { rec, details };
  }

  {
    const { r20, r40, f20, f40, t20, t40, ov20, ov40 } = fillFrom(picked);
    // 主价格 = 页面「总价」口径（海运费 + 附加费，附加费已按美元折算）
    rec['20GP'] = t20 ?? r20 ?? '';
    rec['40HQ'] = t40 ?? r40 ?? '';
    rec['海运费20GP'] = r20 ?? '';
    rec['海运费40HQ'] = r40 ?? '';
    rec['附加费20GP'] = f20 ?? '';
    rec['附加费40HQ'] = f40 ?? '';
    rec['重柜费20GP'] = ov20 ?? '';
    rec['重柜费40HQ'] = ov40 ?? '';
    rec['船名'] = picked.VesselName || '';
    rec['航次'] = picked.Voyage || '';
    rec['预计开船'] = fmtDate(picked.DepartureDate);
    rec['航程天数'] = picked.TransitTime || '';
    rec['中转港'] = (picked.TranShipment || []).join(' / ');
    rec['报价有效期起'] = fmtDate(picked.QuoteValidityFromDate);
    if (f20 == null || f40 == null) rec['备注'] = '该航次官网没给全附加费明细，主价格只有海运费';
  }

  // 最快离港（有舱位的）那一班
  if (pickedEtd) {
    const { r20, r40, t20, t40 } = fillFrom(pickedEtd);
    rec['最快离港20GP'] = t20 ?? r20 ?? '';
    rec['最快离港40HQ'] = t40 ?? r40 ?? '';
    rec['最快离港船期'] = `${pickedEtd.VesselName || ''} ${fmtDate(pickedEtd.DepartureDate)} ${pickedEtd.TransitTime || ''}天`;
  }

  rec['状态'] = '正常';

  // 备注：全港最低价那班如果比这班便宜，把它的开船日和价格提示出来
  {
    const main20 = rec['20GP'];
    const main40 = rec['40HQ'];
    if (pickedLowest && pickedLowest.OfferId !== picked.OfferId &&
        fmtDate(pickedLowest.DepartureDate) !== fmtDate(picked.DepartureDate)) {
      const f = fillFrom(pickedLowest);
      const p20 = f.t20 ?? f.r20;
      const p40 = f.t40 ?? f.r40;
      const cheaper20 = typeof main20 === 'number' && p20 != null && p20 < main20;
      const cheaper40 = typeof main40 === 'number' && p40 != null && p40 < main40;
      if (cheaper20 || cheaper40) {
        const a = p20 != null ? p20 : '';
        const b = p40 != null ? p40 : '';
        rec['备注'] = (rec['备注'] ? rec['备注'] + '；' : '') +
          `${fmtDate(pickedLowest.DepartureDate)} 更低 ${a}/${b}`;
      }
    }
  }

  return { rec, details };
}

// ---------------- 主流程 ----------------
(async () => {
  const rowsRaw = parseCSV(fs.readFileSync(PORTS_FILE, 'utf8').replace(/^\ufeff/, ''));
  const head = rowsRaw.shift().map((h) => h.trim());
  const allPorts = rowsRaw.map((r) => {
    const o = {};
    head.forEach((h, i) => (o[h] = (r[i] || '').trim()));
    return o;
  }).filter((p) => p['查询名'] || p['港口代码']);

  const ports = allPorts
    .filter((p) => !OPT.region || (p['区域'] || (/(中南美)/.test(p['分组'] || '') ? '中南美' : '非洲')).includes(OPT.region))
    .filter((p) => !OPT.group || p['分组'] === OPT.group)
    .filter((p) => !OPT.only || OPT.only.split(/[|,]/).some((k) => k && (p['查询名'] + p['原表写法']).toUpperCase().includes(k.toUpperCase())))
    .slice(0, OPT.limit > 0 ? OPT.limit : undefined);

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`${OPT.region ? '[' + OPT.region + '] ' : ''}共 ${ports.length} 个目的港（起运港 ${OPT.pol}，箱型 ${OPT.equips.join('+')}，最大净重 ${OPT.weight} KGM，只取 Spot 有舱位且开船日 ≥ ${MIN_ETD} 的航次）`);

  const results = [], detailRows = [], pending = [], codeUpdates = {};

  for (const p of ports) {
    const code = p['港口代码'];
    const cached = code ? loadCache(code) : null;
    if (cached && !OPT.fresh && !OPT.inspectAll) {
      const sel = selectPicks(cached);
      if (!sel.price.need && !sel.etd.need) {
        const ids = [sel.price.line ? sel.price.line.OfferId : null, sel.etd.line ? sel.etd.line.OfferId : null].filter(Boolean);
        const needFee = OPT.withTotal && ids.some((id) => !hasFee(cached, id));
        if (!needFee) {
          cached.pickedId = sel.price.line ? sel.price.line.OfferId : null;
          cached.pickedEtdId = sel.etd.line ? sel.etd.line.OfferId : null;
          const { rec, details } = buildRecord(p, code, cached);
          results.push(rec);
          detailRows.push(...details);
          continue;
        }
      }
    }
    pending.push(p);
  }

  console.log(`缓存命中 ${ports.length - pending.length} 个，需要新查 ${pending.length} 个`);
  if (pending.length) await fetchPending(pending, results, detailRows, codeUpdates);
  else console.log('全部命中缓存，没有发起任何查询');

  // 没有报价的港口直接剔除，不写进表里
  const dropped = results.filter((r) => r['状态'] !== '正常');
  const kept = results.filter((r) => r['状态'] === '正常');
  const keptCodes = new Set(kept.map((r) => r['港口代码']));
  const keptDetails = detailRows.filter((d) => keptCodes.has(d['港口代码']));
  if (dropped.length) {
    console.log('已剔除没有报价的港口：' + dropped.map((r) => r['目的港']).join('、'));
  }

  // ---------------- 与上一次结果对比，打印变化 ----------------
  try {
    const nameTag = OPT.region ? OPT.region + '_' : '';
    const prevs = fs.readdirSync(OUT_DIR)
      .filter((f) => f.startsWith(`CMA价格_${nameTag}`) && f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (prevs.length) {
      const prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, prevs[0].f), 'utf8'));
      const prevMap = new Map((prev.results || []).map((r) => [r['目的港'], r]));
      const curMap = new Map(kept.map((r) => [r['目的港'], r]));
      const priceChanged = [], shipChanged = [], added = [], removed = [];

      const when = new Date(prev.generated || prevs[0].t).toLocaleString('zh-CN', { hour12: false });
      for (const [name, cur] of curMap) {
        const old = prevMap.get(name);
        if (!old) { added.push(name); continue; }
        const d20 = Number(cur['20GP']) - Number(old['20GP']);
        const d40 = Number(cur['40HQ']) - Number(old['40HQ']);
        if ((d20 && Number.isFinite(d20)) || (d40 && Number.isFinite(d40))) {
          priceChanged.push({ name, o20: old['20GP'], n20: cur['20GP'], d20, o40: old['40HQ'], n40: cur['40HQ'], d40 });
        } else if (old['预计开船'] !== cur['预计开船'] || old['船名'] !== cur['船名']) {
          shipChanged.push({
            name,
            oDate: old['预计开船'] || '', oShip: old['船名'] || '',
            nDate: cur['预计开船'] || '', nShip: cur['船名'] || '',
          });
        }
      }
      for (const name of prevMap.keys()) if (!curMap.has(name)) removed.push(name);

      console.log('');
      console.log(`===== 本次变化（对比 ${when} 那次）=====`);
      if (!priceChanged.length && !shipChanged.length && !added.length && !removed.length) {
        console.log('  价格、船期都没有变化');
      }
      if (priceChanged.length) {
        console.log(`  价格变化 ${priceChanged.length} 个港：`);
        priceChanged.slice(0, 20).forEach((x) => {
          const p20 = x.d20 ? `20GP ${x.o20} → ${x.n20}（${x.d20 > 0 ? '涨' : '降'} ${Math.abs(x.d20)}）` : '';
          const p40 = x.d40 ? `40HQ ${x.o40} → ${x.n40}（${x.d40 > 0 ? '涨' : '降'} ${Math.abs(x.d40)}）` : '';
          console.log(`    ${x.name}: ${[p20, p40].filter(Boolean).join('，')}`);
        });
        if (priceChanged.length > 20) console.log(`    ...还有 ${priceChanged.length - 20} 个港`);
      }
      if (shipChanged.length) {
        console.log(`  船期/船名变化 ${shipChanged.length} 个港（价格没变）：`);
        shipChanged.slice(0, 10).forEach((x) => console.log(`    ${x.name}: ${x.oDate} ${x.oShip} → ${x.nDate} ${x.nShip}`));
        if (shipChanged.length > 10) console.log(`    ...还有 ${shipChanged.length - 10} 个港`);
      }
      if (added.length) console.log('  新增港口：' + added.join('、'));
      if (removed.length) console.log('  本次没有报价的港口：' + removed.join('、'));
      console.log('===== 变化汇总结束 =====');

      // 同时写一份变化记录：CSV（Excel 可直接开）+ JSON（交给 to_xlsx 生成带颜色的表）
      try {
        const items = [];
        const dl = (d) => (d > 0 ? '+' + d : d < 0 ? String(d) : '');
        for (const x of priceChanged) {
          const up = x.d20 > 0 || x.d40 > 0, down = x.d20 < 0 || x.d40 < 0;
          items.push({
            name: x.name,
            type: up && !down ? '涨价' : down && !up ? '降价' : '有涨有降',
            o20: x.o20, n20: x.n20, d20: x.d20 || 0, d20s: dl(x.d20),
            o40: x.o40, n40: x.n40, d40: x.d40 || 0, d40s: dl(x.d40),
          });
        }
        for (const x of shipChanged) {
          items.push({
            name: x.name,
            type: x.oDate !== x.nDate ? '改期' : '换船',
            oDate: x.oDate, nDate: x.nDate, oShip: x.oShip, nShip: x.nShip,
          });
        }
        for (const n of added) items.push({ name: n, type: '新增' });
        for (const n of removed) items.push({ name: n, type: '本次无报价' });

        const stamp2 = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
        const nameTag2 = OPT.region ? OPT.region + '_' : '';
        const payload = { region: OPT.region || '全部', at: Date.now(), compareTo: prevs[0].f, items };
        const baseName = path.join(OUT_DIR, `变化记录_${nameTag2}${stamp2}`);
        fs.writeFileSync(baseName + '.json', JSON.stringify(payload, null, 2), 'utf8');

        const head = ['目的港', '变化类型', '上次20GP', '本次20GP', '20GP涨跌', '上次40HQ', '本次40HQ', '40HQ涨跌', '上次开船', '本次开船', '上次船名', '本次船名'];
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const lines = [head.map(esc).join(',')];
        for (const x of items) {
          const arrow = x.type === '涨价' ? '↑ 涨价' : x.type === '降价' ? '↓ 降价'
            : x.type === '有涨有降' ? '↕ 有涨有降' : x.type === '新增' ? '＋ 新增'
            : x.type === '本次无报价' ? '－ 本次无报价' : '≈ ' + x.type;
          lines.push([x.name, arrow, x.o20 ?? '', x.n20 ?? '', x.d20s ?? '', x.o40 ?? '', x.n40 ?? '',
            x.d40s ?? '', x.oDate ?? '', x.nDate ?? '', x.oShip ?? '', x.nShip ?? ''].map(esc).join(','));
        }
        if (items.length === 1 && items[0].type === '无变化') lines.push(['(本次没有变化)', '无变化'].map(esc).join(',') + ','.repeat(10));
        fs.writeFileSync(baseName + '.csv', '\uFEFF' + lines.join('\r\n'), 'utf8');
        console.log('变化记录: ' + baseName + '.csv');
      } catch (_) {}
    }
  } catch (e) {
    console.log('[提示] 变化对比没做成：' + e.message);
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const tag = OPT.region ? OPT.region + '_' : '';
  const mainFile = path.join(OUT_DIR, `CMA价格_${tag}${stamp}.csv`);
  const detailFile = path.join(OUT_DIR, `CMA价格明细_${tag}${stamp}.csv`);
  const jsonFile = path.join(OUT_DIR, `CMA价格_${tag}${stamp}.json`);

  if (!kept.length) {
    console.log('');
    console.log('本次没有任何有效报价，已跳过写文件，保留上一次的数据。');
    console.log('常见原因：登录未完成、接口限流、或开船日下限过滤掉了全部航次。');
    process.exitCode = 2;
    return;
  }

  writeCSV(mainFile, ['分组', '目的港', '20GP', '40HQ', '海运费20GP', '海运费40HQ', '附加费20GP', '附加费40HQ', '重柜费20GP', '重柜费40HQ', '最快离港20GP', '最快离港40HQ', '最快离港船期', '预计开船', '航程天数', '中转港', '船名', '航次', '港口代码', '目的港全名', '国家', '总航次数', '报价有效期起', '状态', '备注'], kept);
  writeCSV(detailFile, ['分组', '目的港', '港口代码', '船名', '航次', '预计开船', '预计到港', '航程天数', '中转港', '20GP', '40HQ', '重柜费20GP', '舱位', '船期', '有效期起', 'OfferId'], keptDetails);
  fs.writeFileSync(jsonFile, JSON.stringify({ generated: new Date().toISOString(), pol: OPT.pol, sort: OPT.sort, results: kept, allResults: results, details: keptDetails }, null, 2), 'utf8');

  // 只保留最近的几份结果文件，免得 output 越堆越多（变化记录留 5 份，其余 3 份）
  {
    const nameTag = OPT.region ? OPT.region + '_' : '';
    for (const prefix of [`CMA价格_${nameTag}`, `CMA价格明细_${nameTag}`, `变化记录_${nameTag}`]) {
      const keep = prefix.startsWith('变化记录_') ? 5 : 3;
      // 没有区域名时，只清理「无区域」的文件（CMA价格_2026...），别误删 CMA价格_非洲_...
      const re = nameTag
        ? new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*\\.(csv|json|xlsx)$')
        : new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d{12}\\.(csv|json|xlsx)$');
      const files = fs.readdirSync(OUT_DIR)
        .filter((f) => re.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      const keepStamps = new Set([...new Set(files.map((x) => (x.f.match(/(\d{12})/) || [])[1] || x.f))].slice(0, keep));
      for (const x of files) {
        const st = (x.f.match(/(\d{12})/) || [])[1] || x.f;
        if (st && !keepStamps.has(st)) { try { fs.unlinkSync(path.join(OUT_DIR, x.f)); } catch (_) {} }
      }
    }
  }

  const ok = results.filter((r) => r['状态'] === '正常').length;
  console.log('');
  console.log(`完成：成功 ${ok}，无报价/失败 ${results.length - ok}`);
  console.log('汇总表: ' + mainFile);
  console.log('航次明细: ' + detailFile);
  console.log('JSON: ' + jsonFile);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

// ---------------- 联网部分 ----------------
async function apiStatus(page) {
  try {
    return await page.evaluate(async () => {
      const r = await fetch('/apigw/commercial/spoton/bff/v1/requestquotationpartners', {
        headers: { Accept: 'application/json' }, credentials: 'include',
      });
      return r.status;
    });
  } catch (_) { return 0; }
}

// 确认登录态；接口异常（401 / 跳登录页）就提示重新登录，登录完自动继续
async function ensureSession(ctx, page) {
  await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  await dismissSessionModal(page);          // 有“会话已过期”遮罩就先点掉
  let st = await apiStatus(page);
  if (st === 200 && !isLoginUrl(page.url())) return true;

  console.log('');
  console.log('==========================================================');
  console.log('  接口返回异常（' + (st || '页面跳转') + '），可能是登录过期，也可能是刚才请求太频繁被临时限制。');
  console.log('  请在弹出的浏览器窗口里登录 CMA CGM，登录完不用关窗口，程序会自己继续。');
  console.log('  最多等 20 分钟。');
  console.log('==========================================================');
  notifyLogin(page);
  const deadline = Date.now() + 20 * 60 * 1000;
  let lastLog = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (page.isClosed()) throw new Error('浏览器窗口被关闭');
    await dismissSessionModal(page);        // 遮罩又冒出来就再点掉
    st = await apiStatus(page);
    if (st === 200) {
      await saveState(ctx).catch(() => {});
      // 登录成功后页面可能还在跳转，等它回到报价页并稳定，否则随后的请求会被打断
      try {
        if (!/instant-Quoting/i.test(page.url())) {
          await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' });
        }
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);
        await dismissSessionModal(page);
      } catch (_) {}
      console.log('登录成功，继续查询 ...');
      return true;
    }
    if (!isLoginUrl(page.url()) && !/instant-Quoting/i.test(page.url())) {
      await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); console.log('  ... 等待登录中'); }
  }
  return false;
}

async function fetchPending(pending, results, detailRows, codeUpdates) {
  const ctx = await launch({ headless: false });

  // 页面内 fetch 助手写进 init script：页面跳转/刷新后依然可用
  await ctx.addInitScript(() => {
    const cookie = (n) => {
      const m = document.cookie.match(new RegExp('(^|;\\s*)' + n + '=([^;]*)'));
      return m ? decodeURIComponent(m[2]) : '';
    };
    window.__cma = {
      async get(url) {
        const r = await fetch(url, { headers: { Accept: 'application/json, text/plain, */*' }, credentials: 'include' });
        return { status: r.status, text: await r.text() };
      },
      async post(url, body) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' };
        const x = cookie('XSRF-TOKEN');
        if (x) headers['X-XSRF-TOKEN'] = x;
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'include' });
        return { status: r.status, text: await r.text() };
      },
    };
  });

  const page = await getPage(ctx);

  // 运行期间定时检查“会话已过期”遮罩，出现就点掉，免得卡住
  const modalTimer = setInterval(async () => {
    try {
      if (page.isClosed()) return;
      const dismissed = await dismissSessionModal(page);
      // 点掉之后如果被带离了报价页（但又不是登录页），拉回来，避免后续接口打错域名
      if (dismissed) {
        const u = page.url();
        if (!isLoginUrl(u) && !/instant-Quoting/i.test(u)) {
          await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForTimeout(1500);
        }
      }
    } catch (_) {}
  }, 8000);
  if (modalTimer.unref) modalTimer.unref();
  try { ctx.on('close', () => clearInterval(modalTimer)); } catch (_) {}
  if (!(await ensureSession(ctx, page))) {
    console.log('登录没成功，退出。已经查到的港口不会丢（都在 output/cache 里）。');
    await ctx.close();
    process.exit(3);
  }

  const pr = await page.evaluate(() => window.__cma.get('/apigw/commercial/spoton/bff/v1/requestquotationpartners'));
  let partnerCodes = [];
  try { partnerCodes = JSON.parse(pr.text).map((p) => p.Code); } catch (_) {}
  console.log('报价单位: ' + (partnerCodes.join(',') || '(未取到)'));

  // 查一个航次：是否可订 + 费用明细（原始明细一并返回，方便以后离线重算）
  async function inspect(offerId) {
    const r = await page.evaluate((u) => window.__cma.get(u), '/apigw/commercial/spoton/bff/v1/allocationandchargedetails/' + offerId);
    if (r.status === 401 || r.status === 403) throw new Error('接口 401 会话失效');
    let j;
    try { j = JSON.parse(r.text); } catch (_) { return { bookable: null, fee: {}, raw: null }; }
    const a = j.AllocationDetail || {};
    const bookable = a.NoAllocationExist !== true && a.AllocationNotAvailable !== true;
    return { bookable, fee: feeFromRaw(j), raw: j };
  }

  // 处理一个港口：解析港口 -> 询价 -> 核实舱位 -> 写缓存
  async function fetchOne(p) {
    let code = p['港口代码'];

    if (!code) {
      const q = encodeURIComponent(p['查询名']);
      const r = await page.evaluate((u) => window.__cma.get(u), `/api/LaracisCodifiedPlaces/GetAllPlacesForSpotOnPricing?id=${q}`);
      if (r.status === 401 || r.status === 403) throw new Error('接口 401 会话失效');
      let list = [];
      try { list = JSON.parse(r.text); } catch (_) {}
      if (!Array.isArray(list) || !list.length) throw new Error('地点查不到：' + p['查询名']);
      const portOnes = list.filter((x) => String(x.placeType).toLowerCase() === 'port');
      const pool = portOnes.length ? portOnes : list;
      const tokens = String(p['国家'] || '').split('|').filter(Boolean).map((t) => t.toLowerCase());
      const score = (x) => {
        const cn = String(x.countryName || '').toLowerCase();
        if (!cn) return -1;
        let s = 0;
        for (const t of tokens) {
          if (cn.startsWith(t.slice(0, 4)) || t.startsWith(cn.slice(0, 4))) s += 2;
          else if (cn.includes(t)) s += 1;
        }
        return s;
      };
      const best = pool.map((x) => ({ x, s: score(x) })).sort((a, b) => b.s - a.s)[0].x;
      code = best.code;
      p['_fullName'] = best.actualName || best.name || '';
      p['_country'] = best.countryName || '';
      codeUpdates[p['查询名']] = code;
    }

    let cache = loadCache(code);
    if (!cache || OPT.fresh) {
      const body = {
        Pol: OPT.pol, Pod: code,
        Equipments: OPT.equips.map((e) => ({ EquipmentSizeType: e, NumberOfContainers: 1, WeightPerContainer: OPT.weight })),
        EquipmentType: 'ST', CommodityCode: 'FAK',
        Soc: false, Hazardous: false, EmptyContainer: false, FlexiTank: false,
        SimulationDate: new Date().toISOString().slice(0, 10),
        Poo: null, Fpd: null, ReceiptHaulage: null, DeliveryHaulage: null,
        Nor: false, IsBestOfferNearByPortSelected: false, Language: 'zh',
        CustomerType: null, FmcEligible: false, PartnerCodes: partnerCodes,
      };
      const r = await page.evaluate((b) => window.__cma.post('/apigw/commercial/spoton/bff/v1/getbestoffer', b), body);
      if (r.status !== 200 || r.text.trim().startsWith('<')) throw new Error('接口异常 HTTP ' + r.status);
      const offers = JSON.parse(r.text);
      fs.writeFileSync(path.join(RAW_DIR, `${code}.json`), r.text, 'utf8');
      cache = { offers, checked: {}, fees: {} };
      saveCache(code, cache);
    }

    // 每次按当前规则重挑：缓存里的「已核实舱位」直接复用，不重复查
    await repick(code, cache);
    return buildRecord(p, code, cache);
  }

  // 按「开船日 >= MIN_ETD」+「Spot 有舱位」重新挑：最低价一班、最快开船一班
  async function repick(code, cache) {
    const checked = cache.checked || {};
    const fees = cache.fees || {};
    const charges = cache.charges || {};
    let dirty = false;

    // 一次性把全部航次核实完：之后换任何过滤条件都是离线秒出
    if (OPT.inspectAll) {
      const lines = (cache.offers.QuoteLineAndRoutingHeaders || []).filter((l) => (l.Equipments || []).length);
      for (const l of lines) {
        if (l.OfferId in checked) continue;
        if (!OPT.equips.every((e) => rateOf(l, e) != null)) continue;
        const info = await inspect(l.OfferId);
        if (info.bookable === null) continue;
        checked[l.OfferId] = info.bookable;
        if (info.bookable) { fees[l.OfferId] = info.fee; if (info.raw) charges[l.OfferId] = info.raw; await sleep(120); }
        dirty = true;
      }
      cache.complete = true;
    }

    // 按当前规则挑；遇到还没核实舱位的航次就先查那一条
    for (let guard = 0; guard < 40; guard++) {
      const sel = selectPicks({ offers: cache.offers, checked, fees });
      const need = sel.price.need || sel.etd.need;
      if (!need) {
        cache.pickedId = sel.price.line ? sel.price.line.OfferId : null;
        cache.pickedEtdId = sel.etd.line ? sel.etd.line.OfferId : null;
        break;
      }
      const info = await inspect(need);
      if (info.bookable === null) { checked[need] = false; dirty = true; continue; }
      checked[need] = info.bookable;
      if (info.bookable) { fees[need] = info.fee; if (info.raw) charges[need] = info.raw; }
      dirty = true;
    }

    cache.checked = checked;
    cache.fees = fees;
    cache.charges = charges;

    // 选中的航次还没存费用明细时，补取一次（以后就不用了，明细原件都在本地）
    for (const id of new Set([cache.pickedId, cache.pickedEtdId].filter(Boolean))) {
      if (!charges[id]) {
        const info = await inspect(id);
        if (info.raw) { charges[id] = info.raw; fees[id] = info.fee; dirty = true; }
      }
    }

    if (dirty) saveCache(code, cache);
  }

  let done = 0;
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const tag = `[${i + 1}/${pending.length}] ${p['分组'] || ''} ${p['查询名']}`;
    let out = null;

    for (let attempt = 0; attempt < 3 && !out; attempt++) {
      try {
        out = await fetchOne(p);
      } catch (err) {
        // 403 多半是请求太频繁被临时限制：先等一会重试，不要马上弹登录
        if (/\b403\b/.test(err.message) && attempt < 2) {
          console.log('  接口 403（请求太频繁被临时限制），等 60 秒重试 ...');
          await sleep(60000);
          continue;
        }
        if (/closed|Target page|Browser has been closed/i.test(err.message)) {
          console.log('浏览器窗口被关了，先停在这里。已完成的港口都存在缓存里，重跑会接着来。');
          await ctx.close().catch(() => {});
          process.exit(4);
        }
        const needLogin = /401|403|会话失效|Execution context|Cannot read properties|接口异常/.test(err.message);
        if (!needLogin || attempt === 2) {
          results.push({ ...buildRecord(p, p['港口代码'], {}).rec, '状态': '失败', '备注': err.message });
          console.log(`${tag} -> 失败: ${err.message}`);
          break;
        }
        console.log(`  ${err.message} → 重新登录后重试这个港口 ...`);
        if (!(await ensureSession(ctx, page))) {
          results.push({ ...buildRecord(p, p['港口代码'], {}).rec, '状态': '失败', '备注': '登录失效且未重新登录成功' });
          break;
        }
      }
    }

    if (out) {
      results.push(out.rec);
      detailRows.push(...out.details);
      done++;
      console.log(`${tag} (${out.rec['港口代码']}) -> ${out.rec['状态'] === '正常'
        ? `20GP ${out.rec['20GP']} / 40HQ ${out.rec['40HQ']} · ${out.rec['船名']} ${out.rec['预计开船']} ${out.rec['航程天数']}天 · 共 ${out.rec['总航次数']} 班`
        : '无报价 ' + out.rec['备注']}`);
    }
    if (i < pending.length - 1) await sleep(OPT.delay + Math.random() * 2200);
  }

  await saveState(ctx).catch(() => {});
  await ctx.close();
}
