// 公共模块：启动带持久化用户目录的 Chrome，并恢复上次保存的登录会话
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

// 临时目录放在程序自己目录里，避免某些电脑上 %TEMP% 没权限（会让浏览器起不来）
const TMP_DIR = path.join(__dirname, '.tmp');
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  process.env.TMP = TMP_DIR;
  process.env.TEMP = TMP_DIR;
} catch (_) {}

const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const STATE_FILE = path.join(__dirname, '.auth-state.json');
// 不覆盖 UA：使用浏览器真实 UA，版本对不上会被 WAF 判定为自动化

const QUOTE_URL = 'https://www.cma-cgm.com/ebusiness/pricing/instant-Quoting';

// 上一次运行被打断时，自动化浏览器可能还挂着，占着配置目录 → 新的一次就起不来。
// 这里只清理“用我们配置目录”的 chrome 进程，不影响你自己开的浏览器。
function killStaleBrowser() {
  try {
    const { execFileSync } = require('child_process');
    const ps = [
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*browser-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*browser-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join('; ');
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    return true;
  } catch (_) {
    return false;
  }
}

function isLoginUrl(u) {
  return /auth\.cma-cgm\.com|\/signin-oidc/i.test(u);
}

async function launch(opts = {}) {
  const headless = !!opts.headless;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // 启动前先清掉残留的 Chrome / Edge（否则会往旧窗口里不断开新标签）
  killStaleBrowser();

  // 用本机已安装的浏览器（Chrome 优先，没有就退到 Edge）
  let channels = (process.env.CMA_BROWSER || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!channels.length) channels = ['chrome', 'msedge'];
  let ctx = null, lastErr = null;
  for (const channel of channels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
          channel,
          headless,
          viewport: null,
          args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
          locale: 'zh-CN',
          acceptDownloads: true,
        });
        break;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message).split('\n')[0];
        if (attempt === 1) {
          // 多半是上次被打断、浏览器还挂在那儿占着配置目录
          console.log(`[warn] 打不开 ${channel}，正在清理上次残留的浏览器进程后重试 ...`);
          killStaleBrowser();
          await new Promise((r) => setTimeout(r, 2500));
        } else {
          console.log(`[warn] 打不开 ${channel}：${msg}`);
        }
      }
    }
    if (ctx) break;
    // 只有本机没装 Chrome 才退到 Edge；其它失败（比如配置目录被占）直接报错，不再换浏览器
    if (channel === 'chrome' && lastErr && !/is not found|executable doesn't exist|Executable doesn/i.test(String(lastErr.message))) break;
  }
  if (!ctx) {
    throw new Error('本机没有可用的 Chrome / Edge 浏览器，请先安装其中一个。' + (lastErr ? '（' + lastErr.message.split('\n')[0] + '）' : ''));
  }

  // 只有配置目录里还没有 cookie 时才导入 .auth-state.json
  // （否则每次启动都用旧 cookie 覆盖正在有效的会话，会反复掉登录）
  const cookieStore = path.join(PROFILE_DIR, 'Default', 'Cookies');
  let needImport = true;
  try {
    if (fs.existsSync(cookieStore) && fs.statSync(cookieStore).size > 20000) needImport = false;
  } catch (_) {}
  if (needImport && fs.existsSync(STATE_FILE)) {
    try {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (st.cookies && st.cookies.length) {
        const fixed = st.cookies.map((c) => {
          const o = { ...c };
          delete o.size; delete o.session; delete o.priority; delete o.sameParty; delete o.sourceScheme;
          delete o.sourcePort; delete o.partitionKey;
          return o;
        });
        await ctx.addCookies(fixed);
      }
      if (st.origins && st.origins.length) {
        await ctx.addInitScript((origins) => {
          try {
            for (const o of origins) {
              for (const kv of o.localStorage || []) {
                try { localStorage.setItem(kv.name, kv.value); } catch (_) {}
              }
            }
          } catch (_) {}
        }, st.origins);
      }
    } catch (e) {
      console.log('[warn] 读取 .auth-state.json 失败: ' + e.message);
    }
  }

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  ctx.setDefaultTimeout(60000);
  return ctx;
}

async function saveState(ctx) {
  await ctx.storageState({ path: STATE_FILE });
  return STATE_FILE;
}

async function getPage(ctx) {
  const pages = ctx.pages();
  return pages.length ? pages[0] : await ctx.newPage();
}

// CMA 空闲久了会弹「您的会话已过期」遮罩（红色按钮“进入登录页面”），
// 不点掉页面就卡住。这里自动点掉它；同一轮 45 秒内不重复点，避免刷屏。
let lastDismissAt = 0;

async function dismissSessionModal(page, opts = {}) {
  if (!page || page.isClosed()) return false;
  const now = Date.now();
  if (!opts.force && now - lastDismissAt < 45000) return false;

  let clicked = '';
  try {
    clicked = await page.evaluate(() => {
      const want = ['进入登录页面', '进入登录页'];
      const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      // 1) 按钮/链接
      for (const el of document.querySelectorAll('button, a, [role="button"], input[type=button]')) {
        const t = ((el.innerText || el.value || '') + '').trim();
        if (!t || t.length > 30 || !vis(el)) continue;
        if (want.some((x) => t.includes(x))) { el.click(); return t; }
      }
      // 2) 兜底：任何可见元素，文字正好是“进入登录页面”
      for (const el of document.querySelectorAll('div, span')) {
        const t = ((el.innerText || '') + '').trim();
        if (t === '进入登录页面' && vis(el)) { el.click(); return t; }
      }
      return '';
    });
  } catch (_) {
    return false;
  }

  if (!clicked) return false;
  lastDismissAt = Date.now();
  try { await page.waitForTimeout(1000); } catch (_) {}
  // 点完确认遮罩是否真的消失
  let stillThere = false;
  try {
    stillThere = await page.evaluate(() => /您的会话已过期|会话已过期/.test(document.body ? document.body.innerText : ''));
  } catch (_) {}
  console.log('  [自动处理] 已点掉“' + clicked + '”弹窗' + (stillThere ? '（遮罩仍在，等下次再试）' : ''));
  return true;
}

// 检测是否停在人机验证页（DataDome 滑块）
async function isCaptcha(page) {
  try {
    const url = page.url();
    if (/captcha|datadome|blocked/i.test(url)) return true;
    const txt = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return t.slice(0, 400);
    }).catch(() => '');
    if (/向右滑动|滑动以保护|verify you are human|访问暂时受限|访问受限/i.test(txt)) return true;
    const frames = page.frames().map((f) => f.url()).join(' ');
    if (/datadome|captcha/i.test(frames)) return true;
  } catch (_) {}
  return false;
}

module.exports = { PROFILE_DIR, STATE_FILE, QUOTE_URL, isLoginUrl, launch, saveState, getPage, dismissSessionModal, isCaptcha };
