import * as THREE from 'three';
import type { UnusualSystemDef } from './parse';
import { ControlPoint, SystemInstance } from './sim';
import type { AttachmentAnchor, AttachmentsJson, HitboxesJson } from './util';
import { DEFAULT_ATTACHMENT_QUAT, loadHitboxes, loadParticleIndex, parseAttachmentEntry } from './util';

export { setParticlePointScale } from './sim';

// Unusual weapon effects: a CPU port of the weapon unusual particle systems, driven by the
// extracted PCF definitions. Particles simulate in WORLD space while control points follow
// the weapon's attachments (PATTACH_POINT_FOLLOW), which is why effects lag and swirl.

export type AttachmentTransformResolver = (
  index: number,
  attachment: AttachmentAnchor,
  target: THREE.Matrix4,
) => boolean;

export interface UnusualEffect {
  object: THREE.Object3D;
  // Re-anchors control points from the weapon's world transform (centerGroup.matrixWorld).
  // The Viewer calls this every frame before update(dt).
  updateAnchor(matrix: THREE.Matrix4, resolveAttachment?: AttachmentTransformResolver): void;
  update(dt: number): void;
  // The next update() treats an instant transform snap (view preset or reset) as a rigid
  // move, carrying particles and control points instead of reading a huge velocity spike.
  notifyTeleport(): void;
  dispose(): void;
}

const KNOWN_EFFECT_IDS = new Set(['hot', 'isotope', 'cool', 'energy_orb', 'sparkle']);

// A pre-resolved (effect, weapon) bundle: the system the game spawns for that pair, plus
// its transitive children, copied verbatim from the source PCF data.
interface UnusualBundle {
  root: string;
  systems: Record<string, UnusualSystemDef>;
}

// Fetched once per (effect, weapon) pair and shared by every instance of it.
const unusualBundlePromises = new Map<string, Promise<UnusualBundle>>();
function loadUnusualBundle(effectId: string, weaponKey: string): Promise<UnusualBundle> {
  const key = `${effectId}/${weaponKey}`;
  let promise = unusualBundlePromises.get(key);
  if (!promise) {
    const base = import.meta.env.BASE_URL;
    // paintkit_tool is a presentation prop, so its PCFs author no suffixed dispatch. Reuse
    // c_rocketlauncher's, then bind its CPs to the six spray-can attachments (unusual_0..5).
    const bundleWeaponKey = weaponKey === 'paintkit_tool' ? 'c_rocketlauncher' : weaponKey;
    const bundlePath = effectId === 'sparkle'
      ? 'sparkle.json'
      : `${effectId}/${bundleWeaponKey}.json`;
    promise = fetch(`${base}data/effects/unusuals/${bundlePath}`).then((r) => {
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

// Returns at once with an empty Group, then fills in when the unusual bundle, attachments
// and sprite textures resolve. modelCenter (geometry-space bounding-box center) is the
// fallback control point for systems with no matching attachment. The Group must sit at
// the SCENE ROOT with an identity transform: particles simulate in world space.
export function createUnusualEffect(
  id: string,
  radius: number,
  weaponKey: string,
  modelCenter: THREE.Vector3,
): UnusualEffect | null {
  if (!KNOWN_EFFECT_IDS.has(id)) return null;

  const group = new THREE.Group();
  let root: SystemInstance | null = null;
  let disposed = false;

  const fallbackAnchor: AttachmentAnchor = { pos: modelCenter.clone(), quat: DEFAULT_ATTACHMENT_QUAT.clone() };
  const anchoredCps = new Map<number, ControlPoint>();
  const dynamicCps: ControlPoint[] = [];
  const anchorMatrix = new THREE.Matrix4();
  const anchorQuat = new THREE.Quaternion();
  const attachmentMatrix = new THREE.Matrix4();
  const attachmentQuat = new THREE.Quaternion();
  let resolveAttachment: AttachmentTransformResolver | undefined;
  let anchorDirty = true;

  const updateAnchoredCp = (index: number, cp: ControlPoint) => {
    if (cp.anchor && resolveAttachment?.(index, cp.anchor, attachmentMatrix)) {
      attachmentQuat.setFromRotationMatrix(attachmentMatrix);
      cp.setFromAnchorMatrix(attachmentMatrix, attachmentQuat);
    } else {
      cp.setFromAnchorMatrix(anchorMatrix, anchorQuat);
    }
  };

  // Teleport handling: a view preset or reset moves the whole transform in one frame, which
  // ControlPoint.beginFrame would read as enormous velocity and fling lock/velocityInherit
  // particles. prevAnchorMatrix is the anchor at the end of the last tick; pendingTeleport
  // is set by notifyTeleport() and cleared on the next update().
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

  const hitboxesPromise: Promise<HitboxesJson> = id === 'sparkle' ? loadHitboxes() : Promise.resolve({});
  Promise.all([loadUnusualBundle(id, weaponKey), loadAttachmentsJson(), loadParticleIndex(), hitboxesPromise])
    .then(([bundle, attachments, particleIndex, hitboxes]) => {
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
          updateAnchoredCp(index, cp);
          // Anchored CPs are created lazily, mid-tick after beginFrame: prime them so same-tick
          // Movement Lock sees zero motion.
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
        const instance = new SystemInstance(
          name, sysDef, radius, getCp, createDynamicCp, particleIndex,
          hitboxes[weaponKey] ?? [],
          (point) => point.applyMatrix4(anchorMatrix),
        );
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
    updateAnchor(matrix: THREE.Matrix4, resolver?: AttachmentTransformResolver) {
      anchorMatrix.copy(matrix);
      anchorQuat.setFromRotationMatrix(matrix);
      resolveAttachment = resolver;
      anchorDirty = true;
    },
    notifyTeleport() {
      pendingTeleport = true;
    },
    update(dt: number) {
      if (disposed || !root) return;
      if (anchorDirty) {
        for (const [index, cp] of anchoredCps) updateAnchoredCp(index, cp);
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
        // Rigidly carry every alive particle and dynamic CP from the old anchor to the new one.
        // Anchored CPs already read the new anchor, so they only need re-priming below.
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
        // Prime every CP to its new pose so beginFrame computes zero delta and velocity.
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
