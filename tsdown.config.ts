import { defineConfig } from 'tsdown'

const ID = 'dsh-reference-session'

export default defineConfig([
  // 主机半身：src/index.ts 产出 lib/index.js（ESM / node）。
  {
    name: `${ID}/lib`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    outputOptions: { codeSplitting: false },
    fixedExtension: false,
    dts: true,
    clean: false,
    // 框架/原生依赖由宿主 profile 树在运行时解析；官方解码器仅软加载。
    deps: {
      neverBundle: [
        /^node:/,
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-session',
        '@huggingface/tokenizers',
      ],
    },
  },
  // 浏览器半身：src/client/index.ts 产出 lib/client.js（ModuleLoader 工厂，占位空注册）。
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    deps: {
      neverBundle: ['@deepseek-ai/cordis'],
      alwaysBundle: (id: string) => (id.startsWith('@deepseek-ai/') ? undefined : true),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
