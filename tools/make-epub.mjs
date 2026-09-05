/*
 * Build the sample book the reader preview opens:
 *
 *     node tools/make-epub.mjs tools/sample.epub
 *
 * Two chapters, ruby over the kanji, one file in a subdirectory, and deflated
 * entries, so the reader's own unzipping and its stripping of furigana are
 * both really exercised rather than assumed.
 */
import { writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';

const files = [
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
  ['OEBPS/one.xhtml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' +
    '<h1>第一章</h1>' +
    '<p><ruby>種<rt>たね</rt></ruby>がある。</p>' +
    '<p>単子葉植物の一つの科である。</p>' +
    '</body></html>'],
  ['OEBPS/text/two.xhtml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' +
    '<h2>第二章</h2><p>すごいですね。</p><p>猫です。</p></body></html>']
];

const parts = [];
const central = [];
let offset = 0;

for (const [name, text] of files) {
  const nameBytes = Buffer.from(name, 'utf8');
  const raw = Buffer.from(text, 'utf8');
  const stored = name === 'mimetype';
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
console.log('wrote ' + process.argv[2]);
