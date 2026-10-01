import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs'
import { login, WEB } from './auth.mjs'
const label = process.argv[3]
const routes = ['/','/portfolio','/products','/attention','/transactions','/payments','/analytics','/recommendations','/integrations','/settings','/reports','/import','/products/new','/transactions/new','/payments/new','/ocr-summary','/nonexistent']
const browser = await chromium.launch()
for (const [w,h] of [[390,844],[1440,900]]) {
  const ctx = await browser.newContext({ viewport:{width:w,height:h} })
  await login(ctx, (label==='empty'?(process.env.QA_EMPTY_EMAIL||'empty@example.com'):(process.env.QA_EMAIL||'qa@example.com')))
  const page = await ctx.newPage()
  const errs=[]; page.on('console', m => { if (m.type()==='error'||m.type()==='warning') errs.push(m.text().slice(0,200)) }); page.on('pageerror', e => errs.push('PAGEERR '+e.message))
  page.on('response', r => { if (r.status()>=400) errs.push('HTTP '+r.status()+' '+r.url()) })
  for (const r of routes) {
    errs.length=0
    await page.goto(WEB+r); await page.waitForTimeout(1200)
    const info = await page.evaluate(() => {
      const t = document.body.innerText
      const overflow = document.documentElement.scrollWidth - window.innerWidth
      const bad = ['NaN','undefined','Invalid Date','null','[object Object]'].filter(x => t.includes(x))
      const wide = [...document.querySelectorAll('body *')].filter(e => { const b=e.getBoundingClientRect(); return b.right > window.innerWidth+1 && b.width>0 && getComputedStyle(e).position!=='fixed' }).slice(0,3).map(e => e.tagName+'.'+(e.className||'').toString().slice(0,40))
      return { overflow, bad, wide, h1: (document.querySelector('h1')||{}).innerText, len: t.length }
    })
    const name = `${label}-${w}${r.replace(/\//g,'_')||'_root'}.png`
    await page.screenshot({ path: 'shots/'+name, fullPage: true })
    console.log(JSON.stringify({ w, r, ...info, errs: [...errs] }))
  }
  await ctx.close()
}
await browser.close()
