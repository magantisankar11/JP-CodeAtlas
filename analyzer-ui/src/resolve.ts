/** Module specifier → repo-relative file, using relative paths and the project's aliases (jsconfig / quasar). */
export class ModuleResolver {
  private readonly aliases: Array<[string, string]>;

  constructor(private readonly files: Set<string>, aliases: Record<string, string> = DEFAULT_ALIASES) {
    this.aliases = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length);
  }

  resolve(fromFile: string, spec: string): string | null {
    let base: string | null = null;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const dir = fromFile.split('/').slice(0, -1);
      for (const part of spec.split('/')) {
        if (part === '.' || part === '') continue;
        if (part === '..') dir.pop();
        else dir.push(part);
      }
      base = dir.join('/');
    } else {
      for (const [prefix, target] of this.aliases) {
        if (spec === prefix || spec.startsWith(prefix + '/')) {
          base = target === '' ? spec.slice(prefix.length + 1) : target + spec.slice(prefix.length);
          break;
        }
      }
    }
    if (base === null) return null;
    for (const ext of ['', '.js', '.ts', '.vue', '.mjs', '.jsx', '.tsx', '/index.js', '/index.ts', '/index.vue']) {
      if (this.files.has(base + ext)) return base + ext;
    }
    return null;
  }
}

/** Quasar / jsconfig defaults seen in JustPerform-UI (src/*, components/*, pages/*, ...) plus the common "@" alias. */
export const DEFAULT_ALIASES: Record<string, string> = {
  src: 'src', '@': 'src', app: '', components: 'src/components', layouts: 'src/layouts', pages: 'src/pages',
  assets: 'src/assets', boot: 'src/boot', stores: 'src/stores',
};
