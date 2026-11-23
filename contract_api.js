// 合约建立（纯接口版）：不点界面，直接调 SpotOn 的 BFF 接口拿报价号
// 用法：node contract_api.js payload.json
// payload: {"portCode":"NGAPP","portName":"Apapa","equips":[{"type":"20ST","qty":1}],"weight":15770,"vessel":"...","voyage":"...","etd":"2026-11-01"}
const fs = require('fs');
const path = require('path');
const { launch, getPage, QUOTE_URL, dismissSessionModal } = require('./lib');

const OUT = path.join(__dirname, 'output');
const STATE_FILE = path.join(OUT, '.contract_state.json');
const RECORD_FILE = path.join(OUT, '合约记录.csv');

const STEPS = [
  '登录取报价单位',
  '调 getbestoffer 取船期和 OfferId',
  '匹配指定船期',
  '检查下单权限',
  '调 createquote 生成报价号',
  '写记录',
];

const TYPE_MAP = { '20GP': '20ST', '40GP': '40ST', '40HQ': '40HC', '45HQ': '45HC' };
const cmaType = (t) => TYPE_MAP[t] || t;
const SLOT = { '20ST': 0, '40ST': 1, '40HC': 2, '45HC': 3 };

const rawArg = process.argv[2] || '{}';
const args = rawArg.trim().startsWith('{') ? JSON.parse(rawArg) : JSON.parse(fs.readFileSync(rawArg, 'utf8'));

const state = {
  startedAt: Date.now(),
  steps: STEPS.map((n) => ({ name: n, status: 'pending', note: '' })),
  quoteNo: '', error: '', finished: false, shot: '', payload: args,
};
const save = (p = {}) => { Object.assign(state, p); try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch (_) {} };
const step = (i, s, n) => { if (state.steps[i]) { state.steps[i].status = s; if (n) state.steps[i].note = n; } save(); console.log(`[${i + 1}/6] ${STEPS[i]} -> ${s}${n ? '：' + n : ''}`); };
// 合约 24 小时就过期，过期的记录直接清掉
function purgeOldRecords() {
  try {
    if (!fs.existsSync(RECORD_FILE)) return;
    const raw = fs.readFileSync(RECORD_FILE, 'utf8').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return;
    const head = lines.shift();
    const keep = lines.filter((ln) => {
      const m = /^"([^"]+)"/.exec(ln);
      if (!m) return false;
      const t = Date.parse(m[1].replace(/\//g, '-'));
      return Number.isFinite(t) ? (Date.now() - t) < 24 * 3600 * 1000 : true;
    });
    if (keep.length !== lines.length) {
      fs.writeFileSync(RECORD_FILE, '\uFEFF' + [head, ...keep].join('\r\n') + '\r\n', 'utf8');
      console.log(`  清理过期记录：删除 ${lines.length - keep.length} 条（超过 24 小时）`);
    }
  } catch (_) {}
}

function appendRecord(row) {
  try {
    if (!fs.existsSync(RECORD_FILE)) fs.writeFileSync(RECORD_FILE, '\uFEFF时间,目的港,柜型×柜量,船名/航次,开船,报价号,状态,20GP,40HQ\r\n', 'utf8');
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    fs.appendFileSync(RECORD_FILE, row.map(esc).join(',') + '\r\n', 'utf8');
  } catch (_) {}
}

// 记住这次建立报价用的参数，方便到点自动续约
function savePayload(quoteNo) {
  try {
    const f = path.join(OUT, '.contract_payloads.json');
    let m = {};
    try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
    m[quoteNo] = { payload: args, at: Date.now() };
    fs.writeFileSync(f, JSON.stringify(m, null, 2), 'utf8');
  } catch (_) {}
}

// 记录写完立刻重建带样式的 xlsx（界面「已建立的合约」卡片打开的就是它）
function rebuildXlsx() {
  try {
    const py = path.join(__dirname, 'runtime', 'python', 'python.exe');
    require('child_process')
      .spawn(py, [path.join(__dirname, 'contract_xlsx.py')], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true })
      .unref();
  } catch (_) {}
}

async function main() {
  purgeOldRecords();
  const equips = args.equips.map((e) => ({ EquipmentSizeType: cmaType(e.type), NumberOfContainers: e.qty || 1, WeightPerContainer: args.weight }));
  const eqText = args.equips.map((e) => `${e.qty} x ${cmaType(e.type)}`).join(' + ');
  console.log(`目标：${args.portName || args.portCode} / ${eqText} / ${args.weight} KGM / ${args.vessel || ''} ${args.voyage || ''} ${args.etd || ''}`);

  const ctx = await launch({ headless: false });
  const page = await getPage(ctx);
  const timer = setInterval(() => { if (!page.isClosed()) dismissSessionModal(page).catch(() => {}); }, 8000);
  if (timer.unref) timer.unref();

  try {
    step(0, 'running');
    await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    await dismissSessionModal(page);
    await page.waitForTimeout(1000);

    const api = async (method, url, body) => page.evaluate(async ({ m, u, b }) => {
      const r = await fetch(u, {
        method: m, credentials: 'include',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: r.status, text: await r.text() };
    }, { m: method, u: url, b: body });

    // 登录态 + 报价单位
    const pr = await api('GET', '/apigw/commercial/spoton/bff/v1/requestquotationpartners');
    if (pr.status !== 200) throw new Error('登录态无效（HTTP ' + pr.status + '），请先登录 CMA');
    const partnerList = JSON.parse(pr.text);
    const partners = partnerList.map((p) => p.Code);
    const partnerDetails = partnerList.map((p) => ({ partnerCode: p.Code, partnerName: p.Name || p.PartnerName || p.PartnerFullName || '' }));
    step(0, 'done', partners.join(','));

    // 取船期
    step(1, 'running');
    const today = new Date().toISOString().slice(0, 10);
    const body = {
      Pol: 'CNXMN', Pod: args.portCode, Equipments: equips,
      EquipmentType: 'ST', CommodityCode: 'FAK',
      Soc: false, Hazardous: false, EmptyContainer: false, FlexiTank: false,
      SimulationDate: today, Poo: null, Fpd: null, ReceiptHaulage: null, DeliveryHaulage: null,
      Nor: false, IsBestOfferNearByPortSelected: false, Language: 'zh',
      CustomerType: null, FmcEligible: false, PartnerCodes: partners,
    };
    const gr = await api('POST', '/apigw/commercial/spoton/bff/v1/getbestoffer', body);
    if (gr.status !== 200) throw new Error('getbestoffer HTTP ' + gr.status);
    const gj = JSON.parse(gr.text);
    const traceId = gj.TraceId || '';
    const loggedId = gj.LoggedId || '';
    const routes = gj.QuoteLineAndRoutingHeaders || [];
    step(1, 'done', routes.length + ' 条航线');

    // 匹配船期
    step(2, 'running');
    const wantV = String(args.vessel || '');
    const wantDay = String(args.etd || '').slice(0, 10);
    // 只在“有舱位”的航线里挑：逐条查 allocationandchargedetails
    const sameVessel = routes.filter((r) => (wantV ? r.VesselName === wantV : true) &&
      (wantDay ? String(r.DepartureDate || '').slice(0, 10) === wantDay : true));
    const pool = sameVessel.length ? sameVessel : routes;
    let hit = null;
    for (const r of pool) {
      const ar = await api('GET', '/apigw/commercial/spoton/bff/v1/allocationandchargedetails/' + r.OfferId);
      let ok = false;
      try {
        const aj = JSON.parse(ar.text).AllocationDetail || {};
        ok = aj.NoAllocationExist !== true && aj.AllocationNotAvailable !== true;
      } catch (_) {}
      console.log('   航线', r.SolutionNumber, r.VesselName, String(r.DepartureDate).slice(0, 10), ok ? '有舱位' : '已满');
      if (ok) { hit = r; break; }
    }
    if (!hit) throw new Error('这条船名/日期下所有航线都没有舱位');
    const offerId = hit.OfferId;
    step(2, 'done', `${hit.VesselName} ${hit.Voyage} ${String(hit.DepartureDate).slice(0, 10)}`);

    // 关键：先 PATCH updatenextdeparture，告诉服务端“我选的是哪条航线”
    const patch = await api('PATCH', '/apigw/commercial/spoton/bff/v1/updatenextdeparture', {
      LoggedId: loggedId, SolutionId: hit.SolutionNumber, ScheduleId: hit.ScheduleNumber,
    });
    console.log('  updatenextdeparture:', patch.status, patch.text.slice(0, 30));

    // PATCH 之后服务端会重新生成“下一班次”，必须再查一次 getbestoffer 拿新的 OfferId
    let freshRoutes = routes, freshTrace = traceId, freshOffer = offerId;
    const gr2 = await api('POST', '/apigw/commercial/spoton/bff/v1/getbestoffer', body);
    if (gr2.status === 200) {
      try {
        const gj2 = JSON.parse(gr2.text);
        freshRoutes = gj2.QuoteLineAndRoutingHeaders || freshRoutes;
        freshTrace = gj2.TraceId || freshTrace;
        const h2 = freshRoutes.find((r) => r.VesselName === wantV && String(r.DepartureDate || '').slice(0, 10) === wantDay)
                 || freshRoutes.find((r) => r.VesselName === wantV) || freshRoutes[0];
        if (h2 && h2.OfferId) { freshOffer = h2.OfferId; hit2 = h2; console.log('  刷新后 OfferId:', freshOffer, h2.VesselName, String(h2.DepartureDate).slice(0,10)); }
      } catch (_) {}
    }

    // 取“更新后”的 offerId：界面在 PATCH 之后会 GET 一次 offer 详情，里面的 id 才是可下单的
    let useOfferId = offerId;
    try {
      const offRes = await api('GET', '/apigw/commercial/spoton/bff/v1/offers/' + traceId + '/offer/' + offerId);
      if (offRes.status === 200) {
        const oj = JSON.parse(offRes.text);
        try { fs.writeFileSync(OUT + '/_offerdetail.json', JSON.stringify(oj, null, 2), 'utf8'); } catch (_) {}
        console.log('  offer详情字段:', Object.keys(oj).filter((k) => /id|departure|offer|next/i.test(k)).join(','));
        const deepFind = (o) => {
          if (!o || typeof o !== 'object') return '';
          for (const k of Object.keys(o)) {
            if (/^offerid$/i.test(k) && typeof o[k] === 'string' && o[k].length > 20) return o[k];
            const r = deepFind(o[k]);
            if (r) return r;
          }
          return '';
        };
        const nid = deepFind(oj);
        if (nid) useOfferId = nid;
        console.log('  offerId 刷新为:', useOfferId);
      }
    } catch (e) {
      console.log('  offer 刷新失败（沿用原 id）:', e.message);
    }

    // 先把该 offer 的附加服务“登记”一次（界面在进总结页前会调这个）
    await api('POST', '/apigw/commercial/spoton/bff/v1/vasdetails', {
      offerId: hit.OfferId, partnerDetails, languageCode: 'zh',
    });

    // 下单权限
    step(3, 'running');
    const simDate = String(hit.DepartureDate || today).slice(0, 10);
    const accessDate = today;
    const hc = await api('POST', '/apigw/commercial/spoton/bff/v1/hascreatequotationaccess', {
      partnerCodes: partners, simulationDate: simDate,
    });
    step(3, 'done', 'HTTP ' + hc.status + ' ' + (hc.text || '').slice(0, 20));

    // 创建报价
    step(4, 'running');
    const cq = await api('POST', '/apigw/commercial/spoton/bff/v1/createquote', {
      NextDepartureId: hit.OfferId,
      TraceId: traceId,
      Affiliates: partners,
      SimulationDate: simDate,
      ShippingCompany: '0001',
      Tariff: { BasedRateType: 'BOF', TarrifType: 'PL', DealPeriod: 'SPOT' },
      VasChargeDetails: null,
      OfferId: hit.OfferId,
      ImportSurchargeChecked: true,
      ExportSurchargeChecked: true,
      FmcTermConditionsAccepted: false,
      SocTermConditionsAccepted: false,
      HazTermConditionsAccepted: false,
      FlexitankTermConditionsAccepted: false,
      SpecialEquipmentTermConditionsAccepted: false,
      ExportInlandTermConditionsAccepted: false,
      ImportInlandTermConditionsAccepted: false,
      CarbonVasReduction: 0,
      VoucherCode: null,
      BurnPoints: false,
      FmcFirstName: null, FmcLastName: null, FmcJobTitle: null, FmcCustomerType: null,
      PartialBurnAmount: 0,
    });
    if (cq.status !== 200) throw new Error('createquote HTTP ' + cq.status + ' ' + cq.text.slice(0, 120));
    const cjj = JSON.parse(cq.text);
    const quoteNo = cjj.Quotation || '';
    if (!quoteNo) throw new Error('返回里没有报价号：' + cq.text.slice(0, 150));
    state.quoteNo = quoteNo;
    step(4, 'done', quoteNo);

    step(5, 'running');
    appendRecord([
      new Date().toLocaleString('zh-CN', { hour12: false }),
      args.portName || args.portCode, eqText,
      `${hit.VesselName} / ${hit.Voyage}`, String(hit.DepartureDate).slice(0, 10), quoteNo, '成功',
      args.p20 != null ? args.p20 : '', args.p40 != null ? args.p40 : '',
    ]);
    savePayload(quoteNo);
    rebuildXlsx();
    step(5, 'done');
    save({ finished: true });
    console.log('报价号: ' + quoteNo);
    console.log('完成 ✅');
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.log('ERR ' + msg);
    const run = state.steps.findIndex((s) => s.status === 'running');
    if (run >= 0) state.steps[run].status = 'failed';
    appendRecord([
      new Date().toLocaleString('zh-CN', { hour12: false }),
      args.portName || args.portCode,
      (args.equips || []).map((x) => `${x.qty}×${x.type}`).join(' + '),
      `${args.vessel || ''} / ${args.voyage || ''}`, args.etd || '', '', '失败：' + msg.slice(0, 60),
      args.p20 != null ? args.p20 : '', args.p40 != null ? args.p40 : '',
    ]);
    rebuildXlsx();
    save({ finished: true, error: msg });
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    save({ finished: true });
  }
}
main();
