import { describe, expect, test } from 'vitest';
import { writeVpk } from '../../src/export/vpkWrite';
import { openVpkPackage } from '../../src/source/vpk';

const VPK_HEADER_SIZE = 28;

function fillPattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 2654435761) % 256;
  return bytes;
}

const files = [
  { path: 'readme.txt', data: new TextEncoder().encode('root file at the archive root') },
  { path: 'Materials/Patterns/MyPaint/Deep/Nested/Path/base.vtf', data: fillPattern(4096) },
  { path: 'materials/patterns/mypaint/base_normal.vtf', data: fillPattern(2048) },
  { path: 'materials/patterns/mypaint/base.vmt', data: new TextEncoder().encode('"vertexlitgeneric" { }') },
  { path: 'materials/patterns/mypaint/large.vtf', data: fillPattern(256 * 1024) },
];

describe('VPK writer', () => {
  test('round-trips every entry through the production reader', async () => {
    const bytes = writeVpk(files);
    const fileBytes = new Uint8Array(bytes.byteLength);
    fileBytes.set(bytes);
    const source = new File([fileBytes.buffer], 'warpaint_export_dir.vpk');
    const pkg = await openVpkPackage([source]);

    expect(pkg.entries.size).toBe(files.length);
    for (const file of files) {
      const normalized = file.path.replace(/\\/g, '/').toLowerCase();
      expect(pkg.has(normalized)).toBe(true);
      expect(await pkg.read(normalized)).toEqual(file.data);
    }
  });

  test('is deterministic and writes a valid version 2 header', () => {
    const bytes = writeVpk(files);
    expect(writeVpk(files)).toEqual(bytes);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const treeSize = view.getUint32(8, true);
    const expectedDataSize = files.reduce((sum, file) => sum + file.data.byteLength, 0);
    expect(view.getUint32(0, true)).toBe(0x55aa1234);
    expect(view.getUint32(4, true)).toBe(2);
    expect(treeSize).toBeGreaterThan(0);
    expect(treeSize).toBeLessThan(bytes.byteLength);
    expect(bytes.byteLength).toBe(VPK_HEADER_SIZE + treeSize + expectedDataSize);
    expect(view.getUint32(12, true)).toBe(expectedDataSize);
    expect(view.getUint32(16, true)).toBe(0);
    expect(view.getUint32(20, true)).toBe(0);
    expect(view.getUint32(24, true)).toBe(0);
    expect(writeVpk([]).byteLength).toBe(VPK_HEADER_SIZE + 1);
  });

  test.each([
    ['file with no extension', [{ path: 'materials/noextension', data: new Uint8Array(1) }]],
    ['dotfile with no stem', [{ path: 'materials/.vtf', data: new Uint8Array(1) }]],
    ['duplicate normalized path', [
      { path: 'Materials/Foo.VTF', data: new Uint8Array(1) },
      { path: 'materials/foo.vtf', data: new Uint8Array(2) },
    ]],
    ['path traversal', [{ path: 'materials/../evil.vtf', data: new Uint8Array(1) }]],
    ['absolute path', [{ path: '/materials/evil.vtf', data: new Uint8Array(1) }]],
    ['empty path', [{ path: '', data: new Uint8Array(1) }]],
  ])('rejects %s', (_label, entries) => {
    expect(() => writeVpk(entries)).toThrow();
  });
});
