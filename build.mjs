import { mkdir, readFile, writeFile } from 'node:fs/promises';

const read = (relativePath, encoding) => readFile(new URL(relativePath, import.meta.url), encoding);
let html = await read('src/viewer-ui.html', 'utf8');
const slots = {
  NC_PARSER: 'viewer-parser.js',
  NC_RENDERER: 'render.js',
  NC_STOCK: 'viewer-stock.js',
  SOLID_MESH: 'solid-mesh.js',
  SOLID_CUTTER: 'solid-cutter.js',
  SOLID_RENDER: 'solid-render.js',
  NC_SOURCE: 'source-list.js',
  VIEWER_APP: 'viewer-app.js'
};
function inject(marker, content) {
  if (html.split(marker).length !== 2) throw new Error('Expected one template marker: ' + marker);
  html = html.replace(marker, () => content);
}
for (const [slot, file] of Object.entries(slots)) {
  const source = await read('src/' + file, 'utf8');
  if (/<\/script\s*>/i.test(source)) throw new Error('Unexpected closing script tag in ' + file);
  inject('/*__' + slot + '__*/', source);
}
inject('__NC_SAMPLE_BASE64__', (await read('examples/demo.nc')).toString('base64'));
await mkdir(new URL('docs/', import.meta.url), {recursive:true});
await writeFile(new URL('docs/index.html', import.meta.url), html);

