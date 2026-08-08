import { useEffect, useRef, useState } from 'preact/hooks'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { CatalogItem } from '../uiContract'
import { catalogBytes } from '../../storage/catalog'
import { disposeVrm, loadVrmFromBytes } from '../../world/vrmLoader'
import { AvatarRig } from '../../world/AvatarRig'

type Props = { item: CatalogItem }

/** One interactive preview for the selected avatar; catalog cards remain lightweight images. */
export function AvatarPreview3D({ item }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false
    let frame = 0
    let loadedRig: AvatarRig | null = null
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf1f3f6)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667080, 2.1))
    const key = new THREE.DirectionalLight(0xffffff, 2.6)
    key.position.set(3, 5, 4)
    scene.add(key)
    const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.01, 100)
    const controls = new OrbitControls(camera, canvas)
    controls.enableDamping = true
    controls.enablePan = false
    controls.minDistance = 0.5
    controls.maxDistance = 8

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const clock = new THREE.Clock()
    const animate = () => {
      if (cancelled) return
      frame = requestAnimationFrame(animate)
      const delta = clock.getDelta()
      loadedRig?.update(Math.min(delta, 0.1))
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    void (async () => {
      try {
        const vrm = await loadVrmFromBytes(await catalogBytes(item.cid))
        if (cancelled) {
          disposeVrm(vrm)
          return
        }
        const rig = new AvatarRig('#8a8f9d')
        rig.setVrm(vrm)
        rig.playAnim('idle', 0)
        loadedRig = rig
        scene.add(rig.root)
        const box = new THREE.Box3().setFromObject(rig.root)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const radius = Math.max(size.length() / 2, 0.2)
        controls.target.copy(center)
        camera.near = Math.max(radius / 100, 0.01)
        camera.far = radius * 100
        camera.position.copy(center).add(new THREE.Vector3(0, radius * 0.08, radius * 2.8))
        camera.lookAt(center)
        camera.updateProjectionMatrix()
        controls.minDistance = radius * 1.1
        controls.maxDistance = radius * 6
        setReady(true)
      } catch {
        // The embedded thumbnail/letter tile underneath remains visible.
      }
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      if (loadedRig) {
        scene.remove(loadedRig.root)
        loadedRig.dispose()
      }
      renderer.dispose()
      setReady(false)
    }
  }, [item.cid])

  return (
    <div class="preview-thumb avatar-preview-3d" aria-hidden="true">
      {item.thumb ? (
        <img class="avatar-preview-fallback" src={item.thumb} alt="" />
      ) : (
        <span class="avatar-preview-fallback preview-thumb-blank">{item.name.slice(0, 1).toUpperCase()}</span>
      )}
      <canvas ref={canvasRef} class={ready ? 'avatar-preview-canvas is-ready' : 'avatar-preview-canvas'} />
    </div>
  )
}
