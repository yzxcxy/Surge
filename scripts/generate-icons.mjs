import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

// The square source is also the foreground of the Android adaptive icon.
// Android masks its outer area, keeping the paper mark in the safe zone.
const image = readFileSync(new URL('../web/icon-source.png', import.meta.url)).toString('base64');
const source = `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108"><image width="108" height="108" href="data:image/png;base64,${image}"/></svg>`;
const render = size => new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();

for (const size of [192, 512]) {
  writeFileSync(new URL(`../web/icon-${size}.png`, import.meta.url), render(size));
}

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(densities)) {
  const dir = new URL(`../android/app/src/main/res/mipmap-${density}/`, import.meta.url);
  const icon = render(size);
  writeFileSync(new URL('ic_launcher.png', dir), icon);
  writeFileSync(new URL('ic_launcher_round.png', dir), icon);
  writeFileSync(new URL('ic_launcher_foreground.png', dir), render(size * 108 / 48));
}
