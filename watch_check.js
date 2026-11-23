// 抢舱检查（一次性的）：查指定港口的舱位，命中就立刻建报价单
// 用法：node watch_check.js "<json>"
//   json = {port, portName, weight, equips:[{type,qty}], targets:[{vessel,voyage,etd,p20,p40}]}
// 输出最后一行：RESULT:{...}
const fs = require('fs');
const path = require('path');
const { launch, getPage, QUOTE_URL, dismissSessionModal } = require('./lib');

const OUT = path.join(__dirname, 'output');
const TYPE_MAP = { '20GP': '20ST', '40GP': '40ST', '40HQ': '40HC', '45HQ': '45HC' };
const cma = (t) => TYPE_MAP[t] || t;

let args;
try {
  args = JSON.parse(process.argv[2] || '{}');
} catch (e) {
  console.log('RESULT:' + JSON.stringify({ ok: false, fatal: '参数解析失败：' + e.message, results: [] }));
  process.exit(1);
}

const d10 = (s) => String(s || '').slice(0, 10);

(async () => {
  const ctx = await launch({ headless: false });
  const page = await getPage(ctx);
  const timer = setInterval(() => { if (!page.isClosed()) dismissSessionModal(page).catch(() => {}); }, 8000);
  if (timer.unref) timer.unref();

  const api = async (method, url, body) => page.evaluate(async ({ m, u, b }) => {
    const r = await fetch(u, {
      method: m, credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, text: await r.text() };
  }, { m: method, u: url, b: body });

  const emit = (obj) => console.log('RESULT:' + JSON.stringify(obj));

  try {
    await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    await dismissSessionModal(page);
    await page.waitForTimeout(600);

    const pr = await api('GET', '/apigw/commercial/spoton/bff/v1/requestquotationpartners');
    if (pr.status !== 200) {
      emit({ ok: false, authed: false, fatal: '登录态失效 HTTP ' + pr.status, results: [] });
      return;
    }
    const partnerList = JSON.parse(pr.text);
    const partners = partnerList.map((p) => p.Code);
    const partnerDetails = partnerList.map((p) => ({ partnerCode: p.Code, partnerName: p.Name || p.PartnerName || '' }));

    const equips = (args.equips && args.equips.length ? args.equips : [{ type: '20GP', qty: 1 }])
      .map((e) => ({ EquipmentSizeType: cma(e.type), NumberOfContainers: e.qty || 1, WeightPerContainer: args.weight || 25000 }));

    const today = new Date().toISOString().slice(0, 10);
    const gr = await api('POST', '/apigw/commercial/spoton/bff/v1/getbestoffer', {
      Pol: 'CNXMN', Pod: args.port, Equipments: equips,
      EquipmentType: 'ST', CommodityCode: 'FAK',
      Soc: false, Hazardous: false, EmptyContainer: false, FlexiTank: false,
      SimulationDate: today, Poo: null, Fpd: null, ReceiptHaulage: null, DeliveryHaulage: null,
      Nor: false, IsBestOfferNearByPortSelected: false, Language: 'zh',
      CustomerType: null, FmcEligible: false, PartnerCodes: partners,
    });
    if (gr.status !== 200) {
      emit({ ok: false, authed: true, fatal: 'getbestoffer HTTP ' + gr.status, results: [] });
      return;
    }
    const gj = JSON.parse(gr.text);
    const traceId = gj.TraceId || '';
    const routes = gj.QuoteLineAndRoutingHeaders || [];
    const results = [];

    for (const t of (args.targets || [])) {
      const want = { vessel: String(t.vessel || '').trim(), voyage: String(t.voyage || '').trim(), etd: d10(t.etd) };
      const hitRoute = routes.find((r) =>
        String(r.VesselName || '').trim() === want.vessel &&
        (!want.voyage || String(r.Voyage || '').trim() === want.voyage) &&
        (!want.etd || d10(r.DepartureDate) === want.etd));

      if (!hitRoute) { results.push({ ...want, state: 'gone' }); continue; }

      const ar = await api('GET', '/apigw/commercial/spoton/bff/v1/allocationandchargedetails/' + hitRoute.OfferId);
      let aj = {};
      try { aj = JSON.parse(ar.text).AllocationDetail || {}; } catch (_) {}

      if (aj.NoAllocationExist === true || aj.AllocationNotAvailable === true) {
        results.push({ ...want, state: 'full', offerId: hitRoute.OfferId });
        continue;
      }

      // 按请求的每种柜型逐个核对：有记录且 Allocation 不为 false 就算有舱位
      //（注意：可订航线这里 NumberOfContainersAvailable 也可能是 0，不能拿它当判据）
      const detail = aj.AllocationDetails || [];
      const allOk = equips.every((e) => {
        const d = detail.find((x) => x.EquipmentSizeType === e.EquipmentSizeType);
        return !d || d.Allocation !== false;
      });
      if (!allOk) { results.push({ ...want, state: 'full', offerId: hitRoute.OfferId, partial: true }); continue; }

      const k = [want.vessel, want.voyage, want.etd].join('|');
      const allowCreate = Array.isArray(args.createFor) && args.createFor.includes(k);
      if (!allowCreate) {
        // 只探测：报告「已放舱」，由服务端下一轮确认后再建单
        results.push({ ...want, state: 'open', offerId: hitRoute.OfferId });
        continue;
      }

      // 放舱了 → 建单
      const patch = await api('PATCH', '/apigw/commercial/spoton/bff/v1/updatenextdeparture', {
        LoggedId: gj.LoggedId || '', SolutionId: hitRoute.SolutionNumber, ScheduleId: hitRoute.ScheduleNumber,
        OfferId: hitRoute.OfferId,
      });
      await api('POST', '/apigw/commercial/spoton/bff/v1/vasdetails', {
        offerId: hitRoute.OfferId, partnerDetails, languageCode: 'zh',
      });
      await api('POST', '/apigw/commercial/spoton/bff/v1/hascreatequotationaccess', {
        partnerCodes: partners, simulationDate: today,
      });
      const cq = await api('POST', '/apigw/commercial/spoton/bff/v1/createquote', {
        NextDepartureId: hitRoute.OfferId, TraceId: traceId, Affiliates: partners,
        SimulationDate: d10(hitRoute.DepartureDate) || today, ShippingCompany: '0001',
        Tariff: { BasedRateType: 'BOF', TarrifType: 'PL', DealPeriod: 'SPOT' },
        VasChargeDetails: null, OfferId: hitRoute.OfferId,
        ImportSurchargeChecked: true, ExportSurchargeChecked: true,
        FmcTermConditionsAccepted: false, SocTermConditionsAccepted: false, HazTermConditionsAccepted: false,
        FlexitankTermConditionsAccepted: false, SpecialEquipmentTermConditionsAccepted: false,
        ExportInlandTermConditionsAccepted: false, ImportInlandTermConditionsAccepted: false,
        CarbonVasReduction: 0, VoucherCode: null, BurnPoints: false,
        FmcFirstName: null, FmcLastName: null, FmcJobTitle: null, FmcCustomerType: null, PartialBurnAmount: 0,
      });
      const q = /QSPOT\d{6,}/.exec(cq.text);
      if (q) {
        results.push({ ...want, state: 'hit', quote: q[0], offerId: hitRoute.OfferId, patch: patch.status });
      } else {
        results.push({
          ...want, state: 'fail', offerId: hitRoute.OfferId,
          reason: 'HTTP ' + cq.status + ' ' + String(cq.text || '').slice(0, 120).replace(/\s+/g, ' '),
        });
      }
    }

    emit({ ok: true, authed: true, routes: routes.length, results });
  } catch (e) {
    emit({ ok: false, authed: true, fatal: String(e.message || e).slice(0, 200), results: [] });
  } finally {
    clearInterval(timer);
    try { await page.close({ runBeforeUnload: false }); } catch (_) {}
    try { await ctx.close(); } catch (_) {}
    // 兜底：确保进程退出、浏览器被回收（否则 Chrome 窗口会越积越多）
    setTimeout(() => process.exit(0), 300);
  }
})();
