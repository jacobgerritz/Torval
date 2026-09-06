/*
 * Build the sample books the reader preview opens:
 *
 *     node tools/make-epub.mjs tools/sample.epub plain
 *     node tools/make-epub.mjs tools/sample-awkward.epub awkward
 *
 * Two books, because a reader that works on a tidy one proves very little.
 *
 * plain    what an epub looks like when everything goes right: EPUB 3, a
 *          heading in every chapter, ruby over the kanji, one file in a
 *          subdirectory, everything deflated.
 *
 * awkward  what they look like in the wild. EPUB 2, so the chapter names live
 *          in a toc.ncx and nowhere else. No headings in the text. Paragraphs
 *          wrapped in a blockquote, which is two blocks around one piece of
 *          text. A chapter built out of bare divs, and another out of nothing
 *          but line breaks. A filename with a space in it, so the spine has to
 *          be un-escaped. One chapter stored rather than deflated. A cover
 *          marked linear="no" with no words in it.
 */
import { writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';

const xhtml = (body) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' +
  body + '</body></html>';

const BOOKS = {
  plain: [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml',
      '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/content.opf',
      '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>種の話</dc:title><dc:identifier id="id">x</dc:identifier></metadata>' +
      '<manifest><item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'],
    ['OEBPS/one.xhtml', xhtml(
      '<h1>第一章</h1>' +
      '<p><ruby>種<rt>たね</rt></ruby>がある。</p>' +
      '<p>単子葉植物の一つの科である。</p>')],
    ['OEBPS/text/two.xhtml', xhtml('<h2>第二章</h2><p>すごいですね。</p><p>猫です。</p>')]
  ],

  awkward: [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml',
      '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="content/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['content/package.opf',
      '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>むかしの話</dc:title>' +
      '<dc:identifier id="id">y</dc:identifier></metadata>' +
      '<manifest>' +
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
      '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c1" href="pages/chapter one.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="pages/two.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c3" href="pages/three.xhtml" media-type="application/xhtml+xml"/>' +
      '</manifest>' +
      '<spine toc="ncx">' +
      '<itemref idref="cover" linear="no"/>' +
      '<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>' +
      '</spine></package>'],
    ['content/toc.ncx',
      '<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
      '<navMap>' +
      '<navPoint id="n1" playOrder="1"><navLabel><text>はじめに</text></navLabel>' +
      '<content src="pages/chapter%20one.xhtml"/></navPoint>' +
      '<navPoint id="n2" playOrder="2"><navLabel><text>второй</text></navLabel>' +
      '<content src="pages/two.xhtml#top"/></navPoint>' +
      '</navMap></ncx>'],
    // A cover with a picture and no words in it. Nothing to read, so nothing
    // should be listed for it.
    ['content/cover.xhtml', xhtml('<div><img src="cover.jpg" alt=""/></div>')],
    // Paragraphs inside a blockquote: two blocks around one piece of text.
    ['content/pages/chapter one.xhtml', xhtml(
      '<div class="body"><blockquote><p>種がある。</p><p>猫です。</p></blockquote></div>')],
    // Nothing but divs, which is how a great many real books are built.
    ['content/pages/two.xhtml', xhtml(
      '<div class="page"><div class="para">すごいですね。</div><div class="para">本を読みました。</div></div>')],
    // And nothing but line breaks.
    ['content/pages/three.xhtml', xhtml('今日は暑いですね。<br/>台湾に行きました。<br/>')]
  ]
};

const shape = process.argv[3] || 'plain';
const files = BOOKS[shape];
if (!files) {
  console.error('no such book: ' + shape + ' (try ' + Object.keys(BOOKS).join(' or ') + ')');
  process.exit(1);
}

const parts = [];
const central = [];
let offset = 0;

for (const [name, text] of files) {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.from(text, 'utf8');
  // The mimetype has to be stored rather than deflated, and one chapter is
  // stored as well so that the reader is made to handle both.
  const stored = name === 'mimetype' || name.endsWith('three.xhtml');
  const body = stored ? raw : deflateRawSync(raw);
  const sum = typeof crc32 === 'function' ? crc32(raw) : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(stored ? 0 : 8, 8);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  parts.push(local, nameBytes, body);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(stored ? 0 : 8, 10);
  entry.writeUInt32LE(sum, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(raw.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBytes);

  offset += local.length + nameBytes.length + body.length;
}

const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

writeFileSync(process.argv[2], Buffer.concat([Buffer.concat(parts), directory, end]));
console.log('wrote ' + process.argv[2] + ' (' + shape + ')');
