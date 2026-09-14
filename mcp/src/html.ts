import { parse, type DefaultTreeAdapterMap } from 'parse5';

const tags = new Set('html head body meta title style h1 h2 h3 h4 h5 h6 main header footer section article aside div span p a ul ol li strong em b i table caption colgroup col thead tbody tfoot tr th td code pre blockquote hr br dl dt dd small sup sub'.split(' '));
const attributes = new Set('class id lang charset name content style href target rel colspan rowspan scope media'.split(' '));
function validateCss(css: string): void {
  if (/url\s*\(|@import|expression\s*\(|behavior\s*:|-moz-binding|image-set\s*\(|https?:|data:|\/\/|\\/i.test(css)) throw new Error('Printable HTML CSS must not contain remote assets, imports, executable expressions, or escaped CSS.');
}
/** Reject active or fetching HTML instead of trying to sanitize arbitrary HTML. */
export function validatePrintableHtml(html: string): void {
  const document = parse(html);
  function visit(node: DefaultTreeAdapterMap['node']): void {
    if ('tagName' in node) {
      if (!tags.has(node.tagName)) throw new Error(`Printable HTML contains unsupported element: ${node.tagName}. Use static teaching text, tables, and CSS only.`);
      for (const attr of node.attrs) {
        if (!attributes.has(attr.name) || attr.namespace) throw new Error(`Printable HTML contains unsupported attribute: ${attr.name}.`);
        if (attr.name === 'href') {
          const href = attr.value;
          let safe = /^(#[^\s\\]*|\/(?!\/)[^\s\\]*)$/.test(href);
          if (href.startsWith('https://')) { try { const parsed = new URL(href); safe = !parsed.username && !parsed.password; } catch { safe = false; } }
          if (node.tagName !== 'a' || !safe) throw new Error('Printable HTML links must be HTTPS, a fragment, or a site-relative path.');
        }
        if (attr.name === 'style') validateCss(attr.value);
      }
      if (node.tagName === 'style') for (const child of node.childNodes) if ('value' in child) validateCss(child.value);
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  }
  visit(document);
}
