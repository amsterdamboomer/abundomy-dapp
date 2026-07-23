/**
 * Statische build van de Abundomy-contentsite (Fase 4) → `web/site-dist/`.
 *
 * De site is PHP, maar puur templating: includes (header/footer) + i18n die al
 * CLIENT-SIDE draait (elke pagina fetcht `json/<page>.json` en vult `#tx_NN`-spans;
 * Engels staat inline als fallback). Er is geen database of formulier. Dus volstaat
 * het de PHP-includes/echoes één keer voor `en` + relatieve paden te resolven; de
 * taalwisseling blijft in de browser werken.
 *
 * Bewust beperkt: server-side taalwisselaar (`set-language.php`) en de hreflang-loop
 * vervallen statisch; zeldzame multi-echo PHP-blokjes (bv. een mailto) worden gestript.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../Abundomy/', import.meta.url))
const OUT = fileURLToPath(new URL('./site-dist/', import.meta.url))

const PAGES = {
  'index.php': { out: 'index.html', title: 'Home | Abundomy' },
  'base.php': { out: 'base.html', title: 'Summary | Abundomy' },
  'community.php': { out: 'community.html', title: 'Community | Abundomy' },
  'education.php': { out: 'education.html', title: 'Education | Abundomy' },
  'projects.php': { out: 'projects.html', title: 'Projects | Abundomy' },
}
const ASSET_DIRS = ['css', 'img', 'json', 'font', 'articles', 'download']

// 68 talen (1-op-1 uit set-language.php) + RTL-codes. De per-pagina fill-JS gebruikt
// `currentLang`; we maken die dynamisch (localStorage) en bouwen een client-side
// taalkiezer terug die de dode server-side `set-language.php` vervangt.
const LANGUAGES = {
  ah: 'አማርኛ Amharic', ar: 'عربي Arabic', am: 'Armenian հայկ', az: 'Azərbaycan',
  by: 'беларускі Belarus', be: 'বাংলা Bengali', bo: 'Bosanski Bosnian', bg: 'български Bulgaria',
  ca: '廣州話 Cantonese', ch: '簡體中文 Chinese', cz: 'čeština Czech', se: 'Cрпски Serbian',
  da: 'Dansk', de: 'Deutsch', en: 'English', es: 'Espagnol', fp: 'Filipino', fr: 'Français',
  ir: 'Gaeilge Irish', gr: 'ελληνικά Greece', ha: 'Hausa Nigeria', he: 'עִברִيت Hebrew',
  hi: 'हिंदी Hindi', cr: 'Hrvatski Croatia', ig: 'Igbo Nigeria', in: 'Indonesia',
  ic: 'íslenskur Iceland', it: 'Italiano', ja: '日本語 Japanese', ka: 'қазақ Kazakh',
  kh: 'Khmer ខ្មែរ', ki: 'Kinyarwanda', sh: 'Kiswahili', co: 'Kituba Congo', ko: '한국인 Korean',
  kg: 'Kyrgyz', la: 'ภาษาลาว Lao', lv: 'Latviski Latvia', lt: 'Lietuvių Lithuania',
  hu: 'Magyar Hungary', mg: 'Malagasy', ma: 'Marathi India', ml: 'Melayu Malaysia',
  mo: 'Монгол Mongolia', bu: 'မြန်မာ Myanmar', ne: 'Nederlands', np: 'नेपाली Nepal', no: 'Norsk',
  or: 'Oromoo Ethiopia', pa: 'Pashto Afghanistan', pe: 'Persian', po: 'Polski', pt: 'Português',
  ro: 'Română', ru: 'Русский Russian', zi: 'Setswana Zimbab.', al: 'Shqiptare Albania',
  sl: 'Slovenski Slovenia', sk: 'Slovenský Slovak', so: 'Soomaali', fi: 'Suomalainen Fin.',
  sw: 'Svenska Sweden', ta: 'தமிழ் Tamil', th: 'แบบไทย Thailand', vi: 'Tiếng Việt Vietnam',
  tu: 'Türkçe', ur: 'اردو Urdu Pakistan', yo: 'Yoruba Nigeria',
}
const RTL_LANGS = ['ah', 'ar', 'he', 'fa', 'ur', 'pa', 'pe']

// Boek-cover + PDF per taal (1-op-1 uit $book_list in includes/functions.inc.php). Talen
// zonder eigen boek vallen terug op 'en'. In de statische build kwam dit uit de DB → leeg
// (gebroken cover/link); we vullen 'en' statisch in en laten JS het per taal wisselen.
const BOOK_LIST = {
  ar: { img: 'Cover_AR_300x425.jpg', pdf: 'ALWAFRA_(AR_IISDAR_1.3,_2025_uktubar_6).pdf' },
  ch: { img: 'Cover_CH_300x425.jpg', pdf: 'FENGSHENG_DE_SHENGHUO_(CH_BANBEN_1.3,_2025_Nian_10_yue_6_ri).pdf' },
  de: { img: 'Cover_DE_300x425.jpg', pdf: 'ABUNDOMIE_(DE_VERSION_1.3,_6._Oktober_2025).pdf' },
  en: { img: 'Cover_EN_300x425.jpg', pdf: 'ABUNDOMY_(EN_VERSION_1.3,_October_6th,_2025).pdf' },
  es: { img: 'Cover_ES_300x425.jpg', pdf: 'ABUNDOMIA_(ES_VERSIÓN_1.3,_6_octubre_2025).pdf' },
  fr: { img: 'Cover_FR_300x425.jpg', pdf: 'ABUNDOMIE_(FR_VERSION_1.3,_6_Octobre_2025).pdf' },
  ki: { img: 'Cover_KI_300x425.jpg', pdf: 'ABUNDOMY_(KI_KURE_1.3,_Ku ya_6_Ukwakira_2025).pdf' },
  ne: { img: 'Cover_NE_300x425.jpg', pdf: 'ABUNDOMIE_(NE_VERSIE_1.3,_6_Oktober_2025).pdf' },
  pt: { img: 'Cover_PT_300x425.jpg', pdf: 'ABUNDOMIA_(PT_VERSAO_1.3,_6_de_outubro_de_2025).pdf' },
  pu: { img: 'Cover_PU_300x425.jpg', pdf: 'BELORI_(PU_VARAJANA_1.3,_6_Akatubara,_2025).pdf' },
  ru: { img: 'Cover_RU_300x425.jpg', pdf: 'IZOBILOMICS_(RU_VERSIYA_1.3,_6_oktyabrya_2025).pdf' },
}

/**
 * Vroeg head-script: kies de taal (localStorage), zet <html lang/dir>, en definieer de
 * globale taalfuncties. De taalkiezer is — net als de money-app en abundomy.com — een
 * ronde landvlag rechtsboven in de balk; klikken opent een taalpagina (zoekveld +
 * vlaggenlijst). `__abSetLang(code)` past de vertaling DIRECT toe (geen reload) en
 * ververst de vlag. De vlaggen (json/flags.json) zijn 1-op-1 het originele getFlagSVG.
 */
const LANGS_JSON = JSON.stringify(LANGUAGES)
const HEAD_I18N = `<script>
window.__ABUNDOMY_RTL=${JSON.stringify(RTL_LANGS)};
window.__abLangs=${LANGS_JSON};
window.__abBooks=${JSON.stringify(BOOK_LIST)};
window.__abFlags={};
window.__abUpdateBook=function(){
  var b=window.__abBooks[window.__lang]||window.__abBooks['en'];
  var img=document.getElementById('bookCover');if(img)img.src='/img/'+b.img;
  var dl=document.querySelectorAll('a.book-dl');for(var i=0;i<dl.length;i++){dl[i].setAttribute('href','/download/'+encodeURIComponent(b.pdf));}
};
// Gedeelde download-teller via /api/downloads (mailer-node). Toont totaal + de teller van
// de huidige taal; bij een download optimistisch ophogen + POSTen (lang = huidige taal).
window.__abDlCounts=null;
window.__abRenderDownloads=function(){
  if(!window.__abDlCounts)return;
  var t=document.getElementById('total-count');if(t)t.textContent=window.__abDlCounts.total||0;
  var l=document.getElementById('lang-count');if(l)l.textContent=(window.__abDlCounts.counts||{})[window.__lang]||0;
};
// Losse item-teller (bv. de OneCoinH-demo op artikelpagina's): #xlsx-count = counts.xlsx.
window.__abRenderXlsx=function(){var e=document.getElementById('xlsx-count');if(e&&window.__abDlCounts)e.textContent=(window.__abDlCounts.counts||{})['xlsx']||0;};
window.__abLoadDownloads=function(){
  if(!document.getElementById('total-count')&&!document.getElementById('xlsx-count'))return; // alleen pagina's mét teller
  fetch('/api/downloads').then(function(r){return r.json()}).then(function(d){window.__abDlCounts=d;window.__abRenderDownloads();window.__abRenderXlsx();}).catch(function(){});
};
function __abPost(key){try{fetch('/api/downloads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lang:key}),keepalive:true});}catch(e){}}
// __abTrack = boek-tracker (lang = huidige taal); window.sendTracking wordt ná de bron-
// definitie (body) hierop gezet zodat de boek-download-onclick onze versie aanroept.
window.__abTrack=function(){
  var lang=window.__lang||'en';
  if(window.__abDlCounts){window.__abDlCounts.total=(window.__abDlCounts.total||0)+1;window.__abDlCounts.counts=window.__abDlCounts.counts||{};window.__abDlCounts.counts[lang]=(window.__abDlCounts.counts[lang]||0)+1;window.__abRenderDownloads();}
  __abPost(lang);
};
// __abTrackItem = item-tracker (bv. 'xlsx'): optimistisch ophogen + POST.
window.__abTrackItem=function(item){
  if(window.__abDlCounts){window.__abDlCounts.counts=window.__abDlCounts.counts||{};window.__abDlCounts.counts[item]=(window.__abDlCounts.counts[item]||0)+1;window.__abRenderXlsx();}
  __abPost(item);
};
window.__lang=(function(){try{return localStorage.getItem('abundomy-lang')||'en'}catch(e){return 'en'}})();
document.documentElement.lang=window.__lang;
if(window.__ABUNDOMY_RTL.indexOf(window.__lang)>=0)document.documentElement.dir='rtl';
window.__abFlag=function(code,uid){var s=window.__abFlags[code]||window.__abFlags['en']||'';if(!s)return '';return '<img src="/'+s+'" alt="'+(uid||code||'')+'" class="ab-flag-img">';};
window.__abRenderFlag=function(){var b=document.getElementById('abLangFlag');if(b)b.innerHTML=window.__abFlag(window.__lang,'hdr');};
window.__abSetLang=function(code){
  window.__lang=code;
  document.documentElement.lang=code;
  document.documentElement.dir=window.__ABUNDOMY_RTL.indexOf(code)>=0?'rtl':'ltr';
  try{localStorage.setItem('abundomy-lang',code)}catch(e){}
  var p=window.__abPageJson||(location.pathname.split('/').pop()||'index.html').replace(/\\.html?$/,'')||'index';
  fetch('/json/'+p+'.json').then(function(r){return r.json()}).then(function(d){
    var ct=d[code]||d['en']||{};for(var k in ct){var el=document.getElementById(k);if(el)el.innerHTML=ct[k];}
  }).catch(function(){});
  window.__abRenderFlag();
  window.__abUpdateBook();
  window.__abRenderDownloads();
};
window.__abBuildList=function(){
  var box=document.getElementById('abLangList');if(!box)return;box.innerHTML='';
  var cur=window.__lang;
  Object.keys(window.__abLangs).forEach(function(code){
    var name=window.__abLangs[code];
    var it=document.createElement('div');
    it.className='ab-lang-item'+(code===cur?' ab-active':'');
    it.setAttribute('data-s',name.toLowerCase());it.setAttribute('data-code',code);
    it.innerHTML='<div class="ab-flag">'+window.__abFlag(code)+'</div><span class="ab-lang-name">'+name+'</span>';
    it.addEventListener('click',function(){window.__abSetLang(code);window.__abCloseLang();});
    box.appendChild(it);
  });
};
window.__abOpenLang=function(){window.__abBuildList();var s=document.getElementById('abLangSearch');if(s)s.value='';var o=document.getElementById('abLangOverlay');if(o)o.style.display='block';if(s)s.focus();};
window.__abCloseLang=function(){var o=document.getElementById('abLangOverlay');if(o)o.style.display='none';};
window.__abFilter=function(){var q=(document.getElementById('abLangSearch').value||'').toLowerCase();var items=document.querySelectorAll('#abLangList .ab-lang-item');for(var i=0;i<items.length;i++){var n=items[i].getAttribute('data-s');items[i].style.display=(!q||n.indexOf(q)>=0)?'':'none';}};
</script>
<style>
.ab-lang-flag{width:clamp(35px,12.15vw,70px);height:clamp(35px,12.15vw,70px);padding:0;border:2px solid rgba(255,255,255,.7);border-radius:50%;background:transparent;cursor:pointer;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.4);transition:filter .2s,transform .2s;display:block}
.ab-lang-flag:hover{filter:brightness(1.25);transform:scale(1.06)}
.ab-lang-flag img{width:100%;height:100%;display:block;border-radius:50%;object-fit:cover}
.ab-lang-overlay{display:none;position:fixed;inset:0;z-index:2147483000;overflow-y:auto;background:#0d1228;padding:clamp(10px,3vw,24px) clamp(8px,3vw,20px) 3rem}
.ab-lang-bar{display:flex;align-items:center;justify-content:space-between;gap:1rem;max-width:576px;margin:0 auto clamp(10px,3vw,18px)}
.ab-lang-bar h2{font-family:raleway_bold,sans-serif;color:#E8B923;margin:0;font-size:clamp(16px,5vw,28px)}
.ab-lang-bar button{font-family:raleway_bold,sans-serif;color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);border-radius:1.5rem;padding:.4rem 1.1rem;cursor:pointer;font-size:clamp(12px,3.5vw,18px)}
.ab-lang-search{display:block;width:100%;max-width:576px;margin:0 auto;box-sizing:border-box;font-family:raleway_regular,sans-serif;color:#fff;background:rgba(0,0,0,.45);border:1px solid rgba(145,107,1,.5);border-radius:.6rem;padding:.5rem .8rem;font-size:clamp(13px,4vw,20px)}
.ab-lang-list{max-width:576px;margin:clamp(10px,3vw,18px) auto 0;border:1px solid rgba(145,107,1,.3);border-radius:14px;overflow:hidden;background:rgba(0,0,0,.25)}
.ab-lang-item{display:flex;align-items:center;gap:clamp(8px,2.6vw,15px);padding:clamp(7px,1.8vw,10px) clamp(8px,2.4vw,14px);border-bottom:1px solid rgba(255,255,255,.08);cursor:pointer}
.ab-lang-item:hover{background:rgba(255,255,255,.06)}
.ab-lang-item.ab-active{background:rgba(0,191,255,.15);font-weight:bold}
.ab-flag img{width:clamp(34px,11vw,44px);height:clamp(34px,11vw,44px);display:block;border-radius:50%;object-fit:cover}
.ab-lang-name{font-family:raleway_regular,sans-serif;color:#E8B923;font-size:clamp(13px,4.3vw,24px);text-align:left;line-height:1.2}
</style>`

/** Eind-injectie: de taalpagina-overlay + flags laden + de vlag tekenen. */
const BODY_I18N = `<div id="abLangOverlay" class="ab-lang-overlay" role="dialog" aria-label="Language">
  <div class="ab-lang-bar"><h2>Language</h2><button type="button" onclick="window.__abCloseLang()">Cancel</button></div>
  <input id="abLangSearch" class="ab-lang-search" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Enter language" oninput="window.__abFilter()" />
  <div id="abLangList" class="ab-lang-list"></div>
</div>
<script>(function(){
  fetch('/json/flags.json').then(function(r){return r.json()}).then(function(f){window.__abFlags=f;window.__abRenderFlag();}).catch(function(){});
  if(window.__abUpdateBook)window.__abUpdateBook();
  if(window.__abLoadDownloads)window.__abLoadDownloads();
  window.sendTracking=window.__abTrack; // onze tracker wint van de bron-definitie
})();</script>`

/**
 * Repareer het boek-downloadblok op de homepagina: in de DB-loze build kwamen
 * `$displayBook['img']` en `['pdf']` leeg uit → `src="img/"` (gebroken cover) en
 * `href="download/"` (dode link). Vul de Engelse cover/PDF statisch in (+ id/class
 * zodat `__abUpdateBook` ze per taal kan verwisselen).
 */
function fixBook(html) {
  const en = BOOK_LIST.en
  html = html.replace('<img class="book-image" src="img/" alt="Abundomy Book Cover">',
    `<img id="bookCover" class="book-image" src="/img/${en.img}" alt="Abundomy Book Cover">`)
  html = html.replace(/href="download\/"/g, `href="/download/${encodeURIComponent(en.pdf)}" class="book-dl"`)
  // download-tellers kwamen ook uit de DB → leeg ("Downloads: ()"); toon 0 (serverloos).
  html = html.replace('<span id="total-count"></span>', '<span id="total-count">0</span>')
  html = html.replace('<span id="lang-count"></span>', '<span id="lang-count">0</span>')
  return html
}

/** Voeg op artikelpagina's met de OneCoinH-demo een download-teller + tracking toe
 *  (het origineel telde dit niet). Eén gedeelde 'xlsx'-sleutel via /api/downloads. */
function fixXlsxDownload(html) {
  if (!html.includes('OneCoinHDemo.xlsx')) return html
  html = html.replace(/(<a\b[^>]*OneCoinHDemo\.xlsx[^>]*?)>/g, `$1 onclick="window.__abTrackItem&&window.__abTrackItem('xlsx')">`)
  html = html.replace(/(<a\b[^>]*OneCoinHDemo\.xlsx[\s\S]*?<\/a>)/, `$1\n<p class="par" style="text-align:center;margin:.45rem 0 0;opacity:.85">Downloads: <span id="xlsx-count">0</span></p>`)
  return html
}

/** Maak de i18n client-side: dynamische taal + vlag-taalkiezer i.p.v. de dode 🌐.
 *  `pageJson` (optioneel): de json-basename voor pagina's waar die afwijkt van de
 *  bestandsnaam (artikel-readers gebruiken bv. article01.json i.p.v. article01-reader). */
function injectSwitcher(html, pageJson) {
  // 0. per-pagina json-naam vastleggen (gebruikt door __abSetLang bij taalwissel)
  if (pageJson) html = html.replace(/<head>/i, `<head>\n<script>window.__abPageJson=${JSON.stringify(pageJson)};</script>`)
  // 1. fill-JS dynamisch maken (currentLang/lang kwamen uit $currentLang → "en")
  html = html.replace(/const currentLang = "en"/g, 'const currentLang = window.__lang')
  html = html.replace(/const lang = "en"/g, 'const lang = window.__lang')
  // 2. dode taal-icoon (🌐-link) → ronde vlag-knop die de taalpagina opent
  html = html.replace(/<a [^>]*class="lang-icon"[^>]*>[\s\S]*?<\/a>/,
    `<button id="abLangFlag" class="ab-lang-flag" type="button" aria-label="Language" onclick="window.__abOpenLang()"></button>`)
  // 3. header-mousedown-blok onze knop laten doorlaten (origineel doet preventDefault
  //    voor alles wat geen <a> is → anti-focus, maar dat hoeft de vlag-knop niet te raken).
  html = html.replace(/!e\.target\.closest\('a'\)/g, "!e.target.closest('a') && !e.target.closest('button')")
  // 4. scripts injecteren (head vroeg, body laat)
  html = html.replace(/<head>/i, '<head>\n' + HEAD_I18N)
  html = html.replace(/<\/body>/i, BODY_I18N + '\n</body>')
  return html
}

/** Resolve de (eenvoudige) PHP naar statische HTML voor taal `en` + relatieve paden. */
function renderPhp(src, { title = 'Abundomy', desc = 'Abundomy - Realizing Resource Systems', keywords = 'Abundomy, Resource Systems, Local Economy, Alternative Currency, Isonomy' } = {}) {
  let s = src
  // 1. includes → markers (sluit/heropen het PHP-blok zodat de marker HTML-output wordt)
  // include/require (_once) → marker; sta een pad-prefix toe (artikelen: "../header.php").
  s = s.replace(/(?:include|require)(?:_once)?\s+["'][^"']*header\.php["']\s*;?/g, '?>{{HEADER}}<?php ')
  s = s.replace(/(?:include|require)(?:_once)?\s+["'][^"']*footer\.php["']\s*;?/g, '?>{{FOOTER}}<?php ')
  // 2. bekende output-echoes resolven (vóór het strippen van logica-blokken)
  // $baseHref → absolute root "/" (zoals de bron in productie): werkt op élke diepte,
  // dus ook voor /articles/-pagina's (assets, nav-links, json blijven correct).
  s = s.replace(/<\?php\s+echo\s+\$baseHref\s*;?\s*\?>/g, '/')
  s = s.replace(/<\?php\s+echo\s+\$currentLang(\s*\?\?\s*'en')?\s*;?\s*\?>/g, 'en')
  s = s.replace(/<\?php\s+echo\s+getFlagSVG\([^)]*\)\s*;?\s*\?>/g, '🌐')
  // non-greedy t/m de eerste ?> (de ternary bevat zelf ook een '?')
  s = s.replace(/<\?php\s+echo\s+isset\(\$pageTitle\)[\s\S]*?\?>/g, title)
  s = s.replace(/<\?php\s+echo\s+isset\(\$pageDesc\)[\s\S]*?\?>/g, desc)
  s = s.replace(/<\?php\s+echo\s+isset\(\$pageKeywords\)[\s\S]*?\?>/g, keywords)
  // isRTL-ternary → false-tak (we renderen LTR/en)
  s = s.replace(/<\?php\s+echo\s+\(?[^?{}]*\$isRTL[^?{}]*\?\s*("[^"]*"|'[^']*')\s*:\s*("[^"]*"|'[^']*')\s*;?\s*\?>/g, (_m, _t, f) => f.slice(1, -1))
  // overige enkelvoudige string-echoes → de string zelf
  s = s.replace(/<\?php\s+echo\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*;?\s*\?>/g, (_m, str) => str.slice(1, -1))
  // 3. alle resterende PHP-blokken (setup, DB, hreflang-loop, multi-echo) strippen
  s = s.replace(/<\?php[\s\S]*?\?>/g, '')
  s = s.replace(/<\?=[\s\S]*?\?>/g, '')
  // 4. links: .php → .html voor de gegenereerde pagina's; taalwisselaar uitschakelen
  s = s.replace(/(href=["'])([^"']*?)(index|base|community|education|projects)\.php/g, '$1$2$3.html')
  s = s.replace(/(href=["'])[^"']*set-language\.php[^"']*(["'])/g, '$1#$2')
  // Translator-knop op de homepagina alleen visueel weghalen (referenties laten staan).
  s = s.replace(/<a [^>]*href=['"]article-translator\.php['"][^>]*>[\s\S]*?<\/a>/g, '')
  // Per-artikel server-side PDF-knop (POST naar generate-pdf-r.inc.php) → kan statisch
  // niet; verwijder het formulier zodat er geen dode knop blijft staan.
  s = s.replace(/<form[^>]*generate-pdf[^>]*>[\s\S]*?<\/form>/g, '')
  // Overige .php-links (artikel-readers, samenvattingen) → .html (alles wat we bouwen).
  s = s.replace(/(href=["'][^"']*?)\.php(["'?#])/g, '$1.html$2')
  // money-app-link → onze IPFS-app (op /app/), i.p.v. het oude bron-domein 1coinh.com
  s = s.replace(/https?:\/\/(www\.)?1coinh\.com\/?/g, '/app/')
  return s
}

const read = (name) => readFileSync(SRC + name, 'utf8')

// --- bouwen ---
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const headerSrc = read('header.php')
const footer = renderPhp(read('footer.php'))

let built = 0
for (const [php, { out, title }] of Object.entries(PAGES)) {
  if (!existsSync(SRC + php)) { console.log('• overslaan (ontbreekt):', php); continue }
  const header = renderPhp(headerSrc, { title }) // per pagina: juiste <title>/OG
  let html = renderPhp(read(php), { title })
  html = html.replace('{{HEADER}}', header).replace('{{FOOTER}}', footer)
  html = fixBook(html)        // boek-cover/PDF-link (DB-loos → EN-default + per-taal-swap)
  html = injectSwitcher(html) // client-side taalkiezer + dynamische taal
  writeFileSync(OUT + out, html)
  built++
  console.log('•', php, '→', out)
}

for (const dir of ASSET_DIRS) {
  if (existsSync(SRC + dir)) { cpSync(SRC + dir, OUT + dir, { recursive: true }); console.log('• assets:', dir) }
}

// Vlaggen (1-op-1 getFlagSVG, gegenereerd in web/public/json/flags.json) → de content-bundel,
// zodat de vlag-taalkiezer dezelfde vlaggen toont als de money-app.
const FLAGS_SRC = fileURLToPath(new URL('./public/json/flags.json', import.meta.url))
if (existsSync(FLAGS_SRC)) {
  mkdirSync(OUT + 'json', { recursive: true })
  cpSync(FLAGS_SRC, OUT + 'json/flags.json')
  console.log('• vlaggen: json/flags.json')
} else {
  console.log('⚠ web/public/json/flags.json ontbreekt — vlag-taalkiezer toont geen vlaggen')
}

// Vlag-JPG's (punt 01.1, 23 jul 2026: SVG→JPG) → content-bundel, zodat /img/flags/flag_XX.jpg werkt.
const FLAGS_IMG = fileURLToPath(new URL('./public/img/flags/', import.meta.url))
if (existsSync(FLAGS_IMG)) { cpSync(FLAGS_IMG, OUT + 'img/flags', { recursive: true }); console.log('• vlag-JPG\'s: img/flags/') }

// Extra bundel-assets die niet in de Abundomy-bron zitten (bv. OneCoinHDemo.xlsx — door
// youtube01/tiktok01 gelinkt maar nooit meegekomen; opgehaald van abundomy.com). Map-
// structuur onder web/site-extra/ wordt 1-op-1 over de bundel-root gelegd.
const EXTRA = fileURLToPath(new URL('./site-extra/', import.meta.url))
if (existsSync(EXTRA)) { cpSync(EXTRA, OUT, { recursive: true }); console.log('• extra-assets: site-extra/ → bundel-root') }

// --- Artikelen/educatie: elke articles/*.php door dezelfde pipeline → .html ---
// Ze includen ../header.php + ../footer.php en vullen tx_NN-spans client-side uit
// json/<artikel>.json (per-pagina via window.__abPageJson). De meegekopieerde
// .php-bronnen verwijderen we daarna uit de bundel.
const ART_SRC = SRC + 'articles/'
let articlesBuilt = 0
if (existsSync(ART_SRC)) {
  for (const name of readdirSync(ART_SRC)) {
    if (!/\.php$/i.test(name) || !statSync(ART_SRC + name).isFile()) continue
    const src = readFileSync(ART_SRC + name, 'utf8')
    const jm = src.match(/json\/([A-Za-z0-9_.\-]+)\.json/)      // fill-fetch → json-basename
    const pageJson = jm ? jm[1] : null
    const tm = src.match(/\$fallbackTitle\s*=\s*"([^"]+)"/)     // SEO-titel uit de bron
    const title = (tm ? tm[1] : 'Abundomy') + ' | Abundomy'
    const header = renderPhp(headerSrc, { title })
    let html = renderPhp(src, { title })
    html = html.replace('{{HEADER}}', header).replace('{{FOOTER}}', footer)
    html = fixXlsxDownload(html) // download-teller op artikelen met de OneCoinH-demo
    html = injectSwitcher(html, pageJson)
    const out = name.replace(/\.php$/i, '.html')
    writeFileSync(OUT + 'articles/' + out, html)
    rmSync(OUT + 'articles/' + name, { force: true })          // .php-bron weg uit de bundel
    articlesBuilt++
  }
  console.log(`• artikelen gebouwd: ${articlesBuilt} (.php → .html)`)
}

// leftover-controle: er mag geen onverwerkte PHP in de output zitten
const hasPhp = (file) => existsSync(file) && readFileSync(file, 'utf8').includes('<?php')
let leftover = 0
const checkDir = (base, names) => { for (const n of names) if (/\.html$/i.test(n) && hasPhp(base + n)) { console.log('⚠ resterende <?php in', base + n); leftover++ } }
checkDir(OUT, Object.values(PAGES).map((p) => p.out))
if (existsSync(OUT + 'articles')) checkDir(OUT + 'articles/', readdirSync(OUT + 'articles'))
console.log(`\n${leftover === 0 ? '✅' : '❌'} ${built} pagina's + ${articlesBuilt} artikelen gebouwd (resterende PHP: ${leftover})`)
if (leftover > 0) process.exitCode = 1
