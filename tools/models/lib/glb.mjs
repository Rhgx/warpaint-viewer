// Minimal glTF 2.0 binary (GLB) writer. No external deps.
// Supports interleaved-free layout: one buffer, separate bufferViews per accessor.

const COMPONENT = {
  FLOAT: 5126,
  UNSIGNED_INT: 5125,
  UNSIGNED_SHORT: 5123,
};
const TARGET = { ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963 };

function align4(n) {
  return (n + 3) & ~3;
}

// Build a GLB Buffer (Node Buffer) from a scene description.
// primitives: [{ material: <index>, positions:Float32Array, normals:Float32Array,
//                uvs:Float32Array, indices:Uint32Array }]
// materials: [{ name }]
export function buildGLB({ primitives, materials, meta }) {
  const bin = [];       // list of { data: Buffer, byteOffset }
  let binLength = 0;
  const bufferViews = [];
  const accessors = [];

  function pushView(typedArray, target) {
    const buf = Buffer.from(
      typedArray.buffer,
      typedArray.byteOffset,
      typedArray.byteLength,
    );
    const byteOffset = binLength;
    bin.push({ data: buf, byteOffset });
    const view = {
      buffer: 0,
      byteOffset,
      byteLength: buf.byteLength,
    };
    if (target) view.target = target;
    bufferViews.push(view);
    binLength = align4(binLength + buf.byteLength);
    return bufferViews.length - 1;
  }

  const gltfPrimitives = [];
  for (const p of primitives) {
    const count = p.positions.length / 3;

    // POSITION accessor with min/max
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.positions.length; i += 3) {
      const x = p.positions[i], y = p.positions[i + 1], z = p.positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const posView = pushView(p.positions, TARGET.ARRAY_BUFFER);
    accessors.push({
      bufferView: posView,
      componentType: COMPONENT.FLOAT,
      count,
      type: 'VEC3',
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });
    const posAcc = accessors.length - 1;

    const nrmView = pushView(p.normals, TARGET.ARRAY_BUFFER);
    accessors.push({
      bufferView: nrmView,
      componentType: COMPONENT.FLOAT,
      count,
      type: 'VEC3',
    });
    const nrmAcc = accessors.length - 1;

    const uvView = pushView(p.uvs, TARGET.ARRAY_BUFFER);
    accessors.push({
      bufferView: uvView,
      componentType: COMPONENT.FLOAT,
      count,
      type: 'VEC2',
    });
    const uvAcc = accessors.length - 1;

    const idxView = pushView(p.indices, TARGET.ELEMENT_ARRAY_BUFFER);
    accessors.push({
      bufferView: idxView,
      componentType: COMPONENT.UNSIGNED_INT,
      count: p.indices.length,
      type: 'SCALAR',
    });
    const idxAcc = accessors.length - 1;

    gltfPrimitives.push({
      attributes: { POSITION: posAcc, NORMAL: nrmAcc, TEXCOORD_0: uvAcc },
      indices: idxAcc,
      material: p.material,
      mode: 4, // TRIANGLES
    });
  }

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'mdl2gltf (warpaint-viewer)',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: meta?.name || 'model' }],
    meshes: [{ primitives: gltfPrimitives, name: meta?.name || 'model' }],
    materials: materials.map((m) => ({ name: m.name })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  if (meta?.extras) gltf.meshes[0].extras = meta.extras;

  // Assemble BIN chunk
  const binChunk = Buffer.alloc(binLength);
  for (const b of bin) b.data.copy(binChunk, b.byteOffset);

  // JSON chunk
  let jsonStr = JSON.stringify(gltf);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const jsonPadded = Buffer.alloc(align4(jsonBuf.length), 0x20); // pad with spaces
  jsonBuf.copy(jsonPadded);

  const binPadded = Buffer.alloc(align4(binChunk.length), 0x00);
  binChunk.copy(binPadded);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4); // version
  const totalLength = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.write('JSON', 4, 'ascii');

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.write('BIN\0', 4, 'ascii');

  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
}
