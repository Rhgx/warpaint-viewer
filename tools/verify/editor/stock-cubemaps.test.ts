import assert from 'node:assert/strict';
import { test } from 'vitest';
import stockCubemaps from '../../../src/viewer/stockCubemaps.generated.json';
import {
  isStockMaterialCubemap,
  materialCubemapIdentity,
  stockMaterialCubemapUrls,
} from '../../../src/viewer/env';

test('stock material cubemap manifest and Source aliases', () => {
  assert.deepEqual(Object.keys(stockCubemaps), [
    'cubemaps/cubemap_gold001',
    'cubemaps/cubemap_shapes002',
    'cubemaps/cubemap_sheen001',
    'cubemaps/cubemap_sheen002',
    'cubemaps/cubemap_specular001',
    'cubemaps/cubemap_specular002',
    'cubemaps/cubemap_sunset001',
  ]);
  assert.equal(materialCubemapIdentity('Materials\\Cubemaps\\Cubemap_Gold001.HDR.VTF'), 'cubemaps/cubemap_gold001');
  assert.equal(isStockMaterialCubemap('textures/cubemaps/cubemap_specular002.webp'), true);
  assert.equal(isStockMaterialCubemap('env_cubemap'), true);
  assert.equal(isStockMaterialCubemap('cubemaps/missing'), false);

  const urls = stockMaterialCubemapUrls('cubemaps\\cubemap_sunset001.vtf');
  assert.equal(urls?.length, 6);
  assert.match(urls?.[0] ?? '', /material-cubemaps\/cubemap_sunset001\/px\.png$/);
  assert.match(stockMaterialCubemapUrls('editor/cubemap')?.[0] ?? '', /env\/editor-cubemap\/px\.png$/);
  assert.equal(stockMaterialCubemapUrls('env_cubemap'), null);
  assert.equal(stockMaterialCubemapUrls('cubemaps/missing'), null);
});
