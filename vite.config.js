import { defineConfig } from 'vite';
import { existsSync, readdirSync, cpSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ISLANDS = 'virtual:island-registry';
const MASCOTS = 'virtual:mascots-module';
const PLACEHOLDER = '_placeholder';

function scanIslands() {
  const dir = join(ROOT, 'islands');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[a-z0-9_-]+$/.test(name))
    .filter((name) => existsSync(join(dir, name, 'scene.js')))
    .sort();
}

// The dev placeholder ships only when asked for, or when nothing real exists yet.
function registryNames(isBuild) {
  const all = scanIslands();
  if (!isBuild || process.env.ISLANDS_INCLUDE_PLACEHOLDER === '1') return all;
  const real = all.filter((n) => n !== PLACEHOLDER);
  return real.length ? real : all;
}

function islandsPlugin() {
  let isBuild = false;
  let outDir = 'dist';
  return {
    name: 'grok-islands',
    configResolved(config) {
      isBuild = config.command === 'build';
      outDir = config.build.outDir;
    },
    resolveId(id) {
      if (id === ISLANDS || id === MASCOTS) return '\0' + id;
      return null;
    },
    load(id) {
      if (id === '\0' + ISLANDS) {
        const rows = registryNames(isBuild).map(
          (n) => `${JSON.stringify(n)}: () => import(${JSON.stringify(`/islands/${n}/scene.js`)})`,
        );
        return `export default {\n${rows.join(',\n')}\n};`;
      }
      if (id === '\0' + MASCOTS) {
        const has = existsSync(join(ROOT, 'assets/mascots/mascots.js'));
        return has
          ? `export default () => import('/assets/mascots/mascots.js');`
          : `export default null;`;
      }
      return null;
    },
    configureServer(server) {
      // Other agents add islands and mascots while the dev server runs.
      const refresh = (file) => {
        if (!/(islands\/[^/]+\/scene\.js|assets\/mascots\/mascots\.js)$/.test(file)) return;
        for (const id of ['\0' + ISLANDS, '\0' + MASCOTS]) {
          const mod = server.moduleGraph.getModuleById(id);
          if (mod) server.moduleGraph.invalidateModule(mod);
        }
      };
      server.watcher.on('add', refresh);
      server.watcher.on('unlink', refresh);
    },
    closeBundle() {
      if (!isBuild) return;
      // Only runtime asset folders ship. references/ and blender/ never do.
      const dist = resolve(ROOT, outDir);
      for (const name of registryNames(true)) {
        const src = join(ROOT, 'islands', name, 'assets');
        if (existsSync(src)) copyTree(src, join(dist, 'islands', name, 'assets'));
      }
      const masc = join(ROOT, 'assets/mascots');
      if (existsSync(masc)) copyTree(masc, join(dist, 'assets/mascots'), ['.js', '.cjs', '.mjs']);
    },
  };
}

function copyTree(src, dest, skipExt = []) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      if (statSync(p).isDirectory()) return !/(^|\/)(references|\.work|blender)$/.test(p);
      return ![...skipExt, '.blend', '.blend1', '.py', '.psd'].includes(extname(p));
    },
  });
}

export default defineConfig({
  base: './',
  appType: 'mpa',
  publicDir: 'public',
  plugins: [islandsPlugin()],
  server: {
    port: 3260,
    strictPort: true,
    host: true,
    watch: {
      ignored: ['**/.work/**', '**/blender/**', '**/look/**', '**/board/**', '**/references-shared/**', '**/references/**', '**/*.blend', '**/*.png'],
    },
  },
  preview: { port: 3260, strictPort: true, host: true },
  optimizeDeps: {
    entries: ['index.html'],
    exclude: ['three'],
  },
  build: {
    outDir: 'dist',
    assetsDir: '_app',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    emptyOutDir: true,
  },
});
