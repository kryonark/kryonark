// Kryonark hero · the ice cube as a real 3D object (three.js), textured with the design's own faces.
// Loop: slow full turn, pulsing orange seam, a light sheen sweeping the ice, drifting snow.
// Falls back to the static cube image when WebGL is missing or the viewer prefers reduced motion.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// camera fitted to the design: 9 cube corners from the render, least-squares, 3.9 px RMS at 1440x798
const CFG = { fov: 16.223, camY: -4.366, dist: 13.137, lookY: -2.565, offX: -116, offY: -600, rotY: Math.PI / 4, seamY: 0 };

const canvas = document.getElementById("cube3d");
const still = document.getElementById("cube-still");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const calib = new URLSearchParams(location.search).has("calib");
const calibRot = ((+new URLSearchParams(location.search).get("rot") || 0) * Math.PI) / 180;   // ?calib&rot=30 holds the cube at +30 deg (for checking)

function webgl() { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; } }
if (canvas && webgl() && !reduce) start();

function start() {
  // the canvas is the plate's own 1440x798 frame, so plate coordinates map 1:1 onto it
  const W = 1440, H = 798;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  // camera below the seam, looking slightly up: the design's horizontal edges all slope down toward the sides
  const cam = new THREE.PerspectiveCamera(CFG.fov, W / H, 0.1, 100);
  cam.position.set(0, CFG.camY, CFG.dist);
  cam.lookAt(0, CFG.lookY, 0);
  cam.setViewOffset(W, H, CFG.offX, CFG.offY, W, H);   // slide the frame so the cube lands where the design has it

  const load = (u) => { const t = new THREE.TextureLoader().load(u); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  const faceL = load("assets/tex-face-left.webp"), faceR = load("assets/tex-face-right.webp");
  const glowL = load("assets/tex-glow-left.webp"), glowR = load("assets/tex-glow-right.webp");
  const cap = load("assets/tex-cap.webp"), capDark = load("assets/tex-cap-dark.webp");
  const data = (u) => { const t = new THREE.TextureLoader().load(u); t.anisotropy = 8; return t; };   // linear data maps (no sRGB)
  const nrmL = data("assets/tex-normal-left.webp"), nrmR = data("assets/tex-normal-right.webp"), nrmC = data("assets/tex-normal-cap.webp");
  const rghL = data("assets/tex-rough-left.webp"), rghR = data("assets/tex-rough-right.webp"), rghC = data("assets/tex-rough-cap.webp");

  // image-based reflections, so the glossy ice catches a soft studio and the frost scatters it
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // The face textures already carry the render's own light, so they are shown as they are (no scene lights).
  // On top: a sheen band that sweeps across the ice in world space, and a soft shade on faces turned away from the camera.
  const sheen = { value: 0 };
  const iceMat = (map, normalMap, roughnessMap) => {
    const m = new THREE.MeshStandardMaterial({
      map, normalMap, normalScale: new THREE.Vector2(0.85, 0.85), roughnessMap, roughness: 1, metalness: 0,
      emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.78, envMapIntensity: 0.35,
    });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uSheen = sheen;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vW;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvW = (modelMatrix * vec4(position, 1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vW;\nuniform float uSheen;")
        .replace("#include <dithering_fragment>", `#include <dithering_fragment>
          float d = dot(vW, normalize(vec3(1.0, 0.6, 0.35))) - uSheen;
          float band = exp(-d * d * 7.0);
          // the sheen follows the relief: brighter where the frost faces up, broken where it is rough
          float lum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor.rgb += vec3(0.70, 0.86, 1.0) * band * (0.08 + 0.25 * lum);`);
    };
    return m;
  };
  // The cube is two ice blocks with a recessed light groove between them (the design's lamp sits inside the ice).
  // Texture rows: the groove spans v 0.482..0.524 of each face; each block shows only its own part of the face.
  const G = 0.026;          // half height of the groove
  const DEPTH = 0.12;       // how far the lamp sits inside the ice (deeper than the edge rounding, so the groove reads at the corners)
  const V_TOP = 0.539, V_BOT = 0.494;
  const SIDES = [0, 1, 4, 5];  // BoxGeometry face groups: +x, -x, +y, -y, +z, -z
  // ice blocks have softened edges: a rounded box, with each side face's texture squeezed to that block's part of the face
  const RADIUS = 0.05;     // edge rounding, in cube units (the cube is 2 wide)
  function block(y0, y1, v0, v1, materials) {
    const g = new RoundedBoxGeometry(2, y1 - y0, 2, 6, RADIUS);
    const uv = g.attributes.uv, idx = g.index, done = new Set();
    for (const grp of g.groups) {
      if (!SIDES.includes(grp.materialIndex)) continue;
      for (let k = grp.start; k < grp.start + grp.count; k++) {
        const i = idx ? idx.getX(k) : k;
        if (done.has(i)) continue; done.add(i);
        uv.setY(i, v0 + uv.getY(i) * (v1 - v0));
      }
    }
    uv.needsUpdate = true;
    const m = new THREE.Mesh(g, materials); m.position.y = (y0 + y1) / 2; return m;
  }
  // the groove walls (the blocks' faces that look into the groove) are lit warm by the lamp
  const wallMat = new THREE.MeshBasicMaterial({ color: 0xff8a4a });
  const capTop = iceMat(cap, nrmC, rghC), capBot = iceMat(capDark, nrmC, rghC);
  const topMats = [iceMat(faceR, nrmR, rghR), iceMat(faceL, nrmL, rghL), capTop, wallMat, iceMat(faceL, nrmL, rghL), iceMat(faceR, nrmR, rghR)];
  const botMats = [topMats[0], topMats[1], wallMat, capBot, topMats[4], topMats[5]];
  const mats = topMats;
  const upper = block(G, 1, V_TOP, 1, topMats), lower = block(-1, -G, 0, V_BOT, botMats);
  // the lamp: a bright core recessed into the groove
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffc38a });
  const lamp = new THREE.Mesh(new RoundedBoxGeometry(2 - DEPTH * 2, G * 1.5, 2 - DEPTH * 2, 6, G * 0.7), lampMat);
  const cube = new THREE.Group(); cube.add(upper, lower, lamp);

  // the seam's warm spill on the ice, as an additive layer a hair above each block, pulsing with the lamp
  const glowMat = (map) => new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 });
  const nada = new THREE.MeshBasicMaterial({ visible: false });
  const gmats = [glowMat(glowR), glowMat(glowL), nada, nada, glowMat(glowL), glowMat(glowR)];
  const glowUp = block(G, 1, V_TOP, 1, gmats), glowLo = block(-1, -G, 0, V_BOT, gmats);
  glowUp.scale.set(1.002, 1, 1.002); glowLo.scale.set(1.002, 1, 1.002);
  const glow = new THREE.Group(); glow.add(glowUp, glowLo);

  // seam bloom: soft additive strips on each face, sized to the face so nothing sticks out
  const haloTex = (() => { const c = document.createElement("canvas"); c.width = 256; c.height = 64; const g = c.getContext("2d"); const gr = g.createLinearGradient(0, 0, 0, 64); gr.addColorStop(0, "rgba(255,110,40,0)"); gr.addColorStop(0.5, "rgba(255,150,80,1)"); gr.addColorStop(1, "rgba(255,110,40,0)"); g.fillStyle = gr; g.fillRect(0, 0, 256, 64); const h = g.createLinearGradient(0, 0, 256, 0); h.addColorStop(0, "rgba(0,0,0,1)"); h.addColorStop(0.06, "rgba(0,0,0,0)"); h.addColorStop(0.94, "rgba(0,0,0,0)"); h.addColorStop(1, "rgba(0,0,0,1)"); g.globalCompositeOperation = "destination-out"; g.fillStyle = h; g.fillRect(0, 0, 256, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const haloMat = new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.4 });
  const halo = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2, 0.24), haloMat);
    const a = (i * Math.PI) / 2; p.position.set(Math.sin(a) * (1.004), CFG.seamY, Math.cos(a) * (1.004)); p.rotation.y = a; halo.add(p);
  }
  const box = new THREE.Group(); box.add(cube, glow, halo); scene.add(box);

  scene.add(new THREE.AmbientLight(0xa9c2df, 0.05));
  const key = new THREE.DirectionalLight(0xcfe6ff, 0.45); key.position.set(-2.5, 4, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x8fc2ff, 0.5); rim.position.set(3.5, 2.5, -3); scene.add(rim);
  const glint = new THREE.PointLight(0xcfe6ff, 3.2, 9, 2); scene.add(glint);           // sweeps across the front so the relief glitters
  const lampLight = new THREE.PointLight(0xff7a36, 6, 3.2, 2); lampLight.position.set(0, CFG.seamY, 1.75); scene.add(lampLight);

  // snow: points scattered in a slab around the cube, drifting down and sideways
  const N = 260, pos = new Float32Array(N * 3), spd = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 12; pos[i * 3 + 1] = (Math.random() - 0.5) * 7; pos[i * 3 + 2] = (Math.random() - 0.5) * 6 - 0.5; spd[i] = 0.08 + Math.random() * 0.22; }
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const dot = (() => { const c = document.createElement("canvas"); c.width = c.height = 32; const g = c.getContext("2d"); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, "rgba(235,245,255,1)"); gr.addColorStop(0.4, "rgba(235,245,255,0.55)"); gr.addColorStop(1, "rgba(235,245,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
  const snow = new THREE.Points(sg, new THREE.PointsMaterial({ map: dot, size: 0.07, transparent: true, depthWrite: false, opacity: 0.85, sizeAttenuation: true }));
  scene.add(snow);

  // ---- loop ----
  const TURN = 28;          // seconds per full turn (the cube repeats every quarter turn, so any point loops cleanly)
  const PULSE = 2.8;        // seconds per seam pulse
  const SWEEP = 7;          // seconds per sheen sweep
  const t0 = performance.now();
  let first = true, visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(canvas);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    const t = (now - t0) / 1000;
    box.rotation.y = CFG.rotY + (calib ? calibRot : (t / TURN) * Math.PI * 2);
    box.position.y = calib ? 0 : Math.sin((t / 7) * Math.PI * 2) * 0.05;
    const p = 0.5 + 0.5 * Math.sin((t / PULSE) * Math.PI * 2);
    for (const m of [gmats[0], gmats[1], gmats[4], gmats[5]]) m.opacity = 0.15 + p * 0.95;
    lampMat.color.setRGB(0.85 + p * 0.15, 0.45 + p * 0.33, 0.22 + p * 0.3);
    wallMat.color.setRGB(0.32 + p * 0.38, 0.12 + p * 0.2, 0.05 + p * 0.08);
    haloMat.opacity = 0.08 + p * 0.5;
    sheen.value = ((t % SWEEP) / SWEEP) * 7 - 3.5;
    const g = (t % SWEEP) / SWEEP; glint.position.set(-3 + g * 6, 1.6 - g * 1.2, 3.2);
    lampLight.intensity = 1.5 + p * 5;
    const a = snow.geometry.attributes.position.array;
    for (let i = 0; i < N; i++) { a[i * 3 + 1] -= spd[i] * 0.016; a[i * 3] += Math.sin(t * 0.6 + i) * 0.0015; if (a[i * 3 + 1] < -3.6) a[i * 3 + 1] = 3.6; }
    snow.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, cam);
    if (first) { first = false; canvas.classList.add("on"); if (!calib) still.classList.add("off"); }
  }
  requestAnimationFrame(frame);
}
