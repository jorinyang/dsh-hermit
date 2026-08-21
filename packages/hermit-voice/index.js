// 根入口转发：兼容那些不走 package.json main/exports、直接找 index.js 的 loader
export { name, inject, Config, apply } from './lib/index.js'
