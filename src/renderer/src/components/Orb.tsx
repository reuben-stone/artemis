import { useRef, useMemo, type MutableRefObject } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export type OrbState = 'idle' | 'thinking' | 'executing' | 'speaking' | 'listening' | 'error'

// Per-state visual tuning: base color, how fast it churns, how much it breathes.
const STATE_CONFIG: Record<OrbState, { color: THREE.Color; speed: number; breathe: number }> = {
  // calm: deep ocean blue, drifting like water — gentle but clearly alive
  idle: { color: new THREE.Color('#2f7dff'), speed: 0.22, breathe: 0.07 },
  thinking: { color: new THREE.Color('#9b6bff'), speed: 0.8, breathe: 0.08 },
  executing: { color: new THREE.Color('#27e0a8'), speed: 1.2, breathe: 0.06 },
  // active/speaking: rich purple instead of gold
  speaking: { color: new THREE.Color('#a855f7'), speed: 1.0, breathe: 0.10 },
  // listening: alert cyan, calm but attentive — pulses to the user's voice
  listening: { color: new THREE.Color('#22d3ee'), speed: 0.5, breathe: 0.07 },
  error: { color: new THREE.Color('#ff4d5e'), speed: 1.8, breathe: 0.12 }
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uAmp;
  uniform float uBreathe;
  uniform float uSpeed;
  varying float vDisp;
  varying vec3 vNormal;

  // --- Ashima simplex noise (3D) ---
  vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x,289.0); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0,1.0/3.0);
    const vec4 D = vec4(0.0,0.5,1.0,2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod(i,289.0);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0/7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m*m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vNormal = normalize(normalMatrix * normal);
    float t = uTime * uSpeed;
    // layered noise gives a living, churning surface
    float n = snoise(normal * 1.6 + t * 0.4);
    n += 0.5 * snoise(normal * 3.2 - t * 0.6);
    // amplitude (voice) and a slow breathe both push the surface out
    float disp = n * (uBreathe + uAmp * 0.45) + uAmp * 0.18;
    vDisp = disp;
    vec3 pos = position + normal * disp;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAmp;
  varying float vDisp;
  varying vec3 vNormal;

  void main() {
    // fresnel rim glow
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.5);
    vec3 base = uColor * (0.35 + vDisp * 1.4);
    vec3 glow = uColor * fresnel * (1.4 + uAmp * 1.5);
    vec3 color = base + glow;
    gl_FragColor = vec4(color, 1.0);
  }
`

function OrbMesh({
  state,
  amplitudeRef
}: {
  state: OrbState
  amplitudeRef: MutableRefObject<number>
}) {
  const matRef = useRef<THREE.ShaderMaterial>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const colorRef = useRef(STATE_CONFIG[state].color.clone())
  const ampRef = useRef(0)

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAmp: { value: 0 },
      uBreathe: { value: STATE_CONFIG.idle.breathe },
      uSpeed: { value: STATE_CONFIG.idle.speed },
      uColor: { value: STATE_CONFIG.idle.color.clone() }
    }),
    []
  )

  useFrame((_, delta) => {
    const cfg = STATE_CONFIG[state]
    const u = uniforms
    // Advance by REAL elapsed time so the orb never runs in slow-motion when the
    // frame rate drops (e.g. macOS throttling rAF while the window is unfocused or
    // occluded). Only a genuine long pause (>1s — a parked/resumed window) is capped
    // to a tiny step so we don't jump; the `% 1000` wrap below keeps uTime bounded so
    // simplex noise never drifts into a flat (frozen-looking) region.
    const dt = delta > 1 ? 0.016 : delta
    u.uTime.value = (u.uTime.value + dt) % 1000
    // smooth the live amplitude so the pulse feels organic, not jittery
    ampRef.current += (amplitudeRef.current - ampRef.current) * Math.min(1, dt * 12)
    u.uAmp.value = ampRef.current
    // ease state-driven params
    u.uBreathe.value += (cfg.breathe - u.uBreathe.value) * Math.min(1, dt * 3)
    u.uSpeed.value += (cfg.speed - u.uSpeed.value) * Math.min(1, dt * 3)
    colorRef.current.lerp(cfg.color, Math.min(1, dt * 3))
    ;(u.uColor.value as THREE.Color).copy(colorRef.current)
    // A slow, steady spin guarantees visible life even at the calmest idle churn —
    // and makes any residual rAF throttling obvious (it would stutter, not glide).
    if (meshRef.current) {
      meshRef.current.rotation.y += dt * 0.15
      meshRef.current.rotation.x += dt * 0.04
    }
  })

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1.1, 24]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
      />
    </mesh>
  )
}

export default function Orb({
  state,
  amplitudeRef
}: {
  state: OrbState
  amplitudeRef: MutableRefObject<number>
}) {
  return (
    <Canvas
      camera={{ position: [0, 0, 6.4], fov: 45 }}
      dpr={[1, 1.5]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
    >
      <ambientLight intensity={0.4} />
      <OrbMesh state={state} amplitudeRef={amplitudeRef} />
    </Canvas>
  )
}
