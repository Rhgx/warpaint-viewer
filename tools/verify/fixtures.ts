import fs from 'node:fs';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';

export async function fixtureFragments(filePath: string): Promise<Array<{ name: string; text: string }>> {
  const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(filePath)])));
  try {
    const entries = await reader.getEntries();
    return await Promise.all(entries
      .filter((entry) => !entry.directory && 'getData' in entry && entry.filename.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        if (!('getData' in entry)) throw new Error(`Fixture entry ${entry.filename} cannot be read.`);
        return { name: entry.filename, text: await entry.getData(new TextWriter()) };
      }));
  } finally {
    await reader.close();
  }
}

export function fixturePaintkitIds(value: unknown): number[] {
  if (!value || typeof value !== 'object' || !('paintkits' in value) || !Array.isArray(value.paintkits)) return [];
  return value.paintkits.flatMap((kit) => (
    kit && typeof kit === 'object' && 'id' in kit && typeof kit.id === 'number' ? [kit.id] : []
  ));
}

