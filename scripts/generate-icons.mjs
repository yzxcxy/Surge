import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/icon.svg', import.meta.url), 'utf8');
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect x="43" y="31" width="106" height="130" rx="22" fill="#252521"/>
  <path d="M61 31h88v77l-43 43H61a18 18 0 0 1-18-18V49a18 18 0 0 1 18-18Z" fill="#FFFDF8"/>
  <path d="M106 151v-27a16 16 0 0 1 16-16h27Z" fill="#FFBF28"/>
  <path d="M64 63h62M64 84h47" stroke="#252521" stroke-width="8" stroke-linecap="round"/>
</svg>`;
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(densities)) {
  const dir = new URL(`../android/app/src/main/res/mipmap-${density}/`, import.meta.url);
  const render = svg => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(new URL('ic_launcher.png', dir), render(source));
  writeFileSync(new URL('ic_launcher_round.png', dir), render(source));
  writeFileSync(new URL('ic_launcher_foreground.png', dir), render(foreground));
}
