// CMA 报价助手 - 本地服务
// 只用 Node 自带模块，不依赖任何第三方库
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'output');
const DD_DIR = path.join(ROOT, 'dd');
let ddCache = null;
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const NODE_EXE = fs.existsSync(path.join(ROOT, 'runtime', 'node', 'node.exe'))
  ? path.join(ROOT, 'runtime', 'node', 'node.exe')
  : process.execPath;
const PY_EXE = fs.existsSync(path.join(ROOT, 'runtime', 'python', 'python.exe'))
  ? path.join(ROOT, 'runtime', 'python', 'python.exe')
  : 'python';
const PORT = Number(process.env.PORT || 8899);
const BUILD = '2026-10-22 17:00';   // 服务端构建时间，界面底部会显示，便于判断是不是旧进程

// ---------------- 设置 ----------------
const DEFAULT_SETTINGS = { pol: 'CNXMN', minEtdDays: 3, weight: 25000, keepAlive: true, keepAliveMinutes: 5 };

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULT_SETTINGS, ...s };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const cur = readSettings();
  const next = { ...cur, ...patch };
  // 校验
  if (!/^[A-Za-z0-9]{5}$/.test(String(next.pol || ''))) throw new Error('起运港必须是 5 位港口代码，例如 CNXMN');
  const d = Number(next.minEtdDays);
  if (!Number.isFinite(d) || d < 0 || d > 30) throw new Error('开船日偏移要在 0~30 天之间');
  const w = Number(next.weight);
  if (!Number.isFinite(w) || w < 1000 || w > 40000) throw new Error('单柜最大净重要在 1000~40000 KGM 之间');
  next.pol = String(next.pol).toUpperCase();
  next.minEtdDays = Math.round(d);
  next.weight = Math.round(w);
  next.keepAlive = !!next.keepAlive;
  const km = Number(next.keepAliveMinutes);
  next.keepAliveMinutes = Number.isFinite(km) && km >= 2 && km <= 30 ? Math.round(km) : 5;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ---------------- 运行状态 ----------------
const state = {
  running: false,
  region: '',
  startedAt: 0,
  finishedAt: 0,
  exitCode: null,
  progress: { done: 0, total: 0 },
  needLogin: false,
  logs: [],
  seq: 0,
  lastIdle: Date.now(),
  lastRun: null,
  lastPing: 0,
  lastPingStatus: null,
  keepAliveInfo: null,
  contractRunning: false,
  contractLog: [],
  contractOpts: null,
  contractOptsAt: 0,
};

function saveLastRun() {
  try {
    fs.writeFileSync(path.join(OUT, '.lastrun.json'), JSON.stringify(state.lastRun), 'utf8');
  } catch (_) {}
}

function loadLastRun() {
  try {
    const raw = fs.readFileSync(path.join(OUT, '.lastrun.json'), 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    // 只认当天的，跨天就当没跑过
    if (j.startedAt && new Date(j.startedAt).toDateString() === new Date().toDateString()) return j;
  } catch (_) {}
  return null;
}

function log(line) {
  state.logs.push({ n: ++state.seq, t: Date.now(), line });
  if (state.logs.length > 3000) state.logs.splice(0, state.logs.length - 3000);
  const m = line.match(/\[(\d+)\/(\d+)\]/);
  if (m) {
    state.progress = { done: Number(m[1]), total: Number(m[2]) };
    state.lastRun.done = Number(m[1]);
    state.lastRun.total = Number(m[2]);
    saveLastRun();
  }
  if (/需要重新登录|登录已过期|接口返回异常/.test(line)) state.needLogin = true;
  if (/登录成功/.test(line)) state.needLogin = false;
}

function rowsOf(region) {
  try {
    const cands = fs.readdirSync(OUT).filter((f) => f.startsWith('CMA价格_' + region + '_') && f.endsWith('.json'));
    if (!cands.length) return null;
    const f = cands.map((x) => ({ x, t: fs.statSync(path.join(OUT, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0].x;
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    return Array.isArray(j.results) ? j.results.length : null;
  } catch (_) { return null; }
}

function latestFiles() {
  const list = (re) => {
    if (!fs.existsSync(OUT)) return [];
    return fs.readdirSync(OUT)
      .filter((f) => re.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  };
  const pack = (arr, region) => {
    if (!arr.length) return null;
    return { name: arr[0].f, at: arr[0].t, rows: region ? rowsOf(region) : null, more: arr.slice(1, 4).map((x) => ({ name: x.f, at: x.t })) };
  };
  return {
    africa: pack(list(/^CMA报价_非洲_.*\.xlsx$/), '非洲'),
    latam: pack(list(/^CMA报价_中南美_.*\.xlsx$/), '中南美'),
    med: pack(list(/^CMA报价_地中海黑海_.*\.xlsx$/), '地中海黑海'),
    changes: pack(list(/^变化记录_.*\.xlsx$/), null),
    changesAfrica: pack(list(/^变化记录_非洲_.*\.xlsx$/), null),
    inland: pack(list(/^非洲后段_.*\.xlsx$/), null),
    changesLatam: pack(list(/^变化记录_中南美_.*\.xlsx$/), null),
    changesMed: pack(list(/^变化记录_地中海黑海_.*\.xlsx$/), null),
    detail: pack(list(/^CMA价格明细_.*\.csv$/), null),
  };
}

// ---------------- 跑任务 ----------------
function runTask(region, opts = {}) {
  if (state.running) throw new Error('已有任务在运行');
  const isInland = region === '非洲后段';
  const args = isInland ? ['inland.js'] : ['fetch.js'];
  if (!isInland && region) args.push('--region', region);
  // resume = 用今天已经查到的结果，只补没查完的港口
  if (!isInland && !opts.resume) args.push('--fresh', '1');
  if (opts.limit) args.push('--limit', String(opts.limit));

  state.running = true;
  state.region = region || '全部';
  state.startedAt = Date.now();
  state.finishedAt = 0;
  state.exitCode = null;
  state.progress = { done: 0, total: 0 };
  state.needLogin = false;
  state.logs = [];
  state.seq = 0;
  state.lastRun = { region: region || '全部', startedAt: Date.now(), done: 0, total: 0, finished: false };
  saveLastRun();
  log(`开始更新：${state.region}${opts.resume ? '（继续上次）' : ''}`);

  const child = spawn(NODE_EXE, args, { cwd: ROOT, windowsHide: true });
  const onData = (buf) => {
    String(buf).split(/\r?\n/).forEach((ln) => { if (ln.trim()) log(ln.trim()); });
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => log('启动失败: ' + e.message));

  child.on('close', (code) => {
    log(`查询结束（退出码 ${code}），正在生成 Excel ...`);
    if (code !== 0) {   // 任务失败就不生成表格
      log('任务失败，未生成表格');
      state.running = false;
      state.finishedAt = Date.now();
      state.exitCode = code;
      state.lastRun.finished = false;
      saveLastRun();
      return;
    }
    const pyScript = (state.region === '非洲后段') ? 'to_inland_xlsx.py' : 'to_xlsx.py';
    const py = spawn(PY_EXE, [pyScript], { cwd: ROOT, windowsHide: true });
    const onPy = (buf) => String(buf).split(/\r?\n/).forEach((ln) => { if (ln.trim()) log(ln.trim()); });
    py.stdout.on('data', onPy);
    py.stderr.on('data', onPy);
    py.on('close', (c2) => {
      log(c2 === 0 ? '全部完成 ✅' : `生成表格失败（退出码 ${c2}）`);
      state.running = false;
      state.finishedAt = Date.now();
      state.exitCode = c2;
      state.lastRun.finished = c2 === 0;
      saveLastRun();
    });
  });
}

// 找 WPS 表格程序 et.exe（直接调用它，新文件会作为标签页并入已打开的 WPS，
// 而用 ShellExecute/cmd start 会另起一个新 WPS 实例，把旧文档显示成只读）
function findWpsET() {
  const bases = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Kingsoft', 'WPS Office'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Kingsoft', 'WPS Office'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Kingsoft', 'WPS Office'),
  ].filter(Boolean);
  let best = null, bestV = '';
  for (const b of bases) {
    let dirs = [];
    try { dirs = fs.readdirSync(b); } catch (_) { continue; }
    for (const d of dirs) {
      const exe = path.join(b, d, 'office6', 'et.exe');
      if (fs.existsSync(exe) && String(d) > bestV) { bestV = String(d); best = exe; }
    }
  }
  return best;
}

// ---------------- 保活：隔几分钟轻敲一次 CMA，让服务端会话别过期 ----------------
const https = require('https');

function cookieHeaderForCMA() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.auth-state.json'), 'utf8').replace(/^\uFEFF/, '');
    const st = JSON.parse(raw);
    const now = Date.now() / 1000;
    const parts = (st.cookies || [])
      .filter((c) => /cma-cgm/.test(c.domain || ''))
      .filter((c) => !c.expires || c.expires < 0 || c.expires > now)
      .map((c) => `${c.name}=${c.value}`);
    return parts.length ? parts.join('; ') : '';
  } catch (_) {
    return '';
  }
}

function keepAlivePing() {
  return new Promise((resolve) => {
    const cookie = cookieHeaderForCMA();
    if (!cookie) return resolve({ ok: false, reason: '没有登录 cookie' });
    const req = https.request(
      {
        hostname: 'www.cma-cgm.com',
        path: '/ebusiness/pricing/instant-Quoting',
        method: 'GET',
        timeout: 20000,
        headers: {
          Cookie: cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      },
      (res) => {
        res.resume();
        state.lastPing = Date.now();
        state.lastPingStatus = res.statusCode;
        resolve({ ok: res.statusCode < 400, status: res.statusCode });
      }
    );
    req.on('timeout', () => { req.destroy(); state.lastPing = Date.now(); state.lastPingStatus = 'timeout'; resolve({ ok: false, reason: '超时' }); });
    req.on('error', (e) => { state.lastPing = Date.now(); state.lastPingStatus = 'error'; resolve({ ok: false, reason: e.message }); });
    req.end();
  });
}

let keepAliveTimer = null;
function scheduleKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  const cfg = readSettings();
  if (!cfg.keepAlive) return;
  const ms = Math.max(2, Math.min(30, Number(cfg.keepAliveMinutes) || 5)) * 60 * 1000;
  keepAliveTimer = setInterval(() => {
    if (state.running) return;              // 正在跑就不用敲，本来就在请求
    if (!readSettings().keepAlive) return;
    keepAlivePing().then((r) => {
      state.keepAliveInfo = r;
      if (!r.ok) log('[保活] 失败：' + (r.reason || r.status));
    });
  }, ms);
}

// ---------------- HTTP ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  state.lastIdle = Date.now();
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(ROOT, 'ui.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (p === '/api/state') {
    return json(res, 200, {
      running: state.running,
      region: state.region,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      exitCode: state.exitCode,
      progress: state.progress,
      needLogin: state.needLogin,
      seq: state.seq,
      settings: readSettings(),
      files: latestFiles(),
      lastRun: state.lastRun || loadLastRun(),
      build: BUILD,
      lastPing: state.lastPing,
      lastPingStatus: state.lastPingStatus,
      keepAliveDays: (readSettings().keepAlive === false ? null : readSettings().keepAliveMinutes),
    });
  }

  if (p === '/api/log') {
    const since = Number(u.searchParams.get('since') || 0);
    return json(res, 200, { lines: state.logs.filter((x) => x.n > since) });
  }

  if (p === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    // 只接受这几个区域名，其它一律当「全部」，避免乱码把参数带坏
    const OK_REGIONS = ['非洲', '中南美', '地中海黑海', '非洲后段'];
    const region = OK_REGIONS.includes(body.region) ? body.region : '';
    try {
      runTask(region, { limit: body.limit, resume: !!body.resume });
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/pingNow' && req.method === 'POST') {
    const r = await keepAlivePing();
    state.keepAliveInfo = r;
    return json(res, 200, r);
  }

  if (p === '/api/settings') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const saved = writeSettings(body);
        scheduleKeepAlive();
        return json(res, 200, { ok: true, settings: saved });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
    return json(res, 200, { settings: readSettings() });
  }

  if (p === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    const target = String(body.path || '');
    const full = path.isAbsolute(target) ? target : path.join(OUT, target);
    if (!fs.existsSync(full)) return json(res, 404, { ok: false, error: '文件不存在' });
    // 用 ShellExecute（cmd start）打开：这和你在资源管理器里双击是同一个入口，
    // WPS 正常会把它作为标签页并入已打开的窗口。
    spawn('cmd', ['/c', 'start', '', full], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

    return json(res, 200, { ok: true, via: 'shell' });
  }

  if (p === '/api/files') {
    let items = [];
    try {
      items = fs.readdirSync(OUT)
        .filter((f) => !f.startsWith('.'))
        .map((f) => {
          const st = fs.statSync(path.join(OUT, f));
          return { name: f, size: st.size, at: st.mtimeMs, dir: st.isDirectory() };
        })
        .sort((a, b) => b.at - a.at)
        .slice(0, 60);
    } catch (_) {}
    return json(res, 200, { dir: OUT, items });
  }

  // ---------------- 合约建立 ----------------
  if (p === '/api/contract/options') {
    // 从最近一次抓价结果里整理「港口 -> 船期 + 价格」
    const now = Date.now();
    if (state.contractOpts && now - state.contractOptsAt < 20000) return json(res, 200, state.contractOpts);
    const regions = ['非洲', '中南美', '地中海黑海'];
    const ports = {};
    let dataAt = 0;
    for (const reg of regions) {
      let files = [];
      try {
        files = fs.readdirSync(OUT)
          .filter((f) => f.startsWith('CMA价格_' + reg + '_') && f.endsWith('.json'))
          .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
      } catch (_) { continue; }
      if (!files.length) continue;
      dataAt = Math.max(dataAt, files[0].t);
      let data = null;
      try { data = JSON.parse(fs.readFileSync(path.join(OUT, files[0].f), 'utf8').replace(/^\uFEFF/, '')); } catch (_) { continue; }
      for (const d of data.details || []) {
        const isFull = d['舱位'] === '已满';
        const key = d['港口代码'] || d['目的港'];
        if (!key) continue;
        const port = ports[key] || (ports[key] = {
          code: key, name: d['目的港'], region: reg, group: d['分组'] || '', sailings: [], full: [],
        });
        if (!port.full) port.full = [];
        const etd = String(d['预计开船'] || '').slice(0, 10);
        if (!etd) continue;
        (isFull ? port.full : port.sailings).push({
          vessel: d['船名'] || '',
          voyage: d['航次'] || '',
          etd,
          transit: d['航程天数'] || null,
          tranship: d['中转港'] || '',
          p20: typeof d['20GP'] === 'number' ? d['20GP'] : null,
          p40: typeof d['40HQ'] === 'number' ? d['40HQ'] : null,
          offerId: d['OfferId'] || '',
        });
      }
    }
    for (const k of Object.keys(ports)) {
      for (const fld of ['sailings', 'full']) {
        const seen = new Set();
        ports[k][fld] = (ports[k][fld] || [])
          .filter((s) => {
            const id = s.vessel + '|' + s.voyage + '|' + s.etd;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .sort((a, b) => (a.etd < b.etd ? -1 : a.etd > b.etd ? 1 : 0))
          .slice(0, 40);
      }
    }
    const list = Object.values(ports).filter((x) => x.sailings.length || (x.full || []).length).sort((a, b) => a.name.localeCompare(b.name));
    state.contractOpts = { dataAt, ports: list };
    state.contractOptsAt = now;
    return json(res, 200, state.contractOpts);
  }

  if (p === '/api/contract/state') {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(OUT, '.contract_state.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (_) {}
    // 子进程被强杀时 close 事件可能没跑到，这里用状态文件兜底，避免“已有合约任务在运行”卡死
    if (state.contractRunning && st && st.finished) state.contractRunning = false;
    return json(res, 200, { running: state.contractRunning, state: st, log: state.contractLog.slice(-40) });
  }

  if (p === '/api/contract/records') {
    const rows = [];
    try {
      let raw = fs.readFileSync(path.join(OUT, '合约记录.csv'), 'utf8').replace(/^\uFEFF/, '');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      lines.shift();   // 丢掉表头
      // 固定 9 列，避免旧表头（7 列）把价格丢掉
      const head = ['时间', '目的港', '柜型×柜量', '船名/航次', '开船', '报价号', '状态', '20GP', '40HQ'];
      for (const ln of lines.slice(-40).reverse()) {
        // 用 + 而不是 *，否则每个引号单元格后面会多出一个空匹配，导致整行右移一列
        const cells = ln.match(/("([^"]|"")*"|[^,]+)/g) || [];
        if (cells.length < head.length) continue;   // 坏行（旧的报错带换行）直接跳过
        const obj = {};
        head.forEach((h, i) => { obj[h] = (cells[i] || '').replace(/^"|"$/g, '').replace(/""/g, '"'); });
        // 合约 24 小时过期，过期的不再显示
        const t = Date.parse((obj['时间'] || '').replace(/\//g, '-'));
        if (Number.isFinite(t) && Date.now() - t > 24 * 3600 * 1000) continue;
        rows.push(obj);
      }
    } catch (_) {}
    return json(res, 200, { rows });
  }

  // 自动续约开关（按报价号存）
  const RENEW_FILE = path.join(OUT, '.contract_renew.json');
  const PAYLOAD_FILE = path.join(OUT, '.contract_payloads.json');
  if (p === '/api/contract/renew' && req.method === 'GET') {
    let map = {};
    try { map = JSON.parse(fs.readFileSync(RENEW_FILE, 'utf8')); } catch (_) {}
    return json(res, 200, { ok: true, map });
  }
  if (p === '/api/contract/renew' && req.method === 'POST') {
    const body = await readBody(req);
    const quoteNo = String(body.quoteNo || '').trim();
    if (!quoteNo) return json(res, 400, { ok: false, error: '缺少报价号' });
    let map = {};
    try { map = JSON.parse(fs.readFileSync(RENEW_FILE, 'utf8')); } catch (_) {}
    if (body.on) map[quoteNo] = { on: true, at: Date.now() };
    else delete map[quoteNo];
    try { fs.writeFileSync(RENEW_FILE, JSON.stringify(map, null, 2), 'utf8'); } catch (_) {}
    return json(res, 200, { ok: true, map });
  }

  // 自动续约：报价单 24 小时过期，提前 2 小时（满 22 小时）用同样的船名/航次重建一单
  function renewTick() {
    if (state.contractRunning) return;
    let map = {}, payloads = {};
    try { map = JSON.parse(fs.readFileSync(RENEW_FILE, 'utf8')); } catch (_) { return; }
    try { payloads = JSON.parse(fs.readFileSync(PAYLOAD_FILE, 'utf8')); } catch (_) { return; }
    const now = Date.now();
    for (const q of Object.keys(map)) {
      if (!map[q] || !map[q].on) continue;
      const rec = payloads[q];
      if (!rec || !rec.payload) continue;
      if (map[q].renewedAt && now - map[q].renewedAt < 23 * 3600 * 1000) continue;  // 这一轮已续过
      if (now - rec.at < 22 * 3600 * 1000) continue;                                // 还没到提前 2 小时
      map[q].renewedAt = now;
      try { fs.writeFileSync(RENEW_FILE, JSON.stringify(map, null, 2), 'utf8'); } catch (_) {}
      state.contractRunning = true;
      const child = spawn(NODE_EXE, ['contract_api.js', JSON.stringify(rec.payload)], { cwd: ROOT, windowsHide: true });
      state.contractLog = ['[自动续约] ' + q + ' → 用同样的船名/航次重新建立报价'];
      const onData = (b) => {
        String(b).split(/\r?\n/).forEach((ln) => { if (ln.trim()) state.contractLog.push(ln.trim()); });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('close', () => { state.contractRunning = false; });
      return;
    }
  }
  setInterval(renewTick, 5 * 60 * 1000);

  if (p === '/api/contract/start' && req.method === 'POST') {
    if (state.contractRunning) return json(res, 400, { ok: false, error: '已有合约任务在运行' });
    const body = await readBody(req);
    if (!body || !body.port || !Array.isArray(body.equips) || !body.equips.length) {
      return json(res, 400, { ok: false, error: '参数不完整' });
    }
    const payload = {
      portCode: String(body.port).toUpperCase(),
      portName: body.portName || '',
      equips: body.equips.slice(0, 3).map((e) => ({ type: String(e.type || ''), qty: Math.max(1, Number(e.qty) || 1) })),
      weight: Math.max(1000, Number(body.weight) || 25000),
      vessel: body.vessel || '',
      voyage: body.voyage || '',
      etd: body.etd || '',
      p20: body.p20, p40: body.p40,
    };
    state.contractRunning = true;
    state.contractLog = [];
    try { fs.unlinkSync(path.join(OUT, '.contract_state.json')); } catch (_) {}
    const child = spawn(NODE_EXE, ['contract_api.js', JSON.stringify(payload)], { cwd: ROOT, windowsHide: true });
    const onData = (buf) => {
      String(buf).split(/\r?\n/).forEach((ln) => { if (ln.trim()) state.contractLog.push(ln.trim()); });
      if (state.contractLog.length > 400) state.contractLog.splice(0, state.contractLog.length - 400);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      state.contractRunning = false;
      state.contractLog.push('[结束] 退出码 ' + code);
    });
    return json(res, 200, { ok: true });
  }

  // ---------------- 自动抢舱 ----------------
const { createWatcher } = require('./watch');

function notifyBox(title, msg) {
  try {
    const vbs = path.join(OUT, '.watch_notify.vbs');
    const esc = (s) => String(s).replace(/"/g, '""');
    const text = `Dim m\nm = "${esc(title)}" & vbCrLf & vbCrLf & "${esc(msg)}"\nMsgBox m, 64 + 4096 + 65536, "CMA 报价助手 - ${esc(title)}"\n`;
    fs.writeFileSync(vbs, '\uFEFF' + text, 'utf16le');
    spawn('wscript', ['//nologo', vbs], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (_) {}
}

const watcher = createWatcher({
  NODE_EXE, PY_EXE, ROOT, OUT,
  isBusy: () => state.running || state.contractRunning,
  log: (line) => log(line),
  notify: (title, msg) => notifyBox(title, msg),
});

// 抢舱记录文件信息（给界面上的快捷入口用）
function watchRecordInfo() {
  const f = path.join(OUT, '抢舱记录.xlsx');
  if (!fs.existsSync(f)) return null;
  let count = 0;
  try {
    const raw = fs.readFileSync(path.join(OUT, '抢舱记录.csv'), 'utf8').replace(/^\uFEFF/, '');
    count = Math.max(0, raw.split(/\r?\n/).filter((x) => x.trim()).length - 1);
  } catch (_) {}
  const stt = fs.statSync(f);
  return { name: path.basename(f), at: stt.mtimeMs, count };
}

// ---------------- 免柜期查询（本地数据包 dd/） ----------------
  // ---------------- 自动抢舱接口 ----------------
  if (p === '/api/watch/start' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b || !b.port) return json(res, 400, { ok: false, error: '请选择目的港' });
    if (!Array.isArray(b.targets) || !b.targets.length) return json(res, 400, { ok: false, error: '至少要选一条船期' });
    const iv = Math.max(5, Math.min(60, Number(b.intervalMin) || 30));
    const cfg = {
      port: String(b.port).toUpperCase(),
      portName: b.portName || '',
      weight: Math.max(1000, Number(b.weight) || 25000),
      equips: (b.equips || [{ type: '20GP', qty: 1 }]).slice(0, 3).map((e) => ({ type: String(e.type || '20GP'), qty: Math.max(1, Number(e.qty) || 1) })),
      intervalMin: iv,
      autoResume: b.autoResume !== false,
      targets: b.targets.slice(0, 5).map((t) => ({
        vessel: String(t.vessel || ''), voyage: String(t.voyage || ''),
        etd: String(t.etd || '').slice(0, 10), p20: t.p20 != null ? t.p20 : '', p40: t.p40 != null ? t.p40 : '',
      })),
    };
    return json(res, 200, { ok: true, watch: watcher.start(cfg) });
  }

  if (p === '/api/watch/stop' && req.method === 'POST') {
    return json(res, 200, { ok: true, watch: watcher.stop('手动停止') });
  }

  if (p === '/api/watch/state') {
    return json(res, 200, { ok: true, watch: watcher.getState(), record: watchRecordInfo() });
  }

  if (p === '/api/watch/now' && req.method === 'POST') {
    watcher.checkNow();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/dd/index') {
    try {
      const raw = fs.readFileSync(path.join(ROOT, 'dd', 'index.json'), 'utf8').replace(/^\uFEFF/, '');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(raw);
    } catch (e) {
      return json(res, 500, { error: '免柜期数据未安装：' + e.message });
    }
  }

  if (p === '/api/dd/pdf') {
    const name = path.basename(String(u.searchParams.get('file') || ''));
    const full = path.join(ROOT, 'dd', 'pdfs', name);
    if (!name || !fs.existsSync(full)) return json(res, 404, { error: '没有这个 PDF：' + name });
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="' + encodeURIComponent(name) + '"',
      'Content-Length': fs.statSync(full).size,
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(full).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CMA 报价助手已启动: http://127.0.0.1:${PORT}`);
  scheduleKeepAlive();
});

// 界面窗口关掉后自动退出（90 秒没人访问就退出）
setInterval(() => {
  if (!state.running && Date.now() - state.lastIdle > 90 * 1000) {
    console.log('界面已关闭，服务退出');
    process.exit(0);
  }
}, 15000);
