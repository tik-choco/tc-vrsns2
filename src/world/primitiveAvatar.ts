// Default avatar built entirely from three.js primitives (no external assets):
// a capsule body plus a sphere head, tinted with the player's profile color.
// Two small eye spheres mark the front (+Z).
import * as THREE from 'three'

export const PRIMITIVE_AVATAR_HEIGHT = 1.55

export type PrimitiveAvatar = {
  group: THREE.Group
  setColor(color: string): void
  dispose(): void
}

const EYE_COLOR = 0x14161c

export function createPrimitiveAvatar(color: string): PrimitiveAvatar {
  const group = new THREE.Group()
  group.name = 'PrimitiveAvatar'

  const bodyMaterial = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.05 })
  const headMaterial = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 })
  const eyeMaterial = new THREE.MeshStandardMaterial({ color: EYE_COLOR, roughness: 0.35 })

  const bodyGeometry = new THREE.CapsuleGeometry(0.23, 0.62, 6, 16)
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
  body.position.y = 0.54
  body.castShadow = true
  group.add(body)

  const headGeometry = new THREE.SphereGeometry(0.21, 20, 16)
  const head = new THREE.Mesh(headGeometry, headMaterial)
  head.position.y = 1.32
  head.castShadow = true
  group.add(head)

  const eyeGeometry = new THREE.SphereGeometry(0.035, 10, 8)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeometry, eyeMaterial)
    eye.position.set(side * 0.075, 1.36, 0.185)
    group.add(eye)
  }

  const setColor = (c: string) => {
    const base = new THREE.Color(c)
    bodyMaterial.color.copy(base)
    headMaterial.color.copy(base).lerp(new THREE.Color(0xffffff), 0.35)
  }
  setColor(color)

  return {
    group,
    setColor,
    dispose() {
      bodyGeometry.dispose()
      headGeometry.dispose()
      eyeGeometry.dispose()
      bodyMaterial.dispose()
      headMaterial.dispose()
      eyeMaterial.dispose()
    },
  }
}
