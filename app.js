/* Catfish Check — all client-side. No photos or details leave the device unless the user
   explicitly sends a photo to a reverse-image search site. */
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const toast = msg => { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3200); };

/* ---------------- Tabs ---------------- */
function showTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'verdict') renderVerdict();
  if (name === 'quick') renderQuick();
  window.scrollTo({top: 0, behavior: 'smooth'});
}
$$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------------- Install prompt ---------------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#installBtn').hidden = true;
});
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

/* ================= PHOTO CHECK ================= */
const photos = []; // {id, file, url, w, h, findings:[], aiScore, fakeScore, exif, gen}
let nextId = 1;

const fileInput = $('#fileInput'), dz = $('#dropzone');
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
document.addEventListener('paste', e => {
  if (!$('#tab-photos').classList.contains('active')) return;
  const files = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (files.length) addFiles(files);
});

async function addFiles(list) {
  for (const file of [...list]) {
    if (!file.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png|webp|gif|avif)$/i.test(file.name)) { toast(`${file.name} isn't an image`); continue; }
    const p = {id: nextId++, file, url: URL.createObjectURL(file), findings: [], aiScore: 0, fakeScore: 0, realScore: 0, pending: true};
    photos.push(p); renderPhotos();
    try { await analyzePhoto(p); } catch (err) { console.error(err); p.findings.push({lvl: 'info', t: 'Could not fully read this file: ' + err.message}); }
    p.pending = false; renderPhotos();
  }
}

function imgSize(url) {
  return new Promise(res => { const i = new Image(); i.onload = () => res({w: i.naturalWidth, h: i.naturalHeight}); i.onerror = () => res({w: 0, h: 0}); i.src = url; });
}

/* Pull only the metadata parts of the file as text, so generator names aren't matched against random pixel bytes. */
async function metadataText(file) {
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 30 * 1024 * 1024)).arrayBuffer());
  const latin = (a, b) => { let s = ''; for (let i = a; i < b; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(b, i + 8192))); return s; };
  const u32 = i => (buf[i] << 24 | buf[i+1] << 16 | buf[i+2] << 8 | buf[i+3]) >>> 0;
  const parts = []; let kind = 'other'; const pngText = {};
  if (buf[0] === 0x89 && buf[1] === 0x50) { // PNG
    kind = 'png'; let i = 8;
    while (i + 8 < buf.length) {
      const len = u32(i), type = latin(i + 4, i + 8);
      if (['tEXt','iTXt','zTXt','eXIf','caBX'].includes(type) || type === 'iCCP') {
        const body = latin(i + 8, i + 8 + Math.min(len, 2e6));
        if (type !== 'iCCP') parts.push(type + ':' + body);
        if (type === 'tEXt' || type === 'iTXt') { const k = body.split('\0')[0]; pngText[k] = body.slice(k.length + 1).replace(/^\0+/, ''); }
      }
      if (type === 'IEND') break; i += 12 + len;
    }
  } else if (buf[0] === 0xFF && buf[1] === 0xD8) { // JPEG: APPn + COM segments before SOS
    kind = 'jpeg'; let i = 2;
    while (i + 4 < buf.length && buf[i] === 0xFF) {
      const m = buf[i+1]; if (m === 0xDA || m === 0xD9) break;
      const len = buf[i+2] << 8 | buf[i+3];
      if ((m >= 0xE0 && m <= 0xEF) || m === 0xFE) parts.push(latin(i + 4, i + 2 + len));
      i += 2 + len;
    }
  } else if (latin(0, 4) === 'RIFF' && latin(8, 12) === 'WEBP') {
    kind = 'webp'; let i = 12;
    while (i + 8 < buf.length) { const t = latin(i, i + 4); const len = buf[i+4] | buf[i+5] << 8 | buf[i+6] << 16 | buf[i+7] << 24;
      if (t === 'EXIF' || t === 'XMP ') parts.push(latin(i + 8, i + 8 + len)); i += 8 + len + (len & 1); }
  } else {
    if (/ftyp(heic|heix|mif1|avif)/.test(latin(4, 12))) kind = 'heic';
    parts.push(latin(0, Math.min(buf.length, 512 * 1024)));
  }
  return {kind, text: parts.join('\n'), pngText};
}

const AI_GENERATORS = [
  ['Midjourney', /midjourney/i], ['DALL·E / OpenAI', /dall[\s\-·]?e|openai|chatgpt|gpt-4o|gpt-image/i],
  ['Stable Diffusion', /stable[\s_-]?diffusion|sdxl|automatic1111|a1111/i], ['ComfyUI', /comfyui|"class_type"/i],
  ['InvokeAI', /invokeai|sd-metadata/i], ['NovelAI', /novelai/i], ['Adobe Firefly', /firefly/i],
  ['Google Imagen / Gemini', /imagen|made with google ai|gemini/i], ['Leonardo.ai', /leonardo\.ai/i],
  ['Ideogram', /ideogram/i], ['FLUX', /black forest labs|flux\.1|flux-(dev|pro|schnell)/i],
  ['Microsoft Designer / Bing Image Creator', /bing image creator|microsoft designer|image creator from designer/i],
  ['Meta AI', /imagined with ai|meta ai/i], ['NightCafe', /nightcafe/i], ['Runway', /runwayml/i],
  ['DreamStudio', /dreamstudio/i], ['Artbreeder', /artbreeder/i], ['This Person Does Not Exist', /thispersondoesnotexist|stylegan/i],
];
const EDIT_APPS = /photoshop|lightroom|gimp|snapseed|facetune|meitu|picsart|remini|faceapp|lensa|beautyplus|airbrush|youcam|perfect365|vsco|canva|pixelmator|affinity|picmonkey|befunky|fotor|retouch|beauty ?cam|b612|snow|ulike|peachy/i;
const AI_SIZES = new Set(['512x512','768x768','1024x1024','2048x2048','1024x1536','1536x1024','1792x1024','1024x1792',
  '832x1216','1216x832','896x1152','1152x896','1344x768','768x1344','1536x640','640x1536','1456x816','816x1456',
  '1232x928','928x1232','1344x896','896x1344','1360x768','768x1360','2048x1152','1152x2048','1664x928','928x1664','1408x768','768x1408']);

async function analyzePhoto(p) {
  const F = p.findings, add = (lvl, t, k = {}) => { F.push({lvl, t}); p.aiScore += k.ai || 0; p.fakeScore += k.fake || 0; p.realScore += k.real || 0; };
  const {w, h} = await imgSize(p.url); p.w = w; p.h = h;
  let exif = null;
  try { exif = await exifr.parse(p.file, {tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, jfif: false, ihdr: true, mergeOutput: true, translateValues: true, reviveValues: true}); } catch (e) { /* unreadable */ }
  p.exif = exif || {};
  const meta = await metadataText(p.file).catch(() => ({kind: 'other', text: '', pngText: {}}));
  p.kind = meta.kind;
  const flat = (meta.text + ' ' + JSON.stringify(p.exif, (k, v) => typeof v === 'string' ? v : (v instanceof Uint8Array ? undefined : v))).slice(0, 4e6);

  // ---- AI generation signals (strong) ----
  const gens = AI_GENERATORS.filter(([, re]) => re.test(flat)).map(([n]) => n);
  if (/trainedAlgorithmicMedia/i.test(flat) && !/compositeWithTrainedAlgorithmicMedia/i.test(flat)) add('bad', 'Metadata labels this image as <strong>AI-generated</strong> (IPTC "trainedAlgorithmicMedia").', {ai: 6});
  else if (/compositeWithTrainedAlgorithmicMedia|algorithmicallyEnhanced/i.test(flat)) add('bad', 'Metadata says this image was <strong>partly made or edited with AI</strong>.', {ai: 4});
  if (meta.pngText.parameters && /Steps:|Sampler:|CFG scale/i.test(meta.pngText.parameters)) add('bad', 'Contains a <strong>Stable Diffusion prompt and settings</strong> embedded in the file.', {ai: 6});
  if (meta.pngText.prompt || meta.pngText.workflow) add('bad', 'Contains an embedded <strong>AI image prompt / workflow</strong> (ComfyUI-style).', {ai: 6});
  if (gens.length) add('bad', `Metadata mentions an AI image tool: <strong>${esc(gens.join(', '))}</strong>.`, {ai: 5});
  const hasC2PA = /c2pa|contentauth|jumb/i.test(meta.text);
  if (hasC2PA) add(gens.length ? 'bad' : 'info', `Has <strong>Content Credentials (C2PA)</strong>. ${gens.length ? 'These often get added by AI generators.' : 'Check it at <a href="https://contentcredentials.org/verify" target="_blank" rel="noopener">contentcredentials.org/verify</a> to see what made the image.'}`, {ai: gens.length ? 1 : 0});

  // ---- Camera metadata ----
  const make = p.exif.Make, model = p.exif.Model, software = p.exif.Software || p.exif.CreatorTool || p.exif.ProcessingSoftware || '';
  const taken = p.exif.DateTimeOriginal || p.exif.CreateDate, modified = p.exif.ModifyDate;
  const hasCamera = !!(make || model);
  const hasAnyExif = Object.keys(p.exif).some(k => !['ImageWidth','ImageHeight','BitDepth','ColorType','Compression','Filter','Interlace','ihdr'].includes(k));
  if (hasCamera) add('good', `Camera info: <strong>${esc([make, model].filter(Boolean).join(' '))}</strong>${p.exif.LensModel ? ' · ' + esc(p.exif.LensModel) : ''}. Real phone/camera photos usually carry this (it can be faked, but rarely is).`, {real: 2});
  else if (!hasAnyExif) add('info', 'No metadata at all. That\'s <strong>normal</strong> for photos sent through most apps (they strip it), screenshots, and downloaded images. It\'s also typical of AI images. Neutral on its own.');
  else add('info', 'Has some metadata but no camera make/model.');

  if (software && EDIT_APPS.test(software)) add('warn', `Edited with <strong>${esc(software)}</strong>. Face-retouching apps can make someone look very different from real life.`, {fake: 1});
  else if (software && !gens.length) add('info', `Software tag: ${esc(software)}`);

  // ---- Dates ----
  const now = Date.now();
  if (taken instanceof Date && !isNaN(taken)) {
    const yrs = (now - taken) / (365.25 * 864e5);
    if (yrs > 3) add('warn', `Photo was taken <strong>${taken.toLocaleDateString()}</strong>, about ${Math.floor(yrs)} years ago. Old photos get recycled by catfish, or the person may look different now.`, {fake: 1});
    else if (yrs < -0.01) add('warn', `Photo date is in the future (${taken.toLocaleDateString()}). The camera clock was wrong or the metadata was tampered with.`, {fake: 1});
    else add('good', `Taken <strong>${taken.toLocaleDateString()}</strong>${yrs < 0.25 ? ' (recent)' : ''}.`, {real: 1});
    if (modified instanceof Date && !isNaN(modified) && (modified - taken) > 864e5 * 2) add('warn', `Modified on ${modified.toLocaleDateString()}, after it was taken. It may have been edited or re-saved.`);
  }
  if (p.exif.latitude != null) add('info', 'Contains <strong>GPS location</strong> data. If they said the photo is from their city, you could sanity-check that. Be respectful with location info.');

  // ---- Dimension / format heuristics (weak hints) ----
  const dim = `${w}x${h}`, square = w === h;
  const screenshot = /screenshot|screen shot|img_\d{4}\.png/i.test(p.file.name) || /screenshot/i.test(flat);
  if (AI_SIZES.has(dim) && !hasCamera) add('warn', `Size is <strong>${dim}</strong>, a typical output size for AI image generators. A hint, not proof.`, {ai: 2});
  else if (w && w % 64 === 0 && h % 64 === 0 && !hasCamera && Math.max(w, h) <= 2048) add('warn', `Both sides are multiples of 64 (${dim}), common for AI generators. Weak hint.`, {ai: 1});
  if ((meta.kind === 'png' || meta.kind === 'webp') && !hasCamera && !screenshot) add('warn', `It's a ${meta.kind.toUpperCase()} with no camera data. Phones save photos as JPEG/HEIC, while many AI tools output PNG/WebP. Weak hint.`, {ai: 1});
  if (screenshot) add('info', 'Looks like a <strong>screenshot</strong>, so metadata won\'t tell you much. Reverse image search still works.');
  if (w && Math.max(w, h) < 500) add('info', `Low resolution (${dim}). Images saved from the web or re-sent many times are often small.`, {fake: 0.5});

  if (!gens.length && p.aiScore === 0 && !hasCamera) add('info', 'No AI signals found in the file itself. Many AI images have their metadata stripped, so <strong>do the reverse image search</strong> and try a detector below.');
}

function photoVerdict(p) {
  if (p.aiScore >= 5) return ['bad', 'AI signs'];
  if (p.aiScore >= 2) return ['warn', 'Possible AI'];
  if (p.realScore >= 2) return ['good', 'Looks camera-made'];
  return ['warn', 'Inconclusive'];
}

/* ---- Reverse image search ---- */
function postFileToNewTab(action, fieldName, file, extra = {}) {
  const form = document.createElement('form');
  form.method = 'POST'; form.action = action; form.target = '_blank'; form.enctype = 'multipart/form-data'; form.style.display = 'none';
  const input = document.createElement('input'); input.type = 'file'; input.name = fieldName;
  const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; form.appendChild(input);
  for (const [k, v] of Object.entries(extra)) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; form.appendChild(i); }
  document.body.appendChild(form); form.submit(); setTimeout(() => form.remove(), 1000);
}
async function toJpeg(p, max = 1600) { // Normalise HEIC/huge files into a JPEG search sites accept
  const img = new Image(); img.src = p.url; await img.decode();
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  return new File([blob], 'photo.jpg', {type: 'image/jpeg'});
}
async function toPngBlob(p) {
  const img = new Image(); img.src = p.url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
  return new Promise(r => c.toBlob(r, 'image/png'));
}
const ENGINES = {
  google: {name: 'Google Lens', site: 'https://lens.google.com/', byUrl: u => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}`,
    upload: f => postFileToNewTab(`https://lens.google.com/v3/upload?ep=ccm&s=&st=${Date.now()}`, 'encoded_image', f)},
  bing: {name: 'Bing Visual', site: 'https://www.bing.com/visualsearch', byUrl: u => `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${encodeURIComponent(u)}`},
  tineye: {name: 'TinEye', site: 'https://tineye.com/', byUrl: u => `https://tineye.com/search?url=${encodeURIComponent(u)}`},
  yandex: {name: 'Yandex', site: 'https://yandex.com/images/', byUrl: u => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(u)}`,
    upload: f => postFileToNewTab('https://yandex.com/images/search?rpt=imageview', 'upfile', f)},
};

async function runSearch(p, key) {
  const eng = ENGINES[key]; p.searched = p.searched || new Set(); p.searched.add(key);
  const u = (p.remoteUrl || '').trim();
  if (/^https?:\/\//i.test(u)) { window.open(eng.byUrl(u), '_blank', 'noopener'); return; }
  if (eng.upload) {
    try { eng.upload(await toJpeg(p)); toast(`Sending this photo to ${eng.name} in a new tab…`); return; }
    catch (e) { console.warn(e); }
  }
  // Fallback: copy to clipboard (desktop) and open the site to paste/upload.
  let copied = false;
  try { if (navigator.clipboard && window.ClipboardItem) { await navigator.clipboard.write([new ClipboardItem({'image/png': toPngBlob(p)})]); copied = true; } } catch (e) {}
  window.open(eng.site, '_blank', 'noopener');
  toast(copied ? `Photo copied. On ${eng.name}, paste it (Ctrl/Cmd+V) or use the upload button.` : `On ${eng.name}, tap the camera/upload icon and choose this photo.`);
}
async function sharePhoto(p) {
  try {
    const f = await toJpeg(p);
    if (navigator.canShare && navigator.canShare({files: [f]})) { await navigator.share({files: [f], title: 'Photo to check'}); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  toast('Sharing isn\'t supported in this browser. Use the search buttons instead.');
}

function renderPhotos() {
  const list = $('#photoList');
  list.innerHTML = photos.map(p => {
    const [cls, label] = p.pending ? ['warn', 'Analyzing…'] : photoVerdict(p);
    const kv = p.exif ? Object.entries({
      'Type': p.file.type || p.kind, 'Size': p.w ? `${p.w} × ${p.h}px · ${(p.file.size / 1024).toFixed(0)} KB` : '',
      'Camera': [p.exif.Make, p.exif.Model].filter(Boolean).join(' '), 'Lens': p.exif.LensModel, 'Software': p.exif.Software || p.exif.CreatorTool,
      'Taken': p.exif.DateTimeOriginal?.toLocaleString?.(), 'Modified': p.exif.ModifyDate?.toLocaleString?.(),
      'GPS': p.exif.latitude != null ? 'Present' : '', 'Exposure': p.exif.ExposureTime ? `1/${Math.round(1 / p.exif.ExposureTime)}s, ISO ${p.exif.ISO ?? '?'}` : '',
    }).filter(([, v]) => v) : [];
    return `<article class="card photo" data-id="${p.id}">
      <img class="thumb" src="${p.url}" alt="Uploaded photo">
      <div>
        <div class="photo-head"><h3>${esc(p.file.name)}</h3><span class="pill ${cls}">${label}</span></div>
        <div class="meta">${p.w ? `${p.w}×${p.h}` : ''} ${esc((p.kind || '').toUpperCase())}</div>
        <ul class="findings">${p.findings.map(f => `<li class="${f.lvl}"><span class="ic">${{bad:'🚩',warn:'⚠️',good:'✅',info:'ℹ️'}[f.lvl]}</span><span>${f.t}</span></li>`).join('')}</ul>
        <h3>Reverse image search <span class="muted small">(is this photo elsewhere under another name?)</span></h3>
        <div class="btnrow">
          ${Object.entries(ENGINES).map(([k, e]) => `<button class="btn small ${p.searched?.has(k) ? 'ghost' : ''}" data-act="search" data-eng="${k}">${p.searched?.has(k) ? '✓ ' : '🔎 '}${e.name}</button>`).join('')}
        </div>
        <p class="howto">Google Lens and Yandex receive the photo directly when you tap. Bing and TinEye open their site with the photo copied, so paste it (desktop) or tap upload. If the photo is online (e.g. a profile pic link), paste its address below and every button searches by link instead.</p>
        <div class="urlrow"><input type="url" placeholder="Optional: image link (https://…)" data-act="url" value="${esc(p.remoteUrl || '')}"></div>
        <div class="btnrow">
          <button class="btn small ghost" data-act="share">📤 Share to app (phone)</button>
          <button class="btn small ghost" data-act="copy">📋 Copy image</button>
          <button class="btn small ghost" data-act="remove">🗑 Remove</button>
        </div>
        <details><summary>Free AI-image detectors (second opinion)</summary>
          <p class="small muted">These are third-party sites. Uploading there shares the photo with them. Detectors make mistakes both ways, so treat results as hints.</p>
          <div class="btnrow">
            <a class="btn small ghost" href="https://huggingface.co/spaces/umm-maybe/AI-image-detector" target="_blank" rel="noopener">Hugging Face detector</a>
            <a class="btn small ghost" href="https://sightengine.com/detect-ai-generated-images" target="_blank" rel="noopener">Sightengine</a>
            <a class="btn small ghost" href="https://isitai.com/ai-image-detector/" target="_blank" rel="noopener">IsItAI</a>
            <a class="btn small ghost" href="https://contentcredentials.org/verify" target="_blank" rel="noopener">Content Credentials</a>
          </div>
          <p class="small muted">Look yourself too: warped earrings/glasses, mismatched ears, melted hair edges, odd teeth, garbled text in the background, overly smooth skin, and identical lighting across every photo.</p>
        </details>
        ${kv.length ? `<details><summary>Raw metadata</summary><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>` : ''}
      </div>
    </article>`;
  }).join('');
}
$('#photoList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT') return;
  const p = photos.find(x => x.id == b.closest('.photo').dataset.id); if (!p) return;
  const act = b.dataset.act;
  if (act === 'search') { await runSearch(p, b.dataset.eng); renderPhotos(); }
  if (act === 'share') sharePhoto(p);
  if (act === 'copy') { try { await navigator.clipboard.write([new ClipboardItem({'image/png': toPngBlob(p)})]); toast('Image copied to clipboard'); } catch { toast('Copy not supported here. Long-press the photo instead.'); } }
  if (act === 'remove') { URL.revokeObjectURL(p.url); photos.splice(photos.indexOf(p), 1); renderPhotos(); }
});
$('#photoList').addEventListener('input', e => {
  if (e.target.dataset.act !== 'url') return; const p = photos.find(x => x.id == e.target.closest('.photo').dataset.id); if (p) p.remoteUrl = e.target.value;
});

/* ================= PROFILE CHECK ================= */
const FLAGS = [
  // id, label, weight, explanation, kind
  ['novideo', 'Refused or keeps dodging a video call', 4, 'Avoiding video is the single most common catfish sign. Real people can do a 1-minute call.'],
  ['money', 'Asked for money, gift cards, crypto, or help paying a bill', 6, 'Asking for money from someone they haven\'t met is the defining sign of a romance scam.'],
  ['invest', 'Brought up investing, crypto trading, or a "special platform"', 6, '"Pig butchering" scams build a romance and then steer you into a fake investment app.'],
  ['offapp', 'Pushed to move to WhatsApp / Telegram / text within days', 2, 'Scammers move off-app fast, before the dating app can flag and ban them.'],
  ['lovebomb', 'Very intense affection fast ("soulmate", "I love you" early)', 3, 'Love-bombing builds emotional dependence quickly so you\'ll ignore warning signs.'],
  ['inconsistent', 'Stories, age, or details don\'t line up', 3, 'Catfish juggling several victims or a fake identity often slip on details.'],
  ['abroad', 'Works overseas / military / oil rig / doctor abroad', 3, 'Classic scam cover stories explain why they can\'t meet or video call.'],
  ['nomeet', 'Always has an excuse not to meet in person', 3, 'Endless postponing (often followed by a sudden emergency) is a pattern.'],
  ['tooperfect', 'Photos look like a model / too polished / all professional', 2, 'Catfish often use stolen photos of models or influencers, or AI images.'],
  ['fewphotos', 'Only has a few photos, or won\'t send new ones', 2, 'Someone using stolen pictures has a limited set and can\'t take new ones on request.'],
  ['scripted', 'Messages feel scripted, generic, or ignore your questions', 2, 'Scammers copy-paste scripts (and increasingly use AI chatbots) across many targets.'],
  ['emergency', 'Sudden emergency / medical bill / stuck at customs', 4, 'A crisis that only money can fix is the usual "ask" moment.'],
  ['secrecy', 'Asks you to keep the relationship secret', 2, 'Isolation from friends and family keeps you from getting a second opinion.'],
  ['intimate', 'Pushed for intimate photos early', 3, 'Sextortion scams use fake profiles to get images and then blackmail.'],
  ['personal', 'Asked for ID, bank info, codes, or your address early', 4, 'Identity theft, or verification codes to hijack your accounts.'],
  ['grammar', 'Language or writing doesn\'t match where they say they\'re from', 1, 'Can be innocent, but a mismatch with their claimed background is worth noting.'],
  // positives
  ['didvideo', 'We\'ve done a live video call and it matched their photos', -6, 'A natural live video call is the strongest sign they\'re real.', 'good'],
  ['met', 'We\'ve met in person', -8, 'Meeting in person confirms they exist (identity details can still be checked).', 'good'],
  ['mutuals', 'We have real mutual friends who know them', -3, 'Real-world connections are hard to fake.', 'good'],
  ['posed', 'They sent a selfie doing a specific pose I asked for', -2, 'Good sign, though AI can now fake simple poses.', 'good'],
];
$('#flagList').innerHTML = FLAGS.map(([id, label, , , kind]) =>
  `<label class="flag ${kind === 'good' ? 'good-flag' : ''}"><input type="checkbox" name="f_${id}"><span>${kind === 'good' ? '✅ ' : ''}${label}</span></label>`).join('');

function readProfile() {
  const fd = new FormData($('#profileForm')); const o = Object.fromEntries(fd.entries());
  o.flags = FLAGS.filter(([id]) => fd.get('f_' + id)).map(f => f[0]);
  return o;
}
function scoreProfile() {
  const pr = readProfile(); const reasons = []; let score = 0;
  for (const id of pr.flags) { const f = FLAGS.find(x => x[0] === id); score += f[2]; reasons.push({lvl: f[2] < 0 ? 'good' : f[2] >= 4 ? 'bad' : 'warn', t: `<strong>${f[1]}.</strong> ${f[3]}`}); }
  // Consistency between age and DOB
  if (pr.dob && pr.age) {
    const d = new Date(pr.dob), n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--;
    if (Math.abs(a - +pr.age) >= 2) { score += 3; reasons.push({lvl: 'bad', t: `<strong>Age doesn't match date of birth.</strong> They said ${esc(pr.age)}, but that birthday makes them ${a}.`}); }
    else reasons.push({lvl: 'good', t: 'Age matches the date of birth they gave.'});
  }
  if (pr.age && (+pr.age < 18)) { score += 5; reasons.push({lvl: 'bad', t: '<strong>They say they\'re under 18.</strong> Stop talking with them.'}); }
  if (pr.where === 'wrongnumber') { score += 4; reasons.push({lvl: 'bad', t: '<strong>Started as a "wrong number" text.</strong> This is a well-known opener for romance/investment scams.'}); }
  if (pr.where === 'social') { score += 1; reasons.push({lvl: 'warn', t: 'Met through a social media DM from a stranger. Fake accounts commonly use this route.'}); }
  if (pr.where === 'irl') { score -= 4; reasons.push({lvl: 'good', t: 'You met in person or through friends.'}); }
  if (/engineer.*(offshore|rig)|oil rig|offshore|un (doctor|peacekeeper)|surgeon.*(abroad|syria|yemen)|army|military|deployed|marine|contractor/i.test(pr.job || '') && !pr.flags.includes('abroad')) {
    score += 2; reasons.push({lvl: 'warn', t: `Their job ("${esc(pr.job)}") is one of the cover stories scammers use most, because it explains why they can't meet or call.`});
  }
  if ((pr.duration === 'months' || pr.duration === 'long') && pr.flags.includes('novideo')) { score += 2; reasons.push({lvl: 'bad', t: 'Talking for over a month with <strong>no video call</strong> at all.'}); }
  if (pr.duration === 'days' && pr.flags.includes('lovebomb')) { score += 1; reasons.push({lvl: 'bad', t: 'Strong declarations of love within days.'}); }
  return {score, reasons, pr};
}
function renderProfile() {
  const {score, reasons} = scoreProfile();
  const pct = Math.max(0, Math.min(100, score * 5));
  const [cls, label] = score >= 10 ? ['bad', 'High risk'] : score >= 4 ? ['warn', 'Some red flags'] : score > 0 ? ['warn', 'Minor flags'] : reasons.length ? ['good', 'Low risk'] : ['', 'Tick anything that applies above'];
  const color = cls === 'bad' ? 'var(--bad)' : cls === 'warn' ? 'var(--warn)' : 'var(--good)';
  $('#profileResult').innerHTML = `<h2>Red-flag score: ${Math.max(0, score)} ${cls ? `<span class="pill ${cls}">${label}</span>` : ''}</h2>
    <div class="scorebar"><div style="width:${pct}%;background:${color}"></div></div>
    ${reasons.length ? `<ul class="findings">${reasons.map(r => `<li class="${r.lvl}"><span class="ic">${{bad:'🚩',warn:'⚠️',good:'✅'}[r.lvl]}</span><span>${r.t}</span></li>`).join('')}</ul>` : `<p class="muted">${label}.</p>`}`;
  save();
}
$('#profileForm').addEventListener('input', renderProfile);
$('#profileForm').addEventListener('change', renderProfile);

/* ================= QUICK CHECKS ================= */
function renderQuick() {
  const {name, city, job} = readProfile();
  const q = s => `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  const btns = [];
  if (name) {
    btns.push([`"${name}"${city ? ' ' + city : ''}`, q(`"${name}"${city ? ' ' + city : ''}`)]);
    if (job) btns.push([`"${name}" ${job}`, q(`"${name}" ${job}`)]);
    btns.push([`"${name}" scam / catfish reports`, q(`"${name}" (scam OR catfish OR "romance scam")`)]);
  }
  if (job && city) btns.push([`Is "${job}" a real job in ${city}?`, q(`${job} jobs ${city}`)]);
  btns.push(['Common romance scam scripts', q('romance scam common stories red flags')]);
  $('#quickBtns').innerHTML = btns.map(([l, u]) => `<a class="btn small ${l.startsWith('Common') ? 'ghost' : ''}" href="${u}" target="_blank" rel="noopener">🔎 ${esc(l)}</a>`).join('');
  $('#quickHint').hidden = !!name;
}
const POSES = ['Hold up 3 fingers next to your face and touch your nose with the other hand', 'Hold a paper with my first name and today\'s date written on it',
  'Touch your left ear with your right hand while winking', 'Give a thumbs-down with your left hand and point at the ceiling with the right',
  'Hold a spoon on top of your head', 'Show a peace sign upside down under your chin', 'Make an "OK" sign over one eye like a monocle',
  'Cover your mouth with one hand and hold up 4 fingers with the other', 'Hold your phone\'s clock (showing the time) next to your face in a mirror',
  'Put your hand flat on top of your head and stick your tongue out'];
$('#genPose').addEventListener('click', () => { $('#poseOut').textContent = '“' + POSES[Math.floor(Math.random() * POSES.length)] + '”'; });

/* ================= VERDICT ================= */
function renderVerdict() {
  const {score: prof, reasons: pr} = scoreProfile();
  const rev = $('input[name=rev]:checked').value, vid = $('input[name=vid]:checked').value;
  const done = photos.filter(p => !p.pending);
  const ai = done.reduce((m, p) => Math.max(m, p.aiScore), 0);
  const real = done.reduce((s, p) => s + p.realScore, 0);
  const reasons = [];
  let s = prof; // positive = suspicious
  if (pr.some(r => r.lvl === 'bad')) reasons.push(['bad', `Profile/behaviour red flags (score ${Math.max(0, prof)}): ${pr.filter(r => r.lvl === 'bad').length} serious.`]);
  else if (prof > 0) reasons.push(['warn', `Some behaviour flags (score ${prof}).`]);
  else if (pr.length) reasons.push(['good', 'No serious behaviour red flags ticked.']);
  if (ai >= 5) { s += 8; reasons.push(['bad', 'At least one photo has strong AI-generation markers in its metadata.']); }
  else if (ai >= 2) { s += 3; reasons.push(['warn', 'Some photos have weak AI hints (size/format). Not proof, so do a reverse search.']); }
  else if (done.length) reasons.push(['good', `${done.length} photo${done.length > 1 ? 's' : ''} checked: no AI markers found in the files.`]);
  if (real >= 2) { s -= 2; reasons.push(['good', 'Photo metadata looks like it came from a real camera/phone.']); }
  if (rev === 'other') { s += 10; reasons.push(['bad', 'Their photos appear online under a <strong>different name</strong>. This is the clearest catfish sign.']); }
  if (rev === 'model') { s += 8; reasons.push(['bad', 'Their photos come from a model / influencer / stock site.']); }
  if (rev === 'clean') { s -= 2; reasons.push(['good', 'Reverse image search didn\'t find the photos under someone else.']); }
  if (rev === 'none' && done.length) reasons.push(['warn', 'You haven\'t reported reverse image search results yet (below).']);
  if (vid === 'ok') { s -= 8; reasons.push(['good', 'You\'ve done a live video call that matched.']); }
  if (vid === 'glitchy') { s += 5; reasons.push(['bad', 'The video call felt off. Real-time face filters / deepfakes can cause this.']); }
  const hasData = done.length || pr.length || rev !== 'none' || vid !== 'none';
  let v;
  if (!hasData) v = ['', '🤔', 'Not enough info yet', 'Add photos, fill in the profile details, and come back here.'];
  else if (s >= 10 || rev === 'other' || ai >= 5) v = ['bad', '🚩', ai >= 5 && rev !== 'other' ? 'Likely AI or catfish' : 'Likely catfish', 'Strong warning signs. Don\'t send money or personal info. Ask for a live video call; a real person will do it.'];
  else if (s <= 0 && (vid === 'ok' || rev === 'clean')) v = ['good', '✅', 'Likely real', 'Nothing major stands out. Still take it slow and meet somewhere public.'];
  else v = ['warn', '⚠️', 'Unclear', 'Not enough to say either way. The fastest way to know: a live video call and a reverse image search.'];
  $('#verdictBox').innerHTML = `<div class="card verdict ${v[0]}"><div class="big">${v[1]}</div><h2>${v[2]}</h2><p>${v[3]}</p>
    ${reasons.length ? `<ul class="findings reasons">${reasons.map(([l, t]) => `<li class="${l}"><span class="ic">${{bad:'🚩',warn:'⚠️',good:'✅'}[l]}</span><span>${t}</span></li>`).join('')}</ul>` : ''}</div>`;
}
$$('#revResult input, #videoResult input').forEach(i => i.addEventListener('change', () => { renderVerdict(); save(); }));

/* ================= Persistence (profile answers only, on this device) ================= */
const KEY = 'catfish-check-v1';
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({p: readProfile(), rev: $('input[name=rev]:checked')?.value, vid: $('input[name=vid]:checked')?.value})); } catch {}
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (!d) return;
    const f = $('#profileForm');
    for (const [k, v] of Object.entries(d.p || {})) if (k !== 'flags' && f.elements[k]) f.elements[k].value = v;
    (d.p?.flags || []).forEach(id => { const el = f.elements['f_' + id]; if (el) el.checked = true; });
    if (d.rev) $(`input[name=rev][value=${d.rev}]`).checked = true;
    if (d.vid) $(`input[name=vid][value=${d.vid}]`).checked = true;
  } catch {}
}
$('#resetAll').addEventListener('click', () => {
  if (!confirm('Clear all photos and answers?')) return;
  localStorage.removeItem(KEY); photos.forEach(p => URL.revokeObjectURL(p.url)); photos.length = 0;
  $('#profileForm').reset(); $('input[name=rev][value=none]').checked = true; $('input[name=vid][value=none]').checked = true;
  renderPhotos(); renderProfile(); renderVerdict(); showTab('photos');
});

load(); renderProfile(); renderQuick();
// Expose for testing
window.__catfish = {photos, analyzePhoto, scoreProfile};
})();
