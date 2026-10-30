// One wave spectrum supplies both the GPU surface and CPU buoyancy. Positions
// are Lagrangian: water particles trace orbits as a crest travels past them.
export const SEA_LEVEL = -0.32;
export const WAVES = [
  { x: 0.8, z: 0.6, amplitude: 0.36, length: 11.8, speed: 1.32, orbit: 0.7 },
  {
    x: -0.48,
    z: 0.877268,
    amplitude: 0.17,
    length: 7.1,
    speed: 1.71,
    orbit: 0.6,
  },
  {
    x: 0.94,
    z: -0.341174,
    amplitude: 0.065,
    length: 3.6,
    speed: 2.18,
    orbit: 0.45,
  },
  {
    x: 0.25,
    z: 0.968246,
    amplitude: 0.022,
    length: 1.65,
    speed: 2.72,
    orbit: 0.3,
  },
].map((w) => ({ ...w, k: (Math.PI * 2) / w.length }));

export function sampleWave(
  x,
  z,
  time,
  energy = 1,
  surge = 0,
  front = -22,
  hx = 1,
  hz = 0,
  cx = 0,
  cz = 0,
  shelter = 2.6,
  out = {},
) {
  const rx = x - cx,
    rz = z - cz,
    dist = Math.hypot(rx, rz),
    s = Math.max(0, Math.min(1, (dist - shelter) / 3));
  const fade = 0.42 + 0.58 * s * s * (3 - 2 * s),
    gain = energy * fade;
  let dx = 0,
    dz = 0,
    y = 0,
    xx = 1,
    xz = 0,
    zx = 0,
    zz = 1,
    yx = 0,
    yz = 0;
  for (const w of WAVES) {
    const phase = w.k * (w.x * x + w.z * z) - time * w.speed,
      sn = Math.sin(phase),
      cs = Math.cos(phase),
      a = w.amplitude * gain,
      q = a * w.orbit;
    dx += w.x * q * cs;
    dz += w.z * q * cs;
    y += a * sn;
    xx -= q * w.k * w.x * w.x * sn;
    xz -= q * w.k * w.x * w.z * sn;
    zx -= q * w.k * w.z * w.x * sn;
    zz -= q * w.k * w.z * w.z * sn;
    yx += w.x * w.k * a * cs;
    yz += w.z * w.k * a * cs;
  }
  const d = rx * hx + rz * hz - front,
    crest = Math.exp(-d * d * 0.3) * surge * fade * 0.22;
  y += crest;
  yx -= d * 0.6 * crest * hx;
  yz -= d * 0.6 * crest * hz;
  // Include the shelter gradient so normals also match at the hull transition.
  if (s > 0 && s < 1 && dist > 0) {
    const grad = (0.58 * 6 * s * (1 - s)) / 3,
      fx = (grad * rx) / dist / fade,
      fz = (grad * rz) / dist / fade;
    xx += dx * fx;
    xz += dx * fz;
    zx += dz * fx;
    zz += dz * fz;
    yx += y * fx;
    yz += y * fz;
  }
  const nx = yz * zx - zz * yx,
    ny = zz * xx - xz * zx,
    nz = xz * yx - yz * xx,
    n = Math.hypot(nx, ny, nz);
  Object.assign(out, {
    x: x + dx,
    z: z + dz,
    y: SEA_LEVEL + y,
    dx,
    dz,
    nx: nx / n,
    ny: ny / n,
    nz: nz / n,
    height: y,
  });
  return out;
}

const gl = (n) => Number(n).toFixed(8);
export const WAVE_GLSL = `
uniform float coopTime,coopEnergy,coopSurge,coopFront,coopShelter;
uniform vec2 coopOffset,coopHeading,coopCenter;
void oceanSurface(vec2 p,out vec3 displaced,out vec3 surfaceNormal,out float height){
  vec2 delta=p-coopCenter;float dist=length(delta),s=clamp((dist-coopShelter)/3.,0.,1.);
  float fade=.42+.58*s*s*(3.-2.*s),gain=coopEnergy*fade;
  vec2 drift=vec2(0.);float y=0.;vec3 tx=vec3(1.,0.,0.),tz=vec3(0.,0.,1.);
  ${WAVES.map(
    (w) => `{
    vec2 dir=vec2(${gl(w.x)},${gl(w.z)});float k=${gl(w.k)},a=${gl(w.amplitude)}*gain,q=a*${gl(w.orbit)};
    float phase=k*dot(dir,p)-coopTime*${gl(w.speed)},sn=sin(phase),cs=cos(phase);
    drift+=dir*q*cs;y+=a*sn;
    tx+=vec3(-q*k*dir.x*dir.x*sn,a*k*dir.x*cs,-q*k*dir.y*dir.x*sn);
    tz+=vec3(-q*k*dir.x*dir.y*sn,a*k*dir.y*cs,-q*k*dir.y*dir.y*sn);
  }`,
  ).join("\n")}
  float d=dot(delta,coopHeading)-coopFront,crest=exp(-d*d*.30)*coopSurge*fade*.22;
  y+=crest;tx.y-=d*.6*crest*coopHeading.x;tz.y-=d*.6*crest*coopHeading.y;
  if(s>0.&&s<1.&&dist>0.){
    vec2 grad=.58*6.*s*(1.-s)/3.*delta/dist/fade;
    tx+=vec3(drift.x,y,drift.y)*grad.x;tz+=vec3(drift.x,y,drift.y)*grad.y;
  }
  displaced=vec3(p.x+drift.x,y,p.y+drift.y);surfaceNormal=normalize(cross(tz,tx));height=y;
}
`;
