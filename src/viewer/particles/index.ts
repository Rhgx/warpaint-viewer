import * as THREE from 'three';
import type { UnusualSystemDef } from './parse';
import { ControlPoint, SystemInstance } from './sim';
import type { AttachmentAnchor, AttachmentsJson } from './util';
import { DEFAULT_ATTACHMENT_QUAT, loadParticleIndex, parseAttachmentEntry } from './util';

export { setParticlePointScale } from './sim';
export { loadParticleIndex, loadParticleTexture } from './util';

// ---------------------------------------------------------------------------
// Unusual weapon effects
//
// A CPU port of the four weapon_unusual_* particle systems
// (attribute_controlled_attached_particles 701-704), driven by their
// extracted PCF definitions. Semantics follow the Source particle library
// (public/particles/particles.h attribute model, Alien Swarm SDK operator
// lineage): particles simulate in WORLD space while control points follow
// the weapon's attachments (PATTACH_POINT_FOLLOW in
// CEconEntity::UpdateSingleParticleSystem), which is what makes the effects
// lag and swirl when the weapon moves.
// ---------------------------------------------------------------------------

export interface UnusualEffect {
  object: THREE.Object3D;
  // Re-anchors control points from the weapon's current world transform
  // (centerGroup.matrixWorld); called by the Viewer every frame before
  // update(dt).
  updateAnchor(matrix: THREE.Matrix4): void;
  update(dt: number): void;
  // Flags the next update() as following an instant transform snap (a
  // view-angle preset or reset), so it rigidly carries every alive particle
  // and control point to the new anchor instead of reading the jump as one
  // frame of extreme control-point velocity.
  notifyTeleport(): void;
  dispose(): void;
}

const KNOWN_EFFECT_IDS = new Set(['hot', 'isotope', 'cool', 'energy_orb']);

// A pre-resolved (effect, weapon) bundle: the system name the game actually
// spawns for that pair (see the removed runtime selectSystemName(), now baked in
// at build time by tools/repack-unusuals.mjs / tools/extract-effects.mjs) plus
// its transitive children, copied verbatim from the source PCF data.
export interface UnusualBundle {
  root: string;
  systems: Record<string, UnusualSystemDef>;
}

// Fetched once per (effect, weapon) pair and shared across every effect
// instance/rebuild of that pair.
const unusualBundlePromises = new Map<string, Promise<UnusualBundle>>();
function loadUnusualBundle(effectId: string, weaponKey: string): Promise<UnusualBundle> {
  const key = `${effectId}/${weaponKey}`;
  let promise = unusualBundlePromises.get(key);
  if (!promise) {
    const base = import.meta.env.BASE_URL;
    promise = fetch(`${base}data/effects/unusuals/${effectId}/${weaponKey}.json`).then((r) => {
      if (!r.ok) throw new Error(`unusual bundle "${key}" fetch failed: ${r.status}`);
      return r.json() as Promise<UnusualBundle>;
    });
    unusualBundlePromises.set(key, promise);
  }
  return promise;
}

let attachmentsJsonPromise: Promise<AttachmentsJson> | null = null;
function loadAttachmentsJson(): Promise<AttachmentsJson> {
  if (!attachmentsJsonPromise) {
    const base = import.meta.env.BASE_URL;
    attachmentsJsonPromise = fetch(`${base}data/effects/attachments.json`).then((r) => {
      if (!r.ok) throw new Error(`attachments.json fetch failed: ${r.status}`);
      return r.json() as Promise<AttachmentsJson>;
    });
  }
  return attachmentsJsonPromise;
}

// createUnusualEffect returns immediately (a Group that starts empty) and
// populates itself once the (module-cached) unusual bundle, attachment data, and
// any per-system sprite textures resolve. modelCenter is the model's
// bounding-box center in GEOMETRY space (raw, uncentered), used as a fallback
// control point for weapons/systems with no matching attachment entry. The
// returned Group must sit at the SCENE ROOT with an identity transform:
// particles simulate in world space, and updateAnchor() re-derives the
// control points from the weapon's current world matrix every frame.
export function createUnusualEffect(
  id: string,
  radius: number,
  weaponKey: string,
  modelCenter: THREE.Vector3,
): UnusualEffect | null {
  if (id === 'none') return null;
  if (!KNOWN_EFFECT_IDS.has(id)) return null;

  const group = new THREE.Group();
  let root: SystemInstance | null = null;
  let disposed = false;

  const fallbackAnchor: AttachmentAnchor = { pos: modelCenter.clone(), quat: DEFAULT_ATTACHMENT_QUAT.clone() };
  const anchoredCps = new Map<number, ControlPoint>();
  const dynamicCps: ControlPoint[] = [];
  const anchorMatrix = new THREE.Matrix4();
  const anchorQuat = new THREE.Quaternion();
  let anchorDirty = true;

  // Teleport handling: a view-angle preset or reset moves the weapon's whole
  // transform in a single frame. Left alone, ControlPoint.beginFrame would
  // read that as one tick of enormous velocity and fling every lock/
  // velocityInherit particle. prevAnchorMatrix holds the anchor as of the end
  // of the last tick; pendingTeleport is the explicit flag from
  // notifyTeleport(), consumed (and cleared) on the next update().
  const prevAnchorMatrix = new THREE.Matrix4();
  let prevAnchorValid = false;
  let pendingTeleport = false;
  const teleportDeltaM = new THREE.Matrix4();
  const teleportInvPrev = new THREE.Matrix4();
  const teleportDeltaQuat = new THREE.Quaternion();
  const teleportPos = new THREE.Vector3();
  const teleportQuat = new THREE.Quaternion();
  const teleportScale = new THREE.Vector3();
  const teleportPrevPos = new THREE.Vector3();
  const teleportPrevQuat = new THREE.Quaternion();
  const TELEPORT_DIST = 20; // world units in one frame
  const TELEPORT_ANGLE = THREE.MathUtils.degToRad(45);

  Promise.all([loadUnusualBundle(id, weaponKey), loadAttachmentsJson(), loadParticleIndex()])
    .then(([bundle, attachments, particleIndex]) => {
      if (disposed) return;
      const systemName = bundle.root;
      const weaponAttachments = attachments[weaponKey] ?? {};

      const anchoredCp = (index: number): ControlPoint => {
        let cp = anchoredCps.get(index);
        if (!cp) {
          const anchor = parseAttachmentEntry(weaponAttachments[`unusual_${index}`])
            ?? parseAttachmentEntry(weaponAttachments.unusual_0)
            ?? { pos: fallbackAnchor.pos.clone(), quat: fallbackAnchor.quat.clone() };
          cp = new ControlPoint(anchor);
          cp.setFromAnchorMatrix(anchorMatrix, anchorQuat);
          // Anchored CPs are created lazily on first use, which happens
          // mid-tick (after this frame's beginFrame pass): prime the
          // prev-frame state so same-tick Movement Lock sees zero motion.
          cp.prime();
          anchoredCps.set(index, cp);
        }
        return cp;
      };
      const getCp = (index: number, forSystem: SystemInstance): ControlPoint => {
        return forSystem.cpOverrides.get(index) ?? anchoredCp(index);
      };
      const createDynamicCp = (index: number): ControlPoint => {
        const src = anchoredCp(index);
        const cp = new ControlPoint(null);
        cp.worldPos.copy(src.worldPos);
        cp.worldQuat.copy(src.worldQuat);
        cp.prime();
        dynamicCps.push(cp);
        return cp;
      };

      const build = (name: string, visited: Set<string>): SystemInstance | null => {
        if (visited.has(name)) return null;
        visited.add(name);
        const sysDef = bundle.systems[name];
        if (!sysDef) return null;
        const instance = new SystemInstance(name, sysDef, radius, getCp, createDynamicCp, particleIndex);
        for (const childName of sysDef.children) {
          const child = build(childName, visited);
          if (child) instance.children.push(child);
        }
        return instance;
      };

      const built = build(systemName, new Set());
      if (!built || disposed) {
        built?.dispose();
        return;
      }
      root = built;
      const attach = (sys: SystemInstance) => {
        if (sys.points) group.add(sys.points);
        for (const child of sys.children) attach(child);
      };
      attach(root);
    })
    .catch((err) => {
      console.warn('[warpaint-viewer] unusual effect data failed to load:', err);
    });

  return {
    object: group,
    updateAnchor(matrix: THREE.Matrix4) {
      anchorMatrix.copy(matrix);
      anchorQuat.setFromRotationMatrix(matrix);
      anchorDirty = true;
    },
    notifyTeleport() {
      pendingTeleport = true;
    },
    update(dt: number) {
      if (disposed || !root) return;
      if (anchorDirty) {
        for (const cp of anchoredCps.values()) cp.setFromAnchorMatrix(anchorMatrix, anchorQuat);
        anchorDirty = false;
      }

      let teleport = pendingTeleport;
      pendingTeleport = false;
      if (prevAnchorValid && !teleport) {
        prevAnchorMatrix.decompose(teleportPrevPos, teleportPrevQuat, teleportScale);
        anchorMatrix.decompose(teleportPos, teleportQuat, teleportScale);
        const distMoved = teleportPos.distanceTo(teleportPrevPos);
        const angleMoved = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(teleportPrevQuat.dot(teleportQuat)), -1, 1));
        if (distMoved > TELEPORT_DIST || angleMoved > TELEPORT_ANGLE) teleport = true;
      }

      if (teleport && prevAnchorValid) {
        // Rigidly carry every alive particle (and any dynamic CP tracking
        // last frame's particle positions) from the old anchor to the new
        // one; anchored CPs already read the new anchor above, so they only
        // need re-priming below.
        teleportInvPrev.copy(prevAnchorMatrix).invert();
        teleportDeltaM.copy(anchorMatrix).multiply(teleportInvPrev);
        teleportDeltaQuat.setFromRotationMatrix(teleportDeltaM);
        root.applyRigidTransform(teleportDeltaM, teleportDeltaQuat);
        for (const cp of dynamicCps) {
          cp.worldPos.applyMatrix4(teleportDeltaM);
          cp.worldQuat.premultiply(teleportDeltaQuat);
        }
      }

      if (teleport) {
        // Prime every CP (anchored and dynamic) to its NEW pose so this
        // frame's beginFrame computes zero delta/velocity instead of a
        // one-tick impulse from the jump.
        for (const cp of anchoredCps.values()) cp.prime();
        for (const cp of dynamicCps) cp.prime();
      }

      prevAnchorMatrix.copy(anchorMatrix);
      prevAnchorValid = true;

      for (const cp of anchoredCps.values()) cp.beginFrame(dt);
      for (const cp of dynamicCps) cp.beginFrame(dt);
      root.update(dt);
      for (const cp of anchoredCps.values()) cp.endFrame();
      for (const cp of dynamicCps) cp.endFrame();
    },
    dispose() {
      disposed = true;
      root?.dispose();
      root = null;
    },
  };
}
