// 自动抢舱：定时查舱位，放舱就自动建报价单
// 由 server.js 调用 createWatcher({...}) 挂到本地服务上
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createWatcher(opt) {
  const { NODE_EXE, PY_EXE, ROOT, OUT, isBusy, log, notify } = opt;
  const FILE = path.join(OUT, '.watch_state.json');
  const CSV = path.join(OUT, '抢舱记录.csv');
  const CHECKER = path.join(ROOT, 'watch_check.js');
  const XLSX_PY = path.join(ROOT, 'watch_xlsx.py');

  const empty = () => ({
    active: false, paused: false, pauseReason: '',
    port: '', portName: '', weight: 25000,
    equips: [{ type: '20GP', qty: 1 }],
    intervalMin: 30, targets: [], autoResume: true,
    checks: 0, lastCheckAt: 0, nextAt: 0,
    history: [], lastHit: null, rateLimited: false, rateLimitedUntil: 0,
    streak: {},        // key -> 已丢失轮数
    pending: [],       // 已发现放舱、待二次确认的目标 key
  });

  let st = empty();
  let running = false;      // 正在跑一次检查
  let timer = null;
  let confirmTimer = null;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
      st = { ...empty(), ...j };
      st.history = Array.isArray(st.history) ? st.history.slice(0, 10) : [];
      st.targets = Array.isArray(st.targets) ? st.targets.slice(0, 5) : [];
      st.pending = [];
      // 只有勾了「程序重启后自动恢复监控」才接着跑，否则一律停掉（避免用户没点就开始监控）
      if (st.active && !st.autoResume) {
        st.active = false;
        st.paused = false;
        st.pauseReason = '';
      }
      if (!st.active) st.paused = false;
    } catch (_) { st = empty(); }
  }

  function save() {
    try {
      const { ...copy } = st;
      fs.writeFileSync(FILE, JSON.stringify(copy, null, 2), 'utf8');
    } catch (_) {}
  }

  const keyOf = (t) => [t.vessel, t.voyage, t.etd].join('|');

  function addHistory(line) {
    st.history.unshift(line);
    st.history = st.history.slice(0, 10);
  }

  function appendRecord(row) {
    try {
      if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, '\uFEFF时间,港口,船名/航次,开船,20GP,40HQ,报价号,结果\r\n', 'utf8');
      const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
      fs.appendFileSync(CSV, row.map(esc).join(',') + '\r\n', 'utf8');
    } catch (_) {}
    try {
      spawn(PY_EXE, [XLSX_PY], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (_) {}
    pruneXlsx();
  }

  function pruneXlsx() {
    try {
      const files = fs.readdirSync(OUT)
        .filter((f) => /^抢舱记录.*\.xlsx$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const x of files.slice(3)) { try { fs.unlinkSync(path.join(OUT, x.f)); } catch (_) {} }
    } catch (_) {}
  }

  function runCheck(mode, createFor) {
    if (running) return Promise.resolve(null);
    running = true;
    return new Promise((resolve) => {
      const payload = {
        port: st.port, portName: st.portName, weight: st.weight,
        equips: st.equips, targets: st.targets,
        createFor: createFor || [], mode: mode || 'probe',
      };
      const child = spawn(NODE_EXE, [CHECKER, JSON.stringify(payload)], { cwd: ROOT, windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', (b) => { out += String(b); });
      child.stderr.on('data', (b) => { err += String(b); });
      child.on('close', () => {
        running = false;
        let res = null;
        const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('RESULT:'));
        if (line) { try { res = JSON.parse(line.slice(7)); } catch (_) {} }
        resolve({ res, raw: out, err });
      });
    });
  }

  async function tick(reason) {
    if (!st.active) return;
    if (isBusy()) {
      st.paused = true; st.pauseReason = '更新价格中';
      st.nextAt = Date.now() + 60 * 1000;   // 每分钟看一次抓价是否结束
      save();
      return;
    }
    if (st.paused && st.pauseReason === '更新价格中') {
      st.paused = false; st.pauseReason = '';
      save();
      log && log('[抢舱] 更新价格已结束，恢复监控');
    }
    if (st.paused && st.pauseReason === '需要重新登录') {
      // 掉线暂停：照样按间隔试一次，登录恢复后自动继续
      if (Date.now() < (st.nextAt || 0)) return;
    } else if (st.paused) {
      return;
    }

    const now = Date.now();
    const lim = st.rateLimitedUntil && now < st.rateLimitedUntil;
    st.checks += 1;
    st.lastCheckAt = now;
    const ivMs = (lim ? 60 : st.intervalMin) * 60 * 1000;
    st.nextAt = now + ivMs;
    save();

    const { res } = await runCheck('probe', []);
    if (!res) {
      addHistory(`${hhmm()} 检查失败（进程无返回）`);
      st.failStreak = (st.failStreak || 0) + 1;
      if (st.failStreak >= 5) {
        st.active = false; st.paused = false;
        addHistory(`${hhmm()} 连续 5 次检查失败，已停止监控`);
        notify && notify('自动抢舱已停止', '连续 5 次检查失败（可能是网络或登录问题），请检查后重新开始。');
      }
      save();
      return;
    }
    if (!res.ok) {
      st.failStreak = (st.failStreak || 0) + 1;
      if (res.authed === false) {
        st.paused = true; st.pauseReason = '需要重新登录';
        st.nextAt = Date.now() + 5 * 60 * 1000;   // 5 分钟后再试一次
        addHistory(`${hhmm()} 登录失效，已暂停（${String(res.fatal || '').slice(0, 70)}）`);
        notify && notify('自动抢舱已暂停', '登录已过期，请在程序里重新登录，登录后会自动继续。');
        save();
        return;
      }
    }

    if (res.ok) {
      st.failStreak = 0;
      st.rateLimited = false;
      if (st.paused && st.pauseReason === '需要重新登录') {
        st.paused = false; st.pauseReason = '';
        addHistory(`${hhmm()} 登录已恢复，继续监控`);
      }
    } else {
      {
        addHistory(`${hhmm()} 检查异常：${String(res.fatal || '').slice(0, 60)}`);
        if (/429|440/.test(String(res.fatal || ''))) {
          st.rateLimited = true;
          st.rateLimitedUntil = Date.now() + 60 * 60 * 1000;
          addHistory(`${hhmm()} 接口受限，已降速到 60 分钟`);
        }
      }
      save();
      return;
    }
    const list = res.results || [];
    const full = list.filter((x) => x.state === 'full').length;
    const open = list.filter((x) => x.state === 'open');
    const gone = list.filter((x) => x.state === 'gone');

    // 失效判定：连续 2 轮不见才移除
    for (const t of st.targets.slice()) {
      const k = keyOf(t);
      const isGone = gone.some((x) => keyOf(x) === k);
      if (isGone) {
        st.streak[k] = (st.streak[k] || 0) + 1;
        if (st.streak[k] >= 2) {
          st.targets = st.targets.filter((x) => keyOf(x) !== k);
          addHistory(`${hhmm()} ${t.vessel} ${t.etd} 已下架，移出监控`);
          appendRecord([nowStr(), st.portName || st.port, `${t.vessel} / ${t.voyage}`, t.etd, t.p20 || '', t.p40 || '', '', '已失效（船期下架）']);
        }
      } else {
        st.streak[k] = 0;
      }
    }
    for (const g of gone) { st.streak[keyOf(g)] = st.streak[keyOf(g)] || 0; }

    addHistory(`${hhmm()} ${st.port} ${res.routes || 0} 条航线，目标 ${list.length} 条：${full} 条仍满${open.length ? `，${open.length} 条放舱待确认` : ''}`);
    save();

    if (open.length) {
      // 15 秒后二次确认，确认仍开就建单
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(async () => {
        const { res: r2 } = await runCheck('hit', open.map((x) => keyOf(x)));
        if (!r2 || !r2.ok) return;
        for (const x of r2.results || []) {
          if (x.state === 'hit') {
            st.lastHit = { quote: x.quote, vessel: x.vessel, voyage: x.voyage, etd: x.etd, at: Date.now() };
            addHistory(`${hhmm()} ✅ 抢到 ${x.quote}（${x.vessel} ${x.etd}）`);
            appendRecord([nowStr(), st.portName || st.port, `${x.vessel} / ${x.voyage}`, x.etd, x.p20 || '', x.p40 || '', x.quote, '成功（抢舱）']);
            st.active = false;
            st.paused = false;
            save();
            notify && notify('抢舱成功', `${st.portName || st.port} ${x.vessel} ${x.etd}\n报价号：${x.quote}`);
            return;
          }
          if (x.state === 'fail') {
            addHistory(`${hhmm()} 建单失败：${String(x.reason || '').slice(0, 60)}`);
            appendRecord([nowStr(), st.portName || st.port, `${x.vessel} / ${x.voyage}`, x.etd, x.p20 || '', x.p40 || '', '', '抢舱失败：' + String(x.reason || '').slice(0, 80)]);
          }
        }
        save();
      }, 15000);
    }
  }

  function start(cfg) {
    st = { ...empty(), ...cfg };
    st.targets = (cfg.targets || []).slice(0, 5);
    st.active = true;
    st.paused = false;
    st.pauseReason = '';
    st.checks = 0;
    st.history = [];
    st.streak = {};
    st.pending = [];
    st.nextAt = Date.now() + st.intervalMin * 60 * 1000;
    save();
    log && log(`[抢舱] 开始监控 ${st.portName || st.port}，间隔 ${st.intervalMin} 分钟，目标 ${st.targets.length} 条`);
    tick('start');
    return st;
  }

  function stop(reason) {
    st.active = false;
    st.paused = false;
    st.pauseReason = '';
    clearTimeout(confirmTimer);
    save();
    log && log('[抢舱] 已停止' + (reason ? '：' + reason : ''));
    return st;
  }

  function resume() {
    if (!st.paused) return st;
    st.paused = false;
    st.pauseReason = '';
    save();
    tick('resume');
    return st;
  }

  const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
  const hhmm = () => new Date().toTimeString().slice(0, 5);

  function loop() {
    clearInterval(timer);
    timer = setInterval(() => {
      // 单实例锁：多开程序时只让一个进程真正去查，避免同时弹一堆浏览器
      if (!acquireLock()) return;
      if (!st.active) return;
      if (running) return;                       // 上一次还没跑完
      // 「更新价格中」的恢复交给 tick() 统一处理，这里不重复打日志
      if (st.paused && st.pauseReason !== '更新价格中' && st.pauseReason !== '需要重新登录') return;
      if (Date.now() < (st.nextAt || 0)) return;
      tick('timer');
    }, 15000);
    if (timer.unref) timer.unref();
  }

  // ---- 单实例锁（.watch_lock 里存 pid，60 秒内有效）----
  const LOCK = path.join(OUT, '.watch_lock');
  function acquireLock() {
    const me = process.pid;
    try {
      if (fs.existsSync(LOCK)) {
        const j = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
        const fresh = Date.now() - (j.at || 0) < 60 * 1000;
        if (fresh && j.pid !== me) return false;
      }
    } catch (_) {}
    try { fs.writeFileSync(LOCK, JSON.stringify({ pid: me, at: Date.now() }), 'utf8'); } catch (_) {}
    return true;
  }

  load();
  loop();

  return {
    getState: () => st,
    start, stop, resume, tick,
    checkNow: () => tick('manual'),
    save,
  };
}

module.exports = { createWatcher };
