export const SEA_LEVEL:number;
export const WAVE_GLSL:string;
export const WAVES:ReadonlyArray<{x:number;z:number;amplitude:number;length:number;speed:number;orbit:number;k:number}>;
export interface WaveSample{x:number;y:number;z:number;dx:number;dz:number;nx:number;ny:number;nz:number;height:number}
export function sampleWave(x:number,z:number,time:number,energy?:number,surge?:number,front?:number,hx?:number,hz?:number,cx?:number,cz?:number,shelter?:number,out?:Partial<WaveSample>):WaveSample;
