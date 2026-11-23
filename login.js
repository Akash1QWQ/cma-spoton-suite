// 登录：优先用已保存的会话；会话失效时尝试用浏览器已记住的账号直接登录，否则等待手动登录
const fs = require('fs');
const { launch, getPage, QUOTE_URL, isLoginUrl, saveState } = require('./lib');

const LOGIN_WAIT_MIN = 20;

async function tryAutoLogin(page) {
  try {
    const email = page.locator('#login-email').first();
    const pass = page.locator('#login-password').first();
    if (!(await email.count()) || !(await pass.count())) return false;
    const e = await email.inputValue().catch(() => '');
    const p = await pass.inputValue().catch(() => '');
    if (!e || !p) return false;
    console.log('检测到浏览器已记住账号（' + e + '），自动点击登录 ...');
    await page.locator('button[type=submit]').first().click();
    await page.waitForTimeout(6000);
    return !isLoginUrl(page.url());
  } catch (err) {
    console.log('自动登录失败: ' + err.message);
    return false;
  }
}

(async () => {
  const ctx = await launch({ headless: false });
  const page = await getPage(ctx);

  console.log('[1/4] 打开 CMA CGM 报价页 ...');
  await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto:', e.message));
  await page.waitForTimeout(3000);

  if (isLoginUrl(page.url())) {
    console.log('[2/4] 会话已过期，尝试自动登录 ...');
    const ok = await tryAutoLogin(page);
    if (!ok) {
      console.log('');
      console.log('==========================================================');
      console.log('  请在弹出的浏览器窗口里手动登录（邮箱 + 密码）。');
      console.log('  登录完成后不用关窗口，脚本会自动继续。最多等 ' + LOGIN_WAIT_MIN + ' 分钟。');
      console.log('==========================================================');
      const deadline = Date.now() + LOGIN_WAIT_MIN * 60 * 1000;
      let last = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);
        if (page.isClosed()) { console.log('窗口被关闭，退出。'); process.exit(2); }
        if (!isLoginUrl(page.url()) && /cma-cgm\.com/.test(page.url())) break;
        if (Date.now() - last > 30000) { last = Date.now(); console.log('  ... 等待登录中'); }
      }
    }
    if (isLoginUrl(page.url())) {
      console.log('登录未成功（超时）。请重新运行 node login.js');
      await ctx.close();
      process.exit(3);
    }
  } else {
    console.log('[2/4] 会话有效，无需登录');
  }

  console.log('[3/4] 当前页面：' + page.url().slice(0, 100));
  if (!/instant-Quoting/i.test(page.url())) {
    await page.goto(QUOTE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: 'after-login.png' });

  // 校验：报价表单里的“起点”输入框存在
  const ok = await page.locator('input').count().then((n) => n > 2).catch(() => false);
  console.log('[4/4] 页面元素数量=' + ok + '，保存会话 ...');
  await saveState(ctx);
  const cookies = await ctx.cookies();
  console.log('已保存 .auth-state.json（' + cookies.length + ' 个 cookie）');
  await ctx.close();
  console.log('OK');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
