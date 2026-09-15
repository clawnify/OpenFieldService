// Build screenshot-based covers and recreated conceptual feature illustrations. Chrome capture is deliberately handled by
// TaskWindow; this script never attaches a second debugger or launches Chrome.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { conceptStyles, renderConcept, renderAssignment } from './feature-concepts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'screenshots/manifest.json'), 'utf8'));
const build = resolve(root, '.preview-build');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function local(path) {
  const result = resolve(root, path);
  if (!result.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`Path outside repository: ${path}`);
  return result;
}
function png(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Expected PNG: ${path}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes };
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shots = new Map();
for (const shot of manifest.screenshots) {
  if (![manifest.cover.light, manifest.cover.dark].includes(shot.id)) throw new Error(`Screenshot is not a cover source: ${shot.id}`);
  if (shots.has(shot.id) || !shot.alt || !shot.route) throw new Error(`Invalid screenshot entry: ${shot.id}`);
  const actual = png(local(shot.src));
  if (actual.width !== shot.width || actual.height !== shot.height) throw new Error(`Dimensions changed: ${shot.id}`);
  shots.set(shot.id, { ...shot, uri: `data:image/png;base64,${actual.bytes.toString('base64')}` });
}
const icon = `data:image/svg+xml;base64,${readFileSync(local('icon.svg')).toString('base64')}`;
const style = `
*{box-sizing:border-box}html,body{margin:0;width:1600px;height:1000px;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1b1a19;-webkit-font-smoothing:antialiased}
.brand{position:absolute;right:80px;top:65px;display:flex;align-items:center;gap:12px;font-size:20px;font-weight:600}
.brand img{width:34px;height:34px;border-radius:9px}.eyebrow{position:absolute;left:80px;top:76px;font-size:16px;letter-spacing:2px;font-weight:600}
h1{position:absolute;left:80px;top:142px;margin:0;font-size:66px;line-height:1.1;letter-spacing:-2.7px;font-weight:650}
.subtitle{position:absolute;left:82px;top:229px;margin:0;font-size:25px;color:#646360;line-height:1.4}
.footer{position:absolute;bottom:30px;left:80px;font-size:14px;color:#646360}
.cover-brand{position:absolute;left:80px;top:57px;display:flex;align-items:center;gap:17px}.cover-brand img{width:62px;height:62px;border-radius:16px}
.cover-brand h1{position:static;font-size:59px;letter-spacing:-2px}.cover .subtitle{top:145px;font-size:26px}
.cover .frame{position:absolute;left:80px;top:230px;width:1440px;height:680px;border-radius:15px;overflow:hidden;border:1px solid #1b1a1920;box-shadow:0 24px 70px -32px #1b1a1960}
.frame img{display:block;width:100%;height:auto}.dark{color:#efeeed}.dark .subtitle,.dark .footer{color:#b3b1ac}.dark .frame{border-color:#383733}
`;
const html = (title, body, background, classes = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title><style>${style}</style><body class="${classes}" style="background:${background}">${body}</body></html>`;
const coverStyles = `
.cover-upgrade{color:#222820}.cover-upgrade:before{content:"";position:absolute;left:520px;top:160px;width:1000px;height:830px;background:radial-gradient(ellipse,#d7e5db,transparent 70%)}
.cover-upgrade .cover-brand{left:80px;top:67px;gap:14px}.cover-upgrade .cover-brand img{width:46px;height:46px;border-radius:12px}.cover-upgrade .cover-brand h1{font-size:34px;letter-spacing:-1px}
.cover-upgrade .hero-copy{position:absolute;left:80px;top:292px;width:500px}.hero-copy h2{font-size:74px;line-height:1.04;letter-spacing:-3.4px;font-weight:650;margin:0;white-space:pre-line}.hero-copy p{font-size:24px;line-height:1.5;color:#697067;margin:28px 0 0;max-width:420px}
.cover-upgrade .frame{left:633px;top:235px;width:870px;height:580px;border:0;border-radius:20px;transform:rotate(-3deg);box-shadow:0 2px 3px #29362708,0 20px 40px -16px #29362730,0 45px 70px -38px #29362750}
.cover-upgrade .assignment-ui{left:990px;top:742px;width:470px;padding:25px 28px}.cover-upgrade .hero-meta{position:absolute;left:80px;bottom:74px;color:#587260;font-size:16px;letter-spacing:.2px}
.cover-upgrade.dark{color:#eef2eb}.cover-upgrade.dark:before{background:radial-gradient(ellipse,#2b4034,transparent 70%)}.cover-upgrade.dark .hero-copy p{color:#a6b2a7}.cover-upgrade.dark .hero-meta{color:#a2b8a8}.cover-upgrade.dark .frame{box-shadow:0 0 0 1px #364039,0 30px 70px -30px #0009}
.cover-upgrade.dark .assignment-ui{background:#222b24;border-color:#39443b;color:#eef2eb;box-shadow:0 0 0 1px #364039,0 20px 35px -18px #0009}.cover-upgrade.dark .muted,.cover-upgrade.dark .label{color:#a6b2a7}.cover-upgrade.dark .avatar,.cover-upgrade.dark .checkmark{background:#354a3a;color:#b7d4bb}
`;
const outputs = [];
for (const theme of ['light', 'dark']) {
  const shot = shots.get(manifest.cover[theme]);
  if (!shot || shot.theme !== theme) throw new Error(`Cover requires a real ${theme} screenshot`);
  outputs.push({ id: `cover-${theme}`, src: theme === 'light' ? 'readme-banner.png' : 'readme-banner-dark.png', width: 1600, height: 1000,
    title: manifest.cover.title, alt: `${manifest.cover.title} — ${manifest.cover.subtitle}`, theme,
    html: html(`${manifest.cover.title} cover`, `<style>${conceptStyles}${coverStyles}</style><div class="cover-brand"><img src="${icon}" alt=""><h1>${escape(manifest.cover.title)}</h1></div><div class="hero-copy"><h2>${escape(manifest.cover.headline)}</h2><p>${escape(manifest.cover.subtitle)}</p></div><div class="frame"><img src="${shot.uri}" alt="${escape(shot.alt)}"></div>${renderAssignment()}<div class="hero-meta">Open source · Self-hostable</div>`, theme === 'dark' ? '#141c17' : '#eef2ed', `cover cover-upgrade ${theme}`),
  });
}
for (const feature of manifest.features) {
  for (const source of feature.sources) {
    if (!existsSync(local(source))) throw new Error(`Missing feature source: ${source}`);
  }
  const panels = renderConcept(feature.id);
  outputs.push({ id: feature.id, src: `previews/${feature.id}.png`, width: 1600, height: 1000, title: feature.title, alt: feature.alt, theme: 'light',
    html: html(feature.title, `<style>${conceptStyles}</style><div class="brand"><img src="${icon}" alt="">OpenFieldService</div><div class="eyebrow">${escape(feature.eyebrow)}</div><div class="copy"><h1>${escape(feature.title)}</h1><p>${escape(feature.subtitle)}</p></div>${panels}`, feature.background, `concept ${feature.id}`),
  });
}
const [command = 'build', id, source] = process.argv.slice(2);
if (command === 'build') {
  mkdirSync(build, { recursive: true });
  for (const output of outputs) writeFileSync(resolve(build, `${output.id}.html`), output.html);
  const cards = outputs.map(o => `<a href="${o.id}.html"><iframe src="${o.id}.html" title="${escape(o.title)}" width="1600" height="1000" tabindex="-1"></iframe><span>${escape(o.id)}</span></a>`).join('');
  writeFileSync(resolve(build, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Preview review</title><style>body{margin:24px;background:#ddd;font:16px system-ui;display:grid;grid-template-columns:repeat(2,640px);gap:24px}a{height:430px;position:relative;color:#111}iframe{border:0;transform:scale(.4);transform-origin:top left;pointer-events:none}span{position:absolute;top:407px;left:0}</style>${cards}</html>`);
  console.log('Serve .preview-build on localhost. Capture each HTML at 1600×1000 with TaskWindow, then run: node scripts/build-previews.mjs import <id> <saved-png>');
} else if (command === 'import') {
  const output = outputs.find(o => o.id === id);
  if (!output || !source) throw new Error('Usage: import <output id> <TaskWindow PNG path>');
  if (readFileSync(resolve(build, `${id}.html`), 'utf8') !== output.html) throw new Error('Composition changed. Rebuild and recapture before importing.');
  const actual = png(resolve(source));
  if (actual.width !== output.width || actual.height !== output.height) throw new Error(`Expected ${output.width}×${output.height}; got ${actual.width}×${actual.height}`);
  mkdirSync(dirname(local(output.src)), { recursive: true });
  copyFileSync(resolve(source), local(output.src));
  const receiptPath = local('previews/receipts.json');
  const receipts = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')) : {};
  receipts[id] = { composition: sha(output.html), png: sha(actual.bytes) };
  writeFileSync(receiptPath, JSON.stringify(receipts, null, 2) + '\n');
  console.log(`Saved ${output.src}`);
} else if (command === 'check' || command === 'export') {
  const receipts = JSON.parse(readFileSync(local('previews/receipts.json'), 'utf8'));
  for (const output of outputs) {
    const actual = png(local(output.src));
    if (actual.width !== output.width || actual.height !== output.height || receipts[output.id]?.composition !== sha(output.html) || receipts[output.id]?.png !== sha(actual.bytes)) throw new Error(`Stale output: ${output.id}. Rebuild and capture again.`);
  }
  const catalogue = new Map(outputs.filter(entry => manifest.features.some(feature => feature.id === entry.id)).map(entry => [entry.id, entry]));
  const images = manifest.carousel.map(id => {
    const entry = catalogue.get(id);
    if (!entry) throw new Error(`Unknown carousel image: ${id}`);
    return { src: entry.src, alt: entry.alt, caption: entry.title.replaceAll('\n', ' '), width: entry.width, height: entry.height };
  });
  if (command === 'export') {
    // Existing website AppImage[] contract. Prefix these repo-relative paths
    // after copying assets, or resolve against a pinned GitHub commit URL.
    writeFileSync(local('previews/website-gallery.json'), JSON.stringify(images, null, 2) + '\n');
  } else if (readFileSync(local('previews/website-gallery.json'), 'utf8') !== JSON.stringify(images, null, 2) + '\n') {
    throw new Error('Stale website gallery. Run previews:export.');
  }
  console.log(`${shots.size} source screenshots and ${outputs.length} compositions verified; ${images.length} carousel images.`);
} else throw new Error('Expected build, import, check or export');
