import { runConsumerBuild } from 'zhuda-laya-engine/compiler/consumer';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
console.log(await runConsumerBuild({projectRoot:root, config:{features:['core','3d','gltf']}}));
