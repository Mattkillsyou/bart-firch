import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ---------- environment ---------- */
const html = document.documentElement;
const { gsap, ScrollTrigger } = window;
if (!gsap || !ScrollTrigger) throw new Error('GSAP failed to load; the static fallback stays on');
html.classList.remove('no-js');
gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const touch = window.matchMedia('(pointer: coarse)').matches;
const fine = window.matchMedia('(pointer: fine)').matches;
const hasGL = (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })();
let useGL = hasGL && !reduced;
/* on touch the DOM draws the photos: native scroll runs off-thread, so GL planes would trail by a frame */
const usePlanes = () => useGL && !touch;
if (reduced) html.classList.add('no-motion');

/* ---------- split text ---------- */
function splitWords(root) {
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === 3) {
        const parts = child.textContent.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        parts.forEach((p) => {
          if (!p) return;
          if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(' ')); return; }
          const w = document.createElement('span'); w.className = 'w';
          const i = document.createElement('span'); i.className = 'wi'; i.textContent = p;
          w.appendChild(i); frag.appendChild(w);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1 && !child.classList.contains('w')) {
        walk(child);
      }
    });
  };
  walk(root);
  return root.querySelectorAll('.wi');
}
document.querySelectorAll('[data-split]').forEach((el) => splitWords(el));

/* ---------- smooth scroll ---------- */
let lenis = null;
let scrollVel = 0;
if (!reduced && window.Lenis) {
  lenis = new window.Lenis({ lerp: 0.085, smoothWheel: true, syncTouch: false, wheelMultiplier: 0.95 });
  lenis.on('scroll', (e) => { scrollVel = e.velocity; ScrollTrigger.update(); });
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  lenis.stop();
}
const focusTarget = (target) => {
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
};
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (id.length < 2) return;
    const target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: 0, duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 4), onComplete: () => focusTarget(target) });
    else { target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }); focusTarget(target); }
  });
});

/* ---------- loader ---------- */
const loader = document.getElementById('loader');
const loaderNum = document.getElementById('loader-num');
const loaderBar = document.getElementById('loader-bar');
const loadState = { p: 0, shown: 0 };
const t0 = performance.now();
function setProgress(p) {
  loadState.p = Math.max(loadState.p, p);
  gsap.to(loadState, { shown: loadState.p, duration: 0.6, ease: 'power2.out', overwrite: true, onUpdate: () => {
    const n = Math.round(loadState.shown * 100);
    loaderNum.textContent = String(n).padStart(2, '0');
    loaderBar.style.width = (loadState.shown * 100) + '%';
  } });
}

/* ---------- WebGL ---------- */
const canvas = document.getElementById('gl');
const GL = window.__GL = { planes: [], fade: 1, fadeTarget: 1, mouse: new THREE.Vector2(0, 0), mouseT: new THREE.Vector2(0, 0), vel: 0 };
const W = () => canvas.clientWidth || html.clientWidth;
const H = () => canvas.clientHeight || window.innerHeight;
function pickRatio(w, h) {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(dpr, 2, Math.sqrt(4.5e6 / Math.max(1, w * h))));
}

const noiseGLSL = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const particleVert = `
${noiseGLSL}
attribute vec3 aSeed;
attribute float aSize;
uniform float uTime, uBreath, uFade, uPixelRatio, uVel;
uniform vec2 uMouse, uArea;
varying float vAlpha;
void main(){
  vec3 p;
  p.x = (aSeed.x - 0.5) * uArea.x * 1.25;
  p.y = (aSeed.y - 0.5) * uArea.y * 1.25;
  p.z = (aSeed.z - 0.5) * 700.0;
  float t = uTime * 0.05;
  float sc = 0.0011;
  vec3 n = vec3(
    snoise(vec3(p.xy * sc, t + aSeed.z * 3.0)),
    snoise(vec3(p.yx * sc + 31.0, t - aSeed.x * 3.0)),
    snoise(vec3(p.xz * sc + 57.0, t * 0.7)));
  p += n * vec3(120.0, 120.0, 60.0);
  p.xy *= uBreath;
  vec2 d = p.xy - uMouse;
  float dist = length(d);
  float f = smoothstep(300.0, 0.0, dist);
  p.xy += (d / max(dist, 1.0)) * f * 140.0;
  p.y += uVel * (0.35 + aSeed.z) * 2.2 + sin(uTime * 0.25 + aSeed.x * 6.2832) * 18.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = smoothstep(-450.0, 350.0, p.z);
  gl_PointSize = min(aSize * uPixelRatio * (900.0 / -mv.z), 48.0);
  vAlpha = (0.12 + 0.7 * depth) * uFade * (0.5 + 0.5 * n.x) * (1.0 - f * 0.5) * 0.85;
}`;
const particleFrag = `
uniform vec3 uColor;
varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.12, d) * 0.9;
  gl_FragColor = vec4(uColor, a * vAlpha);
}`;

const planeVert = `
uniform float uHover, uVel;
uniform vec2 uMouse, uPlane;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec3 p = position;
  float d = distance(uv, uMouse);
  float bump = smoothstep(0.55, 0.0, d) * uHover;
  p.z += bump * 36.0;
  p.y += sin(uv.x * 3.14159) * uVel * 0.3 / max(uPlane.y, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const planeFrag = `
uniform sampler2D uTex;
uniform vec2 uPlane, uImage, uMouse, uFocus;
uniform float uHover, uVel, uReveal, uTime, uWarm, uOpacity;
varying vec2 vUv;
vec2 cover(vec2 uv, vec2 plane, vec2 img){
  float pr = plane.x / plane.y; float ir = img.x / img.y;
  vec2 s = vec2(1.0);
  if (pr > ir) s.y = ir / pr; else s.x = pr / ir;
  vec2 origin = clamp(uFocus - s * 0.5, vec2(0.0), vec2(1.0) - s);
  return origin + uv * s;
}
void main(){
  vec2 uv = vUv;
  float z = mix(1.16, 1.0, uReveal);
  uv = (uv - 0.5) / z + 0.5;
  vec2 dm = uv - uMouse;
  float dd = length(dm);
  float k = smoothstep(0.5, 0.0, dd) * uHover;
  uv -= dm * k * 0.09;
  vec2 cuv = cover(uv, uPlane, uImage);
  float sp = uVel * 0.00022;
  float r = texture2D(uTex, cuv + vec2(0.0, sp)).r;
  float g = texture2D(uTex, cuv).g;
  float b = texture2D(uTex, cuv - vec2(0.0, sp)).b;
  vec3 col = vec3(r, g, b);
  col = mix(col, col * vec3(1.03, 1.0, 0.94), uWarm);
  col = pow(col, vec3(1.06));
  float e = uReveal * 1.12;
  float wipe = 1.0 - smoothstep(e - 0.12, e, 1.0 - vUv.y);
  gl_FragColor = vec4(col, wipe * uOpacity);
}`;

/* grain runs after OutputPass, so it works in display (sRGB) space */
const grainShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAmount: { value: 0.07 }, uRes: { value: new THREE.Vector2(1, 1) }, uGlow: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
  uniform sampler2D tDiffuse; uniform float uTime, uAmount, uGlow; uniform vec2 uRes; varying vec2 vUv;
  float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main(){
    vec4 c = texture2D(tDiffuse, vUv);
    float g = (hash(vUv * uRes + vec2(fract(uTime * 13.7) * 100.0, fract(uTime * 7.3) * 100.0)) - 0.5) * uAmount;
    vec2 q = vUv - 0.5;
    float vig = 1.0 - dot(q, q) * 0.45;
    float ar = uRes.x / uRes.y;
    vec2 gp = vec2(0.18 + 0.06 * sin(uTime * 0.11), 0.22 + 0.05 * cos(uTime * 0.09));
    float glow = smoothstep(0.85, 0.0, distance(vec2(vUv.x * ar, vUv.y), vec2(gp.x * ar, gp.y)));
    c.rgb = c.rgb * vig + vec3(0.29, 0.22, 0.13) * glow * uGlow * 0.5 + g;
    gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
  }`,
};

let renderer, scene, camera, composer, grainPass, particles, pMat, clock;
let lastW = 0, lastH = 0;

function initGL(manager) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(pickRatio(W(), H()));
  renderer.setSize(W(), H(), false);
  renderer.setClearColor(new THREE.Color('#0B0B0C'), 1);
  scene = new THREE.Scene();
  const dist = 1000;
  camera = new THREE.PerspectiveCamera(2 * Math.atan((H() / 2) / dist) * 180 / Math.PI, W() / H(), 10, 3000);
  camera.position.z = dist;
  clock = new THREE.Clock();

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  grainPass = new ShaderPass(grainShader);
  composer.addPass(grainPass);

  /* particles */
  const N = touch ? 2200 : 6500;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), seed = new Float32Array(N * 3), size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    seed[i * 3] = Math.random(); seed[i * 3 + 1] = Math.random(); seed[i * 3 + 2] = Math.random();
    size[i] = 1.6 + Math.pow(Math.random(), 2.2) * 6.5;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  pMat = new THREE.ShaderMaterial({
    vertexShader: particleVert, fragmentShader: particleFrag, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 }, uBreath: { value: 1 }, uFade: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uVel: { value: 0 },
      uMouse: { value: new THREE.Vector2(9999, 9999) }, uArea: { value: new THREE.Vector2(W(), H()) }, uColor: { value: new THREE.Color('#E6C69A') },
    },
  });
  particles = new THREE.Points(geo, pMat);
  particles.frustumCulled = false;
  scene.add(particles);

  /* photo planes: the DOM <img> is the texture source, so each photo is fetched once */
  if (usePlanes()) {
    const planeGeo = new THREE.PlaneGeometry(1, 1, 24, 24);
    document.querySelectorAll('.gl-fig[data-gl]').forEach((fig) => {
      const img = fig.querySelector('img');
      const isHero = !!fig.closest('.arrive');
      const tex = new THREE.Texture();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
      tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      const f = (fig.dataset.focus || '0.5 0.5').split(/\s+/).map(Number);
      const mat = new THREE.ShaderMaterial({
        vertexShader: planeVert, fragmentShader: planeFrag, transparent: true,
        uniforms: {
          uTex: { value: tex }, uPlane: { value: new THREE.Vector2(1, 1) },
          uImage: { value: new THREE.Vector2(+img.getAttribute('width') || 3, +img.getAttribute('height') || 2) },
          uMouse: { value: new THREE.Vector2(0.5, 0.5) }, uHover: { value: 0 }, uVel: { value: 0 }, uReveal: { value: 0 },
          uTime: { value: 0 }, uWarm: { value: 0.6 }, uFocus: { value: new THREE.Vector2(f[0], 1 - f[1]) }, uOpacity: { value: 1 },
        },
      });
      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      const plane = { fig, img, mesh, mat, mouse: new THREE.Vector2(0.5, 0.5), loaded: false, wanted: false, dead: false };
      plane.syncOpacity = () => { mat.uniforms.uOpacity.value = parseFloat(getComputedStyle(fig).opacity) || 1; };
      plane.syncOpacity();
      plane.reveal = () => gsap.to(mat.uniforms.uReveal, { value: 1, duration: 1.7, ease: 'expo.out' });
      plane.want = () => { plane.wanted = true; if (plane.loaded) plane.reveal(); };
      GL.planes.push(plane);
      if (isHero) manager.itemStart(img.src);
      img.loading = 'eager';
      const ready = () => {
        tex.image = img; tex.needsUpdate = true;
        try { renderer.initTexture(tex); } catch (e) { /* upload happens on first draw */ }
        plane.loaded = true;
        if (plane.wanted) plane.reveal();
        if (isHero) manager.itemEnd(img.src);
      };
      const failed = () => { plane.dead = true; fig.classList.add('gl-off'); if (isHero) manager.itemEnd(img.src); };
      (img.decode ? img.decode() : Promise.resolve()).then(ready).catch(() => {
        if (img.complete && img.naturalWidth) ready(); else failed();
      });
      if (fine) {
        fig.addEventListener('pointerenter', () => gsap.to(mat.uniforms.uHover, { value: 1, duration: 0.9, ease: 'expo.out', overwrite: true }));
        fig.addEventListener('pointerleave', () => gsap.to(mat.uniforms.uHover, { value: 0, duration: 1.1, ease: 'expo.out', overwrite: true }));
        fig.addEventListener('pointermove', (e) => {
          const r = fig.getBoundingClientRect();
          plane.mouse.set((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height);
        });
      }
    });
    html.classList.add('gl-planes');
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    gsap.ticker.remove(render);
    html.classList.remove('gl-on', 'gl-planes');
    GL.planes.forEach((p) => { p.mesh.visible = false; });
    renderer = null;
  });

  html.classList.add('gl-on');
  window.addEventListener('resize', onResize);
  onResize();
}

function onResize() {
  if (!renderer) return;
  const w = W(), h = H();
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  renderer.setPixelRatio(pickRatio(w, h));
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = 2 * Math.atan((h / 2) / 1000) * 180 / Math.PI;
  camera.updateProjectionMatrix();
  const pr = renderer.getPixelRatio();
  pMat.uniforms.uArea.value.set(w, h);
  pMat.uniforms.uPixelRatio.value = pr;
  grainPass.uniforms.uRes.value.set(w * pr, h * pr);
  for (const p of GL.planes) p.syncOpacity();
}

let hidden = false;
document.addEventListener('visibilitychange', () => { hidden = document.hidden; });

function render() {
  if (!renderer || hidden) return;
  const t = clock.getElapsedTime();
  const w = W(), h = H();
  GL.vel += (Math.max(-30, Math.min(30, scrollVel)) - GL.vel) * 0.1;
  GL.mouse.lerp(GL.mouseT, 0.08);
  GL.fade += (GL.fadeTarget - GL.fade) * 0.06;

  pMat.uniforms.uTime.value = t;
  pMat.uniforms.uBreath.value = 1 + Math.sin(t * Math.PI * 2 / 6.5) * 0.06;
  pMat.uniforms.uFade.value = GL.fade;
  pMat.uniforms.uVel.value = GL.vel;
  pMat.uniforms.uMouse.value.copy(GL.mouse);
  particles.visible = GL.fade > 0.02;

  for (const p of GL.planes) {
    if (p.dead || !p.loaded) { p.mesh.visible = false; continue; }
    const r = p.fig.getBoundingClientRect();
    const visible = r.bottom > -100 && r.top < h + 100 && r.width > 0;
    p.mesh.visible = visible;
    if (!visible) continue;
    p.mesh.scale.set(r.width, r.height, 1);
    p.mesh.position.set(r.left + r.width / 2 - w / 2, -(r.top + r.height / 2 - h / 2), 0);
    p.mat.uniforms.uPlane.value.set(r.width, r.height);
    p.mat.uniforms.uVel.value = GL.vel;
    p.mat.uniforms.uTime.value = t;
    p.mat.uniforms.uMouse.value.lerp(p.mouse, 0.1);
  }
  grainPass.uniforms.uTime.value = t;
  grainPass.uniforms.uGlow.value = 0.35 + GL.fade * 0.65;
  composer.render();
}

/* ---------- boot ---------- */
const manager = new THREE.LoadingManager();
let assetsDone = false;
manager.onProgress = (url, loaded, total) => setProgress(0.15 + 0.85 * (loaded / total));
manager.onLoad = () => { assetsDone = true; maybeStart(); };
manager.onError = () => { assetsDone = true; maybeStart(); };

if (useGL) {
  try { initGL(manager); } catch (e) {
    console.warn('WebGL disabled:', e);
    useGL = false; html.classList.remove('gl-on', 'gl-planes'); GL.planes.length = 0;
  }
}
if (!useGL || GL.planes.length === 0) assetsDone = true;
setProgress(0.15);
let fontsDone = false;
(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { fontsDone = true; loader.classList.add('fonts-in'); maybeStart(); });
setTimeout(() => { assetsDone = true; fontsDone = true; maybeStart(); }, 6000);

let started = false;
function maybeStart() {
  if (started || !assetsDone || !fontsDone) return;
  started = true;
  const wait = Math.max(0, 1300 - (performance.now() - t0));
  setTimeout(start, wait);
}

function start() {
  window.__booted = true;
  setProgress(1);
  if (useGL && renderer) gsap.ticker.add(render);
  const hero = document.querySelector('.hero');
  const heroWords = hero.querySelectorAll('.wi');
  const heroLines = hero.querySelectorAll('.reveal-line');
  const arriveFig = document.querySelector('.arrive-fig');
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  tl.to(loader, { clipPath: 'inset(0 0 100% 0)', duration: 1.1, ease: 'expo.inOut', delay: 0.35, onComplete: () => { loader.style.display = 'none'; } })
    .add(() => { if (lenis) lenis.start(); GL.fadeTarget = 1; }, '-=0.5')
    .to(heroWords, { y: 0, duration: 1.4, stagger: 0.045 }, '-=0.55')
    .to(heroLines, { opacity: 1, y: 0, duration: 1.2, stagger: 0.1 }, '-=1.0');
  if (reduced) tl.progress(1);
  setupScroll(arriveFig);
  setupCursor();
  setupMagnetic();
  setupForm();
  setupMarquee();
  ScrollTrigger.refresh();
}

/* ---------- scroll choreography ---------- */
function setupScroll(arriveFig) {
  const arrive = document.querySelector('.arrive');
  const arriveWords = arrive.querySelectorAll('.wi');
  gsap.to(arriveFig, { '--p': 1, ease: 'none', scrollTrigger: { trigger: arrive, start: 'top top', end: 'bottom bottom', scrub: true } });
  gsap.to('.arrive-copy', { opacity: 1, y: 0, ease: 'none', scrollTrigger: { trigger: arrive, start: '55% bottom', end: '80% bottom', scrub: true,
    onEnter: () => gsap.to(arriveWords, { y: 0, duration: 1.3, ease: 'expo.out', stagger: 0.03, overwrite: true }) } });
  gsap.to('.arrive-shade', { opacity: 1, ease: 'none', scrollTrigger: { trigger: arrive, start: '45% bottom', end: '80% bottom', scrub: true } });

  /* particle field: strong in the hero, faint through the page, back for the close */
  let heroFade = 1, closeFade = 0;
  const applyFade = () => { GL.fadeTarget = Math.max(heroFade, closeFade); };
  ScrollTrigger.create({ trigger: '.hero', start: 'top top', end: 'bottom 20%', onUpdate: (st) => { heroFade = 1 - st.progress * 0.9; applyFade(); } });
  ScrollTrigger.create({ trigger: '.contact', start: 'top 80%', end: 'bottom bottom', onUpdate: (st) => { closeFade = 0.1 + st.progress * 0.55; applyFade(); }, onLeaveBack: () => { closeFade = 0; applyFade(); } });

  /* photo reveals: GL planes on desktop, the DOM image elsewhere */
  if (GL.planes.length) {
    GL.planes.forEach((p) => {
      if (p.fig === arriveFig) { gsap.delayedCall(0.9, p.want); return; }
      ScrollTrigger.create({ trigger: p.fig, start: 'top 88%', once: true, onEnter: p.want });
    });
  } else if (!reduced) {
    document.querySelectorAll('.gl-fig img').forEach((img) => {
      gsap.set(img, { clipPath: 'inset(100% 0 0 0)', scale: 1.14 });
      const reveal = () => gsap.to(img, { clipPath: 'inset(0% 0 0 0)', scale: 1, duration: 1.7, ease: 'expo.out', overwrite: true });
      if (img.closest('.arrive')) gsap.delayedCall(0.9, reveal);
      else ScrollTrigger.create({ trigger: img, start: 'top 88%', once: true, onEnter: reveal });
    });
  }

  /* depth: the figures drift against the page, which the GL planes pick up from the rect */
  if (!reduced) {
    document.querySelectorAll('.about-fig, .offer-fig, .exp-fig').forEach((fig, i) => {
      gsap.fromTo(fig, { y: 26 + i * 4 }, { y: -26 - i * 4, ease: 'none',
        scrollTrigger: { trigger: fig, start: 'top bottom', end: 'bottom top', scrub: 0.6 } });
    });
  }

  /* nav retracts going down, returns going up */
  const nav = document.getElementById('nav');
  ScrollTrigger.create({
    start: 'top -80', end: 99999,
    onUpdate: (st) => {
      const down = st.direction === 1;
      gsap.to(nav, { yPercent: down ? -140 : 0, duration: 0.5, ease: 'power3.out', overwrite: true });
    },
    onLeaveBack: () => gsap.to(nav, { yPercent: 0, duration: 0.4, ease: 'power3.out', overwrite: true }),
  });

  /* text */
  document.querySelectorAll('[data-split]').forEach((el) => {
    if (el.closest('.hero, .arrive')) return;
    const words = el.querySelectorAll('.wi');
    ScrollTrigger.create({ trigger: el, start: 'top 85%', once: true, onEnter: () => gsap.to(words, { y: 0, duration: 1.3, ease: 'expo.out', stagger: 0.03 }) });
  });
  const lines = [...document.querySelectorAll('.reveal-line')].filter((el) => !el.closest('.hero'));
  ScrollTrigger.batch(lines, { start: 'top 90%', once: true, onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.08, overwrite: true }) });

  if (reduced) {
    ScrollTrigger.getAll().forEach((s) => s.kill());
    gsap.set('.wi, .reveal-line', { clearProps: 'all' });
    gsap.set('.arrive-copy, .arrive-shade', { opacity: 1, y: 0 });
    gsap.set(arriveFig, { '--p': 1 });
  }
}

/* ---------- cursor + magnetic ---------- */
function setupCursor() {
  if (!fine || reduced) return;
  const cur = document.getElementById('cursor'), label = document.getElementById('cursor-label');
  html.classList.add('has-cursor');
  const xTo = gsap.quickTo(cur, 'x', { duration: 0.35, ease: 'power3' }), yTo = gsap.quickTo(cur, 'y', { duration: 0.35, ease: 'power3' });
  window.addEventListener('pointermove', (e) => {
    xTo(e.clientX); yTo(e.clientY);
    GL.mouseT.set(e.clientX - W() / 2, -(e.clientY - H() / 2));
  }, { passive: true });
  document.addEventListener('pointerleave', () => GL.mouseT.set(9999, 9999));
  document.querySelectorAll('[data-cursor]').forEach((el) => {
    el.addEventListener('pointerenter', () => {
      const text = el.getAttribute('data-cursor');
      cur.classList.toggle('is-label', !!text);
      cur.classList.toggle('is-hover', !text);
      label.textContent = text || '';
    });
    el.addEventListener('pointerleave', () => { cur.classList.remove('is-label', 'is-hover'); });
  });
}
function setupMagnetic() {
  if (!fine || reduced) return;
  document.querySelectorAll('[data-magnetic]').forEach((el) => {
    const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3' }), yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3' });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      xTo((e.clientX - (r.left + r.width / 2)) * 0.3); yTo((e.clientY - (r.top + r.height / 2)) * 0.3);
    });
    el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
  });
}

/* ---------- marquee pause (keyboard and touch) ---------- */
function setupMarquee() {
  const mq = document.querySelector('.marquee'), mt = document.querySelector('.marquee-toggle');
  if (!mq || !mt) return;
  mt.addEventListener('click', () => {
    const on = mq.classList.toggle('is-paused');
    mt.setAttribute('aria-pressed', String(on));
    mt.textContent = on ? 'Play' : 'Pause';
  });
}

/* ---------- form ---------- */
function setupForm() {
  const form = document.getElementById('form'), note = document.getElementById('form-note');
  const fields = [form.elements.name, form.elements.email, form.elements.message];
  fields.forEach((f) => f.setAttribute('aria-describedby', 'form-note'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    fields.forEach((f) => f.removeAttribute('aria-invalid'));
    const bad = fields.filter((f) => !f.value.trim() || (f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.value.trim())));
    if (bad.length) {
      bad.forEach((f) => f.setAttribute('aria-invalid', 'true'));
      note.textContent = 'Add your name, a working email, and a line about what is going on.';
      bad[0].focus();
      return;
    }
    note.textContent = 'Thanks, ' + form.elements.name.value.trim().split(' ')[0] + '. I will be in touch.';
    form.reset();
  });
}
