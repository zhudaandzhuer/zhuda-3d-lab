import { WAVE_GLSL } from "./WaveField.js";
export const vertex = `
#define SHADER_NAME OceanVS
#include "Scene.glsl";
#include "SceneFogInput.glsl";
#include "Camera.glsl";
#include "Sprite3DVertex.glsl";
#include "VertexCommon.glsl";
${WAVE_GLSL}
varying vec3 vSeaPosition,vSeaNormal;varying vec2 vSeaParticle,vSeaLocal;varying float vSeaHeight;
void main(){Vertex v;getVertexParams(v);vec3 displaced,n;float h;oceanSurface(v.positionOS.xz,displaced,n,h);
vSeaNormal=n;vSeaHeight=h;vSeaParticle=v.positionOS.xz;vSeaLocal=v.positionOS.xz;
vec4 world=getWorldMatrix()*vec4(displaced,1.);vSeaPosition=world.xyz;
gl_Position=remapPositionZ(getPositionCS(world.xyz));
#ifdef FOG
FogHandle(gl_Position.z);
#endif
}`;
export const fragment = `
#define SHADER_NAME OceanFS
#include "Color.glsl";
#include "Scene.glsl";
#include "SceneFog.glsl";
#include "Camera.glsl";

      uniform float coopTime,coopEnergy,coopSurge,coopSun,coopRain;uniform vec2 coopHeading;uniform vec3 u_Island;varying vec3 vSeaPosition,vSeaNormal;varying vec2 vSeaParticle,vSeaLocal;varying float vSeaHeight;


      float noise(vec2 p){return .5+.22*sin(p.x+sin(p.y*.72))+.17*sin(p.y*1.31+sin(p.x*.83));}
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float foamNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
      void main(){
        #ifndef OUTER_SEA
          if(length(vSeaLocal)>61.)discard;
        #endif
        vec2 p=vSeaPosition.xz,uv=vSeaParticle;
        float shelf=0.;
        { vec3 island=u_Island;float shoreDistance=distance(p,island.xy);
          if(shoreDistance<island.z)discard;
          shelf=max(shelf,1.-smoothstep(island.z,island.z+9.,shoreDistance));
        }
        vec2 ripple=vec2(cos(p.x*5.1+p.y*2.7-coopTime*2.3),sin(p.y*6.3-p.x*1.9-coopTime*1.7))*.045;
        ripple+=vec2(sin(p.x*12.7+p.y*8.3+coopTime*3.1),cos(p.y*14.2-p.x*7.4-coopTime*2.8))*.016;
        ripple+=coopRain*vec2(sin(p.x*18.+p.y*13.-coopTime*14.),cos(p.y*21.-p.x*11.-coopTime*16.))*.03;
        vec3 n=normalize(vSeaNormal+vec3(ripple.x,0.,ripple.y));
        vec3 view=normalize(u_CameraPos-vSeaPosition),sun=normalize(vec3(-.42,.84,.35));
        float nv=max(.0,dot(n,view)),light=.48+.52*max(0.,dot(n,sun));
        float crest=clamp(.5+vSeaHeight/max(.15,coopEnergy*.86),0.,1.);
        float volume=noise(p*.23+n.xz*.8+vec2(coopTime*.025,-coopTime*.017));
        vec3 trough=vec3(.003,.035,.083),body=vec3(.006,.145,.21),tip=vec3(.022,.34,.36);
        vec3 water=mix(trough,body,smoothstep(.03,.60,crest));
        water=mix(water,tip,smoothstep(.50,1.,crest)*.75);
        water*=.82+volume*.33;water=mix(water,vec3(.022,.32,.29),shelf*.55);
        water*=light;
        // Refracted, broad subsurface bands give depth; fine caustics appear only on the island shelf.
        float vein=pow(max(0.,sin(p.x*.69+p.y*.4+noise(p*.3)*2.-coopTime*.25)),5.);
        water+=vec3(.002,.016,.019)*vein;
        float caustic=pow(1.-abs(sin(p.x*2.7+sin(p.y*2.1+coopTime*.6))*sin(p.y*2.4-p.x*.4-coopTime*.45)),18.);
        water+=vec3(.02,.055,.035)*caustic*shelf;
        vec3 reflected=reflect(-view,n);
        vec3 sky=mix(vec3(.13,.27,.32),vec3(.40,.60,.66),smoothstep(-.05,.8,reflected.y));
        float fresnel=.025+.38*pow(1.-nv,4.);
        water=mix(water,sky,fresnel);
        float glint=pow(max(0.,dot(reflect(-sun,n),view)),135.);
        water+=vec3(1.,.89,.68)*glint*.72*coopSun;
        float phase=dot(uv,coopHeading)*.53247333-coopTime*1.32;
        float ridge=smoothstep(.84,.99,sin(phase)+.10*(foamNoise(uv*.8)-.5));
        vec2 foamUV=vec2(dot(uv,vec2(-coopHeading.y,coopHeading.x))*.9,dot(uv,coopHeading)*3.2-coopTime*.12);
        float breakUp=foamNoise(foamUV)*.68+foamNoise(foamUV*3.7)*.32;
        float bubbles=smoothstep(.45,.70,breakUp);
        float foam=ridge*bubbles*smoothstep(.025,.29,vSeaHeight/max(.1,coopEnergy));
        foam*=.40+coopSurge*.30;
        vec3 color=mix(water,vec3(.58,.79,.77),foam);
        color*=.50+.50*coopSun;
        gl_FragColor=vec4(color,1.);

        gl_FragColor=outputTransform(gl_FragColor);

#ifdef FOG
gl_FragColor.rgb=scenUnlitFog(gl_FragColor.rgb);
#endif

      }`;
